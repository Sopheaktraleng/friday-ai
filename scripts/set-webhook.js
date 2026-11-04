import fs from "node:fs";
import path from "node:path";

let token = process.env.TELEGRAM_BOT_TOKEN;
let workerUrl = process.env.WORKER_URL;
let secret = process.env.WEBHOOK_SECRET;

if (!token || !workerUrl || !secret) {
    try {
        const devVarsPath = path.resolve(process.cwd(), ".dev.vars");
        if (fs.existsSync(devVarsPath)) {
            const content = fs.readFileSync(devVarsPath, "utf8");
            for (const line of content.split("\n")) {
                const trimmed = line.trim();
                if (!token && trimmed.startsWith("TELEGRAM_BOT_TOKEN=")) {
                    token = trimmed.split("=")[1].trim();
                }
                if (!workerUrl && trimmed.startsWith("WORKER_URL=")) {
                    workerUrl = trimmed.split("=")[1].trim();
                }
                if (!secret && trimmed.startsWith("WEBHOOK_SECRET=")) {
                    secret = trimmed.split("=")[1].trim();
                }
            }
        }
    } catch (_) {}
}

if (!token) {
    console.error("Missing TELEGRAM_BOT_TOKEN.");
    process.exit(1);
}

if (!workerUrl) {
    console.error(
        "Missing WORKER_URL. Example: https://cashflow-bot.your-name.workers.dev",
    );
    process.exit(1);
}

const webhookUrl = `${workerUrl.replace(/\/$/, "")}/webhook`;
const body = {
    url: webhookUrl,
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: true,
};

if (secret) {
    body.secret_token = secret;
}

const response = await fetch(
    `https://api.telegram.org/bot${token}/setWebhook`,
    {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    },
);

const data = await response.json();

if (!response.ok || !data.ok) {
    console.error("Failed to set webhook:", data);
    process.exit(1);
}

console.log(`Webhook set to ${webhookUrl}`);
