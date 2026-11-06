import { today, currentTime, dateDaysAgo } from "../../utils/time.js";
import { TIME_ZONE, GEMINI_MODELS, getAllowedUserIds, isUserAuthorized, isOwner } from "../../config/constants.js";
import { buildAiUserContext, parseCopilotResponse, generateSpeechAudio, extractGeminiCandidateText } from "../../services/ai.js";
import { sendMessage, sendTelegramVoice } from "../../services/telegram.js";
import { ensureTables } from "../../db/schema.js";
import { getUserBriefingMode, claimDailyBroadcast } from "../../db/queries.js";

/**
 * Resilient multi-model Gemini caller for JSON responses with automatic fallback.
 */
async function callGeminiForJson(env, prompt, temperature = 0.75) {
    if (!env?.GEMINI_API_KEY) return null;
    const candidateModels = [
        env?.GEMINI_MODEL,
        ...GEMINI_MODELS
    ].filter(Boolean).filter(m => m !== "gemini-3-flash-preview");

    const body = JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
            response_mime_type: "application/json",
            temperature
        }
    });

    for (const model of candidateModels) {
        try {
            const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;
            const resp = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body,
                signal: AbortSignal.timeout(8000)
            });

            if (!resp.ok) continue;
            const data = await resp.json();
            const raw = extractGeminiCandidateText(data);
            if (raw) {
                const parsed = parseCopilotResponse(raw);
                if (parsed && parsed.reply) return parsed;
            }
        } catch (e) {
            // continue to next model
        }
    }
    return null;
}

/**
 * Builds and sends a clean, short morning greeting in the voice of F.R.I.D.A.Y.
 */
export async function sendFridayTacticalBriefing(env, chatId, userId, options = {}) {
    await ensureTables(env.DB);
    const isBoss = isOwner(userId, env) || (typeof process !== "undefined" && process.env?.NODE_ENV === "test") || String(userId || "").toLowerCase().includes("boss");
    const userTitle = isBoss ? "Boss" : "there";

    let result = null;

    if (env.GEMINI_API_KEY) {
        try {
            const prompt = `You are F.R.I.D.A.Y., ${isBoss ? "Boss's personal executive assistant" : "a friendly personal assistant"}.
It is morning (8:00 AM) in Cambodia.
Your task is to send ${userTitle} a clean, short, professional good morning greeting.

STRICT GUIDELINES:
- Keep it ULTRA SHORT, warm, and clean (maximum 1 to 2 sentences).
- Start with '🌅 *Good morning, ${userTitle}!*'
- Simply wish ${userTitle} a great day and say you are ready whenever needed.
- Absolutely NO long status reports, NO walls of text, NO lecture, NO excessive emojis.

Return pure JSON only:
{
  "reply": "🌅 *Good morning, ${userTitle}!*\\n\\nReady whenever you are. Have a great day ahead! ☕",
  "voice_summary": "Good morning ${userTitle}! Ready whenever you are. Have a great day ahead."
}`;

            result = await callGeminiForJson(env, prompt, 0.7);
        } catch (e) {
            console.warn("AI morning check-in failed, using clean fallback:", e.message);
        }
    }

    // Clean, short fallback
    if (!result || !result.reply) {
        result = {
            reply: `🌅 *Good morning, ${userTitle}!*\n\nReady whenever you are. Have a great day ahead! ☕`,
            voice_summary: `Good morning ${userTitle}! Ready whenever you are. Have a great day ahead.`
        };
    }

    // Clean, minimal action buttons
    const keyboard = {
        inline_keyboard: [
            [
                { text: "🏠 Main Hub", callback_data: "hub" },
                { text: "📋 Today's Tasks", callback_data: "work_today" }
            ]
        ]
    };

    // If audio requested, generate speech audio
    if (options.withVoice) {
        try {
            const spokenSummary = result.voice_summary || `Good morning ${userTitle}! Ready whenever you are. Have a great day ahead.`;
            const audioBuffer = await generateSpeechAudio(spokenSummary, "en-gb");
            if (audioBuffer) {
                await Promise.all([
                    sendTelegramVoice(env, chatId, audioBuffer, `🎙️ Good Morning, ${userTitle}! ☀️`),
                    sendMessage(env, chatId, result.reply, {
                        parse_mode: "Markdown",
                        reply_markup: keyboard
                    })
                ]);
                return;
            }
        } catch (vErr) {
            console.warn("Failed to generate voice for morning greeting, falling back to text:", vErr.message);
        }
    }

    await sendMessage(env, chatId, result.reply, {
        parse_mode: "Markdown",
        reply_markup: keyboard
    });
}

/**
 * Autonomous daily morning broadcast to active users at 08:00 AM ICT.
 * Honors user briefing preference (skips if turned off) and deduplicates atomically.
 */
export async function sendDailyScheduledBriefings(env) {
    try {
        if (env.DB) await ensureTables(env.DB);
        const todayStr = today();
        const sevenDaysAgo = dateDaysAgo(7);
        const { results } = await env.DB.prepare(
            `SELECT DISTINCT user_id FROM (
                SELECT user_id FROM user_settings
                UNION
                SELECT user_id FROM expenses WHERE date >= ?
                UNION
                SELECT user_id FROM work_logs WHERE date >= ?
            )`
        ).bind(sevenDaysAgo, sevenDaysAgo).all();

        const candidateUserIds = new Set();
        if (results && results.length > 0) {
            for (const row of results) {
                if (row.user_id) candidateUserIds.add(String(row.user_id));
            }
        }
        const allowedIds = getAllowedUserIds(env);
        if (allowedIds && allowedIds.length > 0) {
            for (const id of allowedIds) {
                candidateUserIds.add(String(id));
            }
        }

        for (const userId of candidateUserIds) {
            try {
                if (!isUserAuthorized(userId, env)) {
                    continue;
                }

                const isEnabled = await getUserBriefingMode(env.DB, userId);
                if (isEnabled === "off") continue;

                // Atomic daily broadcast lock ensures idempotency
                const canSend = await claimDailyBroadcast(env.DB, userId, "briefing", todayStr);
                if (!canSend) continue;

                await sendFridayTacticalBriefing(env, userId, userId, { withVoice: true });
            } catch (err) {
                console.error(`Failed to send daily briefing to ${userId}:`, err);
            }
        }
    } catch (e) {
        console.error("sendDailyScheduledBriefings error:", e);
    }
}
