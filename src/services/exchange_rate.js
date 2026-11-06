import { today } from "../utils/time.js";

export const DEFAULT_EXCHANGE_RATE = 4000;
export const NBC_EXCHANGE_RATE_URL = "https://www.nbc.gov.kh/english/economic_research/exchange_rate.php";
export const FALLBACK_EXCHANGE_RATE_URL = "https://open.exchangerate-api.com/v6/latest/USD";

// In-memory module-level cache for zero-latency lookups (<0.001ms)
let memoryCache = {
    rate: DEFAULT_EXCHANGE_RATE,
    source: "DEFAULT",
    date: null,
    updatedAt: null,
    fetchedAtMs: 0
};

/**
 * Fetches the official USD -> KHR exchange rate from the National Bank of Cambodia (NBC).
 * Supplies standard desktop browser headers to bypass CloudFront WAF restrictions
 * and parses the official rate via resilient HTML regex.
 *
 * @param {number} [timeoutMs=6000] - Request timeout in milliseconds
 * @returns {Promise<{rate: number, source: string, date: string}|null>}
 */
export async function fetchNbcExchangeRate(timeoutMs = 6000) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetch(NBC_EXCHANGE_RATE_URL, {
            headers: {
                "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language": "en-US,en;q=0.9",
                "Cache-Control": "no-cache",
                "Pragma": "no-cache"
            },
            signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            console.warn(`NBC exchange rate fetch failed with HTTP status ${response.status}`);
            return null;
        }

        const html = await response.text();
        const match = html.match(/(?:Official Exchange Rate|Official Daily Exchange Rate)\s*:\s*(?:<[^>]+>)*\s*(\d{4,5})\s*(?:<[^>]+>)*\s*KHR\s*\/\s*USD/i);
        if (match && match[1]) {
            const rate = parseInt(match[1], 10);
            if (Number.isFinite(rate) && rate >= 3500 && rate <= 5500) {
                return {
                    rate,
                    source: "NBC",
                    date: today()
                };
            }
        }
        console.warn("Could not extract exchange rate number from NBC HTML response");
        return null;
    } catch (e) {
        clearTimeout(timeoutId);
        console.warn("fetchNbcExchangeRate warning:", e.message);
        return null;
    }
}

/**
 * Fallback provider: fetches USD -> KHR rate from open.exchangerate-api.com
 * when NBC endpoint is temporarily unreachable or blocked.
 *
 * @param {number} [timeoutMs=5000]
 * @returns {Promise<{rate: number, source: string, date: string}|null>}
 */
export async function fetchFallbackExchangeRate(timeoutMs = 5000) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetch(FALLBACK_EXCHANGE_RATE_URL, {
            headers: {
                "Accept": "application/json"
            },
            signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            return null;
        }

        const data = await response.json();
        if (data?.rates?.KHR) {
            const rate = Math.round(Number(data.rates.KHR));
            if (Number.isFinite(rate) && rate >= 3500 && rate <= 5500) {
                return {
                    rate,
                    source: "OpenExchange",
                    date: today()
                };
            }
        }
        return null;
    } catch (e) {
        clearTimeout(timeoutId);
        console.warn("fetchFallbackExchangeRate warning:", e.message);
        return null;
    }
}

/**
 * Retrieves persisted exchange rate configuration from D1 database system_config table.
 *
 * @param {object} db - Cloudflare D1 database binding
 * @returns {Promise<{rate: number, source: string, date: string|null, updatedAt: string|null}|null>}
 */
export async function getExchangeRateConfig(db) {
    if (!db) return null;
    try {
        const row = await db.prepare("SELECT value, updated_at FROM system_config WHERE key = 'exchange_rate'").first();
        if (row?.value) {
            const parsed = JSON.parse(row.value);
            return {
                rate: Number(parsed.rate) || DEFAULT_EXCHANGE_RATE,
                source: parsed.source || "NBC",
                date: parsed.date || null,
                updatedAt: parsed.updated_at || row.updated_at || null
            };
        }
    } catch (_) {
        // Table may not exist yet on initial cold run; handled gracefully
        return null;
    }
    return null;
}

/**
 * Persists exchange rate configuration into D1 database system_config table.
 * Self-healing: automatically creates system_config table if missing.
 *
 * @param {object} db - Cloudflare D1 database binding
 * @param {{rate: number, source?: string, date?: string}} config
 * @returns {Promise<boolean>}
 */
export async function setExchangeRateConfig(db, { rate, source = "NBC", date = null }) {
    if (!db || !rate) return false;
    const nowIso = new Date().toISOString();
    const payload = JSON.stringify({
        rate: Number(rate),
        source,
        date: date || today(),
        updated_at: nowIso
    });

    const upsertSql = `
        INSERT INTO system_config (key, value, updated_at)
        VALUES ('exchange_rate', ?, CURRENT_TIMESTAMP)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `;

    try {
        await db.prepare(upsertSql).bind(payload).run();
        return true;
    } catch (_) {
        // Auto-heal schema if table doesn't exist yet
        try {
            await db.prepare(`
                CREATE TABLE IF NOT EXISTS system_config (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL,
                    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                )
            `).run();
            await db.prepare(upsertSql).bind(payload).run();
            return true;
        } catch (retryErr) {
            console.error("setExchangeRateConfig failed:", retryErr.message);
            return false;
        }
    }
}

