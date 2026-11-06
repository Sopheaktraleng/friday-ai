import { describe, it, expect, vi, beforeEach } from "vitest";
import { getBudgetStatus, getUserSettings } from "../src/db/queries.js";
import { sendTransactionReceipt } from "../src/modules/finance/views.js";
import { handleScanConfirm } from "../src/modules/finance/scanner.js";
import { sendSettingsMenu } from "../src/modules/hub/views.js";
import { sendExchangeRateCard } from "../src/modules/finance/commands.js";
import { setExchangeRateInMemory, resetExchangeRateCacheForTest } from "../src/services/exchange_rate.js";

describe("Receipt Flow, Single-Card Confirmation & Query Optimization", () => {
    beforeEach(() => {
        resetExchangeRateCacheForTest();
        vi.restoreAllMocks();
    });

    describe("1. Zero-Redundancy Query Optimization in getBudgetStatus", () => {
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

    describe("2. Clean Receipt Layout with Undo Action", () => {
        it("should include [❌ Undo] button without clutter when txId is provided", async () => {
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
            expect(catBtn).toBeUndefined(); // Category button cleanly removed

            const undoBtn = buttons.find(b => b.text.includes("Undo"));
            expect(undoBtn).toBeDefined();
            expect(undoBtn.callback_data).toBe("undo_tx:777");
        });
    });

    describe("3. Single-Card Receipt Confirmation in handleScanConfirm", () => {
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
            await handleScanConfirm(mockEnv, 12345, "849550186", 12, 333, "cb_scan");

            // Verify: No plain text "✅ Receipt Recorded" edit occurred
            const plainTextEdit = fetchSpy.mock.calls.find(c => {
                if (typeof c[0] !== "string" || !c[0].includes("editMessageText")) return false;
                const body = JSON.parse(c[1]?.body || "{}");
                return body.text === "✅ Receipt Recorded";
            });
            expect(plainTextEdit).toBeUndefined();

            // Verify: Single edit transformed directly into full receipt
            const receiptEdit = fetchSpy.mock.calls.find(c => {
                if (typeof c[0] !== "string" || !c[0].includes("editMessageText")) return false;
                const body = JSON.parse(c[1]?.body || "{}");
                return body.text && body.text.includes("Expense Recorded") && body.text.includes("$4.5");
            });
            expect(receiptEdit).toBeDefined();

            // Verify: No separate sendMessage call was fired
            const sendMessageCalls = fetchSpy.mock.calls.filter(c => typeof c[0] === "string" && c[0].includes("sendMessage"));
            expect(sendMessageCalls.length).toBe(0);
        });
    });

    describe("4. Single-Home Architecture: Settings and Exchange Rate Separation", () => {
        it("sendSettingsMenu should focus on personal preferences without exchange rate or CSV clutter", async () => {
            const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() =>
                Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }))
            );

            const mockDb = {
                prepare: vi.fn().mockImplementation((sql) => ({
                    bind: vi.fn().mockReturnValue({
                        first: vi.fn().mockImplementation(async () => {
                            if (sql.includes("FROM user_settings")) {
                                return {
                                    display_currency: "KHR",
                                    monthly_budget: 2000000,
                                    voice_mode: "off",
                                    briefing_mode: "on"
                                };
                            }
                            return null;
                        }),
                        all: vi.fn().mockResolvedValue({ results: [] })
                    })
                }))
            };

            const mockEnv = { DB: mockDb, TELEGRAM_BOT_TOKEN: "mock_token" };
            await sendSettingsMenu(mockEnv, 12345, "849550186");

            expect(fetchSpy).toHaveBeenCalled();
            const payload = JSON.parse(fetchSpy.mock.calls[0][1].body);
            expect(payload.text).toContain("System Settings");
            expect(payload.text).not.toContain("Exchange Rate:"); // Exchange rate removed from Settings

            const buttons = payload.reply_markup.inline_keyboard.flat().map(b => b.text);
            expect(buttons.some(t => t.includes("Export CSV"))).toBe(false); // CSV export removed from Settings
        });

        it("sendExchangeRateCard (/rate) should be the sole home for exchange rate and link to Finance Hub", async () => {
            setExchangeRateInMemory(4088, "NBC Official");

            const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() =>
                Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }))
            );

            const mockDb = {
                prepare: vi.fn().mockReturnValue({
                    first: vi.fn().mockResolvedValue({ value: JSON.stringify({ rate: 4088, source: "NBC" }) })
                })
            };

            const mockEnv = { DB: mockDb, TELEGRAM_BOT_TOKEN: "mock_token" };
            await sendExchangeRateCard(mockEnv, 12345, "849550186");

            expect(fetchSpy).toHaveBeenCalled();
            const payload = JSON.parse(fetchSpy.mock.calls[0][1].body);
            expect(payload.text).toContain("Currency Exchange Rate");
            expect(payload.text).toContain("1 USD = 4,088 KHR");

            const buttons = payload.reply_markup.inline_keyboard.flat();
            expect(buttons.some(b => b.callback_data === "finance_hub")).toBe(true);
            expect(buttons.some(b => b.callback_data === "settings")).toBe(false);
        });
    });
});
