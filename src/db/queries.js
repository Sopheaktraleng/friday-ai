import { getExchangeRateSync } from "../services/exchange_rate.js";
import { today, monthPrefix } from "../utils/time.js";
import { formatAmount, normalizeCategory } from "../utils/format.js";

export async function wasUpdateProcessed(db, updateId) {
    if (typeof updateId !== "number") {
        return false;
    }

    try {
        const result = await db
            .prepare("INSERT OR IGNORE INTO processed_updates (update_id) VALUES (?)")
            .bind(updateId)
            .run();

        return result.meta?.changes === 0;
    } catch (error) {
        console.error("Could not save processed update id:", error);
        return false;
    }
}

export async function getUserSettings(db, userId) {
    try {
        const row = await db
            .prepare("SELECT display_currency, monthly_budget, voice_mode, briefing_mode FROM user_settings WHERE user_id = ?")
            .bind(userId)
            .first();
        return {
            display_currency: row?.display_currency || "KHR",
            monthly_budget: row?.monthly_budget || 0,
            voice_mode: row?.voice_mode || "off",
            briefing_mode: row?.briefing_mode || "on"
        };
    } catch (e) {
        return {
            display_currency: "KHR",
            monthly_budget: 0,
            voice_mode: "off",
            briefing_mode: "on"
        };
    }
}

export async function getDisplayCurrency(db, userId) {
    const row = await db
        .prepare("SELECT display_currency FROM user_settings WHERE user_id = ?")
        .bind(userId)
        .first();
    return row?.display_currency || "KHR";
}

export async function setDisplayCurrency(db, userId, currency) {
    await db
        .prepare(
            "INSERT INTO user_settings (user_id, display_currency) VALUES (?, ?) " +
            "ON CONFLICT(user_id) DO UPDATE SET display_currency = excluded.display_currency"
        )
        .bind(userId, currency)
        .run();
}

export async function getUserVoiceMode(db, userId) {
    try {
        const row = await db
            .prepare("SELECT voice_mode FROM user_settings WHERE user_id = ?")
            .bind(userId)
            .first();
        return row?.voice_mode || "off";
    } catch (e) {
        return "off";
    }
}

export async function setUserVoiceMode(db, userId, mode = "off") {
    try {
        await db
            .prepare(
                "INSERT INTO user_settings (user_id, voice_mode) VALUES (?, ?) " +
                "ON CONFLICT(user_id) DO UPDATE SET voice_mode = excluded.voice_mode"
            )
            .bind(userId, mode)
            .run();
        return true;
    } catch (e) {
        console.error("setUserVoiceMode error:", e);
        return false;
    }
}

export async function getUserBriefingMode(db, userId) {
    try {
        const row = await db
            .prepare("SELECT briefing_mode FROM user_settings WHERE user_id = ?")
            .bind(userId)
            .first();
        return row?.briefing_mode || "on";
    } catch (e) {
        return "on";
    }
}

export async function setUserBriefingMode(db, userId, mode = "on") {
    try {
        await db
            .prepare(
                "INSERT INTO user_settings (user_id, briefing_mode) VALUES (?, ?) " +
                "ON CONFLICT(user_id) DO UPDATE SET briefing_mode = excluded.briefing_mode"
            )
            .bind(userId, mode)
            .run();
        return true;
    } catch (e) {
        console.error("setUserBriefingMode error:", e);
        return false;
    }
}

export async function getLastModelChatMessage(db, userId) {
    try {
        const row = await db
            .prepare("SELECT content FROM chat_history WHERE user_id = ? AND role = 'model' ORDER BY id DESC LIMIT 1")
            .bind(userId)
            .first();
        return row?.content || null;
    } catch (e) {
        console.error("getLastModelChatMessage error:", e);
        return null;
    }
}

export async function getFinancialSummary(db, userId, period) {
    let condition = "";
    let bindParams = [userId];
    
    if (period === "today") {
        condition = "AND date = ?";
        bindParams.push(today());
    } else if (period === "month") {
        condition = "AND date LIKE ?";
        bindParams.push(`${monthPrefix()}%`);
    }

    const { results } = await db.prepare(
        `SELECT type, currency, SUM(amount) AS total
         FROM expenses
         WHERE user_id = ? ${condition}
         GROUP BY type, currency`
    )
    .bind(...bindParams)
    .all();

    let incomeUsd = 0;
    let incomeKhr = 0;
    let expenseUsd = 0;
    let expenseKhr = 0;

    if (results) {
        for (const row of results) {
            const amount = Number(row.total || 0);
            if (row.type === "income") {
                if (row.currency === "USD") incomeUsd += amount;
                else incomeKhr += amount;
            } else {
                if (row.currency === "USD") expenseUsd += amount;
                else expenseKhr += amount;
            }
        }
    }

    const exchangeRate = getExchangeRateSync();
    const totalIncomeInKhr = incomeKhr + (incomeUsd * exchangeRate);
    const totalExpenseInKhr = expenseKhr + (expenseUsd * exchangeRate);
    const balanceKhr = totalIncomeInKhr - totalExpenseInKhr;

    return {
        incomeKhr,
        incomeUsd,
        expenseKhr,
        expenseUsd,
        totalIncomeInKhr,
        totalExpenseInKhr,
        balanceKhr
    };
}

