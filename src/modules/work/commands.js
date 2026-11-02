import { today, currentTime, monthPrefix, monthLabel } from "../../utils/time.js";
import { capitalize, getWorkCategoryIcon } from "../../utils/format.js";
import { ensureTables } from "../../db/schema.js";
import { sendMessage, safeEditOrSendMessage } from "../../services/telegram.js";

/**
 * Clean, frictionless task logger.
 * Responds with a minimal, zero-button confirmation.
 */
export async function handleAddWorkLogCommand(env, chatId, userId, text, from) {
    await ensureTables(env.DB);
    const content = text.replace(/^\/\w+\s*/, "").trim();
    if (!content) {
        await sendMessage(
            env,
            chatId,
            `💡 *Usage:* \`/done <task description>\`\n\n` +
            `Examples:\n` +
            `• \`/done Fixed checkout payment failure bug\`\n` +
            `• \`/done Completed API migration for auth service\`\n` +
            `• \`/done Sprint planning meeting with design team\`\n` +
            `• \`/done [Bugfix] Fixed mobile crash on iOS 18\``,
            { parse_mode: "Markdown" }
        );
        return;
    }

    let category = "General";
    let finalContent = content;

    const bracketMatch = content.match(/^\[(.*?)\]\s*(.*)$/);
    if (bracketMatch) {
        category = capitalize(bracketMatch[1].trim());
        finalContent = bracketMatch[2].trim() || content;
    } else {
        const lower = content.toLowerCase();
        if (lower.includes("fix") || lower.includes("bug") || lower.includes("issue") || lower.includes("resolve") || lower.includes("patch") || lower.includes("error") || lower.includes("#bug")) {
            category = "Bugfix";
        } else if (lower.includes("meet") || lower.includes("sync") || lower.includes("call") || lower.includes("standup") || lower.includes("discuss") || lower.includes("1-on-1") || lower.includes("1:1")) {
            category = "Meeting";
        } else if (lower.includes("deploy") || lower.includes("release") || lower.includes("publish") || lower.includes("ship") || lower.includes("#release")) {
            category = "Release";
        } else if (lower.includes("doc") || lower.includes("report") || lower.includes("write") || lower.includes("spec") || lower.includes("manual")) {
            category = "Documentation";
        } else if (lower.includes("test") || lower.includes("qa") || lower.includes("verify") || lower.includes("audit")) {
            category = "Testing";
        } else if (lower.includes("design") || lower.includes("ui") || lower.includes("ux") || lower.includes("figma") || lower.includes("mockup")) {
            category = "Design";
        } else if (lower.includes("code") || lower.includes("api") || lower.includes("feature") || lower.includes("develop") || lower.includes("implement") || lower.includes("refactor") || lower.includes("build") || lower.includes("service") || lower.includes("#dev")) {
            category = "Development";
        }
    }

    const todayDate = today();
    const timeStr = currentTime();

    await env.DB.prepare(
        "INSERT INTO work_logs (user_id, date, time, content, category) VALUES (?, ?, ?, ?, ?)"
    ).bind(userId, todayDate, timeStr, finalContent, category).run();

    const monthStr = monthPrefix();
    const countRow = await env.DB.prepare(
        "SELECT COUNT(*) as count FROM work_logs WHERE user_id = ? AND date LIKE ?"
    ).bind(userId, `${monthStr}%`).first();
    const monthCount = countRow?.count || 1;

    const icon = getWorkCategoryIcon(category);
    const message = [
        `✅ *Task Logged:* ${finalContent}`,
        `🏆 *${monthCount} tasks* this month (${icon} ${category})`
    ].join("\n");

    // Clean, zero-button confirmation to eliminate chat clutter
    await sendMessage(env, chatId, message, {
        parse_mode: "Markdown"
    });
}

/**
 * Clean viewer for today's completed tasks.
 */
export async function handleListTodayTasksCommand(env, chatId, userId, messageId = null) {
    await ensureTables(env.DB);
    const todayDate = today();
    const monthStr = monthPrefix();

    const [todayRows, monthRow] = await Promise.all([
        env.DB.prepare(
            "SELECT id, time, content, category FROM work_logs WHERE user_id = ? AND date = ? ORDER BY id ASC"
        ).bind(userId, todayDate).all(),
        env.DB.prepare(
            "SELECT COUNT(*) as count FROM work_logs WHERE user_id = ? AND date LIKE ?"
        ).bind(userId, `${monthStr}%`).first()
    ]);

    const tasks = todayRows.results || [];
    const monthCount = monthRow?.count || 0;

    let taskList = "";
    if (tasks.length === 0) {
        taskList = "_No tasks logged today yet._\n\n_💡 Log anytime:_ `done <task description>`";
    } else {
        taskList = tasks.map((t, idx) => {
            const icon = getWorkCategoryIcon(t.category);
            return `${idx + 1}. \`${t.time}\` ${icon} ${t.content}`;
        }).join("\n");
    }

    const text = [
        `📋 *Today's Completed Tasks*`,
        `🗓️ \`${todayDate}\``,
        ``,
        taskList,
        ``,
        `🏆 *${monthCount} tasks* logged this month (${monthLabel()})`
    ].join("\n");

    const inline_keyboard = [];
    if (tasks.length > 0) {
        const lastTask = tasks[tasks.length - 1];
        inline_keyboard.push([
            { text: "🗑️ Delete Last Task", callback_data: `work_del:${lastTask.id}` }
        ]);
    }
    inline_keyboard.push([
        { text: "📜 History", callback_data: "tasks_history:1" },
        { text: "📊 Month Stats", callback_data: "tasks_month_stats" }
    ]);
    inline_keyboard.push([
        { text: "🏠 Main Hub", callback_data: "hub" }
    ]);

    await safeEditOrSendMessage(env, chatId, messageId, text, {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard
        }
    });
}

