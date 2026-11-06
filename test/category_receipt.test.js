import { describe, it, expect, vi, beforeEach } from "vitest";
import { updateExpenseCategory, getBudgetStatus, getUserSettings } from "../src/db/queries.js";
import { sendTransactionReceipt, sendTransactionCategoryPicker } from "../src/modules/finance/views.js";
import { handleScanConfirm } from "../src/modules/finance/scanner.js";
import { handleCallback } from "../src/handlers/callback.js";
import { sendSettingsMenu } from "../src/modules/hub/views.js";
import { setExchangeRateInMemory, resetExchangeRateCacheForTest } from "../src/services/exchange_rate.js";

describe("Category Reassignment, Single-Card Confirmation & Query Optimization", () => {
    beforeEach(() => {
        resetExchangeRateCacheForTest();
        vi.restoreAllMocks();
    });

    describe("1. updateExpenseCategory Query & Security Check", () => {
        it("should update category in D1 when user_id matches", async () => {
            const mockDb = {
                prepare: vi.fn().mockImplementation((sql) => ({
                    bind: vi.fn().mockReturnValue({
                        run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
                        first: vi.fn().mockResolvedValue({
                            id: 101,
                            amount: 4.5,
                            currency: "USD",
                            category: "Coffee",
                            type: "expense",
                            merchant: "Starbucks",
                            date: "2026-11-06"
                        })
                    })
                }))
            };

            const result = await updateExpenseCategory(mockDb, "user_123", 101, "Coffee");
            expect(result).not.toBeNull();
            expect(result.category).toBe("Coffee");
            expect(mockDb.prepare).toHaveBeenCalledWith(expect.stringMatching(/UPDATE\s+expenses\s+SET\s+category\s*=\s*\?\s+WHERE\s+id\s*=\s*\?\s+AND\s+user_id\s*=\s*\?/i));
        });

        it("should refuse update and return null if user_id does not own the transaction", async () => {
            const mockDb = {
                prepare: vi.fn().mockImplementation(() => ({
                    bind: vi.fn().mockReturnValue({
                        run: vi.fn().mockResolvedValue({ meta: { changes: 0 } })
                    })
                }))
            };

            const result = await updateExpenseCategory(mockDb, "hacker_user", 101, "Food");
            expect(result).toBeNull();
        });

        it("should reject invalid transaction IDs or null inputs", async () => {
            expect(await updateExpenseCategory(null, "user_1", 101, "Food")).toBeNull();
            expect(await updateExpenseCategory({}, null, 101, "Food")).toBeNull();
            expect(await updateExpenseCategory({}, "user_1", -5, "Food")).toBeNull();
            expect(await updateExpenseCategory({}, "user_1", 101, "")).toBeNull();
        });
    });

    describe("2. Zero-Redundancy Query Optimization in getBudgetStatus", () => {
        it("should return null in 0ms without querying D1 when monthlyBudget is 0 (budget disabled)", async () => {
            const mockDb = {
                prepare: vi.fn()
            };

            const status = await getBudgetStatus(mockDb, "user_1", { monthlyBudget: 0 });
            expect(status).toBeNull();
            expect(mockDb.prepare).not.toHaveBeenCalled(); // zero DB roundtrips!
        });

        it("should reuse pre-fetched displayCurrency and monthlyBudget without querying user_settings", async () => {
            const mockDb = {
                prepare: vi.fn().mockImplementation((sql) => {
                    expect(sql).not.toContain("monthly_budget FROM user_settings");
                    expect(sql).not.toContain("display_currency FROM user_settings");
                    return {
                        bind: vi.fn().mockReturnValue({
                            all: vi.fn().mockResolvedValue({
                                results: [{ total: 200, currency: "USD", type: "expense" }]
                            })
                        })
                    };
                })
            };

            const status = await getBudgetStatus(mockDb, "user_1", {
                monthlyBudget: 1200000,
                displayCurrency: "USD"
            });

            expect(status).not.toBeNull();
            expect(status.budgetKhr).toBe(1200000);
            expect(status.displayCurrency).toBe("USD");
            expect(status.spentStr).toBe("$200");
        });
    });

    describe("3. sendTransactionReceipt Category Button & Receipt Layout", () => {
        it("should include [🏷️ Category] button when txId is provided in extra", async () => {
            const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() =>
                Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }))
            );

            const mockDb = {
                prepare: vi.fn().mockImplementation((sql) => ({
                    bind: vi.fn().mockReturnValue({
                        first: vi.fn().mockImplementation(async () => {
                            if (sql.includes("FROM user_settings")) {
                                return { display_currency: "USD", monthly_budget: 0, voice_mode: "off", briefing_mode: "on" };
                            }
                            if (sql.includes("SUM(CASE WHEN currency = 'USD'")) {
                                return { total: 4000 };
                            }
                            return null;
                        })
                    })
                }))
            };

            const mockEnv = { DB: mockDb, TELEGRAM_BOT_TOKEN: "mock_token" };
            await sendTransactionReceipt(mockEnv, 12345, "user_1", "expense", 5, "USD", "Other", null, {
                txId: 777,
                merchant: "Corner Store"
            });

            expect(fetchSpy).toHaveBeenCalled();
            const payload = JSON.parse(fetchSpy.mock.calls[0][1].body);
            expect(payload.text).toContain("Expense Recorded");
            expect(payload.text).toContain("$5");

            const keyboard = payload.reply_markup.inline_keyboard;
            const buttons = keyboard.flat();

            const catBtn = buttons.find(b => b.text.includes("Category"));
            expect(catBtn).toBeDefined();
            expect(catBtn.callback_data).toBe("edit_cat:777");

            const undoBtn = buttons.find(b => b.text.includes("Undo"));
            expect(undoBtn).toBeDefined();
            expect(undoBtn.callback_data).toBe("undo_tx:777");
        });
    });

    describe("4. sendTransactionCategoryPicker & Callback Handlers", () => {
        it("sendTransactionCategoryPicker should render 3-column category grid with cancel button", async () => {
            const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() =>
                Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }))
            );

            const mockDb = {
                prepare: vi.fn().mockReturnValue({
                    bind: vi.fn().mockReturnValue({
                        first: vi.fn().mockResolvedValue({
                            id: 777,
                            amount: 5,
                            currency: "USD",
                            category: "Other",
                            type: "expense",
                            merchant: "Starbucks"
                        })
                    })
                })
            };

            const mockEnv = { DB: mockDb, TELEGRAM_BOT_TOKEN: "mock_token" };
            await sendTransactionCategoryPicker(mockEnv, 12345, "user_1", 777, 999);

            expect(fetchSpy).toHaveBeenCalled();
            const payload = JSON.parse(fetchSpy.mock.calls[0][1].body);
            expect(payload.text).toContain("Change Category");
            expect(payload.text).toContain("Starbucks");

            const buttons = payload.reply_markup.inline_keyboard.flat();
            expect(buttons.some(b => b.callback_data === "set_cat:777:Coffee")).toBe(true);
            expect(buttons.some(b => b.callback_data === "set_cat:777:Food")).toBe(true);
            expect(buttons.some(b => b.callback_data === "cancel_cat:777")).toBe(true);
        });

        it("handleCallback should handle edit_cat and open category picker", async () => {
            const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() =>
                Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }))
            );

            const mockDb = {
                prepare: vi.fn().mockReturnValue({
                    bind: vi.fn().mockReturnValue({
                        first: vi.fn().mockResolvedValue({
                            id: 888,
                            amount: 10,
                            currency: "USD",
                            category: "Other",
                            type: "expense"
                        })
                    })
                })
            };

            const mockEnv = { DB: mockDb, TELEGRAM_BOT_TOKEN: "mock_token" };
            const callback = {
                id: "cb_edit",
                data: "edit_cat:888",
                from: { id: "849550186" },
                message: { chat: { id: 12345 }, message_id: 111 }
            };

            await handleCallback(callback, mockEnv, "https://bot.example.com");

            const editCall = fetchSpy.mock.calls.find(c => typeof c[0] === "string" && c[0].includes("editMessageText"));
            expect(editCall).toBeDefined();
            const payload = JSON.parse(editCall[1].body);
            expect(payload.text).toContain("Change Category");
        });

        it("handleCallback should handle set_cat, update D1, and refresh receipt in-place", async () => {
            const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() =>
                Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }))
            );

            const mockDb = {
                prepare: vi.fn().mockImplementation((sql) => ({
                    bind: vi.fn().mockReturnValue({
                        run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
                        first: vi.fn().mockImplementation(async () => {
                            if (sql.includes("FROM expenses") && sql.includes("WHERE id = ?")) {
                                return {
                                    id: 888,
                                    amount: 4.5,
                                    currency: "USD",
                                    category: "Coffee",
                                    type: "expense",
                                    merchant: "Brown",
                                    date: "2026-11-06"
                                };
                            }
                            if (sql.includes("FROM user_settings")) {
                                return { display_currency: "USD", monthly_budget: 0 };
                            }
                            if (sql.includes("SUM(CASE WHEN currency = 'USD'")) {
                                return { total: 4000 };
                            }
                            return null;
                        })
                    })
                }))
            };

            const mockEnv = { DB: mockDb, TELEGRAM_BOT_TOKEN: "mock_token" };
            const callback = {
                id: "cb_set",
                data: "set_cat:888:Coffee",
                from: { id: "849550186" },
                message: { chat: { id: 12345 }, message_id: 111 }
            };

            await handleCallback(callback, mockEnv, "https://bot.example.com");

            const answerCall = fetchSpy.mock.calls.find(c => typeof c[0] === "string" && c[0].includes("answerCallbackQuery"));
            expect(answerCall).toBeDefined();
            const answerPayload = JSON.parse(answerCall[1].body);
            expect(answerPayload.text).toContain("Category changed to Coffee");

            const editCall = fetchSpy.mock.calls.find(c => typeof c[0] === "string" && c[0].includes("editMessageText"));
            expect(editCall).toBeDefined();
            const receiptPayload = JSON.parse(editCall[1].body);
            expect(receiptPayload.text).toContain("Expense Recorded");
            expect(receiptPayload.text).toContain("☕ *Coffee*");
        });
    });

    describe("5. Single-Card Receipt Confirmation in handleScanConfirm", () => {
        it("handleScanConfirm should edit pending scan directly into full receipt without duplicate messages", async () => {
            const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() =>
                Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }))
            );

            const mockDb = {
                prepare: vi.fn().mockImplementation((sql) => ({
                    bind: vi.fn().mockReturnValue({
                        run: vi.fn().mockResolvedValue({ meta: { changes: 1, last_row_id: 999 } }),
                        first: vi.fn().mockImplementation(async () => {
                            if (sql.includes("FROM pending_scans")) {
                                return {
                                    id: 12,
                                    user_id: "849550186",
                                    amount: 4.5,
                                    currency: "USD",
                                    category: "Coffee",
                                    type: "expense",
                                    merchant: "Brown Coffee",
                                    date: "2026-11-06"
                                };
                            }
                            if (sql.includes("FROM user_settings")) {
                                return { display_currency: "USD", monthly_budget: 0 };
                            }
                            if (sql.includes("SUM(CASE WHEN currency = 'USD'")) {
                                return { total: 4000 };
                            }
                            return null;
                        })
                    })
                }))
            };

            const mockEnv = { DB: mockDb, TELEGRAM_BOT_TOKEN: "mock_token" };
            await handleScanConfirm(mockEnv, 12345, "849550186", 12, 555, "cb_scan");

            // Verify only 1 message edit occurred (no intermediate plain text edit followed by new message)
            const sendCalls = fetchSpy.mock.calls.filter(c => typeof c[0] === "string" && c[0].includes("sendMessage"));
            expect(sendCalls.length).toBe(0); // Zero duplicate messages sent!

            const editCalls = fetchSpy.mock.calls.filter(c => typeof c[0] === "string" && c[0].includes("editMessageText"));
            expect(editCalls.length).toBe(1); // Exactly 1 seamless card edit!
            const payload = JSON.parse(editCalls[0][1].body);
            expect(payload.text).toContain("Expense Recorded");
            expect(payload.text).toContain("Brown Coffee");
            expect(payload.reply_markup.inline_keyboard.flat().some(b => b.text.includes("Category"))).toBe(true);
        });
    });

    describe("6. Settings Menu Exchange Rate Visibility", () => {
        it("sendSettingsMenu should clearly display active NBC exchange rate in settings summary", async () => {
            setExchangeRateInMemory(4088, "NBC");

            const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() =>
                Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }))
            );

            const mockDb = {
                prepare: vi.fn().mockReturnValue({
                    bind: vi.fn().mockReturnValue({
                        first: vi.fn().mockResolvedValue({
                            display_currency: "USD",
                            monthly_budget: 0,
                            voice_mode: "off",
                            briefing_mode: "on"
                        })
                    })
                })
            };

            const mockEnv = { DB: mockDb, TELEGRAM_BOT_TOKEN: "mock_token" };
            await sendSettingsMenu(mockEnv, 12345, "849550186", 777);

            expect(fetchSpy).toHaveBeenCalled();
            const payload = JSON.parse(fetchSpy.mock.calls[0][1].body);
            expect(payload.text).toContain("Exchange Rate:");
            expect(payload.text).toContain("1 USD = 4,088 KHR (NBC)");

            // Verifies keyboard structure remains 4 rows with all required buttons
            const keyboard = payload.reply_markup.inline_keyboard;
            expect(keyboard.length).toBe(4);
            const buttonTexts = keyboard.flat().map(b => b.text);
            expect(buttonTexts).toContain("💱 Currency: USD");
            expect(buttonTexts).toContain("🎯 Set Budget");
        });
    });
});
