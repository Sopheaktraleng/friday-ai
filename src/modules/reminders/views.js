import { ensureTables } from "../../db/schema.js";
import { safeEditOrSendMessage } from "../../services/telegram.js";
import { cleanMd } from "../../utils/format.js";
import { today } from "../../utils/time.js";

export async function sendPromptAddReminder(env, chatId, messageId = null) {
    const text = [
        `⏱️ *Quick Timers*`,
        ``,
        `_Tap a preset below, or type / voice your reminder anytime:_`,
        `• \`remind in 20m Check oven\``,
        `• \`remind on 30th at 8am Take the ice\``,
        `• \`remind 17:30 Bring lunch box\``
    ].join("\n");

    const buttons = [
        [
            { text: "⏱️ 15 Mins", callback_data: "remind_quick_timer:15" },
            { text: "⏱️ 30 Mins", callback_data: "remind_quick_timer:30" }
        ],
        [
            { text: "⏱️ 1 Hour", callback_data: "remind_quick_timer:60" },
            { text: "⏱️ 2 Hours", callback_data: "remind_quick_timer:120" }
        ],
        [
            { text: "‹ Back to Reminders", callback_data: "reminders" }
        ]
    ];

    await safeEditOrSendMessage(env, chatId, messageId, text, {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: buttons
        }
    });
}

export async function sendRemindersMenu(env, chatId, userId, messageId = null) {
    await ensureTables(env.DB);
    const { results } = await env.DB.prepare(
        "SELECT id, title, reminder_time, target_date, frequency, type, is_active FROM reminders WHERE user_id = ? ORDER BY id ASC"
    ).bind(userId).all();

    const reminders = results || [];
    const todayStr = today();

    const customReminders = reminders.filter(
        r => r.type !== "standup" && r.type !== "expense_log"
    );
    const activeCustom = customReminders.filter(
        r => r.is_active && (!r.target_date || r.target_date >= todayStr)
    ).length;

    const totalActive = activeCustom;
    const activeSummary = totalActive === 1 ? "1 active alert" : `${totalActive} active alerts`;

    let customTextList = "";
    if (customReminders.length === 0) {
        customTextList = `_No personal reminders scheduled._`;
    } else {
        customTextList = customReminders.map((r) => {
            const isPast = r.target_date && r.target_date < todayStr;
            const isCompleted = isPast && !r.is_active;
            const status = isCompleted ? "🏁" : (r.is_active ? "🔔" : "🔕");
            let timeLabel = `\`${r.reminder_time}\``;
            if (r.target_date) {
                const parts = r.target_date.split("-");
                if (parts.length === 3) {
                    const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
                    const mIdx = parseInt(parts[1], 10) - 1;
                    const monthStr = monthNames[mIdx] || parts[1];
                    const dayLabel = r.target_date === todayStr ? "Today" : `${monthStr} ${parseInt(parts[2], 10)}`;
                    timeLabel = `\`${dayLabel} • ${r.reminder_time}\``;
                }
            }
            const freq = isCompleted ? "Completed" : (r.target_date ? "Once" : r.frequency === "weekdays" ? "Mon–Fri" : r.frequency === "daily" ? "Daily" : "Once");
            return `• ${status} ${timeLabel}  ${cleanMd(r.title)} _(${freq})_`;
        }).join("\n");
    }

    const text = [
        `⏰ *Reminders & Alerts*`,
        `📅 \`Phnom Penh (UTC+7) • ${activeSummary}\``,
        ``,
        `*Your Reminders:*`,
        customTextList,
        ``,
        `_Tap below to manage, or type: \`remind in 20m <task>\`_`
    ].join("\n");

    const buttons = [
        [
            { text: "⏱️ Quick Timers", callback_data: "remind_prompt_add" },
            { text: "🎯 Focus Sprint", callback_data: "remind_focus" }
        ]
    ];

    for (const r of customReminders.slice(0, 5)) {
        const isPast = r.target_date && r.target_date < todayStr;
        const isCompleted = isPast && !r.is_active;
        const statusIcon = isCompleted ? "🏁" : (r.is_active ? "🔔" : "🔕");
        let datePrefix = "";
        if (r.target_date) {
            const parts = r.target_date.split("-");
            if (parts.length === 3) {
                const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
                const mIdx = parseInt(parts[1], 10) - 1;
                const monthStr = monthNames[mIdx] || parts[1];
                const dayLabel = r.target_date === todayStr ? "Today" : `${monthStr} ${parseInt(parts[2], 10)}`;
                datePrefix = `${dayLabel} • `;
            }
        }
        const cleanTitle = r.title.length > 20 ? r.title.slice(0, 19) + "…" : r.title;
        const doneBadge = isCompleted ? " (Done)" : "";
        buttons.push([
            { text: `${statusIcon} ${datePrefix}${r.reminder_time} ${cleanTitle}${doneBadge}`, callback_data: `remind_time_menu:${r.id}` }
        ]);
    }

    buttons.push([
        { text: "🏠 Main Hub", callback_data: "hub" }
    ]);

    await safeEditOrSendMessage(env, chatId, messageId, text, {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: buttons
        }
    });
}

