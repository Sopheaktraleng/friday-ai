import { isOwner, hasUserPermission } from "../config/constants.js";

export async function telegram(env, method, payload) {
    const response = await fetch(
        `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        }
    );

    if (!response.ok) {
        const detail = await response.text();
        throw new Error(`Telegram ${method} failed: ${response.status} ${detail}`);
    }

    return response.json();
}

export async function sendMessage(env, chatId, text, extra = {}) {
    try {
        return await telegram(env, "sendMessage", {
            chat_id: chatId,
            text,
            ...extra,
        });
    } catch (err) {
        if (extra.parse_mode) {
            console.warn("Telegram sendMessage failed with parse_mode, retrying as plain text:", err.message);
            const { parse_mode, ...fallbackExtra } = extra;
            const cleanText = text.replace(/[*`_]/g, "");
            return await telegram(env, "sendMessage", {
                chat_id: chatId,
                text: cleanText,
                ...fallbackExtra,
            });
        }
        throw err;
    }
}

export async function answerCallback(env, callbackQueryId, extra = {}) {
    if (!callbackQueryId) return null;
    try {
        return await telegram(env, "answerCallbackQuery", {
            callback_query_id: callbackQueryId,
            ...extra,
        });
    } catch (err) {
        console.warn("answerCallback warning (non-fatal):", err.message);
        return null;
    }
}

