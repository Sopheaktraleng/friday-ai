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
 * Synchronize Telegram Bot Commands with role-based scoping:
 * - Default / All Private Chats scope: guests only see public commands (excludes /users)
 * - Boss chat scope: includes admin commands (/users)
 */
export async function syncBotCommands(env) {
    const ownerId = String(env?.OWNER_ID || env?.OWNER_TELEGRAM_ID || "849550186").trim();

    const guestCommands = [
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

    const bossCommands = [
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

    await telegram(env, "setMyCommands", {
        commands: guestCommands,
        scope: { type: "default" }
    });

    await telegram(env, "setMyCommands", {
        commands: guestCommands,
        scope: { type: "all_private_chats" }
    });

    if (ownerId) {
        await telegram(env, "setMyCommands", {
            commands: bossCommands,
            scope: { type: "chat", chat_id: Number(ownerId) || ownerId }
        });
    }

    return {
        guestCommandsCount: guestCommands.length,
        bossCommandsCount: bossCommands.length,
        ownerId
    };
}
