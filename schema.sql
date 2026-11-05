-- ============================================================================
-- F.R.I.D.A.Y. DATABASE SCHEMA (Cloudflare D1 / SQLite)
-- Production Clean DB Architecture with Domain Constraints & Optimized Indexes
-- ============================================================================

-- 1. ACCESS CONTROL & USER PERMISSIONS
CREATE TABLE IF NOT EXISTS authorized_users (
    user_id TEXT PRIMARY KEY,
    username TEXT,
    first_name TEXT,
    role TEXT NOT NULL DEFAULT 'guest' CHECK (role IN ('owner', 'guest')),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'pending', 'revoked')),
    permissions TEXT NOT NULL DEFAULT 'finance,tasks,reminders,ai_dialog',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    approved_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_authorized_users_status
ON authorized_users (status);

INSERT OR IGNORE INTO authorized_users (user_id, first_name, role, status, approved_by)
VALUES ('849550186', 'Boss', 'owner', 'active', 'system');

-- 2. USER SETTINGS
CREATE TABLE IF NOT EXISTS user_settings (
    user_id TEXT PRIMARY KEY,
    display_currency TEXT NOT NULL DEFAULT 'KHR' CHECK (display_currency IN ('KHR', 'USD')),
    monthly_budget REAL NOT NULL DEFAULT 0 CHECK (monthly_budget >= 0),
    voice_mode TEXT NOT NULL DEFAULT 'off' CHECK (voice_mode IN ('on', 'off')),
    briefing_mode TEXT NOT NULL DEFAULT 'on' CHECK (briefing_mode IN ('on', 'off')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES authorized_users(user_id) ON DELETE CASCADE
);

-- 3. FINANCIAL TRANSACTIONS & LEDGERS
CREATE TABLE IF NOT EXISTS expenses (
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
);

CREATE INDEX IF NOT EXISTS idx_expenses_user_date
ON expenses (user_id, date);

CREATE INDEX IF NOT EXISTS idx_expenses_user_created
ON expenses (user_id, created_at);

-- 4. ALARMS & REMINDERS
CREATE TABLE IF NOT EXISTS reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    title TEXT NOT NULL,
    reminder_time TEXT NOT NULL, -- HH:mm 24-hour format in Asia/Phnom_Penh
    target_date TEXT, -- YYYY-MM-DD for one-off scheduled alerts
    frequency TEXT NOT NULL DEFAULT 'weekdays' CHECK (frequency IN ('weekdays', 'daily', 'once')),
    type TEXT NOT NULL DEFAULT 'lunchbox',
    is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    last_sent_date TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES authorized_users(user_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_reminders_user
ON reminders (user_id);

CREATE INDEX IF NOT EXISTS idx_reminders_active
ON reminders (is_active, reminder_time);

CREATE INDEX IF NOT EXISTS idx_reminders_cleanup
ON reminders (is_active, created_at);

-- 5. WORK JOURNAL & STANDUPS
CREATE TABLE IF NOT EXISTS work_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    date TEXT NOT NULL,
    time TEXT NOT NULL,
    content TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'General',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES authorized_users(user_id) ON DELETE CASCADE
);

-- Compound index covers both (user_id, date) filters and pagination history
CREATE INDEX IF NOT EXISTS idx_work_logs_history
ON work_logs (user_id, date DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_work_logs_user_created
ON work_logs (user_id, created_at);

-- 6. SYSTEM DEDUPLICATION & LOGS
CREATE TABLE IF NOT EXISTS processed_updates (
    update_id INTEGER PRIMARY KEY,
    processed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_processed_updates_at
ON processed_updates (processed_at);

CREATE TABLE IF NOT EXISTS daily_broadcast_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    type TEXT NOT NULL, -- 'wakeup', 'briefing', 'weekly_report'
    date TEXT NOT NULL, -- YYYY-MM-DD
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, type, date) -- SQLite automatically creates unique index for this constraint
);

CREATE INDEX IF NOT EXISTS idx_broadcast_logs_date
ON daily_broadcast_logs (date);

-- 7. OCR & STAGING BUFFERS
CREATE TABLE IF NOT EXISTS pending_scans (
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
);

CREATE INDEX IF NOT EXISTS idx_pending_scans_user
ON pending_scans (user_id);

CREATE INDEX IF NOT EXISTS idx_pending_scans_created
ON pending_scans (created_at);

CREATE TABLE IF NOT EXISTS pending_statements (
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
);

CREATE INDEX IF NOT EXISTS idx_pending_statements_user
ON pending_statements (user_id);

CREATE INDEX IF NOT EXISTS idx_pending_statements_created
ON pending_statements (created_at);

-- 8. CONVERSATION CONTEXT & LONG-TERM MEMORY
CREATE TABLE IF NOT EXISTS chat_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user', 'model')),
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES authorized_users(user_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_chat_history_user
ON chat_history (user_id, created_at);

CREATE INDEX IF NOT EXISTS idx_chat_history_created
ON chat_history (created_at);

CREATE TABLE IF NOT EXISTS user_memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'preference', -- 'identity', 'work', 'preference', 'goal', 'rule'
    fact TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES authorized_users(user_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_user_memories_user
ON user_memories (user_id);

-- 9. FTS5 FULL-TEXT SEARCH VIRTUAL TABLES FOR SEMANTIC RAG
CREATE VIRTUAL TABLE IF NOT EXISTS work_logs_fts USING fts5(
    user_id UNINDEXED,
    content,
    category,
    date UNINDEXED
);

CREATE VIRTUAL TABLE IF NOT EXISTS expenses_fts USING fts5(
    user_id UNINDEXED,
    category,
    type,
    currency UNINDEXED,
    date UNINDEXED
);

CREATE VIRTUAL TABLE IF NOT EXISTS user_memories_fts USING fts5(
    user_id UNINDEXED,
    fact,
    category
);

-- Triggers for FTS5 Synchronization
CREATE TRIGGER IF NOT EXISTS trg_work_logs_ai AFTER INSERT ON work_logs BEGIN
    INSERT INTO work_logs_fts(rowid, user_id, content, category, date)
    VALUES (new.id, new.user_id, new.content, new.category, new.date);
END;

CREATE TRIGGER IF NOT EXISTS trg_work_logs_ad AFTER DELETE ON work_logs BEGIN
    DELETE FROM work_logs_fts WHERE rowid = old.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_work_logs_au AFTER UPDATE ON work_logs BEGIN
    UPDATE work_logs_fts SET content = new.content, category = new.category, date = new.date WHERE rowid = new.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_user_memories_ai AFTER INSERT ON user_memories BEGIN
    INSERT INTO user_memories_fts(rowid, user_id, fact, category)
    VALUES (new.id, new.user_id, new.fact, new.category);
END;

CREATE TRIGGER IF NOT EXISTS trg_user_memories_ad AFTER DELETE ON user_memories BEGIN
    DELETE FROM user_memories_fts WHERE rowid = old.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_user_memories_au AFTER UPDATE ON user_memories BEGIN
    UPDATE user_memories_fts SET fact = new.fact, category = new.category WHERE rowid = new.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_expenses_ai AFTER INSERT ON expenses BEGIN
    INSERT INTO expenses_fts(rowid, user_id, category, type, currency, date)
    VALUES (new.id, new.user_id, new.category, new.type, new.currency, new.date);
END;

CREATE TRIGGER IF NOT EXISTS trg_expenses_ad AFTER DELETE ON expenses BEGIN
    DELETE FROM expenses_fts WHERE rowid = old.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_expenses_au AFTER UPDATE ON expenses BEGIN
    UPDATE expenses_fts SET category = new.category, type = new.type, currency = new.currency, date = new.date WHERE rowid = new.id;
END;