export async function sendFocusMenu(env, chatId, messageId = null) {
    const text = [
        `🎯 *Focus & Deep Work Sprints*`,
        ``,
        `_Lock in with a distraction-free timer:_`,
        `• 🍅 *25m Focus* — High-energy sprint block`,
        `• ⚡ *50m Deep Work* — Heavy problem-solving block`,
        `• ☕ *10m Break* — Quick rest & recharge`,
        ``,
        `_When your sprint finishes, Friday will check in so you can 1-tap record what you accomplished to Today's Tasks!_`
    ].join("\n");

    const buttons = [
        [
            { text: "🍅 25m Focus", callback_data: "focus_start:25:🍅 25m Focus Sprint" },
            { text: "⚡ 50m Deep Work", callback_data: "focus_start:50:⚡ 50m Deep Work" }
        ],
        [
            { text: "☕ 10m Break", callback_data: "focus_start:10:☕ 10m Quick Break" }
        ],
        [
            { text: "‹ Back to Reminders", callback_data: "reminders" }
        ]
    ];

    await safeEditOrSendMessage(env, chatId, messageId, text, {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: buttons
        }
    });
}

export async function sendRoutinesMenu(env, chatId, userId, messageId = null) {
    await ensureTables(env.DB);
    const { results } = await env.DB.prepare(
        "SELECT id, title, reminder_time, frequency, type, is_active FROM reminders WHERE user_id = ? ORDER BY id ASC"
    ).bind(userId).all();

    const reminders = results || [];
    const standup = reminders.find(r => r.type === "standup");
    const standupActive = standup ? Boolean(standup.is_active) : false;

    const lunchbox = reminders.find(r => r.type === "lunchbox");
    const lunchboxActive = lunchbox ? Boolean(lunchbox.is_active) : false;

    const expense = reminders.find(r => r.type === "expense_log");
    const expenseActive = expense ? Boolean(expense.is_active) : false;

    const text = [
        `⚙️ *Daily Routine Automations*`,
        `📅 \`Phnom Penh (UTC+7)\``,
        ``,
        `• ${lunchboxActive ? "🔔" : "🔕"} \`17:30\`  Departure Alarm _(Mon–Fri)_`,
        `• ${expenseActive ? "🔔" : "🔕"} \`21:00\`  Daily Expense Check _(Daily)_`,
        `• ${standupActive ? "🔔" : "🔕"} \`09:00\`  Morning Standup _(Mon–Fri)_`,
        ``,
        `_Tap below to toggle any routine on or off:_`
    ].join("\n");

    const buttons = [
        [
            { 
                text: `${lunchboxActive ? "🔔" : "🔕"} Departure 17:30`, 
                callback_data: "remind_add_lunchbox_routines" 
            },
            { 
                text: `${expenseActive ? "🔔" : "🔕"} Expense Check 21:00`, 
                callback_data: "toggle_expense_reminder_routines" 
            }
        ],
        [
            { 
                text: `${standupActive ? "🔔" : "🔕"} Standup 09:00`, 
                callback_data: "remind_add_standup_routines" 
            }
        ],
        [
            { text: "‹ Back to Reminders", callback_data: "reminders" }
        ]
    ];

    await safeEditOrSendMessage(env, chatId, messageId, text, {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: buttons
        }
    });
}

export async function sendLunchboxMenu(env, chatId, userId, messageId = null) {
    return sendRemindersMenu(env, chatId, userId, messageId);
}

export async function sendReminderTimeMenu(env, chatId, userId, reminderId, messageId = null) {
    await ensureTables(env.DB);
    const r = await env.DB.prepare(
        "SELECT id, title, reminder_time, target_date, frequency, is_active FROM reminders WHERE id = ? AND user_id = ?"
    ).bind(reminderId, userId).first();

    if (!r) {
        return sendRemindersMenu(env, chatId, userId, messageId);
    }

    const todayStr = today();
    const isPast = r.target_date && r.target_date < todayStr;
    const isCompleted = isPast && !r.is_active;

    const freqLabel = isCompleted ? "Completed" : (r.target_date ? "Once" : r.frequency === "weekdays" ? "Mon–Fri" : r.frequency === "daily" ? "Daily" : "Once");
    const statusLabel = isCompleted ? "🏁 Completed" : (r.is_active ? "🔔 Active" : "🔕 Paused");
    let dateLine = "";
    if (r.target_date) {
        const parts = r.target_date.split("-");
        if (parts.length === 3) {
            const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
            const mIdx = parseInt(parts[1], 10) - 1;
            const monthStr = monthNames[mIdx] || parts[1];
            const dayLabel = r.target_date === todayStr ? "Today" : `${monthStr} ${parseInt(parts[2], 10)}`;
            dateLine = `• *Date:*   \`${dayLabel}\`\n`;
        }
    }

    const text = [
        `⚙️ *Manage Reminder*`,
        ``,
        `*${cleanMd(r.title)}*`,
        `• *Status:* ${statusLabel}`,
        dateLine + `• *Time:*   \`${r.reminder_time}\` _(${freqLabel})_`,
        ``,
        isCompleted
            ? `_This reminder was completed on ${r.target_date}. Tap below to re-arm for today or delete._`
            : `_Tap below to toggle or delete:_`
    ].join("\n");

    const toggleText = isPast
        ? "🔔 Re-arm for Today"
        : (r.is_active ? "🔕 Pause Alert" : "🔔 Turn On");

    const buttons = [
        [
            { text: toggleText, callback_data: `remind_toggle_inspect:${r.id}` },
            { text: "🗑️ Delete", callback_data: `remind_del:${r.id}` }
        ],
        [
            { text: "‹ Back to Reminders", callback_data: "reminders" }
        ]
    ];

    await safeEditOrSendMessage(env, chatId, messageId, text, {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: buttons }
    });
}
