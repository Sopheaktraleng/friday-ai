import { ensureTables } from "../../db/schema.js";
import {
    addDebt,
    getDebtById,
    getPendingDebts,
    settleDebt,
    deleteDebt,
    getDisplayCurrency,
    addExpenseRecord,
    deleteExpenseById
} from "../../db/queries.js";
import { getExchangeRateSync } from "../../services/exchange_rate.js";
import { formatMoney, capitalize, cleanMd } from "../../utils/format.js";
import { sendMessage, safeEditOrSendMessage, answerCallback } from "../../services/telegram.js";
import { today, dateDaysAgo, TIME_ZONE } from "../../utils/time.js";

const MONTH_MAP = Object.freeze({
    jan: 1, january: 1,
    feb: 2, february: 2,
    mar: 3, march: 3,
    apr: 4, april: 4,
    may: 5,
    jun: 6, june: 6,
    jul: 7, july: 7,
    aug: 8, august: 8,
    sep: 9, sept: 9, september: 9,
    oct: 10, october: 10,
    nov: 11, november: 11,
    dec: 12, december: 12
});

function isValidDate(year, month, day) {
    if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
    if (month < 1 || month > 12 || day < 1 || day > 31 || year < 2000 || year > 2100) return false;
    const d = new Date(Date.UTC(year, month - 1, day));
    return d.getUTCFullYear() === year && (d.getUTCMonth() + 1) === month && d.getUTCDate() === day;
}

function formatIso(year, month, day) {
    if (!isValidDate(year, month, day)) return null;
    const y = String(year).padStart(4, "0");
    const m = String(month).padStart(2, "0");
    const d = String(day).padStart(2, "0");
    return `${y}-${m}-${d}`;
}

/**
 * Extracts date (e.g. "1st nov", "yesterday", "2026-11-01") and removes it from text,
 * returning the structured date and remaining cleaned note context (or null).
 */