export async function safeEditOrSendMessage(env, chatId, messageId, text, extra = {}) {
    if (messageId) {
        try {
            return await telegram(env, "editMessageText", {
                chat_id: chatId,
                message_id: messageId,
                text,
                ...extra
            });
        } catch (err) {
            console.warn("editMessageText failed with error:", err.message);
            if (extra.parse_mode) {
                try {
                    const { parse_mode, ...fallbackExtra } = extra;
                    const cleanText = text.replace(/[*`_]/g, "");
                    return await telegram(env, "editMessageText", {
                        chat_id: chatId,
                        message_id: messageId,
                        text: cleanText,
                        ...fallbackExtra
                    });
                } catch (err2) {
                    console.warn("editMessageText plain fallback failed:", err2.message);
                }
            }
        }
    }

    return await sendMessage(env, chatId, text, extra);
}

export async function sendTelegramDocument(env, chatId, file, caption = "") {
    const formData = new FormData();
    formData.append("chat_id", chatId);
    formData.append("document", file);
    if (caption) {
        formData.append("caption", caption);
    }

    const response = await fetch(
        `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendDocument`,
        {
            method: "POST",
            body: formData,
        }
    );

    if (!response.ok) {
        const detail = await response.text();
        throw new Error(`Telegram sendDocument failed with status ${response.status}: ${detail}`);
    }

    return response.json();
}

export async function sendTelegramVoice(env, chatId, audioBuffer, caption = "", extra = {}) {
    const formData = new FormData();
    formData.append("chat_id", chatId);
    const blob = new Blob([audioBuffer], { type: "audio/mpeg" });
    formData.append("voice", blob, "voice.mp3");
    if (caption) {
        formData.append("caption", caption.slice(0, 1024));
    }
    if (extra.parse_mode) {
        formData.append("parse_mode", extra.parse_mode);
    }
    if (extra.reply_markup) {
        formData.append("reply_markup", typeof extra.reply_markup === "string" ? extra.reply_markup : JSON.stringify(extra.reply_markup));
    }

    let response = await fetch(
        `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendVoice`,
        {
            method: "POST",
            body: formData,
        }
    );

    // Fallback to sendAudio if Telegram server rejects voice mime format
    if (!response.ok) {
        const audioFormData = new FormData();
        audioFormData.append("chat_id", chatId);
        audioFormData.append("audio", blob, "friday_response.mp3");
        audioFormData.append("title", "Voice Note");
        audioFormData.append("performer", "F.R.I.D.A.Y.");
        if (caption) audioFormData.append("caption", caption.slice(0, 1024));
        if (extra.parse_mode) audioFormData.append("parse_mode", extra.parse_mode);
        if (extra.reply_markup) {
            audioFormData.append("reply_markup", typeof extra.reply_markup === "string" ? extra.reply_markup : JSON.stringify(extra.reply_markup));
        }

        response = await fetch(
            `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendAudio`,
            {
                method: "POST",
                body: audioFormData,
            }
        );

        if (!response.ok) {
            const detail = await response.text();
            throw new Error(`Telegram voice delivery failed: ${response.status} ${detail}`);
        }
    }

    return response.json();
}

export async function sendChatAction(env, chatId, action = "typing") {
    try {
        return await telegram(env, "sendChatAction", { chat_id: chatId, action });
    } catch (_) {
        return null;
    }
}

/**
 * Generates the appropriate Telegram Bot Command list according to enabled feature permissions.
 */
export function getUserCommandList(permissions, isBoss = false) {
    const hasPerm = (feat) => isBoss || hasUserPermission(feat, permissions, isBoss);

    const commands = [
        { command: "hub", description: "🏠 Open Command Center" }
    ];

    if (isBoss) {
        commands.push({ command: "users", description: "👥 Manage Guests & Approvals" });
    }

    if (hasPerm("ai_dialog")) {
        commands.push({ command: "search", description: "🌐 Live Google Search Grounding" });
    }

    if (hasPerm("finance")) {
        commands.push(
            { command: "today", description: "📊 Today Expenses & Balance" },
            { command: "summary", description: "💳 Monthly Spending Summary" }
        );
    }

    if (hasPerm("tasks")) {
        commands.push({ command: "tasks", description: "📋 Today Completed Tasks" });
    }

    if (hasPerm("ai_dialog")) {
        commands.push({ command: "voice", description: "🎙️ Voice Modes & Settings" });
    }

    commands.push(
        { command: "settings", description: "⚙️ Currency & Budget Settings" },
        { command: "help", description: "💡 Quick Guide & Shortcuts" }
    );

    return commands;
}

/**
 * Synchronize Telegram Bot commands specifically scoped for an individual user chat.
 * Dynamically includes only the commands corresponding to their enabled features.
 */
export async function syncUserBotCommands(env, userId, permissions, role = "guest") {
    if (!userId || !env?.TELEGRAM_BOT_TOKEN) return false;
    const isBoss = role === "owner" || isOwner(userId, env);
    const commands = getUserCommandList(permissions, isBoss);

    try {
        await telegram(env, "setMyCommands", {
            commands,
            scope: { type: "chat", chat_id: Number(userId) || userId }
        });
        return true;
    } catch (e) {
        console.warn(`Failed to sync commands for user ${userId}:`, e.message);
        return false;
    }
}

/**
 * Synchronize Telegram Bot Commands with role-based and user-specific scoping:
 * - Default / All Private Chats scope: guests only see public commands (excludes /users)
 * - Individual Active Users: dynamically scoped to their specific enabled features
 * - Boss chat scope: includes admin commands (/users) and all features
 */
export async function syncBotCommands(env) {
    const ownerId = String(env?.OWNER_ID || env?.OWNER_TELEGRAM_ID || "849550186").trim();

    const fallbackGuestCommands = getUserCommandList("finance,tasks,reminders,ai_dialog", false);
    const bossCommands = getUserCommandList("all", true);

    await telegram(env, "setMyCommands", {
        commands: fallbackGuestCommands,
        scope: { type: "default" }
    });

    await telegram(env, "setMyCommands", {
        commands: fallbackGuestCommands,
        scope: { type: "all_private_chats" }
    });

    if (ownerId) {
        await telegram(env, "setMyCommands", {
            commands: bossCommands,
            scope: { type: "chat", chat_id: Number(ownerId) || ownerId }
        });
    }

    // Sync each active user individually from DB if available
    if (env?.DB) {
        try {
            const { results } = await env.DB.prepare(
                "SELECT user_id, role, permissions FROM authorized_users WHERE status = 'active'"
            ).all();
            if (results && results.length > 0) {
                for (const u of results) {
                    await syncUserBotCommands(env, u.user_id, u.permissions, u.role);
                }
            }
        } catch (_) {}
    }

    return {
        guestCommandsCount: fallbackGuestCommands.length,
        bossCommandsCount: bossCommands.length,
        ownerId
    };
}
