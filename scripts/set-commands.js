import fs from "node:fs";
import path from "node:path";

let token = process.env.TELEGRAM_BOT_TOKEN;
let ownerId = process.env.OWNER_ID || process.env.OWNER_TELEGRAM_ID || "849550186";

if (!token) {
    try {
        const devVarsPath = path.resolve(process.cwd(), ".dev.vars");
        if (fs.existsSync(devVarsPath)) {
            const content = fs.readFileSync(devVarsPath, "utf8");
            for (const line of content.split("\n")) {
                const trimmed = line.trim();
                if (trimmed.startsWith("TELEGRAM_BOT_TOKEN=")) {
                    token = trimmed.split("=")[1].trim();
                }
                if (trimmed.startsWith("ALLOWED_USER_IDS=")) {
                    const ids = trimmed.split("=")[1].trim().split(",");
                    if (ids.length > 0 && ids[0]) ownerId = ids[0].trim();
                }
            }
        }
    } catch (_) {}
}

if (!token) {
    console.error("Missing TELEGRAM_BOT_TOKEN. Provide it via env or .dev.vars");
    process.exit(1);
}

export const GUEST_COMMANDS = [
    { command: "hub", description: "🏠 Open Command Center" },
    { command: "search", description: "🌐 Live Google Search Grounding" },
    { command: "today", description: "📊 Today Expenses & Balance" },
    { command: "summary", description: "💳 Monthly Spending Summary" },
    { command: "tasks", description: "📋 Today Completed Tasks" },
    { command: "briefing", description: "🛡️ Morning Briefing & Status" },
    { command: "voice", description: "🎙️ Voice Modes & Settings" },
    { command: "settings", description: "⚙️ Currency & Budget Settings" },
    { command: "help", description: "💡 Quick Guide & Shortcuts" }
];

export const BOSS_COMMANDS = [
    { command: "hub", description: "🏠 Open Command Center" },
    { command: "users", description: "👥 Manage Guests & Approvals" },
    { command: "search", description: "🌐 Live Google Search Grounding" },
    { command: "today", description: "📊 Today Expenses & Balance" },
    { command: "summary", description: "💳 Monthly Spending Summary" },
    { command: "tasks", description: "📋 Today Completed Tasks" },
    { command: "briefing", description: "🛡️ Morning Briefing & Status" },
    { command: "voice", description: "🎙️ Voice Modes & Settings" },
    { command: "settings", description: "⚙️ Currency & Budget Settings" },
    { command: "help", description: "💡 Quick Guide & Shortcuts" }
];

async function setCommands(commands, scope, label) {
    const res = await fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ commands, scope })
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
        console.error(`Failed to set commands for ${label}:`, data);
        process.exit(1);
    }
    console.log(`✅ Set commands for ${label} (${commands.length} commands)`);
}

// 1. Default scope
await setCommands(GUEST_COMMANDS, { type: "default" }, "Default Scope (Guests)");

// 2. All private chats scope
await setCommands(GUEST_COMMANDS, { type: "all_private_chats" }, "All Private Chats (Guests)");

// 3. Boss chat scope
if (ownerId) {
    await setCommands(BOSS_COMMANDS, { type: "chat", chat_id: Number(ownerId) || ownerId }, `Boss Chat Scope (${ownerId})`);
}

console.log("🎉 Scoped Telegram Bot commands configured successfully!");