export function parseDateAndNote(str) {
    if (!str || typeof str !== "string") return { date: null, note: null };
    let text = str.trim();
    let foundDate = null;
    const currentYear = parseInt(today().slice(0, 4), 10);

    // 1. Relative: yesterday / today
    const relRegex = /\b(?:(?:at|on|dated|since|from)\s+)?(yesterday|today)\b/i;
    const relMatch = text.match(relRegex);
    if (relMatch) {
        if (relMatch[1].toLowerCase() === "yesterday") {
            foundDate = dateDaysAgo(1);
        } else {
            foundDate = today();
        }
        text = text.replace(relMatch[0], " ").trim();
    }

    // 2. ISO: YYYY-MM-DD or YYYY/MM/DD
    if (!foundDate) {
        const isoRegex = /\b(?:(?:at|on|dated|since|from)\s+)?([0-9]{4})[-/]([0-9]{1,2})[-/]([0-9]{1,2})\b/i;
        const isoMatch = text.match(isoRegex);
        if (isoMatch) {
            const y = parseInt(isoMatch[1], 10);
            const m = parseInt(isoMatch[2], 10);
            const d = parseInt(isoMatch[3], 10);
            const iso = formatIso(y, m, d);
            if (iso) {
                foundDate = iso;
                text = text.replace(isoMatch[0], " ").trim();
            }
        }
    }

    // 2b. Standard DD/MM/YYYY or DD-MM-YYYY
    if (!foundDate) {
        const dmyRegex = /\b(?:(?:at|on|dated|since|from)\s+)?([0-9]{1,2})[-/]([0-9]{1,2})[-/]([0-9]{4})\b/i;
        const dmyMatch = text.match(dmyRegex);
        if (dmyMatch) {
            const d = parseInt(dmyMatch[1], 10);
            const m = parseInt(dmyMatch[2], 10);
            const y = parseInt(dmyMatch[3], 10);
            const iso = formatIso(y, m, d);
            if (iso) {
                foundDate = iso;
                text = text.replace(dmyMatch[0], " ").trim();
            }
        }
    }

    // 2c. Day/Month (current year with preposition): e.g. "on 1/11", "at 01-11"
    if (!foundDate) {
        const dmSlashRegex = /\b(?:at|on|dated|since|from)\s+([0-9]{1,2})[-/]([0-9]{1,2})\b/i;
        const dmSlashMatch = text.match(dmSlashRegex);
        if (dmSlashMatch) {
            const d = parseInt(dmSlashMatch[1], 10);
            const m = parseInt(dmSlashMatch[2], 10);
            const iso = formatIso(currentYear, m, d);
            if (iso) {
                foundDate = iso;
                text = text.replace(dmSlashMatch[0], " ").trim();
            }
        }
    }

    // 3. Day + Month: e.g. "at 1st nov", "1 nov", "23rd oct 2026", "1st of november"
    if (!foundDate) {
        const dayMonthRegex = /\b(?:(?:at|on|dated|since|from)\s+)?([0-9]{1,2})(?:st|nd|rd|th)?(?:\s+of)?\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?:\s+([0-9]{2,4}))?\b/i;
        const dmMatch = text.match(dayMonthRegex);
        if (dmMatch) {
            const d = parseInt(dmMatch[1], 10);
            const mKey = dmMatch[2].toLowerCase();
            const m = MONTH_MAP[mKey];
            let y = dmMatch[3] ? parseInt(dmMatch[3], 10) : currentYear;
            if (y < 100) y += 2000;
            if (m) {
                const iso = formatIso(y, m, d);
                if (iso) {
                    foundDate = iso;
                    text = text.replace(dmMatch[0], " ").trim();
                }
            }
        }
    }

    // 4. Month + Day: e.g. "nov 1st", "nov 1", "november 1 2026"
    if (!foundDate) {
        const monthDayRegex = /\b(?:(?:at|on|dated|since|from)\s+)?(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+([0-9]{1,2})(?:st|nd|rd|th)?(?:\s+([0-9]{2,4}))?\b/i;
        const mdMatch = text.match(monthDayRegex);
        if (mdMatch) {
            const mKey = mdMatch[1].toLowerCase();
            const m = MONTH_MAP[mKey];
            const d = parseInt(mdMatch[2], 10);
            let y = mdMatch[3] ? parseInt(mdMatch[3], 10) : currentYear;
            if (y < 100) y += 2000;
            if (m) {
                const iso = formatIso(y, m, d);
                if (iso) {
                    foundDate = iso;
                    text = text.replace(mdMatch[0], " ").trim();
                }
            }
        }
    }

    // Cleanup leftover note
    let cleanNote = text
        .replace(/^(?:for|at|on|dated|since|from|about)\s+/i, "")
        .replace(/\s+(?:for|at|on|dated|since|from|about)$/i, "")
        .replace(/^[\s,.-]+|[\s,.-]+$/g, "")
        .trim();

    return {
        date: foundDate,
        note: cleanNote ? capitalize(cleanNote) : null
    };
}

/**
 * Cleanly formats a YYYY-MM-DD date into "1 Nov 2026" or "Today".
 */
export function formatDebtDisplayDate(dateStr) {
    if (!dateStr) return "Today";
    const currentToday = today();
    if (dateStr === currentToday) {
        return "Today";
    }

    const parts = dateStr.split("-");
    if (parts.length === 3) {
        const year = parseInt(parts[0], 10);
        const month = parseInt(parts[1], 10) - 1;
        const day = parseInt(parts[2], 10);
        const d = new Date(Date.UTC(year, month, day, 12, 0, 0));
        return new Intl.DateTimeFormat("en-GB", {
            timeZone: TIME_ZONE,
            day: "numeric",
            month: "short",
            year: "numeric"
        }).format(d);
    }
    return dateStr;
}

/**
 * Formats monetary amounts with clean currency symbol / suffix.
 */
export function formatDebtMoney(amount, currency = "USD") {
    const num = Number(amount) || 0;
    if (currency === "USD") {
        return `$${formatMoney(num, 2)}`;
    }
    return `${formatMoney(num, 0)} ៛`;
}