export async function getTotalExpenses(db, userId) {
    const exchangeRate = getExchangeRateSync();
    const row = await db
        .prepare(
            `SELECT COALESCE(SUM(CASE WHEN currency = 'USD' THEN amount * ${exchangeRate} ELSE amount END), 0) AS total 
             FROM expenses 
             WHERE user_id = ? AND type = 'expense'`
        )
        .bind(userId)
        .first();

    return Number(row?.total || 0);
}

export async function getPeriodStats(db, userId, period) {
    let condition = "date = ?";
    let params = [userId, today()];
    
    if (period === "month") {
        condition = "date LIKE ?";
        params = [userId, `${monthPrefix()}%`];
    } else if (period === "all") {
        condition = "1 = 1";
        params = [userId];
    }
    
    const exchangeRate = getExchangeRateSync();
    const [row, biggest] = await Promise.all([
        db.prepare(
            `SELECT COALESCE(SUM(CASE WHEN currency = 'USD' THEN amount * ${exchangeRate} ELSE amount END), 0) AS total,
                    COUNT(*) AS count,
                    COALESCE(AVG(CASE WHEN currency = 'USD' THEN amount * ${exchangeRate} ELSE amount END), 0) AS average
             FROM expenses
             WHERE user_id = ? AND type = 'expense' AND ${condition}`
        ).bind(...params).first(),
        db.prepare(
            `SELECT amount, category, currency
             FROM expenses
             WHERE user_id = ? AND type = 'expense' AND ${condition}
             ORDER BY (CASE WHEN currency = 'USD' THEN amount * ${exchangeRate} ELSE amount END) DESC, id DESC
             LIMIT 1`
        ).bind(...params).first()
    ]);

    return {
        total: Number(row?.total || 0),
        count: Number(row?.count || 0),
        average: Number(row?.average || 0),
        maxAmount: Number(biggest?.amount || 0),
        maxCategory: biggest?.category || "",
        maxCurrency: biggest?.currency || "KHR"
    };
}

export async function getCategoryRows(db, userId, period, limit) {
    let condition = "date = ?";
    let params = [userId, today(), limit];

    if (period === "month") {
        condition = "date LIKE ?";
        params = [userId, `${monthPrefix()}%`, limit];
    } else if (period === "all") {
        condition = "1 = 1";
        params = [userId, limit];
    }

    const exchangeRate = getExchangeRateSync();
    const { results } = await db
        .prepare(
            `SELECT category, 
                    SUM(CASE WHEN currency = 'USD' THEN amount * ${exchangeRate} ELSE amount END) AS total, 
                    COUNT(*) AS count
             FROM expenses
             WHERE user_id = ? AND type = 'expense' AND ${condition}
             GROUP BY LOWER(category)
             ORDER BY total DESC
             LIMIT ?`
        )
        .bind(...params)
        .all();

    return results || [];
}

/**
 * Returns the user's top recent favorite transactions (grouped by category, amount, currency, merchant)
 * to power 1-tap re-logging.
 */
export async function getRecentFavorites(db, userId, type = "expense", limit = 3) {
    try {
        const rows = await db
            .prepare(`
                SELECT category, amount, currency, merchant, COUNT(*) as freq, MAX(id) as last_id
                FROM expenses
                WHERE user_id = ? AND type = ?
                GROUP BY category, amount, currency, COALESCE(merchant, '')
                ORDER BY freq DESC, last_id DESC
                LIMIT ?
            `)
            .bind(userId, type, limit)
            .all();

        return rows?.results || [];
    } catch (e) {
        console.warn("getRecentFavorites error:", e.message);
        return [];
    }
}

/**
 * Checks for a recent duplicate transaction within the specified time window (default: 30 minutes).
 * Matches user_id, amount, currency, and optionally compares merchant name.
 */
