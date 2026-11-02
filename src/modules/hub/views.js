import { TIME_ZONE, isOwner, OWNER_USER_ID, hasUserPermission, formatUserPermissionsSummary, DEFAULT_GUEST_PERMISSIONS } from "../../config/constants.js";
import { ensureTables } from "../../db/schema.js";
import { getDisplayCurrency, getFinancialSummary, getUserVoiceMode, listAuthorizedUsers, getAuthorizedUser } from "../../db/queries.js";
import { monthPrefix, monthLabel } from "../../utils/time.js";
import { formatAmount, cleanMd } from "../../utils/format.js";
import { safeEditOrSendMessage } from "../../services/telegram.js";

export async function sendMainHub(env, chatId, userId, from, origin, messageId = null) {
    await ensureTables(env.DB);
    const rawUsername = from?.first_name || from?.username || "Friend";
    const cleanUsername = rawUsername.replace(/[_*`[\]]/g, " ").trim() || "Friend";
    const monthStr = monthPrefix();

    const isUserOwner = isOwner(userId, env);
    const userTitle = isUserOwner ? "Boss" : cleanUsername;

    let guestUser = null;
    let permissionsStr = DEFAULT_GUEST_PERMISSIONS;
    if (!isUserOwner && env.DB) {
        guestUser = await getAuthorizedUser(env.DB, userId);
        permissionsStr = guestUser?.permissions || DEFAULT_GUEST_PERMISSIONS;
    }

    const hasFinance = isUserOwner || hasUserPermission("finance", permissionsStr, isUserOwner);
    const hasTasks = isUserOwner || hasUserPermission("tasks", permissionsStr, isUserOwner);
    const hasReminders = isUserOwner || hasUserPermission("reminders", permissionsStr, isUserOwner);

    // Fetch only permitted hub data concurrently in parallel roundtrip
    const [
        displayCurrency,
        todaySummary,
        allSummary,
        workRow,
        allReminders
    ] = await Promise.all([
        getDisplayCurrency(env.DB, userId),
        hasFinance ? getFinancialSummary(env.DB, userId, "today") : Promise.resolve(null),
        hasFinance ? getFinancialSummary(env.DB, userId, "all") : Promise.resolve(null),
        (hasTasks && env.DB?.prepare) ? env.DB.prepare("SELECT COUNT(*) as count FROM work_logs WHERE user_id = ? AND date LIKE ?").bind(userId, `${monthStr}%`).first() : Promise.resolve(null),
        (hasReminders && env.DB?.prepare) ? env.DB.prepare("SELECT id, title, reminder_time, is_active FROM reminders WHERE user_id = ? ORDER BY id ASC").bind(userId).all() : Promise.resolve(null)
    ]);

    const workCount = workRow?.count || 0;
    const remList = allReminders?.results || [];
    const activeRems = remList.filter(r => r.is_active);

    const netBalance = allSummary?.balanceKhr || 0;
    const isNegative = netBalance < 0;
    const balanceStr = formatAmount(netBalance, displayCurrency);
    const todayStr = formatAmount(todaySummary?.totalExpenseInKhr || 0, displayCurrency);

    const now = new Date();
    const ppHour = parseInt(
        new Intl.DateTimeFormat("en-US", {
            timeZone: TIME_ZONE,
            hour: "numeric",
            hour12: false
        }).format(now),
        10
    );

    let quote = `Everything is running smoothly on my end, ${userTitle}.`;
    if (ppHour >= 5 && ppHour < 12) {
        quote = isUserOwner ? "Good morning, Boss. Fresh start today—everything is lined up." : `Good morning, ${userTitle}. Ready whenever you are.`;
    } else if (ppHour >= 12 && ppHour < 17) {
        quote = isUserOwner ? "Good afternoon, Boss. Keeping everything steady and on track." : `Good afternoon, ${userTitle}. How can I help you today?`;
    } else if (ppHour >= 17 && ppHour < 22) {
        quote = isUserOwner ? "Good evening, Boss. Winding down for the day—here's where we stand." : `Good evening, ${userTitle}. Hope you had a great day.`;
    } else {
        quote = isUserOwner ? "Quiet night, Boss. Standing by whenever you need me." : `Quiet night, ${userTitle}. Standing by if you need anything.`;
    }

    const sign = netBalance > 0 ? "+" : "";
    const balanceColorNote = isNegative ? "in the red" : "in the green";
    const agendaLine = activeRems.length > 0
        ? `\`${activeRems.length} active\` _(${activeRems[0].reminder_time} ${activeRems[0].title.slice(0, 20)})_`
        : `_All clear_`;

    const textLines = [
        `⚡ *F.R.I.D.A.Y.*`,
        `*"${quote}"*`
    ];

    const metricLines = [];
    if (hasFinance) {
        metricLines.push(`💳 *Ledger:* \`${sign}${balanceStr}\` _(${balanceColorNote})_`);
        metricLines.push(`💸 *Spent Today:* \`${todayStr}\``);
    }
    if (hasTasks) {
        metricLines.push(`📋 *Work Done:* \`${workCount} tasks\` _(${monthLabel()})_`);
    }
    if (hasReminders) {
        metricLines.push(`⏰ *Alarms:* ${agendaLine}`);
    }

    if (metricLines.length > 0) {
        textLines.push(``, ...metricLines);
    }

    textLines.push(``, `_Standing by whenever you're ready._`);
    const text = textLines.join("\n");

    const hubButtons = [];
    const row1 = [];
    if (hasFinance) {
        row1.push({ text: "💳 Finance Hub", callback_data: "finance_hub" });
    }
    if (hasTasks) {
        row1.push({ text: "📋 Today's Tasks", callback_data: "tasks_today" });
    }
    if (row1.length > 0) hubButtons.push(row1);

    const row2 = [];
    if (hasReminders) {
        row2.push({ text: "⏰ Reminders", callback_data: "reminders" });
    }
    row2.push({ text: "💡 Help & Guide", callback_data: "help" });
    hubButtons.push(row2);

    if (isUserOwner) {
        hubButtons.push([
            { text: "⚙️ Settings", callback_data: "settings" },
            { text: "👥 User Access", callback_data: "manage_users" }
        ]);
    } else {
        hubButtons.push([
            { text: "⚙️ Settings", callback_data: "settings" }
        ]);
    }

    await safeEditOrSendMessage(env, chatId, messageId, text, {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: hubButtons
        }
    });
}

export async function sendMainMenu(env, chatId, userId, from, origin, messageId = null) {
    return sendMainHub(env, chatId, userId, from, origin, messageId);
}

export async function sendSettingsMenu(env, chatId, userId, messageId = null) {
    const displayCurrency = await getDisplayCurrency(env.DB, userId);
    const voiceMode = await getUserVoiceMode(env.DB, userId);
    const settingsRow = await env.DB.prepare(
        "SELECT monthly_budget FROM user_settings WHERE user_id = ?"
    ).bind(userId).first();

    const budgetKhr = settingsRow?.monthly_budget || 0;
    const budgetStr = budgetKhr > 0 ? formatAmount(budgetKhr, displayCurrency) : "Off (No limit)";
    const currencyPill = displayCurrency === "USD" ? "💱 Currency: USD" : "💱 Currency: KHR";
    const voicePill = voiceMode === "on" ? "🎙️ Voice: ON" : "🎙️ Voice: OFF";

    const text = [
        `⚙️ *System Settings*`,
        ``,
        `• *Display Currency:* \`${displayCurrency} (${displayCurrency === "USD" ? "$" : "៛"})\``,
        `• *Monthly Budget:*   \`${budgetStr}\``,
        `• *Auto-Voice Mode:*  \`${voiceMode === "on" ? "Enabled (Always Speak)" : "Disabled (Text)"}\``,
        ``,
        `_Tap any setting below to toggle or reconfigure:_`
    ].join("\n");

    const keyboard = [
        [
            { text: currencyPill, callback_data: "toggle_currency" },
            { text: voicePill, callback_data: "toggle_voice_mode" }
        ],
        [
            { text: "🎯 Set Budget", callback_data: "budget_help" },
            { text: "📥 Export CSV", callback_data: "export_csv" }
        ],
        [
            { text: "🗑️ Reset Data", callback_data: "clear_data" },
            { text: "🏠 Main Hub", callback_data: "hub" }
        ]
    ];

    await safeEditOrSendMessage(env, chatId, messageId, text, {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: keyboard
        }
    });
}

