// Production D1 tables are pre-migrated via schema.sql; default to true to eliminate DDL schema locks on hot requests
let tablesEnsured = true;

const TABLE_SCHEMAS = [
    `CREATE TABLE IF NOT EXISTS authorized_users (
        user_id TEXT PRIMARY KEY,
        username TEXT,
        first_name TEXT,
        role TEXT NOT NULL DEFAULT 'guest' CHECK (role IN ('owner', 'guest')),
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'pending', 'revoked')),
        permissions TEXT NOT NULL DEFAULT 'finance,tasks,reminders,ai_dialog',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        approved_by TEXT
    );`,
    `CREATE TABLE IF NOT EXISTS user_settings (
        user_id TEXT PRIMARY KEY,
        display_currency TEXT NOT NULL DEFAULT 'KHR' CHECK (display_currency IN ('KHR', 'USD')),
        monthly_budget REAL NOT NULL DEFAULT 0 CHECK (monthly_budget >= 0),
        voice_mode TEXT NOT NULL DEFAULT 'off' CHECK (voice_mode IN ('on', 'off')),
        briefing_mode TEXT NOT NULL DEFAULT 'on' CHECK (briefing_mode IN ('on', 'off')),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES authorized_users(user_id) ON DELETE CASCADE
    );`,
    `CREATE TABLE IF NOT EXISTS reminders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        title TEXT NOT NULL,
        reminder_time TEXT NOT NULL,
        target_date TEXT,
        frequency TEXT NOT NULL DEFAULT 'weekdays' CHECK (frequency IN ('weekdays', 'daily', 'once')),
        type TEXT NOT NULL DEFAULT 'lunchbox',
        is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
        last_sent_date TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES authorized_users(user_id) ON DELETE CASCADE
    );`,
    `CREATE TABLE IF NOT EXISTS work_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        date TEXT NOT NULL,
        time TEXT NOT NULL,
        content TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'General',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES authorized_users(user_id) ON DELETE CASCADE
    );`,
    `CREATE TABLE IF NOT EXISTS expenses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        date TEXT NOT NULL,
        amount REAL NOT NULL CHECK (amount > 0),
        category TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'expense' CHECK (type IN ('expense', 'income')),
        currency TEXT NOT NULL DEFAULT 'KHR' CHECK (currency IN ('KHR', 'USD')),
        merchant TEXT,
        note TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES authorized_users(user_id) ON DELETE CASCADE
    );`,
    `CREATE TABLE IF NOT EXISTS processed_updates (
        update_id INTEGER PRIMARY KEY,
        processed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );`,
    `CREATE TABLE IF NOT EXISTS pending_scans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        amount REAL NOT NULL CHECK (amount > 0),
        currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency IN ('USD', 'KHR')),
        category TEXT NOT NULL DEFAULT 'Other',
        type TEXT NOT NULL DEFAULT 'expense' CHECK (type IN ('expense', 'income')),
        merchant TEXT,
        bank TEXT,
        note TEXT,
        date TEXT,
        message_id INTEGER,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES authorized_users(user_id) ON DELETE CASCADE
    );`,
    `CREATE TABLE IF NOT EXISTS chat_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('user', 'model')),
        content TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES authorized_users(user_id) ON DELETE CASCADE
    );`,
    `CREATE TABLE IF NOT EXISTS user_memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'preference',
        fact TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES authorized_users(user_id) ON DELETE CASCADE
    );`,
    `CREATE TABLE IF NOT EXISTS daily_broadcast_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        type TEXT NOT NULL,
        date TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, type, date)
    );`,
    `CREATE TABLE IF NOT EXISTS pending_statements (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        bank TEXT,
        period TEXT,
        currency TEXT DEFAULT 'USD' CHECK (currency IN ('USD', 'KHR')),
        total_inflow REAL DEFAULT 0,
        total_outflow REAL DEFAULT 0,
        transaction_count INTEGER DEFAULT 0,
        transactions_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES authorized_users(user_id) ON DELETE CASCADE
    );`,
    `CREATE TABLE IF NOT EXISTS system_config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );`,
    `CREATE TABLE IF NOT EXISTS debts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        person_name TEXT NOT NULL,
        amount REAL NOT NULL CHECK (amount > 0),
        currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency IN ('USD', 'KHR')),
        note TEXT,
        date TEXT NOT NULL DEFAULT (DATE('now')),
        status TEXT NOT NULL DEFAULT 'unpaid' CHECK (status IN ('unpaid', 'settled')),
        settled_at TEXT,
        expense_id INTEGER,
        repayment_id INTEGER,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES authorized_users(user_id) ON DELETE CASCADE
    );`
];

