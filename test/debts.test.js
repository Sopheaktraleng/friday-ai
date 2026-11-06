import { describe, it, expect, vi, beforeEach } from "vitest";
import {
    parseLendCommand,
    parseNaturalLend,
    parseDateAndNote,
    formatDebtDisplayDate,
    formatDebtMoney,
    formatDebtShortAmount,
    handleLendCommand,
    sendDebtsDashboard,
    recordLoanAndSendCard
} from "../src/modules/finance/debts.js";
import { addDebt, getDebtById, getPendingDebts, settleDebt, deleteDebt } from "../src/db/queries.js";
import { handleCallback } from "../src/handlers/callback.js";
import { handleMessage } from "../src/handlers/message.js";
import { setExchangeRateInMemory } from "../src/services/exchange_rate.js";
import { today, dateDaysAgo } from "../src/utils/time.js";

describe("IOU & Lending Tracker (/lend & /debts)", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        setExchangeRateInMemory(4088, "NBC Official");
    });

    describe("1. parseLendCommand Parser", () => {
        it("should parse standard USD loan with note", () => {
            const res = parseLendCommand("/lend 50 Alex for lunch");
            expect(res).not.toBeNull();
            expect(res.amount).toBe(50);
            expect(res.currency).toBe("USD");
            expect(res.person).toBe("Alex");
            expect(res.note).toBe("Lunch");
        });

        it("should parse KHR amount with note", () => {
            const res = parseLendCommand("/lend 20000 Dara taxi");
            expect(res).not.toBeNull();
            expect(res.amount).toBe(20000);
            expect(res.currency).toBe("KHR");
            expect(res.person).toBe("Dara");
            expect(res.note).toBe("Taxi");
        });

        it("should parse dollar sign prefix and no note", () => {
            const res = parseLendCommand("/lend $25 John");
            expect(res).not.toBeNull();
            expect(res.amount).toBe(25);
            expect(res.currency).toBe("USD");
            expect(res.person).toBe("John");
            expect(res.note).toBeNull();
        });

        it("should parse 'to' preposition and dollar sign suffix", () => {
            const res = parseLendCommand("/lend 50$ to Sarah coffee");
            expect(res).not.toBeNull();
            expect(res.amount).toBe(50);
            expect(res.currency).toBe("USD");
            expect(res.person).toBe("Sarah");
            expect(res.note).toBe("Coffee");
        });

        it("should parse person before amount: /lend Alex 50 lunch", () => {
            const res = parseLendCommand("/lend Alex 50 lunch");
            expect(res).not.toBeNull();
            expect(res.amount).toBe(50);
            expect(res.currency).toBe("USD");
            expect(res.person).toBe("Alex");
            expect(res.note).toBe("Lunch");
        });

        it("should parse compact 'k' notation as KHR (e.g. 15k)", () => {
            const res = parseLendCommand("/lend 15k Sovan dinner");
            expect(res).not.toBeNull();
            expect(res.amount).toBe(15000);
            expect(res.currency).toBe("KHR");
            expect(res.person).toBe("Sovan");
            expect(res.note).toBe("Dinner");
        });

        it("should return null on invalid or missing inputs", () => {
            expect(parseLendCommand("")).toBeNull();
            expect(parseLendCommand("/lend")).toBeNull();
            expect(parseLendCommand("/lend 50")).toBeNull(); // missing person
            expect(parseLendCommand("/lend abc John")).toBeNull(); // non-numeric
            expect(parseLendCommand("/lend -10 Alex")).toBeNull(); // negative
        });
    });

    describe("2. Formatting Helpers", () => {
        it("formatDebtMoney should format USD and KHR correctly", () => {
            expect(formatDebtMoney(50, "USD")).toBe("$50.00");
            expect(formatDebtMoney(20000, "KHR")).toBe("20,000 ៛");
        });

        it("formatDebtShortAmount should format compact button labels", () => {
            expect(formatDebtShortAmount(50, "USD")).toBe("$50");
            expect(formatDebtShortAmount(20000, "KHR")).toBe("20k ៛");
            expect(formatDebtShortAmount(500, "KHR")).toBe("500 ៛");
        });
    });

    describe("3. D1 Queries (addDebt, getDebtById, getPendingDebts, settleDebt, deleteDebt)", () => {
        it("addDebt should insert a new unpaid loan into D1", async () => {
            const mockDb = {
                prepare: vi.fn().mockReturnValue({
                    bind: vi.fn().mockReturnValue({
                        run: vi.fn().mockResolvedValue({ meta: { last_row_id: 101, changes: 1 } })
                    })
                })
            };

            const result = await addDebt(mockDb, "user_1", "Alex", 50, "USD", "Lunch");
            expect(result).not.toBeNull();
            expect(result.id).toBe(101);
            expect(result.person_name).toBe("Alex");
            expect(result.amount).toBe(50);
            expect(result.status).toBe("unpaid");
            expect(mockDb.prepare).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO debts"));
        });

        it("getPendingDebts should query only unpaid debts for that user", async () => {
            const mockDb = {
                prepare: vi.fn().mockReturnValue({
                    bind: vi.fn().mockReturnValue({
                        all: vi.fn().mockResolvedValue({
                            results: [
                                { id: 101, person_name: "Alex", amount: 50, currency: "USD", note: "Lunch", status: "unpaid" }
                            ]
                        })
                    })
                })
            };

            const list = await getPendingDebts(mockDb, "user_1");
            expect(list.length).toBe(1);
            expect(list[0].person_name).toBe("Alex");
            expect(mockDb.prepare).toHaveBeenCalledWith(expect.stringContaining("status = 'unpaid'"));
        });

        it("settleDebt should update status to settled", async () => {
            const mockDb = {
                prepare: vi.fn().mockImplementation((sql) => ({
                    bind: vi.fn().mockReturnValue({
                        run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
                        first: vi.fn().mockResolvedValue({
                            id: 101,
                            user_id: "user_1",
                            person_name: "Alex",
                            amount: 50,
                            currency: "USD",
                            note: "Lunch",
                            status: "settled",
                            settled_at: "2026-11-06 15:20:00"
                        })
                    })
                }))
            };

            const settled = await settleDebt(mockDb, "user_1", 101);
            expect(settled).not.toBeNull();
            expect(settled.status).toBe("settled");
            expect(mockDb.prepare).toHaveBeenCalledWith(expect.stringContaining("UPDATE debts"));
        });

        it("deleteDebt should delete row where user_id matches and reverse linked expense", async () => {
            const mockDb = {
                prepare: vi.fn().mockImplementation((sql) => ({
                    bind: vi.fn().mockReturnValue({
                        run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
                        first: vi.fn().mockResolvedValue({
                            id: 101,
                            user_id: "user_1",
                            expense_id: 555
                        })
                    })
                }))
            };

            const deleted = await deleteDebt(mockDb, "user_1", 101);
            expect(deleted).toBe(true);
            expect(mockDb.prepare).toHaveBeenCalledWith(expect.stringContaining("DELETE FROM debts"));
            expect(mockDb.prepare).toHaveBeenCalledWith(expect.stringContaining("DELETE FROM expenses"));
        });
    });

    describe("4. /lend Command Execution & Card Layout", () => {
        it("handleLendCommand should record loan and deliver interactive confirmation card", async () => {
            const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() =>
                Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }))
            );

            const mockDb = {
                prepare: vi.fn().mockReturnValue({
                    bind: vi.fn().mockReturnValue({
                        run: vi.fn().mockResolvedValue({ meta: { last_row_id: 202, changes: 1 } })
                    })
                })
            };

            const mockEnv = { DB: mockDb, TELEGRAM_BOT_TOKEN: "mock_token" };
            await handleLendCommand(mockEnv, 12345, "849550186", "/lend 50 Alex for lunch");

            expect(fetchSpy).toHaveBeenCalled();
            const payload = JSON.parse(fetchSpy.mock.calls[0][1].body);
            expect(payload.text).toContain("Loan Recorded");
            expect(payload.text).toContain("Alex");
            expect(payload.text).toContain("$50.00");
            expect(payload.text).toContain("Lunch");

            const buttons = payload.reply_markup.inline_keyboard.flat();
            expect(buttons.some(b => b.callback_data === "settle_debt:202")).toBe(true);
            expect(buttons.some(b => b.callback_data === "del_debt:202")).toBe(true);
            expect(buttons.some(b => b.callback_data === "view_debts")).toBe(true);

            // Verifies cashflow outflow is logged in expenses table
            expect(mockDb.prepare).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO expenses"));
            expect(mockDb.prepare).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO debts"));
        });

        it("handleLendCommand should show help when arguments are missing", async () => {
            const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() =>
                Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }))
            );

            const mockEnv = { DB: {}, TELEGRAM_BOT_TOKEN: "mock_token" };
            await handleLendCommand(mockEnv, 12345, "849550186", "/lend");

            expect(fetchSpy).toHaveBeenCalled();
            const payload = JSON.parse(fetchSpy.mock.calls[0][1].body);
            expect(payload.text).toContain("Loan Tracker");
            expect(payload.text).toContain("/lend 50 Alex lunch");
        });
    });

    describe("5. /debts Dashboard & Callbacks", () => {
        it("sendDebtsDashboard should render empty state when no debts are pending", async () => {
            const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() =>
                Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }))
            );

            const mockDb = {
                prepare: vi.fn().mockReturnValue({
                    bind: vi.fn().mockReturnValue({
                        all: vi.fn().mockResolvedValue({ results: [] })
                    })
                })
            };

            const mockEnv = { DB: mockDb, TELEGRAM_BOT_TOKEN: "mock_token" };
            await sendDebtsDashboard(mockEnv, 12345, "849550186");

            expect(fetchSpy).toHaveBeenCalled();
            const payload = JSON.parse(fetchSpy.mock.calls[0][1].body);
            expect(payload.text).toContain("No Outstanding Loans");
            expect(payload.text).toContain("All loans are settled.");
        });

        it("sendDebtsDashboard should render active loans with 1-tap settlement buttons", async () => {
            const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() =>
                Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }))
            );

            const mockDb = {
                prepare: vi.fn().mockReturnValue({
                    bind: vi.fn().mockReturnValue({
                        all: vi.fn().mockResolvedValue({
                            results: [
                                { id: 301, person_name: "Alex", amount: 50, currency: "USD", note: "Lunch" },
                                { id: 302, person_name: "Dara", amount: 20000, currency: "KHR", note: "Taxi" }
                            ]
                        })
                    })
                })
            };

            const mockEnv = { DB: mockDb, TELEGRAM_BOT_TOKEN: "mock_token" };
            await sendDebtsDashboard(mockEnv, 12345, "849550186");

            expect(fetchSpy).toHaveBeenCalled();
            const payload = JSON.parse(fetchSpy.mock.calls[0][1].body);
            expect(payload.text).toContain("Outstanding Loans");
            expect(payload.text).toContain("Alex");
            expect(payload.text).toContain("$50.00");
            expect(payload.text).toContain("Dara");
            expect(payload.text).toContain("20,000 ៛");

            const buttons = payload.reply_markup.inline_keyboard.flat();
            expect(buttons.some(b => b.callback_data === "settle_debt:301")).toBe(true);
            expect(buttons.some(b => b.callback_data === "settle_debt:302")).toBe(true);
        });

        it("handleCallback settle_debt should settle loan in D1, log repayment inflow, and show toast notification", async () => {
            const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() =>
                Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }))
            );

            let firstCount = 0;
            const mockDb = {
                prepare: vi.fn().mockImplementation((sql) => ({
                    bind: vi.fn().mockReturnValue({
                        run: vi.fn().mockResolvedValue({ meta: { changes: 1, last_row_id: 888 } }),
                        first: vi.fn().mockImplementation(() => {
                            firstCount++;
                            return Promise.resolve({
                                id: 301,
                                user_id: "849550186",
                                person_name: "Alex",
                                amount: 50,
                                currency: "USD",
                                note: "Lunch",
                                status: firstCount === 1 ? "unpaid" : "settled"
                            });
                        })
                    })
                }))
            };

            const mockEnv = { DB: mockDb, TELEGRAM_BOT_TOKEN: "mock_token" };
            const callback = {
                id: "cb_settle_301",
                data: "settle_debt:301",
                from: { id: "849550186" },
                message: { chat: { id: 12345 }, message_id: 999 }
            };

            await handleCallback(callback, mockEnv, "https://bot.example.com");

            const answerCall = fetchSpy.mock.calls.find(c => typeof c[0] === "string" && c[0].includes("answerCallbackQuery"));
            expect(answerCall).toBeDefined();
            const answerPayload = JSON.parse(answerCall[1].body);
            expect(answerPayload.text).toContain("Alex • Settled $50.00");

            const editCall = fetchSpy.mock.calls.find(c => typeof c[0] === "string" && c[0].includes("editMessageText"));
            expect(editCall).toBeDefined();
            const editPayload = JSON.parse(editCall[1].body);
            expect(editPayload.text).toContain("Loan Settled");
            expect(editPayload.text).toContain("Alex");

            // Verifies repayment inflow is logged in expenses table
            expect(mockDb.prepare).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO expenses"));
            expect(mockDb.prepare).toHaveBeenCalledWith(expect.stringContaining("UPDATE debts"));
        });

        it("handleCallback del_debt should delete loan from D1 and reverse cashflow expense", async () => {
            const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() =>
                Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }))
            );

            const mockDb = {
                prepare: vi.fn().mockImplementation((sql) => ({
                    bind: vi.fn().mockReturnValue({
                        run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
                        first: vi.fn().mockResolvedValue({
                            id: 301,
                            user_id: "849550186",
                            person_name: "Alex",
                            amount: 50,
                            currency: "USD",
                            expense_id: 404
                        })
                    })
                }))
            };

            const mockEnv = { DB: mockDb, TELEGRAM_BOT_TOKEN: "mock_token" };
            const callback = {
                id: "cb_del_301",
                data: "del_debt:301",
                from: { id: "849550186" },
                message: { chat: { id: 12345 }, message_id: 999 }
            };

            await handleCallback(callback, mockEnv, "https://bot.example.com");

            const answerCall = fetchSpy.mock.calls.find(c => typeof c[0] === "string" && c[0].includes("answerCallbackQuery"));
            expect(answerCall).toBeDefined();
            const answerPayload = JSON.parse(answerCall[1].body);
            expect(answerPayload.text).toContain("Loan removed");
        });
    });

    describe("6. parseNaturalLend & Date Parsing", () => {
        it("should parse 'bob borrow from me 25$ at 1st nov' accurately into date and null note", () => {
            const res = parseNaturalLend("bob borrow from me 25$ at 1st nov");
            expect(res).not.toBeNull();
            expect(res.person).toBe("Bob");
            expect(res.amount).toBe(25);
            expect(res.currency).toBe("USD");
            expect(res.date).toBe("2026-11-01");
            expect(res.note).toBeNull();
        });

        it("should parse compound 'bob borrow from me 25$ at 1st nov for lunch' into both date and note", () => {
            const res = parseNaturalLend("bob borrow from me 25$ at 1st nov for lunch");
            expect(res).not.toBeNull();
            expect(res.person).toBe("Bob");
            expect(res.amount).toBe(25);
            expect(res.currency).toBe("USD");
            expect(res.date).toBe("2026-11-01");
            expect(res.note).toBe("Lunch");
        });

        it("should parse 'bob borrowed from me $50 for lunch' with null date (defaults to today in DB)", () => {
            const res = parseNaturalLend("bob borrowed from me $50 for lunch");
            expect(res).not.toBeNull();
            expect(res.person).toBe("Bob");
            expect(res.amount).toBe(50);
            expect(res.currency).toBe("USD");
            expect(res.date).toBeNull();
            expect(res.note).toBe("Lunch");
        });

        it("should parse 'dara borrowed 20000r for taxi'", () => {
            const res = parseNaturalLend("dara borrowed 20000r for taxi");
            expect(res).not.toBeNull();
            expect(res.person).toBe("Dara");
            expect(res.amount).toBe(20000);
            expect(res.currency).toBe("KHR");
            expect(res.note).toBe("Taxi");
        });

        it("should parse 'lent 20$ to Dara yesterday' with yesterday date and null note", () => {
            const res = parseNaturalLend("lent 20$ to Dara yesterday");
            expect(res).not.toBeNull();
            expect(res.person).toBe("Dara");
            expect(res.amount).toBe(20);
            expect(res.currency).toBe("USD");
            expect(res.date).toBe(dateDaysAgo(1));
            expect(res.note).toBeNull();
        });

        it("should parse 'lent 20$ to Dara yesterday for taxi' with both date and note", () => {
            const res = parseNaturalLend("lent 20$ to Dara yesterday for taxi");
            expect(res).not.toBeNull();
            expect(res.person).toBe("Dara");
            expect(res.amount).toBe(20);
            expect(res.currency).toBe("USD");
            expect(res.date).toBe(dateDaysAgo(1));
            expect(res.note).toBe("Taxi");
        });

        it("should parse 'john owes me $30'", () => {
            const res = parseNaturalLend("john owes me $30");
            expect(res).not.toBeNull();
            expect(res.person).toBe("John");
            expect(res.amount).toBe(30);
            expect(res.currency).toBe("USD");
            expect(res.note).toBeNull();
        });

        it("should parse colloquial 'bob borrow me 20$'", () => {
            const res = parseNaturalLend("bob borrow me 20$");
            expect(res).not.toBeNull();
            expect(res.person).toBe("Bob");
            expect(res.amount).toBe(20);
            expect(res.currency).toBe("USD");
        });

        it("should parse Unicode/Khmer names 'សុភា borrow 10$'", () => {
            const res = parseNaturalLend("សុភា borrow 10$");
            expect(res).not.toBeNull();
            expect(res.person).toBe("សុភា");
            expect(res.amount).toBe(10);
            expect(res.currency).toBe("USD");
        });

        it("should reject interrogative questions from creating debts", () => {
            expect(parseNaturalLend("did bob borrow from me 25$?")).toBeNull();
            expect(parseNaturalLend("can bob borrow 25$")).toBeNull();
            expect(parseNaturalLend("who borrowed 20$")).toBeNull();
            expect(parseNaturalLend("how much did bob borrow")).toBeNull();
        });

        it("parseDateAndNote helper should parse varied date patterns", () => {
            expect(parseDateAndNote("at 1st nov").date).toBe("2026-11-01");
            expect(parseDateAndNote("nov 1").date).toBe("2026-11-01");
            expect(parseDateAndNote("2026-11-01").date).toBe("2026-11-01");
            expect(parseDateAndNote("01/11/2026").date).toBe("2026-11-01");
            expect(parseDateAndNote("on 1/11").date).toBe("2026-11-01");
            expect(parseDateAndNote("at 31 feb").date).toBeNull(); // invalid calendar date
            expect(parseDateAndNote("just coffee").date).toBeNull();
            expect(parseDateAndNote("just coffee").note).toBe("Just coffee");
        });

        it("formatDebtDisplayDate should format today as Today and historical dates as human strings", () => {
            expect(formatDebtDisplayDate(today())).toBe("Today");
            expect(formatDebtDisplayDate("2026-11-01")).toBe("1 Nov 2026");
        });
    });

    describe("7. handleMessage with Natural Lending Input", () => {
        it("should record loan with accurate date and omit empty note when user types 'bob borrow from me 25$ at 1st nov'", async () => {
            const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() =>
                Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }))
            );

            const mockDb = {
                prepare: vi.fn().mockImplementation((sql) => ({
                    bind: vi.fn().mockReturnValue({
                        run: vi.fn().mockResolvedValue({ meta: { last_row_id: 404, changes: 1 } }),
                        first: vi.fn().mockResolvedValue({
                            role: "owner",
                            status: "active"
                        })
                    })
                }))
            };

            const mockEnv = { DB: mockDb, TELEGRAM_BOT_TOKEN: "mock_token" };
            const msg = {
                chat: { id: 12345, type: "private" },
                from: { id: "849550186", first_name: "Boss" },
                text: "bob borrow from me 25$ at 1st nov"
            };

            await handleMessage(msg, mockEnv, "https://bot.example.com");

            expect(fetchSpy).toHaveBeenCalled();
            const payload = JSON.parse(fetchSpy.mock.calls[0][1].body);
            expect(payload.text).toContain("Loan Recorded");
            expect(payload.text).toContain("Bob");
            expect(payload.text).toContain("$25.00");
            expect(payload.text).toContain("1 Nov 2026");
            expect(payload.text).not.toContain("• Note:");

            const buttons = payload.reply_markup.inline_keyboard.flat();
            expect(buttons.some(b => b.callback_data === "settle_debt:404")).toBe(true);
        });
    });
});