/**
 * Compact format for button labels (e.g. $50 or 20k ៛).
 */
export function formatDebtShortAmount(amount, currency = "USD") {
    const num = Number(amount) || 0;
    if (currency === "USD") {
        return `$${formatMoney(num)}`;
    }
    if (num >= 1000) {
        return `${Math.round(num / 1000)}k ៛`;
    }
    return `${formatMoney(num, 0)} ៛`;
}

/**
 * Parses user input for /lend command.
 * Supported patterns:
 *   /lend 50 Alex for lunch
 *   /lend Alex 50 lunch
 *   /lend 20000 Dara taxi
 *   /lend $25 John
 *   /lend 50$ to Sarah coffee
 *   /lend 15k Sovan dinner
 */
export function parseLendCommand(text) {
    if (!text || typeof text !== "string") return null;
    const clean = text.replace(/^\/lend(@\w+)?\s*/i, "").trim();
    if (!clean) return null;

    // Pattern A: /lend <amount> <person> [note/date]
    const amountRegex = /^(\$)?([0-9]+(?:\.[0-9]+)?)(k|khr|r|usd|\$)?\s+/i;
    const matchA = clean.match(amountRegex);
    if (matchA) {
        const prefixSymbol = matchA[1];
        let numVal = parseFloat(matchA[2]);
        const suffixUnit = (matchA[3] || "").toLowerCase();

        if (Number.isFinite(numVal) && numVal > 0) {
            let currency = "USD";
            if (suffixUnit === "k") {
                numVal *= 1000;
                currency = "KHR";
            } else if (suffixUnit === "khr" || suffixUnit === "r" || suffixUnit === "៛") {
                currency = "KHR";
            } else if (prefixSymbol === "$" || suffixUnit === "$" || suffixUnit === "usd") {
                currency = "USD";
            } else {
                currency = numVal >= 1000 ? "KHR" : "USD";
            }

            let remainder = clean.slice(matchA[0].length).trim();
            if (/^to\s+/i.test(remainder)) {
                remainder = remainder.replace(/^to\s+/i, "").trim();
            }

            const parts = remainder.split(/\s+/);
            if (parts.length > 0 && parts[0]) {
                const person = capitalize(parts[0].replace(/[@,:]/g, ""));
                const restAfterPerson = parts.slice(1).join(" ").trim();
                const dateAndNote = parseDateAndNote(restAfterPerson);

                return {
                    amount: numVal,
                    currency,
                    person,
                    date: dateAndNote.date,
                    note: dateAndNote.note
                };
            }
        }
    }

    // Pattern B: /lend <person> <amount> [note/date]
    const matchB = clean.match(/^([\p{L}\p{M}'-]+)\s+(\$)?([0-9]+(?:\.[0-9]+)?)(k|khr|r|usd|\$)?(?:\s+(.*))?$/iu);
    if (matchB) {
        const person = capitalize(matchB[1].replace(/[@,:]/g, ""));
        const prefixSymbol = matchB[2];
        let numVal = parseFloat(matchB[3]);
        const suffixUnit = (matchB[4] || "").toLowerCase();

        if (Number.isFinite(numVal) && numVal > 0) {
            let currency = "USD";
            if (suffixUnit === "k") {
                numVal *= 1000;
                currency = "KHR";
            } else if (suffixUnit === "khr" || suffixUnit === "r" || suffixUnit === "៛") {
                currency = "KHR";
            } else if (prefixSymbol === "$" || suffixUnit === "$" || suffixUnit === "usd") {
                currency = "USD";
            } else {
                currency = numVal >= 1000 ? "KHR" : "USD";
            }

            const restAfter = (matchB[5] || "").trim();
            const dateAndNote = parseDateAndNote(restAfter);

            return {
                amount: numVal,
                currency,
                person,
                date: dateAndNote.date,
                note: dateAndNote.note
            };
        }
    }

    return null;
}

/**
 * Helper to extract numeric amount, currency, and note from a trailing text fragment.
 */
function extractAmountCurrencyNote(restStr) {
    if (!restStr || typeof restStr !== "string") return null;
    const clean = restStr.trim();

    const amountRegex = /^(\$)?([0-9]+(?:\.[0-9]+)?)(k|khr|r|usd|\$)?(?:\s+(.*))?$/i;
    const match = clean.match(amountRegex);
    if (!match) return null;

    const prefixSymbol = match[1];
    let numVal = parseFloat(match[2]);
    const suffixUnit = (match[3] || "").toLowerCase();
    const remainingText = (match[4] || "").trim();

    if (!Number.isFinite(numVal) || numVal <= 0) return null;

    let currency = "USD";
    if (suffixUnit === "k") {
        numVal *= 1000;
        currency = "KHR";
    } else if (suffixUnit === "khr" || suffixUnit === "r" || suffixUnit === "៛") {
        currency = "KHR";
    } else if (prefixSymbol === "$" || suffixUnit === "$" || suffixUnit === "usd") {
        currency = "USD";
    } else {
        currency = numVal >= 1000 ? "KHR" : "USD";
    }

    const dateAndNote = parseDateAndNote(remainingText);

    return {
        amount: numVal,
        currency,
        date: dateAndNote.date,
        note: dateAndNote.note
    };
}

/**
 * Parses natural conversational text for loan/debt intents.
 * Examples:
 *   "bob borrow from me 25$ at 1st nov"
 *   "bob borrow me 20$"
 *   "bob borrowed from me $50 for lunch"
 *   "dara borrowed 20000r for taxi"
 *   "lent 20$ to Dara yesterday"
 *   "lent 50 to Alex for lunch"
 *   "john owes me $30"
 */
export function parseNaturalLend(text) {
    if (!text || typeof text !== "string") return null;
    const trimmed = text.trim();
    if (trimmed.startsWith("/")) return null;

    // Reject interrogative questions (prevent questions from inadvertently creating loans)
    if (trimmed.endsWith("?")) return null;
    if (/^(?:did|do|does|can|could|will|would|should|how|who|why|what|when|where|is|was|are|were)\b/i.test(trimmed)) {
        return null;
    }

    // Pattern 1: "<Person> borrow(ed) (from me/us/me) <amount> [note/date]"
    // e.g. "bob borrow from me 25$ at 1st nov", "bob borrow me 20$"
    const borrowMatch = trimmed.match(/^([\p{L}\p{M}\s'-]+?)\s+(?:borrowed|borrow|borrows)(?:\s+(?:from\s+me|from\s+us|from|me|us))?\s+(.*)$/iu);
    if (borrowMatch) {
        const rawPerson = borrowMatch[1].trim();
        const rest = borrowMatch[2].trim();
        if (/^(?:i|we|you|they|he|she)$/i.test(rawPerson)) return null;

        const parsedRest = extractAmountCurrencyNote(rest);
        if (parsedRest) {
            return {
                person: capitalize(rawPerson),
                amount: parsedRest.amount,
                currency: parsedRest.currency,
                date: parsedRest.date,
                note: parsedRest.note
            };
        }
    }

    // Pattern 2: "<Person> owes/owe me <amount> [note/date]"
    // e.g. "bob owes me 25$ for lunch"
    const oweMatch = trimmed.match(/^([\p{L}\p{M}\s'-]+?)\s+(?:owes\s+me|owe\s+me)\s+(.*)$/iu);
    if (oweMatch) {
        const rawPerson = oweMatch[1].trim();
        const rest = oweMatch[2].trim();
        if (/^(?:i|we|you)$/i.test(rawPerson)) return null;

        const parsedRest = extractAmountCurrencyNote(rest);
        if (parsedRest) {
            return {
                person: capitalize(rawPerson),
                amount: parsedRest.amount,
                currency: parsedRest.currency,
                date: parsedRest.date,
                note: parsedRest.note
            };
        }
    }

    // Pattern 3: "(i) lent/loaned/loans/lend/lends <amount> to <person> [note]"
    // e.g. "lent 25$ to bob at 1st nov"
    const lentToMatch = trimmed.match(/^(?:i\s+)?(?:lent|loaned|loans|lend|lends)\s+(\$?[0-9]+(?:\.[0-9]+)?(?:k|khr|r|usd|\$)?)\s+(?:to\s+)?([\p{L}\p{M}\s'-]+?)(?:\s+(.*))?$/iu);
    if (lentToMatch) {
        const amountStr = lentToMatch[1].trim();
        const rawPerson = lentToMatch[2].trim();
        let remainingNote = (lentToMatch[3] || "").trim();

        if (rawPerson && !/^(?:to|for|at|on)$/i.test(rawPerson)) {
            const parsedAmt = extractAmountCurrencyNote(amountStr);
            if (parsedAmt) {
                const dateAndNote = parseDateAndNote(remainingNote);
                return {
                    person: capitalize(rawPerson),
                    amount: parsedAmt.amount,
                    currency: parsedAmt.currency,
                    date: dateAndNote.date || parsedAmt.date,
                    note: dateAndNote.note
                };
            }
        }
    }

    // Pattern 4: "(i) lent/loaned/loans/lend/lends <person> <amount> [note]"
    // e.g. "lent bob 25$ at 1st nov"
    const lentPersonMatch = trimmed.match(/^(?:i\s+)?(?:lent|loaned|loans|lend|lends)\s+([\p{L}\p{M}\s'-]+?)\s+(\$?[0-9]+(?:\.[0-9]+)?(?:k|khr|r|usd|\$)?)(?:\s+(.*))?$/iu);
    if (lentPersonMatch) {
        const rawPerson = lentPersonMatch[1].trim();
        const amountStr = lentPersonMatch[2].trim();
        let remainingNote = (lentPersonMatch[3] || "").trim();

        if (rawPerson && !/^(?:to|for|at|on)$/i.test(rawPerson)) {
            const parsedAmt = extractAmountCurrencyNote(amountStr);
            if (parsedAmt) {
                const dateAndNote = parseDateAndNote(remainingNote);
                return {
                    person: capitalize(rawPerson),
                    amount: parsedAmt.amount,
                    currency: parsedAmt.currency,
                    date: dateAndNote.date || parsedAmt.date,
                    note: dateAndNote.note
                };
            }
        }
    }

    return null;
}

/**
 * Persists a loan to D1 and delivers the interactive confirmation card.
 */
export async function recordLoanAndSendCard(env, chatId, userId, parsed) {
    await ensureTables(env.DB);

    const recordDate = parsed.date && /^\d{4}-\d{2}-\d{2}$/.test(parsed.date) ? parsed.date : today();

    // 1. Log cash outflow into ledger (reduces balance immediately to match real bank)
    const expenseNote = parsed.note ? `Loan: ${parsed.note}` : `Loan to ${parsed.person}`;
    const txId = await addExpenseRecord(
        env.DB,
        userId,
        parsed.amount,
        "Loan",
        "expense",
        parsed.currency,
        recordDate,
        parsed.person,
        expenseNote
    );

    // Fail-fast if ledger insertion failed (prevent desync between ledger and loan)
    if (!txId) {
        await sendMessage(
            env,
            chatId,
            `⚠️ Failed to record loan in ledger. Please check your balance and try again.`,
            { parse_mode: "Markdown" }
        );
        return false;
    }

    // 2. Persist loan record linked to the outflow transaction ID
    const debt = await addDebt(
        env.DB,
        userId,
        parsed.person,
        parsed.amount,
        parsed.currency,
        parsed.note,
        recordDate,
        txId
    );

    if (!debt) {
        await deleteExpenseById(env.DB, userId, txId);
        await sendMessage(
            env,
            chatId,
            `⚠️ Failed to record loan. Please check the amount and try again.`,
            { parse_mode: "Markdown" }
        );
        return false;
    }

    const amtStr = formatDebtMoney(debt.amount, debt.currency);
    const dateFormatted = formatDebtDisplayDate(debt.date);
    const lines = [
        `🤝 *Loan Recorded*`,
        ``,
        `• *Person:*  *${cleanMd(debt.person_name)}*`,
        `• *Amount:*  \`${amtStr}\``
    ];

    if (debt.note) {
        lines.push(`• *Note:*    _${cleanMd(debt.note)}_`);
    }
    lines.push(`• *Date:*    \`${dateFormatted}\``);

    await sendMessage(
        env,
        chatId,
        lines.join("\n"),
        {
            parse_mode: "Markdown",
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: `✅ Settled`, callback_data: `settle_debt:${debt.id}` },
                        { text: `❌ Cancel`, callback_data: `del_debt:${debt.id}` }
                    ],
                    [
                        { text: "🤝 Debts", callback_data: "view_debts" },
                        { text: "‹ Finance", callback_data: "finance_hub" }
                    ]
                ]
            }
        }
    );
    return true;
}

/**
 * Handles the /lend command to log a new loan.
 */
export async function handleLendCommand(env, chatId, userId, text) {
    const parsed = parseLendCommand(text);

    if (!parsed) {
        await sendMessage(
            env,
            chatId,
            [
                `🤝 *Loan Tracker*`,
                ``,
                `• \`/lend 50 Alex lunch\``,
                `• \`/lend 20000 Dara taxi\``,
                ``,
                `Active loans: \`/debts\``
            ].join("\n"),
            {
                parse_mode: "Markdown",
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: "🤝 Debts", callback_data: "view_debts" },
                            { text: "‹ Finance", callback_data: "finance_hub" }
                        ]
                    ]
                }
            }
        );
        return;
    }

    await recordLoanAndSendCard(env, chatId, userId, parsed);
}

/**
 * Renders the active outstanding loans dashboard (/debts).
 */
export async function sendDebtsDashboard(env, chatId, userId, messageId = null) {
    await ensureTables(env.DB);
    const debts = await getPendingDebts(env.DB, userId);
    const exchangeRate = getExchangeRateSync();

    if (!debts || debts.length === 0) {
        const text = [
            `🤝 *No Outstanding Loans*`,
            ``,
            `All loans are settled.`,
            ``,
            `• \`/lend 50 Alex lunch\``
        ].join("\n");

        await safeEditOrSendMessage(env, chatId, messageId, text, {
            parse_mode: "Markdown",
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: "‹ Finance", callback_data: "finance_hub" },
                        { text: "🏠 Hub", callback_data: "hub" }
                    ]
                ]
            }
        });
        return;
    }

    let totalUsd = 0;
    const lines = [
        `🤝 *Outstanding Loans*`,
        ``
    ];

    for (const d of debts) {
        const amtStr = formatDebtMoney(d.amount, d.currency);
        const meta = [];
        if (d.date && d.date !== today()) {
            meta.push(formatDebtDisplayDate(d.date));
        }
        if (d.note) {
            meta.push(cleanMd(d.note));
        }
        const metaStr = meta.length > 0 ? ` _(${meta.join(" • ")})_` : "";
        lines.push(`• *${cleanMd(d.person_name)}:* \`${amtStr}\`${metaStr}`);

        if (d.currency === "USD") {
            totalUsd += Number(d.amount);
        } else {
            totalUsd += Number(d.amount) / exchangeRate;
        }
    }

    lines.push(`───────────────────────`);
    lines.push(`• *Total:* \`~$${formatMoney(totalUsd, 2)} USD\` _(${debts.length} pending)_`);

    const keyboard = [];
    for (let i = 0; i < debts.length; i += 2) {
        const row = debts.slice(i, i + 2).map(d => ({
            text: `✅ ${d.person_name} (${formatDebtShortAmount(d.amount, d.currency)})`,
            callback_data: `settle_debt:${d.id}`
        }));
        keyboard.push(row);
    }

    keyboard.push([
        { text: "‹ Finance", callback_data: "finance_hub" },
        { text: "🏠 Hub", callback_data: "hub" }
    ]);

    await safeEditOrSendMessage(env, chatId, messageId, lines.join("\n"), {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: keyboard }
    });
}