/**
 * Paginated task history viewer.
 */
export async function handleListTasksHistoryCommand(env, chatId, userId, page = 1, messageId = null) {
    await ensureTables(env.DB);
    const pageSize = 8;
    const offset = (Math.max(1, page) - 1) * pageSize;

    const [totalRow, rows] = await Promise.all([
        env.DB.prepare("SELECT COUNT(*) as count FROM work_logs WHERE user_id = ?").bind(userId).first(),
        env.DB.prepare(
            "SELECT id, date, time, content, category FROM work_logs WHERE user_id = ? ORDER BY date DESC, time DESC, id DESC LIMIT ? OFFSET ?"
        ).bind(userId, pageSize, offset).all()
    ]);

    const totalCount = totalRow?.count || 0;
    const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
    const tasks = rows.results || [];

    if (totalCount === 0 || tasks.length === 0) {
        const emptyText = [
            `📜 *Task History*`,
            ``,
            `_No tasks recorded in your history yet._`,
            ``,
            `_💡 Log anytime:_ \`done <task description>\``
        ].join("\n");

        const emptyKeyboard = [
            [
                { text: "📋 Today's Tasks", callback_data: "tasks_today" },
                { text: "🏠 Main Hub", callback_data: "hub" }
            ]
        ];

        await safeEditOrSendMessage(env, chatId, messageId, emptyText, {
            parse_mode: "Markdown",
            reply_markup: { inline_keyboard: emptyKeyboard }
        });
        return;
    }

    let currentDate = null;
    const lines = [];

    for (const t of tasks) {
        if (t.date !== currentDate) {
            currentDate = t.date;
            lines.push(``, `📅 *${currentDate}*`);
        }
        const icon = getWorkCategoryIcon(t.category);
        lines.push(`• \`${t.time}\` ${icon} ${t.content}`);
    }

    const text = [
        `📜 *Task History* (Page ${page}/${totalPages})`,
        `● *Total Accomplishments:* \`${totalCount} tasks\``,
        ...lines
    ].join("\n");

    const inline_keyboard = [];

    const paginationRow = [];
    if (page > 1) {
        paginationRow.push({ text: "‹ Newer", callback_data: `tasks_history:${page - 1}` });
    }
    if (page < totalPages) {
        paginationRow.push({ text: "Older ›", callback_data: `tasks_history:${page + 1}` });
    }
    if (paginationRow.length > 0) {
        inline_keyboard.push(paginationRow);
    }

    inline_keyboard.push([
        { text: "📋 Today's Tasks", callback_data: "tasks_today" },
        { text: "📊 Month Stats", callback_data: "tasks_month_stats" }
    ]);
    inline_keyboard.push([
        { text: "🏠 Main Hub", callback_data: "hub" }
    ]);

    await safeEditOrSendMessage(env, chatId, messageId, text, {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard }
    });
}

/**
 * Monthly task analytics and category breakdown.
 */
export async function handleTasksMonthStatsCommand(env, chatId, userId, messageId = null) {
    await ensureTables(env.DB);
    const monthStr = monthPrefix();
    const curMonthLabel = monthLabel();

    const [totalRow, activeDaysRow, categoryRows] = await Promise.all([
        env.DB.prepare(
            "SELECT COUNT(*) as count FROM work_logs WHERE user_id = ? AND date LIKE ?"
        ).bind(userId, `${monthStr}%`).first(),
        env.DB.prepare(
            "SELECT COUNT(DISTINCT date) as days FROM work_logs WHERE user_id = ? AND date LIKE ?"
        ).bind(userId, `${monthStr}%`).first(),
        env.DB.prepare(
            "SELECT category, COUNT(*) as count FROM work_logs WHERE user_id = ? AND date LIKE ? GROUP BY category ORDER BY count DESC"
        ).bind(userId, `${monthStr}%`).all()
    ]);

    const totalCount = totalRow?.count || 0;
    const activeDays = activeDaysRow?.days || 0;
    const velocity = activeDays > 0 ? (totalCount / activeDays).toFixed(1) : "0.0";

    const cats = categoryRows.results || [];
    let breakdownLines = [];
    if (cats.length === 0) {
        breakdownLines.push(`_No tasks logged this month yet._`);
    } else {
        breakdownLines = cats.map(c => {
            const icon = getWorkCategoryIcon(c.category);
            const pct = totalCount > 0 ? Math.round((c.count / totalCount) * 100) : 0;
            return `${icon} *${c.category}:* \`${c.count}\` _(${pct}%)_`;
        });
    }

    const text = [
        `📊 *Task Insights* (${curMonthLabel})`,
        ``,
        `● *Total Logged:*  \`${totalCount} tasks\``,
        `● *Active Days:*   \`${activeDays} workdays\``,
        `● *Daily Pace:*    \`${velocity} tasks/day\``,
        ``,
        `*Category Breakdown:*`,
        ...breakdownLines
    ].join("\n");

    const inline_keyboard = [
        [
            { text: "📋 Today's Tasks", callback_data: "tasks_today" },
            { text: "📜 History", callback_data: "tasks_history:1" }
        ],
        [
            { text: "🏠 Main Hub", callback_data: "hub" }
        ]
    ];

    await safeEditOrSendMessage(env, chatId, messageId, text, {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard }
    });
}