export async function findRecentDuplicateExpense(db, userId, { amount, currency, merchant = null, windowMinutes = 30 }) {
    if (!db || !userId || !amount) return null;
    try {
        const mins = parseInt(windowMinutes, 10) || 30;
        const query = `
            SELECT id, amount, currency, category, type, merchant, date, created_at
            FROM expenses
            WHERE user_id = ?
              AND amount = ?
              AND currency = ?
              AND created_at >= datetime('now', '-${mins} minutes')
            ORDER BY id DESC
            LIMIT 5
        `;
        const res = await db.prepare(query)
            .bind(String(userId), amount, currency)
            .all();

        const results = res?.results || [];
        if (results.length === 0) return null;

        const nowMs = Date.now();
        const enrichMinutesAgo = (r) => {
            let minutesAgo = 1;
            if (r.created_at) {
                const raw = String(r.created_at).trim();
                const isoStr = raw.includes("T") 
                    ? (raw.endsWith("Z") ? raw : raw + "Z")
                    : raw.replace(" ", "T") + "Z";
                const createdMs = new Date(isoStr).getTime();
                if (!isNaN(createdMs)) {
                    minutesAgo = Math.max(1, Math.round((nowMs - createdMs) / 60000));
                }
            }
            return { ...r, minutes_ago: minutesAgo };
        };

        if (merchant && typeof merchant === "string" && merchant.trim()) {
            const cleanTarget = merchant.trim().toLowerCase();
            const matched = results.find(r => {
                if (!r.merchant) return false;
                const m = r.merchant.trim().toLowerCase();
                return m === cleanTarget || m.includes(cleanTarget) || cleanTarget.includes(m);
            });
            if (matched) return enrichMinutesAgo(matched);
        }

        return enrichMinutesAgo(results[0]);
    } catch (e) {
        console.warn("findRecentDuplicateExpense error:", e.message);
        return null;
    }
}