export async function sendUserManagementMenu(env, chatId, userId, messageId = null) {
    await ensureTables(env.DB);
    const users = await listAuthorizedUsers(env.DB);
    const owner = users.find(u => u.role === "owner") || { user_id: OWNER_USER_ID, first_name: "Boss" };
    const guests = users.filter(u => u.role !== "owner");
    const activeGuests = guests.filter(g => g.status === "active");
    const pendingGuests = guests.filter(g => g.status === "pending");

    const textLines = [
        `👥 *F.R.I.D.A.Y. • User Access Matrix*`,
        ``,
        `👑 *Owner:* ${cleanMd(owner.first_name || "Boss")} (\`${owner.user_id}\`)`,
        ``
    ];

    if (activeGuests.length > 0) {
        textLines.push(`🟢 *Active Guests (${activeGuests.length}):*`);
        for (const g of activeGuests) {
            const uName = g.username ? ` (@${g.username})` : "";
            const permSummary = formatUserPermissionsSummary(g.permissions);
            textLines.push(`• *${cleanMd(g.first_name || "Guest")}*${uName} — \`${g.user_id}\``);
            textLines.push(`  └ _Features:_ \`${permSummary}\``);
        }
        textLines.push("");
    } else {
        textLines.push(`_No active guests yet._\n`);
    }

    if (pendingGuests.length > 0) {
        textLines.push(`⏳ *Pending Approvals (${pendingGuests.length}):*`);
        for (const p of pendingGuests) {
            const uName = p.username ? ` (@${p.username})` : "";
            textLines.push(`• *${cleanMd(p.first_name || "Guest")}*${uName} — \`${p.user_id}\``);
        }
        textLines.push("");
    }

    textLines.push(`_Tap ⚙️ Manage to configure feature access (e.g. Finance-only) or revoke access:_`);

    const keyboard = [];

    // Pending approvals
    for (const p of pendingGuests) {
        keyboard.push([
            { text: `✅ Approve ${p.first_name || p.user_id}`, callback_data: `approve_user:${p.user_id}` },
            { text: `❌ Deny`, callback_data: `deny_user:${p.user_id}` }
        ]);
    }

    // Active guests: button to manage permissions & revoke
    for (const g of activeGuests) {
        const name = g.first_name || g.user_id;
        keyboard.push([
            { text: `⚙️ Manage ${name}`, callback_data: `manage_guest:${g.user_id}` },
            { text: `🚫 Revoke`, callback_data: `revoke_user:${g.user_id}` }
        ]);
    }

    keyboard.push([
        { text: "🔄 Refresh", callback_data: "manage_users" },
        { text: "⚙️ Settings", callback_data: "settings" }
    ]);
    keyboard.push([
        { text: "🏠 Main Hub", callback_data: "hub" }
    ]);

    await safeEditOrSendMessage(env, chatId, messageId, textLines.join("\n"), {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: keyboard }
    });
}

