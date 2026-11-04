import { describe, it, expect, vi } from "vitest";
import { authenticateApiRequest, handleApiRequest } from "../src/handlers/api.js";

describe("API Authentication Handler", () => {
    it("should allow localhost dev bypass when user_id is provided", async () => {
        const req = new Request("http://localhost:8787/api/data?user_id=12345", {
            headers: { host: "localhost:8787" }
        });
        const env = { TELEGRAM_BOT_TOKEN: "mock_token" };
        const auth = await authenticateApiRequest(req, env);
        expect(auth.userId).toBe("12345");
        expect(auth.error).toBeUndefined();
    });

    it("should reject localhost request if user_id is missing", async () => {
        const req = new Request("http://localhost:8787/api/data", {
            headers: { host: "localhost:8787" }
        });
        const env = { TELEGRAM_BOT_TOKEN: "mock_token" };
        const auth = await authenticateApiRequest(req, env);
        expect(auth.error).toBe("Missing user_id parameter");
        expect(auth.status).toBe(400);
    });

    it("should reject non-localhost request without Telegram session", async () => {
        const req = new Request("https://cashflow.workers.dev/api/data?user_id=12345", {
            headers: { host: "cashflow.workers.dev" }
        });
        const env = { TELEGRAM_BOT_TOKEN: "mock_token" };
        const auth = await authenticateApiRequest(req, env);
        expect(auth.error).toBe("Unauthorized: Telegram WebApp authentication required");
        expect(auth.status).toBe(401);
    });

    it("should reject request when Telegram Init Data hash is invalid", async () => {
        const fakeInitData = "query_id=test&user=%7B%22id%22%3A12345%7D&auth_date=1700000000&hash=badhash";
        const req = new Request("https://cashflow.workers.dev/api/data", {
            headers: {
                host: "cashflow.workers.dev",
                "X-Telegram-Init-Data": fakeInitData
            }
        });
        const env = { TELEGRAM_BOT_TOKEN: "real_token" };
        const auth = await authenticateApiRequest(req, env);
        expect(auth.error).toBe("Invalid or expired Telegram WebApp session");
        expect(auth.status).toBe(401);
    });

    describe("API Feature Permissions Enforcement", () => {
        const createMockDb = (permissions = "finance") => ({
            prepare: vi.fn().mockImplementation((query) => ({
                bind: vi.fn().mockImplementation(() => ({
                    first: vi.fn().mockImplementation(async () => {
                        if (query.includes("FROM authorized_users")) {
                            return {
                                user_id: "777888",
                                permissions
                            };
                        }
                        if (query.includes("COUNT(*) as count")) {
                            return { count: 0 };
                        }
                        return null;
                    }),
                    all: vi.fn().mockResolvedValue({ results: [] }),
                    run: vi.fn().mockResolvedValue({ meta: { changes: 1 } })
                }))
            }))
        });

        it("/api/data should return permissions and omit activeReminder when reminders is disabled", async () => {
            const req = new Request("http://localhost:8787/api/data?user_id=777888", {
                headers: { host: "localhost:8787" }
            });
            const env = {
                TELEGRAM_BOT_TOKEN: "mock_token",
                OWNER_ID: "849550186",
                ALLOWED_USER_IDS: "849550186,777888",
                DB: createMockDb("finance") // ONLY finance
            };

            const resp = await handleApiRequest(req, env);
            expect(resp.status).toBe(200);
            const data = await resp.json();
            expect(data.permissions).toEqual({
                finance: true,
                tasks: false,
                reminders: false
            });
            expect(data.activeReminder).toBeNull();
        });

        it("/api/data should correctly return populated daily, recent, and budgetKhr without variable shadowing", async () => {
            const req = new Request("http://localhost:8787/api/data?user_id=849550186", {
                headers: { host: "localhost:8787" }
            });
            const env = {
                TELEGRAM_BOT_TOKEN: "mock_token",
                OWNER_ID: "849550186",
                ALLOWED_USER_IDS: "849550186",
                DB: {
                    prepare: vi.fn().mockImplementation((query) => ({
                        bind: vi.fn().mockImplementation(() => ({
                            first: vi.fn().mockImplementation(async () => {
                                if (query.includes("FROM user_settings")) return { monthly_budget: 500000 };
                                return null;
                            }),
                            all: vi.fn().mockImplementation(async () => {
                                if (query.includes("GROUP BY date")) return { results: [{ date: "2026-11-04", total: 10000 }] };
                                if (query.includes("LIMIT 10")) return { results: [{ id: 1, amount: 2.5, category: "Coffee" }] };
                                return { results: [] };
                            }),
                            run: vi.fn().mockResolvedValue({ meta: { changes: 1 } })
                        }))
                    }))
                }
            };

            const resp = await handleApiRequest(req, env);
            expect(resp.status).toBe(200);
            const data = await resp.json();
            expect(data.budgetKhr).toBe(500000);
            expect(data.recent).toHaveLength(1);
            expect(data.recent[0].category).toBe("Coffee");
            expect(data.daily).toHaveLength(7);
        });

        it("/api/reminders should return 403 Forbidden when reminders is disabled", async () => {
            const req = new Request("http://localhost:8787/api/reminders?user_id=777888", {
                headers: { host: "localhost:8787" }
            });
            const env = {
                TELEGRAM_BOT_TOKEN: "mock_token",
                OWNER_ID: "849550186",
                ALLOWED_USER_IDS: "849550186,777888",
                DB: createMockDb("finance")
            };

            const resp = await handleApiRequest(req, env);
            expect(resp.status).toBe(403);
            const data = await resp.json();
            expect(data.error).toContain("Forbidden: Reminders module disabled");
        });

        it("/api/work should return 403 Forbidden when tasks is disabled", async () => {
            const req = new Request("http://localhost:8787/api/work?user_id=777888", {
                headers: { host: "localhost:8787" }
            });
            const env = {
                TELEGRAM_BOT_TOKEN: "mock_token",
                OWNER_ID: "849550186",
                ALLOWED_USER_IDS: "849550186,777888",
                DB: createMockDb("finance")
            };

            const resp = await handleApiRequest(req, env);
            expect(resp.status).toBe(403);
            const data = await resp.json();
            expect(data.error).toContain("Forbidden: Work & Tasks module disabled");
        });
    });
});