/**
 * Synchronous in-memory exchange rate getter (guaranteed 0ms latency).
 * Always safe to call inside hot loop calculations and formatting functions.
 *
 * @returns {number} Active exchange rate (default 4000)
 */
export function getExchangeRateSync() {
    return memoryCache.rate || DEFAULT_EXCHANGE_RATE;
}

/**
 * Asynchronous exchange rate getter.
 * Returns in-memory cached rate immediately (0ms). On cold worker start,
 * reads once from D1 (~1ms) to prime the memory cache.
 * NEVER performs a network fetch to NBC during user message processing.
 *
 * @param {object} [db] - Cloudflare D1 database binding
 * @returns {Promise<number>} Active exchange rate
 */
export async function getExchangeRate(db = null) {
    if (memoryCache.fetchedAtMs > 0) {
        return memoryCache.rate;
    }

    if (db) {
        const config = await getExchangeRateConfig(db);
        if (config && config.rate) {
            memoryCache = {
                rate: config.rate,
                source: config.source,
                date: config.date,
                updatedAt: config.updatedAt,
                fetchedAtMs: Date.now()
            };
            return memoryCache.rate;
        }
    }

    return memoryCache.rate;
}

/**
 * Returns full metadata about the active exchange rate for UI / commands.
 *
 * @param {object} [db] - Cloudflare D1 database binding
 * @returns {Promise<{rate: number, source: string, date: string|null, updatedAt: string|null}>}
 */
export async function getExchangeRateDetails(db = null) {
    if (memoryCache.fetchedAtMs === 0 && db) {
        await getExchangeRate(db);
    }
    return {
        rate: memoryCache.rate,
        source: memoryCache.source,
        date: memoryCache.date,
        updatedAt: memoryCache.updatedAt
    };
}

/**
 * Synchronizes the daily exchange rate by fetching from NBC (or fallback API)
 * and persisting it in both module memory and D1 database.
 * Intended for the daily scheduled cron trigger (08:00 AM ICT) or manual /rate sync.
 *
 * @param {object} env - Cloudflare Worker environment bindings
 * @returns {Promise<{success: boolean, rate: number, source: string, date?: string, error?: string}>}
 */
export async function syncExchangeRate(env) {
    let result = await fetchNbcExchangeRate();
    if (!result) {
        result = await fetchFallbackExchangeRate();
    }

    if (result && result.rate) {
        const nowIso = new Date().toISOString();
        memoryCache = {
            rate: result.rate,
            source: result.source,
            date: result.date || today(),
            updatedAt: nowIso,
            fetchedAtMs: Date.now()
        };

        if (env?.DB) {
            await setExchangeRateConfig(env.DB, {
                rate: result.rate,
                source: result.source,
                date: result.date || today()
            });
        }

        return {
            success: true,
            rate: result.rate,
            source: result.source,
            date: result.date || today()
        };
    }

    return {
        success: false,
        rate: memoryCache.rate,
        source: memoryCache.source,
        error: "Failed to fetch from NBC and fallback provider"
    };
}

/**
 * Manually sets an exchange rate override (e.g. /rate 4100).
 *
 * @param {object} db - Cloudflare D1 database binding
 * @param {number} rate - The exchange rate (e.g. 4100)
 * @param {string|number} [userId]
 * @returns {Promise<boolean>}
 */
export async function setManualExchangeRate(db, rate, userId = null) {
    const num = Math.round(Number(rate));
    if (!Number.isFinite(num) || num < 3000 || num > 6000) {
        return false;
    }

    const nowIso = new Date().toISOString();
    memoryCache = {
        rate: num,
        source: "MANUAL",
        date: today(),
        updatedAt: nowIso,
        fetchedAtMs: Date.now()
    };

    if (db) {
        await setExchangeRateConfig(db, {
            rate: num,
            source: "MANUAL",
            date: today()
        });
    }

    return true;
}

/**
 * Manually sets in-memory exchange rate without persisting to D1.
 * Useful for tests.
 */
export function setExchangeRateInMemory(rate, source = "TEST") {
    memoryCache = {
        rate: Number(rate) || DEFAULT_EXCHANGE_RATE,
        source,
        date: today(),
        updatedAt: new Date().toISOString(),
        fetchedAtMs: Date.now()
    };
}

/**
 * Test helper to reset memory cache state in Vitest suites.
 */
export function resetExchangeRateCacheForTest() {
    memoryCache = {
        rate: DEFAULT_EXCHANGE_RATE,
        source: "DEFAULT",
        date: null,
        updatedAt: null,
        fetchedAtMs: 0
    };
}