export async function sendGuestPermissionsMenu(env, chatId, userId, targetGuestId, messageId = null) {
    await ensureTables(env.DB);
    const guest = await getAuthorizedUser(env.DB, targetGuestId);
    if (!guest) {
        await safeEditOrSendMessage(env, chatId, messageId, "⚠️ User not found in database.", {
            reply_markup: {
                inline_keyboard: [[{ text: "‹ Back to Users", callback_data: "manage_users" }]]
            }
        });
        return;
    }

    const rawPerms = (guest.permissions || DEFAULT_GUEST_PERMISSIONS).split(",").map(p => p.trim().toLowerCase());
    const hasFinance = rawPerms.includes("finance");
    const hasTasks = rawPerms.includes("tasks");
    const hasReminders = rawPerms.includes("reminders");
    const hasAiDialog = rawPerms.includes("ai_dialog");

    const text = [
        `👤 *Guest Feature Manager*`,
        ``,
        `• *User:* ${cleanMd(guest.first_name || "Guest")}${guest.username ? ` (@${guest.username})` : ""}`,
        `• *ID:* \`${guest.user_id}\``,
        `• *Status:* \`${guest.status}\` | *Role:* \`${guest.role}\``,
        ``,
        `🛡️ *Feature Access Matrix:*`,
        `• 💳 Finance Hub & Logging: ${hasFinance ? "🟢 *Enabled*" : "🔴 *Disabled*"}`,
        `• 📋 Tasks & Work Logging: ${hasTasks ? "🟢 *Enabled*" : "🔴 *Disabled*"}`,
        `• ⏰ Reminders & Alarms: ${hasReminders ? "🟢 *Enabled*" : "🔴 *Disabled*"}`,
        `• 🤖 AI Dialog & Web Search: ${hasAiDialog ? "🟢 *Enabled*" : "🔴 *Disabled*"}`,
        ``,
        `_Tap any feature below to toggle on or off:_`
    ].join("\n");

    const keyboard = [
        [
            { text: `💳 Finance: ${hasFinance ? "✅ ON" : "❌ OFF"}`, callback_data: `toggle_perm:${guest.user_id}:finance` },
            { text: `📋 Tasks: ${hasTasks ? "✅ ON" : "❌ OFF"}`, callback_data: `toggle_perm:${guest.user_id}:tasks` }
        ],
        [
            { text: `⏰ Reminders: ${hasReminders ? "✅ ON" : "❌ OFF"}`, callback_data: `toggle_perm:${guest.user_id}:reminders` },
            { text: `🤖 AI Dialog: ${hasAiDialog ? "✅ ON" : "❌ OFF"}`, callback_data: `toggle_perm:${guest.user_id}:ai_dialog` }
        ],
        [
            { text: `🚫 Revoke User`, callback_data: `revoke_user:${guest.user_id}` },
            { text: "‹ Back to Users", callback_data: "manage_users" }
        ],
        [
            { text: "🏠 Main Hub", callback_data: "hub" }
        ]
    ];

    await safeEditOrSendMessage(env, chatId, messageId, text, {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: keyboard }
    });
}

