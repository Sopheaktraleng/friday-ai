export const TIME_ZONE = "Asia/Phnom_Penh";
export const EXCHANGE_RATE = 4000; // 1 USD = 4000 KHR

// High-speed conversational models on Groq for routine chat & quick tasks (~200ms)
export const GROQ_MODELS = [
    "qwen/qwen3.8-27b",
    "openai/gpt-oss-120b",
    "openai/gpt-oss-20b"
];

// Flagship deep reasoning models on Groq for /think queries (maximum accuracy MoE)
export const GROQ_THINKING_MODELS = [
    "openai/gpt-oss-120b",
    "qwen/qwen3.8-27b"
];

// OpenRouter free tier models for deep thought and reasoning
export const OPENROUTER_MODELS = [
    "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
    "google/gemma-4-31b-it:free",
    "liquid/lfm-2.5-2.6b:free"
];

// Fast & reliable models for general routine questions (~800ms - 1s)
export const GEMINI_FAST_MODELS = [
    "gemini-flash-lite-latest", // Sub-second conversational speed (~800ms) & high free-tier quota
    "gemini-3.5-flash-lite",    // Ultra-low latency speed fallback (~700ms)
    "gemini-3.1-flash-lite"     // Lite fallback
];

// Flagship high-intelligence reasoning models for /think queries (free tier accessible)
export const GEMINI_THINKING_MODELS = [
    "gemini-3.6-flash",         // Primary flagship reasoning engine (600+ thought tokens)
    "gemini-3.5-flash"          // Deep intelligence reasoning
];

// Unified production models
export const GEMINI_MODELS = [
    ...GEMINI_FAST_MODELS,
    ...GEMINI_THINKING_MODELS,
    "gemini-flash-latest"       // Production latest alias
];

export const QUICK_EXPENSE_CATS = [
    { name: "Food", icon: "🍔" },
    { name: "Coffee", icon: "☕" },
    { name: "Transport", icon: "🚗" },
    { name: "Taxi", icon: "🚕" },
    { name: "Shopping", icon: "🛍️" },
    { name: "Bills", icon: "💡" },
    { name: "Rent", icon: "🏠" },
    { name: "Other", icon: "✨" }
];

export const QUICK_INCOME_CATS = [
    { name: "Salary", icon: "💼" },
    { name: "Freelance", icon: "💻" },
    { name: "Gift", icon: "🎁" },
    { name: "Investment", icon: "📈" },
    { name: "Bonus", icon: "💰" },
    { name: "Other", icon: "✨" }
];

// Primary Owner Telegram User ID
export const OWNER_USER_ID = "849550186";

// Authorized Telegram User IDs (Personal assistant mode: owner + approved users)
export const DEFAULT_ALLOWED_USERS = ["849550186"];

/**
 * Checks whether a given Telegram user ID is the system Owner (Boss).
 */
export function isOwner(userId, env = {}) {
    if (!userId) return false;
    const ownerId = String(env?.OWNER_ID || env?.OWNER_TELEGRAM_ID || OWNER_USER_ID).trim();
    return String(userId).trim() === ownerId;
}

/**
 * Resolves the list of authorized Telegram user IDs.
 * Checks env.ALLOWED_USER_IDS or env.OWNER_TELEGRAM_ID / env.OWNER_ID,
 * and falls back to DEFAULT_ALLOWED_USERS in production.
 */
export function getAllowedUserIds(env = {}) {
    const raw = env?.ALLOWED_USER_IDS || env?.OWNER_TELEGRAM_ID || env?.OWNER_ID;
    if (typeof raw === "string" && raw.trim()) {
        return raw.split(",").map(id => id.trim()).filter(Boolean);
    }
    if (Array.isArray(raw) && raw.length > 0) {
        return raw.map(String).map(s => s.trim()).filter(Boolean);
    }
    // In automated test environments without explicit ALLOWED_USER_IDS, permit mock users unless specified
    if (typeof process !== "undefined" && process.env?.NODE_ENV === "test") {
        return null;
    }
    return DEFAULT_ALLOWED_USERS;
}

/**
 * Synchronous static authorization check (env / owner).
 */
export function isUserAuthorized(userId, env = {}) {
    if (!userId) return false;
    if (isOwner(userId, env)) return true;
    const allowed = getAllowedUserIds(env);
    if (!allowed) return true; // unrestricted test mode
    return allowed.includes(String(userId).trim());
}

/**
 * Asynchronous dynamic authorization check against environment whitelist and D1 authorized_users.
 */
export async function isUserAuthorizedAsync(db, userId, env = {}) {
    if (!userId) return false;
    if (isOwner(userId, env)) return true;
    if (isUserAuthorized(userId, env)) return true;
    if (db) {
        try {
            const row = await db
                .prepare("SELECT status FROM authorized_users WHERE user_id = ?")
                .bind(String(userId))
                .first();
            return row?.status === "active";
        } catch (_) {}
    }
    return false;
}

export const DEFAULT_GUEST_PERMISSIONS = "finance,tasks,reminders,ai_dialog";

/**
 * Checks whether a user has permission to use a specific feature module.
 * Boss (Owner) always has permission for all features.
 * Guests check their comma-separated permissions string.
 */
export function hasUserPermission(feature, userOrPermissions, isBoss = false) {
    if (isBoss) return true;
    if (!feature) return true;

    let permStr = "";
    if (typeof userOrPermissions === "string") {
        permStr = userOrPermissions;
    } else if (userOrPermissions && typeof userOrPermissions === "object") {
        if (userOrPermissions.role === "owner") return true;
        permStr = userOrPermissions.permissions || "";
    }

    if (!permStr || !permStr.trim()) {
        permStr = DEFAULT_GUEST_PERMISSIONS;
    }

    const parts = permStr.split(",").map(p => p.trim().toLowerCase());
    return parts.includes(feature.toLowerCase()) || parts.includes("all") || parts.includes("*");
}

/**
 * Returns a human-friendly list of active feature icons/names for a user.
 */
export function formatUserPermissionsSummary(permissionsStr) {
    const raw = (permissionsStr || DEFAULT_GUEST_PERMISSIONS).split(",").map(p => p.trim().toLowerCase());
    const features = [];
    if (raw.includes("finance")) features.push("💳 Finance");
    if (raw.includes("tasks")) features.push("📋 Tasks");
    if (raw.includes("reminders")) features.push("⏰ Reminders");
    if (raw.includes("ai_dialog")) features.push("🤖 AI Dialog");
    return features.length > 0 ? features.join(" | ") : "🚫 No Features Enabled";
}