export async function addExpenseRecord(db, userId, amount, category, type = "expense", currency = "KHR", customDate = null, merchant = null, note = null) {
    const recordDate = (customDate && /^\d{4}-\d{2}-\d{2}$/.test(customDate)) ? customDate : today();
    const cleanMerchant = merchant && typeof merchant === "string" ? merchant.trim() : null;
    const cleanNote = note && typeof note === "string" ? note.trim() : null;
    const res = await db
        .prepare("INSERT INTO expenses (user_id, date, amount, category, type, currency, merchant, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(userId, recordDate, amount, normalizeCategory(category), type, currency, cleanMerchant, cleanNote)
        .run();
    return res?.meta?.last_row_id ?? res?.meta?.changes ?? null;
}

export async function clearToday(db, userId) {
    await db
        .prepare("DELETE FROM expenses WHERE user_id = ? AND date = ?")
        .bind(userId, today())
        .run();
}

export async function clearAllExpenses(db, userId) {
    await db
        .prepare("DELETE FROM expenses WHERE user_id = ?")
        .bind(userId)
        .run();
}

export async function deleteLastTransaction(db, userId, filterType = null) {
    try {
        let query = "SELECT id, amount, category, type, currency, date FROM expenses WHERE user_id = ?";
        const params = [userId];

        if (filterType && filterType !== "any" && filterType !== "all") {
            const cleanFilter = filterType.toLowerCase().trim();

            let type = null;
            if (/\bincome\b/.test(cleanFilter)) type = "income";
            else if (/\bexpense\b/.test(cleanFilter)) type = "expense";

            const amtMatch = cleanFilter.match(/(\$?[0-9]+(?:\.[0-9]+)?)\s*(usd|khr|\$|dollars|riel)?/);
            let amount = null;
            if (amtMatch) {
                const val = parseFloat(amtMatch[1].replace("$", ""));
                if (!isNaN(val) && val > 0) amount = val;
            }

            const remainder = cleanFilter
                .replace(/\b(income|expense)\b/g, "")
                .replace(/(\$?[0-9]+(?:\.[0-9]+)?)\s*(usd|khr|\$|dollars|riel)?/g, "")
                .trim();

            if (type) {
                query += " AND type = ?";
                params.push(type);
            }
            if (amount !== null) {
                query += " AND amount = ?";
                params.push(amount);
            }
            if (remainder) {
                query += " AND (LOWER(category) = ? OR LOWER(merchant) LIKE ? OR LOWER(note) LIKE ?)";
                params.push(remainder, `%${remainder}%`, `%${remainder}%`);
            }
        }
        query += " ORDER BY id DESC LIMIT 1";

        const lastRow = await db.prepare(query).bind(...params).first();
        if (!lastRow) {
            return null;
        }

        await db.prepare("DELETE FROM expenses WHERE user_id = ? AND id = ?").bind(userId, lastRow.id).run();
        return lastRow;
    } catch (e) {
        console.error("deleteLastTransaction error:", e);
        return null;
    }
}

export async function deleteExpenseById(db, userId, expenseId) {
    try {
        const row = await db.prepare("SELECT id, amount, category, type, currency, date FROM expenses WHERE user_id = ? AND id = ?").bind(userId, expenseId).first();
        if (!row) return null;
        await db.prepare("DELETE FROM expenses WHERE user_id = ? AND id = ?").bind(userId, expenseId).run();
        return row;
    } catch (e) {
        console.error("deleteExpenseById error:", e);
        return null;
    }
}

export async function setMonthlyBudget(db, userId, budgetInKhr) {
    await db
        .prepare(
            "INSERT INTO user_settings (user_id, monthly_budget) VALUES (?, ?) " +
            "ON CONFLICT(user_id) DO UPDATE SET monthly_budget = excluded.monthly_budget"
        )
        .bind(userId, budgetInKhr)
        .run();
}

/**
 * Calculates current month's budget status including visual progress bar and safe-spend burn rate.
 * Supports zero-redundancy query options (monthlyBudget, displayCurrency, monthSummary) to eliminate duplicate DB roundtrips.
 */
export async function getBudgetStatus(db, userId, options = {}) {
    try {
        const preBudget = options.monthlyBudget !== undefined ? Number(options.monthlyBudget) : null;
        const preCurrency = options.displayCurrency || null;

        // Fast-path: if caller supplies monthlyBudget and budget is disabled (0), exit immediately without querying D1
        if (preBudget !== null && preBudget <= 0) {
            return null;
        }

        const promises = [];
        if (preBudget === null) {
            promises.push(db.prepare("SELECT monthly_budget FROM user_settings WHERE user_id = ?").bind(String(userId)).first());
        }
        promises.push(options.monthSummary || getFinancialSummary(db, userId, "month"));
        if (!preCurrency) {
            promises.push(getDisplayCurrency(db, userId));
        }

        const results = await Promise.all(promises);
        let idx = 0;
        const budgetKhr = preBudget !== null ? preBudget : (results[idx++]?.monthly_budget || 0);
        if (budgetKhr <= 0) return null;

        const monthSummary = results[idx++];
        const displayCurrency = preCurrency || results[idx++] || "KHR";
        const spentKhr = monthSummary?.totalExpenseInKhr || 0;
        const percent = Math.round((spentKhr / budgetKhr) * 100);

        // 10-block progress bar e.g. ▓▓▓▓░░░░░░ 42%
        const filled = Math.min(10, Math.max(0, Math.round(percent / 10)));
        const empty = Math.max(0, 10 - filled);
        const bar = "▓".repeat(filled) + "░".repeat(empty);

        const spentStr = formatAmount(spentKhr, displayCurrency);
        const budgetStr = formatAmount(budgetKhr, displayCurrency);

        // Days remaining in the current month (Asia/Phnom_Penh)
        const parts = today().split("-");
        const year = parseInt(parts[0], 10);
        const month = parseInt(parts[1], 10);
        const currentDay = parseInt(parts[2], 10);
        const daysInMonth = new Date(year, month, 0).getDate();
        const daysRemaining = Math.max(1, daysInMonth - currentDay + 1);

        const remainingKhr = budgetKhr - spentKhr;
        const safeDailyKhr = remainingKhr > 0 ? Math.round(remainingKhr / daysRemaining) : 0;
        const safeDailyStr = formatAmount(safeDailyKhr, displayCurrency);

        return {
            budgetKhr,
            spentKhr,
            remainingKhr,
            percent,
            bar,
            spentStr,
            budgetStr,
            daysRemaining,
            safeDailyStr,
            displayCurrency,
            isOver: percent > 100,
            isWarning: percent >= 80 && percent <= 100
        };
    } catch (e) {
        console.error("getBudgetStatus error:", e);
        return null;
    }
}

export async function getBudgetWarningText(db, userId) {
    const status = await getBudgetStatus(db, userId);
    if (!status) return "";
    
    if (status.percent >= 100) {
        const overageInKhr = status.spentKhr - status.budgetKhr;
        const formattedOverage = formatAmount(overageInKhr, status.displayCurrency);
        return `\n\n🚨 *OVER BUDGET ALERT!*\n└ Exceeded monthly budget by *${formattedOverage}* (\`${status.bar}\` ${status.percent}% spent).`;
    } else if (status.percent >= 80) {
        const formattedRemaining = formatAmount(status.remainingKhr, status.displayCurrency);
        return `\n\n⚠️ *BUDGET WARNING (${status.percent}%)*\n└ Spent *${status.percent}%* (\`${status.bar}\`). Only *${formattedRemaining}* remaining (\`${status.safeDailyStr}/day\` safe for ${status.daysRemaining} days).`;
    }
    return "";
}

/**
 * Automatically purges expired ephemeral logs and temporary scans to keep Cloudflare D1 storage clean and fast.
 */
export async function cleanupExpiredDatabaseRecords(db) {
    if (!db) return { ok: false, totalPurged: 0 };
    try {
        const statements = [
            db.prepare("DELETE FROM processed_updates WHERE processed_at < datetime('now', '-7 days')"),
            db.prepare("DELETE FROM pending_scans WHERE created_at < datetime('now', '-2 days')"),
            db.prepare("DELETE FROM pending_statements WHERE created_at < datetime('now', '-3 days')"),
            db.prepare("DELETE FROM chat_history WHERE created_at < datetime('now', '-30 days')"),
            db.prepare("DELETE FROM daily_broadcast_logs WHERE date < date('now', '-14 days')"),
            db.prepare("DELETE FROM reminders WHERE is_active = 0 AND created_at < datetime('now', '-30 days')")
        ];

        if (typeof db.batch === "function") {
            const results = await db.batch(statements);
            const totalPurged = results.reduce((acc, r) => acc + (r?.meta?.changes ?? r?.changes ?? 0), 0);
            return { ok: true, totalPurged };
        }

        let totalPurged = 0;
        for (const stmt of statements) {
            const res = await stmt.run();
            totalPurged += (res?.meta?.changes ?? res?.changes ?? 0);
        }
        return { ok: true, totalPurged };
    } catch (err) {
        console.warn("cleanupExpiredDatabaseRecords warning:", err.message);
        return { ok: false, error: err.message, totalPurged: 0 };
    }
}

// Multi-turn conversation & long-term memory queries

export async function getRecentChatHistory(db, userId, limit = 18) {
    try {
        const { results } = await db
            .prepare(
                `SELECT role, content FROM (
                    SELECT id, role, content FROM chat_history 
                    WHERE user_id = ? 
                    ORDER BY id DESC LIMIT ?
                ) ORDER BY id ASC`
            )
            .bind(userId, limit)
            .all();
        return results || [];
    } catch (e) {
        console.error("getRecentChatHistory error:", e);
        return [];
    }
}

export async function saveChatMessage(db, userId, role, content) {
    if (!content || !userId) return;
    try {
        await db
            .prepare("INSERT INTO chat_history (user_id, role, content) VALUES (?, ?, ?)")
            .bind(userId, role, content)
            .run();

        // Maintain lean storage: keep most recent 50 conversation turns per user
        db.prepare(
            "DELETE FROM chat_history WHERE user_id = ? AND id NOT IN (SELECT id FROM chat_history WHERE user_id = ? ORDER BY id DESC LIMIT 50)"
        )
            .bind(userId, userId)
            .run()
            .catch(() => {});
    } catch (e) {
        console.error("saveChatMessage error:", e);
    }
}

export async function clearChatHistory(db, userId) {
    try {
        await db.prepare("DELETE FROM chat_history WHERE user_id = ?").bind(userId).run();
        return true;
    } catch (e) {
        console.error("clearChatHistory error:", e);
        return false;
    }
}

export async function getUserMemories(db, userId, limit = 20) {
    try {
        const { results } = await db
            .prepare("SELECT id, category, fact, created_at FROM user_memories WHERE user_id = ? ORDER BY id DESC LIMIT ?")
            .bind(userId, limit)
            .all();
        return results || [];
    } catch (e) {
        console.error("getUserMemories error:", e);
        return [];
    }
}

export async function saveUserMemory(db, userId, fact, category = "preference") {
    if (!fact || !fact.trim()) return null;
    const cleanFact = fact.trim();
    try {
        const existing = await db
            .prepare("SELECT id FROM user_memories WHERE user_id = ? AND LOWER(fact) = LOWER(?)")
            .bind(userId, cleanFact)
            .first();
        if (existing) {
            return existing.id;
        }

        const res = await db
            .prepare("INSERT INTO user_memories (user_id, category, fact) VALUES (?, ?, ?)")
            .bind(userId, category, cleanFact)
            .run();
        return res.meta?.last_row_id || true;
    } catch (e) {
        console.error("saveUserMemory error:", e);
        return null;
    }
}

export async function deleteUserMemory(db, userId, memoryId) {
    try {
        const res = await db
            .prepare("DELETE FROM user_memories WHERE user_id = ? AND id = ?")
            .bind(userId, memoryId)
            .run();
        return (res.meta?.changes || 0) > 0;
    } catch (e) {
        console.error("deleteUserMemory error:", e);
        return false;
    }
}

export async function clearUserMemories(db, userId) {
    try {
        await db.prepare("DELETE FROM user_memories WHERE user_id = ?").bind(userId).run();
        return true;
    } catch (e) {
        console.error("clearUserMemories error:", e);
        return false;
    }
}

/**
 * Atomic deduplication lock for daily scheduled broadcasts (wake-up call, briefing, reports).
 * Guarantees that even if Cloudflare or concurrent cron executions fire simultaneously,
 * only one execution claims the slot and sends the alert to the user.
 * Returns true if claimed successfully, false if already sent today.
 */
export async function claimDailyBroadcast(db, userId, type, date) {
    if (!db) return true;
    try {
        const uId = String(userId);
        const t = String(type);
        const d = String(date);

        const existing = await db
            .prepare("SELECT 1 FROM daily_broadcast_logs WHERE user_id = ? AND type = ? AND date = ?")
            .bind(uId, t, d)
            .first();

        if (existing) {
            return false;
        }

        // Atomic insertion to guard against concurrent edge race conditions
        const result = await db
            .prepare("INSERT OR IGNORE INTO daily_broadcast_logs (user_id, type, date) VALUES (?, ?, ?)")
            .bind(uId, t, d)
            .run();

        const changes = result?.meta?.changes ?? result?.changes;
        if (typeof changes === "number" && changes === 0) {
            return false;
        }

        return true;
    } catch (error) {
        console.warn("claimDailyBroadcast warning:", error.message);
        return true;
    }
}

export async function getAuthorizedUser(db, userId) {
    if (!db || !userId) return null;
    try {
        const prep = db.prepare("SELECT user_id, username, first_name, role, status, permissions, created_at, approved_by FROM authorized_users WHERE user_id = ?");
        const bound = typeof prep?.bind === "function" ? prep.bind(String(userId)) : prep;
        return typeof bound?.first === "function" ? await bound.first() : null;
    } catch (e) {
        return null;
    }
}

export async function listAuthorizedUsers(db) {
    if (!db) return [];
    try {
        const { results } = await db
            .prepare("SELECT user_id, username, first_name, role, status, permissions, created_at, approved_by FROM authorized_users ORDER BY role DESC, created_at ASC")
            .all();
        return results || [];
    } catch (e) {
        console.warn("listAuthorizedUsers error:", e.message);
        return [];
    }
}

export async function addOrUpdateAuthorizedUser(db, { userId, username = "", firstName = "", role = "guest", status = "active", permissions = "finance,tasks,reminders,ai_dialog", approvedBy = "owner" }) {
    if (!db || !userId) return false;
    try {
        await db
            .prepare(
                `INSERT INTO authorized_users (user_id, username, first_name, role, status, permissions, approved_by)
                 VALUES (?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(user_id) DO UPDATE SET
                    username = excluded.username,
                    first_name = excluded.first_name,
                    role = excluded.role,
                    status = excluded.status,
                    permissions = COALESCE(excluded.permissions, authorized_users.permissions),
                    approved_by = excluded.approved_by`
            )
            .bind(String(userId), username, firstName, role, status, permissions, approvedBy)
            .run();
        return true;
    } catch (e) {
        console.error("addOrUpdateAuthorizedUser error:", e);
        return false;
    }
}

export async function updateUserPermissions(db, userId, permissions) {
    if (!db || !userId) return false;
    try {
        await db
            .prepare("UPDATE authorized_users SET permissions = ? WHERE user_id = ?")
            .bind(permissions, String(userId))
            .run();
        return true;
    } catch (e) {
        console.error("updateUserPermissions error:", e);
        return false;
    }
}

export async function toggleUserPermission(db, userId, feature) {
    if (!db || !userId || !feature) return null;
    const user = await getAuthorizedUser(db, userId);
    if (!user) return null;

    const currentPerms = (user.permissions || "finance,tasks,reminders,ai_dialog")
        .split(",")
        .map(p => p.trim().toLowerCase())
        .filter(Boolean);

    let nextPerms;
    if (currentPerms.includes(feature.toLowerCase())) {
        nextPerms = currentPerms.filter(p => p !== feature.toLowerCase());
    } else {
        nextPerms = [...currentPerms, feature.toLowerCase()];
    }

    const newPermString = nextPerms.join(",");
    await updateUserPermissions(db, userId, newPermString);
    return newPermString;
}

export async function setAuthorizedUserStatus(db, userId, status) {
    if (!db || !userId) return false;
    try {
        await db
            .prepare("UPDATE authorized_users SET status = ? WHERE user_id = ?")
            .bind(status, String(userId))
            .run();
        return true;
    } catch (e) {
        console.error("setAuthorizedUserStatus error:", e);
        return false;
    }
}

/**
 * Searches engineering work logs using FTS5 when available, falling back to LIKE.
 */
export async function searchWorkLogs(db, userId, query, limit = 10) {
    if (!db || !userId) return [];
    const cleanQuery = (query || "").trim();
    if (!cleanQuery) {
        const rows = await db.prepare(
            "SELECT id, date, time, content, category FROM work_logs WHERE user_id = ? ORDER BY date DESC, id DESC LIMIT ?"
        ).bind(String(userId), limit).all();
        return rows.results || [];
    }

    // Attempt FTS5 virtual table first
    try {
        const ftsQuery = cleanQuery.replace(/[^a-zA-Z0-9_\u1780-\u17FF\s]/g, " ").trim();
        if (ftsQuery) {
            const ftsRows = await db.prepare(
                `SELECT rowid as id, date, content, category 
                 FROM work_logs_fts 
                 WHERE user_id = ? AND work_logs_fts MATCH ? 
                 ORDER BY rank 
                 LIMIT ?`
            ).bind(String(userId), `${ftsQuery}*`, limit).all();
            if (ftsRows.results && ftsRows.results.length > 0) {
                return ftsRows.results;
            }
        }
    } catch (_) {}

    // Resilient fallback to LIKE
    try {
        const term = `%${cleanQuery}%`;
        const rows = await db.prepare(
            `SELECT id, date, time, content, category 
             FROM work_logs 
             WHERE user_id = ? AND (content LIKE ? OR category LIKE ?) 
             ORDER BY date DESC, id DESC 
             LIMIT ?`
        ).bind(String(userId), term, term, limit).all();
        return rows.results || [];
    } catch (e) {
        console.warn("searchWorkLogs error:", e.message);
        return [];
    }
}

/**
 * Searches user memory matrix using FTS5 when available, falling back to LIKE.
 */
export async function searchUserMemories(db, userId, query, limit = 10) {
    if (!db || !userId) return [];
    const cleanQuery = (query || "").trim();
    if (!cleanQuery) {
        return getUserMemories(db, userId, limit);
    }

    // Attempt FTS5 virtual table first
    try {
        const ftsQuery = cleanQuery.replace(/[^a-zA-Z0-9_\u1780-\u17FF\s]/g, " ").trim();
        if (ftsQuery) {
            const ftsRows = await db.prepare(
                `SELECT rowid as id, fact, category 
                 FROM user_memories_fts 
                 WHERE user_id = ? AND user_memories_fts MATCH ? 
                 ORDER BY rank 
                 LIMIT ?`
            ).bind(String(userId), `${ftsQuery}*`, limit).all();
            if (ftsRows.results && ftsRows.results.length > 0) {
                return ftsRows.results;
            }
        }
    } catch (_) {}

    // Resilient fallback to LIKE
    try {
        const term = `%${cleanQuery}%`;
        const rows = await db.prepare(
            `SELECT id, fact, category 
             FROM user_memories 
             WHERE user_id = ? AND (fact LIKE ? OR category LIKE ?) 
             ORDER BY id DESC 
             LIMIT ?`
        ).bind(String(userId), term, term, limit).all();
        return rows.results || [];
    } catch (e) {
        console.warn("searchUserMemories error:", e.message);
        return [];
    }
}

/**
 * Flexible ledger search by date range, category, and type.
 */
export async function searchLedger(db, userId, options = {}) {
    if (!db || !userId) return { transactions: [], totalKhr: 0, count: 0 };
    const { fromDate, toDate, category, type, query, limit = 20 } = options;

    const conditions = ["user_id = ?"];
    const params = [String(userId)];

    if (fromDate) {
        conditions.push("date >= ?");
        params.push(fromDate);
    }
    if (toDate) {
        conditions.push("date <= ?");
        params.push(toDate);
    }
    if (category) {
        conditions.push("LOWER(category) = LOWER(?)");
        params.push(category);
    }
    if (type && type !== "all") {
        conditions.push("type = ?");
        params.push(type);
    }
    if (query && typeof query === "string" && query.trim()) {
        const qTerm = `%${query.trim().toLowerCase()}%`;
        conditions.push("(LOWER(category) LIKE ? OR LOWER(COALESCE(merchant, '')) LIKE ? OR LOWER(COALESCE(note, '')) LIKE ?)");
        params.push(qTerm, qTerm, qTerm);
    }

    const whereClause = conditions.join(" AND ");
    params.push(limit);

    try {
        const rows = await db.prepare(
            `SELECT id, date, amount, currency, category, type, merchant, note, created_at 
             FROM expenses 
             WHERE ${whereClause} 
             ORDER BY date DESC, id DESC 
             LIMIT ?`
        ).bind(...params).all();

        const exchangeRate = options.exchangeRate || getExchangeRateSync();
        const transactions = rows.results || [];
        let totalKhr = 0;
        for (const t of transactions) {
            const amtKhr = t.currency === "USD" ? t.amount * exchangeRate : t.amount;
            totalKhr += amtKhr;
        }

        return {
            transactions,
            count: transactions.length,
            totalKhr,
            totalUsd: Number((totalKhr / exchangeRate).toFixed(2))
        };
    } catch (e) {
        console.warn("searchLedger error:", e.message);
        return { transactions: [], totalKhr: 0, count: 0 };
    }
}

/**
 * Unified RAG search across memories, work logs, and ledger transactions.
 */
export async function searchHistoricalRecords(db, userId, query, options = {}) {
    if (!db || !userId) return { memories: [], workLogs: [], transactions: [] };
    const limit = options.limit || 5;

    const [memories, workLogs, txns] = await Promise.all([
        searchUserMemories(db, userId, query, limit),
        searchWorkLogs(db, userId, query, limit),
        searchLedger(db, userId, { query, limit })
    ]);

    return {
        memories,
        workLogs,
        transactions: txns.transactions || []
    };
}

/**
 * Saves a multi-transaction parsed PDF statement for user confirmation.
 */
export async function savePendingStatement(db, { userId, chatId, bank, period, currency, totalInflow, totalOutflow, transactionCount, transactionsJson }) {
    if (!db) return null;
    try {
        const result = await db.prepare(
            `INSERT INTO pending_statements 
             (user_id, chat_id, bank, period, currency, total_inflow, total_outflow, transaction_count, transactions_json) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
            String(userId),
            String(chatId),
            bank || "Bank Statement",
            period || "",
            currency || "USD",
            totalInflow || 0,
            totalOutflow || 0,
            transactionCount || 0,
            transactionsJson
        ).run();

        return result.meta?.last_row_id || result.lastRowId || null;
    } catch (e) {
        console.error("savePendingStatement error:", e);
        return null;
    }
}

/**
 * Retrieves a pending statement by id and user_id.
 */
export async function getPendingStatement(db, id, userId) {
    if (!db || !id) return null;
    try {
        return await db.prepare(
            "SELECT * FROM pending_statements WHERE id = ? AND user_id = ?"
        ).bind(id, String(userId)).first();
    } catch (e) {
        console.error("getPendingStatement error:", e);
        return null;
    }
}

/**
 * Deletes a pending statement by id and user_id.
 */
export async function deletePendingStatement(db, id, userId) {
    if (!db || !id) return false;
    try {
        await db.prepare(
            "DELETE FROM pending_statements WHERE id = ? AND user_id = ?"
        ).bind(id, String(userId)).run();
        return true;
    } catch (e) {
        console.error("deletePendingStatement error:", e);
        return false;
    }
}

/**
 * Imports all extracted transactions from a pending statement into the expenses ledger.
 */
export async function importPendingStatementTransactions(db, id, userId) {
    if (!db || !id) return { success: false, count: 0 };
    const stmt = await getPendingStatement(db, id, userId);
    if (!stmt) return { success: false, count: 0 };

    let transactions = [];
    try {
        transactions = JSON.parse(stmt.transactions_json);
    } catch (e) {
        console.error("Failed to parse statement transactions_json:", e);
        return { success: false, count: 0 };
    }

    if (!Array.isArray(transactions) || transactions.length === 0) {
        await deletePendingStatement(db, id, userId);
        return { success: true, count: 0 };
    }

    const stmts = transactions.map(t => {
        const amt = parseFloat(t.amount);
        const curr = (t.currency || stmt.currency || "USD").toUpperCase();
        const cat = normalizeCategory(t.category || (t.type === "income" ? "Income" : "Other"));
        const tType = t.type === "income" ? "income" : "expense";
        const tDate = t.date && /^\d{4}-\d{2}-\d{2}$/.test(t.date) ? t.date : today();

        return db.prepare(
            "INSERT INTO expenses (user_id, date, amount, category, type, currency) VALUES (?, ?, ?, ?, ?, ?)"
        ).bind(String(userId), tDate, amt, cat, tType, curr);
    });

    try {
        if (typeof db.batch === "function") {
            await db.batch(stmts);
        } else {
            for (const s of stmts) {
                await s.run();
            }
        }
        await deletePendingStatement(db, id, userId);
        return { success: true, count: transactions.length, transactions };
    } catch (err) {
        console.error("importPendingStatementTransactions error:", err);
        return { success: false, count: 0, error: err.message };
    }
}


