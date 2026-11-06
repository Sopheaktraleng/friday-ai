import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
    fetchNbcExchangeRate,
    fetchFallbackExchangeRate,
    getExchangeRate,
    getExchangeRateSync,
    getExchangeRateDetails,
    getExchangeRateConfig,
    setExchangeRateConfig,
    syncExchangeRate,
    setManualExchangeRate,
    setExchangeRateInMemory,
    resetExchangeRateCacheForTest,
    DEFAULT_EXCHANGE_RATE,
    NBC_EXCHANGE_RATE_URL,
    FALLBACK_EXCHANGE_RATE_URL
} from "../src/services/exchange_rate.js";
import { formatAmount } from "../src/utils/format.js";
import { formatPendingScanText } from "../src/modules/finance/scanner.js";
import { handleRateCommand, sendExchangeRateCard } from "../src/modules/finance/commands.js";
import { handleCallback } from "../src/handlers/callback.js";

describe("Dynamic NBC Exchange Rate Engine", () => {
    beforeEach(() => {
        resetExchangeRateCacheForTest();
        vi.restoreAllMocks();
    });

    afterEach(() => {
        resetExchangeRateCacheForTest();
        vi.restoreAllMocks();
    });

    describe("NBC Scraper & Fallback Provider", () => {
        it("should successfully parse NBC official exchange rate HTML with font tags", async () => {
            const mockHtml = `
                <html>
                <body>
                    <table>
                        <tr>
                            <td>
                                <br>
                                Official Exchange Rate : <font color="#FF3300">4088</font> KHR / USD
                            </td>
                        </tr>
                    </table>
                </body>
                </html>
            `;

            vi.spyOn(globalThis, "fetch").mockImplementation((url, init) => {
                expect(url).toBe(NBC_EXCHANGE_RATE_URL);
                expect(init.headers["User-Agent"]).toContain("Mozilla/5.0");
                return Promise.resolve(new Response(mockHtml, { status: 200 }));
            });

            const result = await fetchNbcExchangeRate();
            expect(result).not.toBeNull();
            expect(result.rate).toBe(4088);
            expect(result.source).toBe("NBC");
            expect(result.date).toBeDefined();
        });

        it("should parse alternative HTML variations of NBC page", async () => {
            const variations = [
                "Official Exchange Rate: 4095 KHR / USD",
                "Official Daily Exchange Rate : <span>4090</span> KHR/USD",
                "Official Exchange Rate : <b><font color='red'>4110</font></b> KHR / USD"
            ];

            for (const html of variations) {
                vi.spyOn(globalThis, "fetch").mockImplementation(() =>
                    Promise.resolve(new Response(html, { status: 200 }))
                );
                const res = await fetchNbcExchangeRate();
                expect(res).not.toBeNull();
                expect(res.rate).toBeGreaterThanOrEqual(4000);
            }
        });

        it("should return null gracefully on NBC HTTP 403 or 500 error without throwing", async () => {
            vi.spyOn(globalThis, "fetch").mockImplementation(() =>
                Promise.resolve(new Response("CloudFront 403 Forbidden", { status: 403 }))
            );

            const result = await fetchNbcExchangeRate();
            expect(result).toBeNull();
        });

        it("should return null gracefully on network timeout or fetch abort", async () => {
            vi.spyOn(globalThis, "fetch").mockImplementation(() =>
                Promise.reject(new Error("Network connection timed out"))
            );

            const result = await fetchNbcExchangeRate();
            expect(result).toBeNull();
        });

        it("should parse OpenExchange API fallback when NBC fails", async () => {
            const mockJson = {
                result: "success",
                rates: {
                    KHR: 4094.25,
                    THB: 35.12
                }
            };

            vi.spyOn(globalThis, "fetch").mockImplementation((url) => {
                expect(url).toBe(FALLBACK_EXCHANGE_RATE_URL);
                return Promise.resolve(new Response(JSON.stringify(mockJson), { status: 200 }));
            });

            const result = await fetchFallbackExchangeRate();
            expect(result).not.toBeNull();
            expect(result.rate).toBe(4094);
            expect(result.source).toBe("OpenExchange");
        });

        it("should reject rates that are wildly outside realistic economic limits (<3500 or >5500)", async () => {
            const badHtml = "Official Exchange Rate : 1200 KHR / USD";
            vi.spyOn(globalThis, "fetch").mockImplementation(() =>
                Promise.resolve(new Response(badHtml, { status: 200 }))
            );

            const result = await fetchNbcExchangeRate();
            expect(result).toBeNull();
        });
    });

    describe("In-Memory Caching & Performance (0ms Hot Path)", () => {
        it("getExchangeRateSync should return DEFAULT_EXCHANGE_RATE (4000) initially in 0ms", () => {
            expect(getExchangeRateSync()).toBe(4000);
        });

        it("getExchangeRate should return immediately from memory without touching D1 when warm", async () => {
            setExchangeRateInMemory(4088, "NBC");

            const mockDb = {
                prepare: vi.fn()
            };

            const rate = await getExchangeRate(mockDb);
            expect(rate).toBe(4088);
            expect(getExchangeRateSync()).toBe(4088);
            expect(mockDb.prepare).not.toHaveBeenCalled(); // 0ms, zero D1 roundtrip
        });

        it("getExchangeRate should read from D1 on cold worker start and prime memory cache", async () => {
            const mockDb = {
                prepare: vi.fn().mockReturnValue({
                    first: vi.fn().mockResolvedValue({
                        value: JSON.stringify({ rate: 4092, source: "NBC", date: "2026-11-06" }),
                        updated_at: "2026-11-06T08:00:00Z"
                    })
                })
            };

            const rate = await getExchangeRate(mockDb);
            expect(rate).toBe(4092);
            expect(getExchangeRateSync()).toBe(4092);
            expect(mockDb.prepare).toHaveBeenCalledWith(expect.stringContaining("system_config"));

            // Subsequent call is now warm and should not hit D1 again
            const warmRate = await getExchangeRate(mockDb);
            expect(warmRate).toBe(4092);
            expect(mockDb.prepare).toHaveBeenCalledTimes(1);
        });

        it("should fall back to 4000 if D1 returns empty or error on cold start", async () => {
            const mockDb = {
                prepare: vi.fn().mockReturnValue({
                    first: vi.fn().mockRejectedValue(new Error("no such table: system_config"))
                })
            };

            const rate = await getExchangeRate(mockDb);
            expect(rate).toBe(4000);
            expect(getExchangeRateSync()).toBe(4000);
        });
    });

    describe("D1 Database Persistence & Self-Healing", () => {
        it("setExchangeRateConfig should insert/upsert into system_config", async () => {
            const runSpy = vi.fn().mockResolvedValue({ meta: { changes: 1 } });
            const bindSpy = vi.fn().mockReturnValue({ run: runSpy });
            const prepareSpy = vi.fn().mockReturnValue({ bind: bindSpy });

            const mockDb = { prepare: prepareSpy };
            const ok = await setExchangeRateConfig(mockDb, { rate: 4088, source: "NBC" });

            expect(ok).toBe(true);
            expect(prepareSpy).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO system_config"));
            expect(bindSpy).toHaveBeenCalledWith(expect.stringContaining('"rate":4088'));
        });

        it("setExchangeRateConfig should auto-create system_config table if missing on first write", async () => {
            let attempt = 0;
            const mockDb = {
                prepare: vi.fn().mockImplementation((sql) => {
                    if (sql.includes("INSERT INTO system_config")) {
                        attempt++;
                        if (attempt === 1) {
                            return {
                                bind: () => ({
                                    run: vi.fn().mockRejectedValue(new Error("no such table: system_config"))
                                })
                            };
                        }
                        return {
                            bind: () => ({
                                run: vi.fn().mockResolvedValue({ meta: { changes: 1 } })
                            })
                        };
                    }
                    if (sql.includes("CREATE TABLE IF NOT EXISTS system_config")) {
                        return { run: vi.fn().mockResolvedValue({}) };
                    }
                    return { bind: () => ({ run: vi.fn() }) };
                })
            };

            const ok = await setExchangeRateConfig(mockDb, { rate: 4095, source: "NBC" });
            expect(ok).toBe(true);
            expect(mockDb.prepare).toHaveBeenCalledWith(expect.stringContaining("CREATE TABLE IF NOT EXISTS system_config"));
        });
    });

    describe("Automated Background Sync (Cron / Manual)", () => {
        it("syncExchangeRate should fetch from NBC, update memory, and persist to D1", async () => {
            const mockHtml = "Official Exchange Rate : <font color='#FF3300'>4088</font> KHR / USD";
            vi.spyOn(globalThis, "fetch").mockImplementation(() =>
                Promise.resolve(new Response(mockHtml, { status: 200 }))
            );

            const runSpy = vi.fn().mockResolvedValue({});
            const mockDb = {
                prepare: vi.fn().mockReturnValue({
                    bind: vi.fn().mockReturnValue({ run: runSpy })
                })
            };

            const res = await syncExchangeRate({ DB: mockDb });
            expect(res.success).toBe(true);
            expect(res.rate).toBe(4088);
            expect(res.source).toBe("NBC");
            expect(getExchangeRateSync()).toBe(4088);
            expect(mockDb.prepare).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO system_config"));
        });

        it("syncExchangeRate should fallback to OpenExchange if NBC is blocked", async () => {
            vi.spyOn(globalThis, "fetch").mockImplementation((url) => {
                if (url.includes("nbc.gov.kh")) {
                    return Promise.resolve(new Response("Blocked", { status: 403 }));
                }
                if (url.includes("open.exchangerate-api.com")) {
                    return Promise.resolve(new Response(JSON.stringify({ rates: { KHR: 4092 } }), { status: 200 }));
                }
                return Promise.reject(new Error("Unknown URL"));
            });

            const res = await syncExchangeRate({});
            expect(res.success).toBe(true);
            expect(res.rate).toBe(4092);
            expect(res.source).toBe("OpenExchange");
            expect(getExchangeRateSync()).toBe(4092);
        });
    });

    describe("Manual Override & User Commands (/rate)", () => {
        it("setManualExchangeRate should update memory and D1 with MANUAL source", async () => {
            const mockDb = {
                prepare: vi.fn().mockReturnValue({
                    bind: vi.fn().mockReturnValue({ run: vi.fn().mockResolvedValue({}) })
                })
            };

            const ok = await setManualExchangeRate(mockDb, 4100, "849550186");
            expect(ok).toBe(true);
            expect(getExchangeRateSync()).toBe(4100);

            const details = await getExchangeRateDetails(mockDb);
            expect(details.rate).toBe(4100);
            expect(details.source).toBe("MANUAL");
        });

        it("setManualExchangeRate should reject non-numeric or unrealistic rates", async () => {
            expect(await setManualExchangeRate(null, "invalid")).toBe(false);
            expect(await setManualExchangeRate(null, 100)).toBe(false);
            expect(await setManualExchangeRate(null, 50000)).toBe(false);
        });

        it("handleRateCommand /rate should render rate card with active rate and source", async () => {
            setExchangeRateInMemory(4088, "NBC");

            const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() =>
                Promise.resolve(new Response(JSON.stringify({ ok: true, result: true }), { status: 200 }))
            );

            const mockEnv = { TELEGRAM_BOT_TOKEN: "mock_token" };
            await handleRateCommand(mockEnv, 123456, "849550186", "/rate");

            expect(fetchSpy).toHaveBeenCalled();
            const payload = JSON.parse(fetchSpy.mock.calls[0][1].body);
            expect(payload.text).toContain("Currency Exchange Rate");
            expect(payload.text).toContain("1 USD = 4,088 KHR");
            expect(payload.text).toContain("National Bank of Cambodia (NBC)");
            expect(payload.reply_markup.inline_keyboard[0][0].text).toContain("Sync NBC Rate Now");
        });

        it("handleRateCommand /rate 4100 should update preferred rate and reply with confirmation", async () => {
            const mockDb = {
                prepare: vi.fn().mockReturnValue({
                    bind: vi.fn().mockReturnValue({ run: vi.fn().mockResolvedValue({}) })
                })
            };

            const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() =>
                Promise.resolve(new Response(JSON.stringify({ ok: true, result: true }), { status: 200 }))
            );

            const mockEnv = { DB: mockDb, TELEGRAM_BOT_TOKEN: "mock_token" };
            await handleRateCommand(mockEnv, 123456, "849550186", "/rate 4100");

            expect(getExchangeRateSync()).toBe(4100);
            expect(fetchSpy).toHaveBeenCalled();
            const payload = JSON.parse(fetchSpy.mock.calls[0][1].body);
            expect(payload.text).toContain("Exchange Rate Updated");
            expect(payload.text).toContain("1 USD = 4,100 KHR");
        });

        it("handleRateCommand /rate sync should trigger immediate fetch from NBC", async () => {
            const mockHtml = "Official Exchange Rate : <font color='#FF3300'>4088</font> KHR / USD";
            const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((url) => {
                if (typeof url === "string" && url.includes("nbc.gov.kh")) {
                    return Promise.resolve(new Response(mockHtml, { status: 200 }));
                }
                return Promise.resolve(new Response(JSON.stringify({ ok: true, result: true }), { status: 200 }));
            });

            const mockEnv = { DB: null, TELEGRAM_BOT_TOKEN: "mock_token" };
            await handleRateCommand(mockEnv, 123456, "849550186", "/rate sync");

            expect(getExchangeRateSync()).toBe(4088);
            const tgCall = fetchSpy.mock.calls.find(c => typeof c[0] === "string" && c[0].includes("sendMessage"));
            expect(tgCall).toBeDefined();
            const payload = JSON.parse(tgCall[1].body);
            expect(payload.text).toContain("Exchange Rate Synchronized");
            expect(payload.text).toContain("4,088 KHR");
        });
    });

    describe("Callback Queries: sync_rate & view_rate", () => {
        it("should handle sync_rate callback and update the rate card message", async () => {
            const mockHtml = "Official Exchange Rate : <font color='#FF3300'>4088</font> KHR / USD";
            const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((url) => {
                if (typeof url === "string" && url.includes("nbc.gov.kh")) {
                    return Promise.resolve(new Response(mockHtml, { status: 200 }));
                }
                return Promise.resolve(new Response(JSON.stringify({ ok: true, result: true }), { status: 200 }));
            });

            const mockEnv = { TELEGRAM_BOT_TOKEN: "mock_token" };
            const callback = {
                id: "cb_123",
                data: "sync_rate",
                from: { id: "849550186" },
                message: { chat: { id: 123456 }, message_id: 999 }
            };

            await handleCallback(callback, mockEnv, "https://bot.example.com");

            expect(getExchangeRateSync()).toBe(4088);
            const editCall = fetchSpy.mock.calls.find(c => typeof c[0] === "string" && c[0].includes("editMessageText"));
            expect(editCall).toBeDefined();
            const payload = JSON.parse(editCall[1].body);
            expect(payload.text).toContain("4,088 KHR");
        });
    });

    describe("Financial Conversion Integration", () => {
        it("formatAmount should convert KHR to USD accurately using dynamic exchange rate", () => {
            setExchangeRateInMemory(4088);
            // 40,880 KHR / 4088 = exactly $10.00
            const usdStr = formatAmount(40880, "USD");
            expect(usdStr).toBe("$10");

            // 20,440 KHR / 4088 = exactly $5.00
            const usdStr5 = formatAmount(20440, "USD");
            expect(usdStr5).toBe("$5");
        });

        it("formatPendingScanText should display alternative currency amount using dynamic exchange rate", () => {
            setExchangeRateInMemory(4088);

            const usdScan = {
                amount: 10,
                currency: "USD",
                category: "Coffee",
                type: "expense",
                merchant: "Brown Coffee"
            };

            const text = formatPendingScanText(usdScan);
            // 10 * 4088 = 40,880
            expect(text).toContain("-$10");
            expect(text).toContain("(~40,880 ៛)");
        });
    });
});