export async function sendHelpMessage(env, chatId, messageId = null, userId = null) {
    const effectiveUserId = userId || chatId;
    const isBoss = isOwner(effectiveUserId, env);

    let guestUser = null;
    let permissionsStr = DEFAULT_GUEST_PERMISSIONS;
    if (!isBoss && env.DB) {
        guestUser = await getAuthorizedUser(env.DB, effectiveUserId);
        permissionsStr = guestUser?.permissions || DEFAULT_GUEST_PERMISSIONS;
    }

    const hasFinance = isBoss || hasUserPermission("finance", permissionsStr, isBoss);
    const hasTasks = isBoss || hasUserPermission("tasks", permissionsStr, isBoss);
    const hasReminders = isBoss || hasUserPermission("reminders", permissionsStr, isBoss);
    const hasAiDialog = isBoss || hasUserPermission("ai_dialog", permissionsStr, isBoss);

    const assistantFeatures = [];
    if (hasAiDialog) {
        assistantFeatures.push(
            `🤖 *F.R.I.D.A.Y. Tactical Assistant*`,
            `• \`/search <query>\` — Live Google Search grounding (weather, crypto, news, scores)`
        );
        if (isBoss) {
            assistantFeatures.push(`• \`/users\` — Dynamic user access matrix & guest approval (Boss only)`);
        }
        assistantFeatures.push(
            `• \`/remember <fact>\` — Teach Friday personal preferences & habits`,
            `• \`/memory\` — Inspect Friday's long-term memory matrix`,
            `• \`/reset\` — Clear active multi-turn conversation context`,
            `• *Two-Way Voice:* Send a voice note, Friday speaks back!`,
            `• *Vision & Error Debugger:* Send code screenshots or error photos`,
            `• \`/ask <question>\` — e.g. _"Friday, can I afford a $60 dinner?"_`
        );
    }

    const sections = [
        `💡 *Help & Shortcuts Guide*`,
        ``
    ];

    const fastShortcuts = [];
    if (hasFinance) {
        fastShortcuts.push(
            `• *Expense:* \`5 coffee\` or \`12000 lunch\` or \`3.50 grab\``,
            `• *Income:* \`+500 salary\`, \`40$ income\`, or \`earned $50 freelance\``
        );
    }
    if (hasTasks) {
        fastShortcuts.push(`• *Work Task:* \`done Fixed payment timeout bug\``);
    }
    if (hasReminders) {
        fastShortcuts.push(`• *Reminder:* \`remind 17:30 Daily sync\` or \`remind in 25m Review PR\``);
    }
    if (hasFinance || hasTasks) {
        fastShortcuts.push(`• *Undo Mistake:* \`/undo\` or type \`undo\` to remove the last entry`);
    }

    if (fastShortcuts.length > 0) {
        sections.push(
            `⚡ *Fast Natural Logging (No Commands Needed)*`,
            ...fastShortcuts,
            ``
        );
    }

    if (hasAiDialog || hasFinance) {
        const voiceAndScan = [];
        if (hasAiDialog) voiceAndScan.push(`• *Voice Note:* Hold 🎙️ and speak in English or Khmer (*អក្សរខ្មែរ*)`);
        if (hasFinance) voiceAndScan.push(`• *Receipt OCR:* Send ABA Bank, Bakong, KHQR, or receipt photos`);
        sections.push(
            `🎙️ *Hands-Free Voice & Slip Scanner*`,
            ...voiceAndScan,
            ``
        );
    }

    if (hasTasks) {
        sections.push(
            `💼 *Work & Task Logging*`,
            `• \`done <task>\` — Log completed task (e.g. \`done Fixed login issue\`)`,
            `• \`/tasks\` — View today's completed accomplishments`,
            ``
        );
    }

    if (hasFinance) {
        sections.push(
            `💳 *Finance & Cashflow*`,
            `• \`/today\` — Today's transactions & balance`,
            `• \`/summary\` — Monthly spending breakdown & analytics`,
            `• \`/settings\` — Currency toggle (USD / KHR) & monthly budget`,
            ``
        );
    }

    if (assistantFeatures.length > 0) {
        sections.push(...assistantFeatures, ``);
    }

    sections.push(`_Tap any button below to jump directly to that workspace:_`);
    const text = sections.join("\n");

    const helpButtons = [];
    const row1 = [];
    if (hasFinance) {
        row1.push({ text: "💳 Finance Hub", callback_data: "finance_hub" });
    }
    if (hasTasks) {
        row1.push({ text: "📋 Today's Tasks", callback_data: "tasks_today" });
    }
    if (row1.length > 0) helpButtons.push(row1);

    const row2 = [];
    if (hasReminders) {
        row2.push({ text: "⏰ Reminders", callback_data: "reminders" });
    }
    row2.push({ text: "🏠 Main Hub", callback_data: "hub" });
    helpButtons.push(row2);

    await safeEditOrSendMessage(env, chatId, messageId, text, {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: helpButtons
        }
    });
}
