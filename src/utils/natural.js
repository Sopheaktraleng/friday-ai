/**
 * Natural language intent and command parsers for Cashflow Bot.
 * Accurately differentiates financial intent, income vs expense, and conversational queries.
 */

const CONVERSATIONAL_QUESTION_WORDS = /^(?:can|could|should|would|will|is|are|am|do|does|did|why|how|what|when|where|who)\b/i;

const CORRECTION_OR_NEGATION_WORDS = /\b(not\s+(?:my\s+|an?\s+)?expense|is\s+(?:my\s+)?income|was\s+(?:my\s+)?income|not\s+what\s+i|wrong|mistake|error|delete|remove|undo|cancel|fix|correct|convert|change)\b/i;

const INCOME_KEYWORDS = /\b(income|salary|deposit|earned|earning|received|revenue|bonus|dividend|freelance|paycheck)\b/i;

const STOP_WORDS_IN_CATEGORY = /\b(is|was|are|were|not|my|the|this|that|why|how|what|can|could|should|undo|delete|remove|clear|cancel|wrong|budget|dollar|dollars|riel|khr|usd)\b/i;

/**
 * Detects whether a message contains multiple simultaneous action intents.
 * e.g. "Hey Friday, I just paid $8.50 for lunch with Jinie, remind me at 3:30 PM to review the design file, and note down that she loves matcha lattes."
 * These compound requests must bypass single-intent regexes and be routed to F.R.I.D.A.Y. AI Copilot.
 */