// Auto-create missing tables and indexes for effortless self-healing
export async function ensureTables(db) {
    if (tablesEnsured || !db) return;
    try {
        if (typeof db.batch === "function") {
            await db.batch(TABLE_SCHEMAS.map(sql => db.prepare(sql)));
        } else {
            for (const sql of TABLE_SCHEMAS) {
                try {
                    await db.prepare(sql).run();
                } catch (e) {
                    console.error("ensureTables sequential error:", e);
                }
            }
        }

        // Schema migrations & missing columns
        const alters = [
            "ALTER TABLE reminders ADD COLUMN target_date TEXT",
            "ALTER TABLE debts ADD COLUMN date TEXT",
            "ALTER TABLE debts ADD COLUMN expense_id INTEGER",
            "ALTER TABLE debts ADD COLUMN repayment_id INTEGER",
            "ALTER TABLE user_settings ADD COLUMN briefing_mode TEXT DEFAULT 'on'",
            "ALTER TABLE expenses ADD COLUMN merchant TEXT",
            "ALTER TABLE expenses ADD COLUMN note TEXT",
            "ALTER TABLE authorized_users ADD COLUMN permissions TEXT NOT NULL DEFAULT 'finance,tasks,reminders,ai_dialog'",
            "CREATE TABLE IF NOT EXISTS system_config (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
            // Clean up redundant duplicate indexes
            "DROP INDEX IF EXISTS idx_work_logs_user_date",
            "DROP INDEX IF EXISTS idx_broadcast_logs_user_date",
            // Optimized query & TTL pruning indexes
            "CREATE INDEX IF NOT EXISTS idx_work_logs_history ON work_logs (user_id, date DESC, id DESC)",
            "CREATE INDEX IF NOT EXISTS idx_processed_updates_at ON processed_updates (processed_at)",
            "CREATE INDEX IF NOT EXISTS idx_pending_scans_created ON pending_scans (created_at)",
            "CREATE INDEX IF NOT EXISTS idx_pending_statements_created ON pending_statements (created_at)",
            "CREATE INDEX IF NOT EXISTS idx_chat_history_created ON chat_history (created_at)",
            "CREATE INDEX IF NOT EXISTS idx_broadcast_logs_date ON daily_broadcast_logs (date)",
            "CREATE INDEX IF NOT EXISTS idx_reminders_cleanup ON reminders (is_active, created_at)",
            "CREATE INDEX IF NOT EXISTS idx_authorized_users_status ON authorized_users (status)",
            "CREATE INDEX IF NOT EXISTS idx_debts_user_status ON debts (user_id, status)"
        ];

        for (const alterSql of alters) {
            try {
                await db.prepare(alterSql).run();
            } catch (_) {}
        }

        try {
            await db.prepare(`
                INSERT OR IGNORE INTO authorized_users (user_id, first_name, role, status, approved_by)
                VALUES ('849550186', 'Boss', 'owner', 'active', 'system')
            `).run();
        } catch (e) {}

        try {
            await db.prepare(`CREATE VIRTUAL TABLE IF NOT EXISTS work_logs_fts USING fts5(user_id UNINDEXED, content, category, date UNINDEXED)`).run();
            await db.prepare(`CREATE VIRTUAL TABLE IF NOT EXISTS expenses_fts USING fts5(user_id UNINDEXED, category, type, currency UNINDEXED, date UNINDEXED)`).run();
            await db.prepare(`CREATE VIRTUAL TABLE IF NOT EXISTS user_memories_fts USING fts5(user_id UNINDEXED, fact, category)`).run();
        } catch (e) {}

        tablesEnsured = true;
    } catch (e) {
        console.error("ensureTables error:", e);
    }
}

export function resetTablesEnsuredForTest() {
    tablesEnsured = false;
}