export function isCompoundOrMultiAction(text) {
    if (!text || typeof text !== "string") return false;
    const clean = text.trim();
    if (clean.startsWith("/")) return false;

    if (/^(?:hey\s+)?friday[,:\s]/i.test(clean)) return true;

    const lower = clean.toLowerCase();

    const hasActionConjunction = /\b(?:and\s+(?:also\s+)?|also\s+|plus\s+|then\s+)(?:remind|alarm|note(?:\s+down)?|remember|log|track|record|save|add|put|buy|bought|paid|spent|spend)\b/i.test(lower);
    if (hasActionConjunction) return true;

    let signals = 0;
    if (/\b(?:paid|spent|bought|cost|expense|income|earned|salary|\$\s*\d+|\d+\s*\$|\d+\s*(?:usd|khr|riel|dollars))\b/i.test(lower)) {
        signals++;
    }
    if (/\b(?:remind(?:\s+me)?|alarm|alert\s+me)\b/i.test(lower)) {
        signals++;
    }
    if (/\b(?:note\s+down|remember(?:\s+that)?|keep\s+in\s+mind|don't\s+forget\s+that|she\s+likes|she\s+loves|he\s+likes|he\s+loves|i\s+like|i\s+love|my\s+favorite)\b/i.test(lower)) {
        signals++;
    }
    if (/\b(?:done|completed|finished)\s+(?:with\s+|the\s+|all\s+|my\s+)?\b/i.test(lower)) {
        signals++;
    }

    return signals >= 2;
}

/**
 * Determines whether a message is conversational, questioning, or corrective.
 * Messages matching this must NEVER be greedily captured by simple expense regexes.
 */
export function isConversationalOrCorrection(text) {
    if (!text || typeof text !== "string") return false;
    const clean = text.trim();
    if (clean.startsWith("/")) return false;

    if (isCompoundOrMultiAction(clean)) return true;

    if (isRealTimeSearchQuery(clean)) return true;

    if (/^(?:hey\s+)?friday[,:\s]/i.test(clean)) return true;

    if (/^(hi|hello|hey|yo|sup|hiya|howdy|hell|greetings|good\s+(?:morning|afternoon|evening)|what's\s+up|wassup|សួស្តី|ជំរាបសួរ)\b/i.test(clean)) {
        return true;
    }

    if (clean.includes("?")) return true;

    if (CONVERSATIONAL_QUESTION_WORDS.test(clean)) return true;

    if (CORRECTION_OR_NEGATION_WORDS.test(clean)) return true;

    if (/\b(budget|currency|switch\s+to|change\s+to|set\s+currency|set\s+budget|how\s+much|balance|report|briefing|standup|joke|quote|talk)\b/i.test(clean)) {
        return true;
    }

    return false;
}

/**
 * Strips natural target destination suffixes (e.g. "to finance hub", "to ledger", "to cashflow").
 */
export function stripTargetSuffix(text) {
    if (!text || typeof text !== "string") return "";
    return text.replace(/\s+(?:to|in|into)\s+(?:finance(?:\s+hub)?|cashflow|ledger|wallet)$/i, "").trim();
}

/**
 * Parses natural income commands.
 * Examples:
 *   "+500 salary"
 *   "income 500 salary"
 *   "40$ income"
 *   "$500 salary"
 *   "500$ salary"
 *   "earned $40 freelance"
 *   "received 100 bonus"
 *   "got paid 500"
 *   "add income 500"
 */
export function parseNaturalIncome(text) {
    if (!text || typeof text !== "string") return null;
    let clean = stripTargetSuffix(text.trim());
    if (clean.startsWith("/")) return null;

    // If text expresses a negation/correction, pass to AI Copilot so it can undo the mistake
    if (CORRECTION_OR_NEGATION_WORDS.test(clean) && /\b(not|wrong|mistake|error|undo|delete|remove|fix)\b/i.test(clean)) {
        return null;
    }

    let amount = null;
    let currencyHint = null;
    let rawCategory = "";

    const mPlus = clean.match(/^\+\s*(\$?[0-9]+(?:\.[0-9]+)?)\s*(usd|khr|\$|dollars|riel|៛)?(?:\s+(.*))?$/i);
    const mIncome = clean.match(/^(?:add\s+)?income\s*[:\s]\s*(\$?[0-9]+(?:\.[0-9]+)?)\s*(usd|khr|\$|dollars|riel|៛)?(?:\s+(.*))?$/i);
    const mSuffix = clean.match(/^(\$?[0-9]+(?:\.[0-9]+)?)\s*(usd|khr|\$|dollars|riel|៛)?\s+(?:is\s+)?(?:my\s+)?(income|salary|bonus|deposit|revenue|earnings?|freelance)(?:\s+(.*))?$/i);
    const mPrefix = clean.match(/^(salary|bonus|deposit)\s+(\$?[0-9]+(?:\.[0-9]+)?)\s*(usd|khr|\$|dollars|riel|៛)?(?:\s+(.*))?$/i);
    const mEarned = clean.match(/^(?:i\s+)?(?:earned|received|got(?:\s+paid)?)\s+(\$?[0-9]+(?:\.[0-9]+)?)\s*(usd|khr|\$|dollars|riel|៛)?\s*(?:for|from|as)?\s*(.*)$/i);

    if (mPlus) {
        amount = Number(mPlus[1].replace("$", ""));
        currencyHint = mPlus[2] || (mPlus[1].includes("$") ? "USD" : null);
        rawCategory = mPlus[3] || "";
    } else if (mIncome) {
        amount = Number(mIncome[1].replace("$", ""));
        currencyHint = mIncome[2] || (mIncome[1].includes("$") ? "USD" : null);
        rawCategory = mIncome[3] || "";
    } else if (mSuffix) {
        amount = Number(mSuffix[1].replace("$", ""));
        currencyHint = mSuffix[2] || (mSuffix[1].includes("$") ? "USD" : null);
        const term = mSuffix[3].toLowerCase();
        const extra = (mSuffix[4] || "").trim();
        rawCategory = extra ? `${term} - ${extra}` : term;
    } else if (mPrefix) {
        amount = Number(mPrefix[2].replace("$", ""));
        currencyHint = mPrefix[3] || (mPrefix[2].includes("$") ? "USD" : null);
        const term = mPrefix[1].toLowerCase();
        const extra = (mPrefix[4] || "").trim();
        rawCategory = extra ? `${term} - ${extra}` : term;
    } else if (mEarned) {
        amount = Number(mEarned[1].replace("$", ""));
        currencyHint = mEarned[2] || (mEarned[1].includes("$") ? "USD" : null);
        rawCategory = mEarned[3] || "Income";
    }

    if (!amount || !Number.isFinite(amount) || amount <= 0) {
        return null;
    }

    let category = "Income";
    let source = null;
    let note = null;

    const noteMatch = rawCategory.match(/\(([^)]+)\)/);
    if (noteMatch) {
        note = noteMatch[1].trim();
        rawCategory = rawCategory.replace(/\([^)]+\)/, "").trim();
    }
    const fromMatch = rawCategory.match(/\s+(?:from|by)\s+([a-zA-Z0-9\s'-]+)$/i);
    if (fromMatch) {
        source = fromMatch[1].trim();
        rawCategory = rawCategory.slice(0, fromMatch.index).trim();
    }

    const catLower = rawCategory.toLowerCase();
    if (catLower.includes("salary")) category = "Salary";
    else if (catLower.includes("bonus")) category = "Bonus";
    else if (catLower.includes("freelance")) category = "Freelance";
    else if (catLower.includes("deposit")) category = "Deposit";
    else if (catLower.includes("income")) category = "Income";
    else if (rawCategory.trim()) category = rawCategory.trim();

    let currency = null;
    if (currencyHint) {
        const u = currencyHint.toUpperCase();
        if (u === "$" || u === "USD" || u === "DOLLARS") currency = "USD";
        else if (u === "KHR" || u === "RIEL" || u === "៛") currency = "KHR";
    }

    const res = { amount, currency, category };
    if (source) res.source = source;
    if (note) res.note = note;
    return res;
}

/**
 * Parses natural expense commands with strict guards against false positives.
 * Examples:
 *   "5 coffee"
 *   "$12 lunch"
 *   "coffee 5"
 *   "spent $15 on dinner"
 *   "paid 20000 for gas"
 *   "bought coffee for $4"
 *   "add amount 3000 khr to finance hub"
 *   "add 3000 khr"
 *   "3000 khr"
 */
export function parseNaturalExpense(text) {
    if (!text || typeof text !== "string") return null;
    let clean = text.trim();
    if (clean.startsWith("/")) return null;

    if (isConversationalOrCorrection(clean)) {
        return null;
    }

    if (INCOME_KEYWORDS.test(clean)) {
        return null;
    }

    clean = stripTargetSuffix(clean);

    const hasActionPrefix = /^(?:add\s+(?:an?\s+)?(?:amount|expense)|add|log|record|put|track)\s+/i.test(clean);
    if (hasActionPrefix) {
        clean = clean.replace(/^(?:add\s+(?:an?\s+)?(?:amount|expense)|add|log|record|put|track)\s+/i, "").trim();
    }

    let amount = null;
    let category = null;
    let currencyHint = null;

    const standaloneMatch = clean.match(/^(\$?[0-9]+(?:\.[0-9]+)?)\s*(usd|khr|\$|dollars|riel|៛)?$/i);
    if (standaloneMatch) {
        const rawAmount = Number(standaloneMatch[1].replace("$", ""));
        const rawCurr = standaloneMatch[2] || (standaloneMatch[1].includes("$") ? "USD" : null);
        if (rawCurr || hasActionPrefix || rawAmount >= 100) {
            amount = rawAmount;
            currencyHint = rawCurr;
            category = "Other";
        }
    }

    if (!amount) {
        const expMatch3 = clean.match(/^(?:i\s+)?(?:spent|paid|bought)\s+(\$?[0-9]+(?:\.[0-9]+)?)\s*(usd|khr|\$|dollars|riel|៛)?\s*(?:on|for)?\s*([a-zA-Z0-9\s()@'-]+)$/i);
        const expMatch4 = clean.match(/^(?:i\s+)?(?:spent|paid|bought)\s+([a-zA-Z0-9\s()@'-]+)\s+(?:for|at)?\s+(\$?[0-9]+(?:\.[0-9]+)?)\s*(usd|khr|\$|dollars|riel|៛)?$/i);
        const expMatch1 = clean.match(/^(\$?[0-9]+(?:\.[0-9]+)?)\s*(usd|khr|\$|dollars|riel|៛)?\s+(?:for|on\s+)?([a-zA-Z0-9\s()@'-]+)$/i);
        const expMatch2 = clean.match(/^([a-zA-Z0-9\s()@'-]+)\s+(\$?[0-9]+(?:\.[0-9]+)?)\s*(usd|khr|\$|dollars|riel|៛)?$/i);

        if (expMatch3) {
            amount = Number(expMatch3[1].replace("$", ""));
            currencyHint = expMatch3[2] || (expMatch3[1].includes("$") ? "USD" : null);
            category = expMatch3[3].trim();
        } else if (expMatch4) {
            amount = Number(expMatch4[2].replace("$", ""));
            currencyHint = expMatch4[3] || (expMatch4[2].includes("$") ? "USD" : null);
            category = expMatch4[1].trim();
        } else if (expMatch1) {
            amount = Number(expMatch1[1].replace("$", ""));
            currencyHint = expMatch1[2] || (expMatch1[1].includes("$") ? "USD" : null);
            category = expMatch1[3].trim();
        } else if (expMatch2) {
            amount = Number(expMatch2[2].replace("$", ""));
            currencyHint = expMatch2[3] || (expMatch2[2].includes("$") ? "USD" : null);
            category = expMatch2[1].trim();
        }
    }

    if (!amount || !Number.isFinite(amount) || amount <= 0 || !category) {
        return null;
    }

    category = category.replace(/^(?:for|on)\s+/i, "").trim();
    if (!category) {
        category = "Other";
    }

    if (category.length > 25) {
        return null;
    }

    const words = category.split(/\s+/);
    if (words.length >= 3 && STOP_WORDS_IN_CATEGORY.test(category)) {
        return null;
    }

    if (words.length === 1 && /^(is|was|are|were|the|this|that|not|for|from|to|my|our|your)$/i.test(category)) {
        return null;
    }

    let merchant = null;
    let note = null;

    const noteMatch = category.match(/\(([^)]+)\)/);
    if (noteMatch) {
        note = noteMatch[1].trim();
        category = category.replace(/\([^)]+\)/, "").trim();
    }

    const atMatch = category.match(/\s+(?:at|@)\s+([a-zA-Z0-9\s'-]+)$/i);
    if (atMatch) {
        merchant = atMatch[1].trim();
        category = category.slice(0, atMatch.index).trim();
    }

    if (!category) return null;

    let currency = null;
    if (currencyHint) {
        const u = currencyHint.toUpperCase();
        if (u === "$" || u === "USD" || u === "DOLLARS") currency = "USD";
        else if (u === "KHR" || u === "RIEL" || u === "៛") currency = "KHR";
    }

    const res = { amount, currency, category };
    if (merchant) res.merchant = merchant;
    if (note) res.note = note;
    return res;
}

/**
 * Detects whether a message is asking for real-time external information (weather, news, sports, crypto, web search).
 */
export function isRealTimeSearchQuery(text) {
    if (!text || typeof text !== "string") return false;
    const clean = text.trim();
    if (clean.startsWith("/")) {
        return /^\/(search|web|google|weather)\b/i.test(clean);
    }

    const lower = clean.toLowerCase();

    if (/^(?:search(?:\s+for)?|google|look\s+up|browse|find\s+online)\b/i.test(lower)) {
        return true;
    }

    if (/\b(?:weather|temperature|forecast|rain|raining|rainy|degrees|humidity|sunny|storm|monsoon|អាកាសធាតុ|ភ្លៀង)\b/i.test(lower)) {
        return true;
    }

    if (/\b(?:news|headline|headlines|what\s+happened)\b/i.test(lower)) {
        return true;
    }

    if (/\b(?:who\s+won|football\s+score|match\s+score|premier\s+league|champions\s+league|world\s+cup|arsenal|man\s+united|barcelona|real\s+madrid)\b/i.test(lower)) {
        return true;
    }

    if (/\b(?:bitcoin|btc|crypto|ethereum|eth\s+price|solana|gold\s+price\s+today|stock\s+price)\b/i.test(lower)) {
        // Exclude internal budget questions like "my budget" or "can i afford"
        if (!/\b(budget|my\s+expense|my\s+spend|can\s+i\s+afford)\b/i.test(lower)) {
            return true;
        }
    }

    if (/\b(?:cinema|movie\s+showtimes?|movies\s+playing|legend\s+cinema|major\s+cineplex|prime\s+cineplex)\b/i.test(lower)) {
        return true;
    }

    return false;
}
