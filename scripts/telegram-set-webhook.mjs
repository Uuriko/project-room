// Register (or remove) the Telegram webhook for one inbox connection.
//
//   TELEGRAM_BOT_TOKEN=... TELEGRAM_WEBHOOK_SECRET=... \
//     node scripts/telegram-set-webhook.mjs https://room.example.test --connection telegram-main [--dry-run] [--delete]
//
// The token and secret come from the environment only (the same two bindings
// the Worker uses); they are never printed. --dry-run shows the request with
// the secret redacted and sends nothing. Exit code 1 when Telegram answers
// ok: false, 2 for a usage or configuration problem.
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { validId } from "../src/events.js";
import { telegramConfig, redactTelegram } from "../server/channel-adapters/telegram-config.mjs";
import { messageKinds } from "../server/channel-adapters/telegram.mjs";

export const webhookRoutePrefix = "/api/inbox/webhooks/";
export const usage = `Usage: node scripts/telegram-set-webhook.mjs <public https url> --connection <id> [--dry-run] [--delete] [--drop-pending]
  <public https url>  The Room origin (https://room.example.test) or the full webhook URL
  --connection <id>   Inbox connection id the webhook delivers to (required with an origin)
  --dry-run           Print the request without sending it
  --delete            Call deleteWebhook instead of setWebhook
  --drop-pending      Ask Telegram to drop updates it is still holding
Environment: TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET (values are never printed)\n`;

// The webhook URL Telegram must call: <origin>/api/inbox/webhooks/<connectionId>.
export function webhookUrl(publicUrl, connectionId = null) {
  let url;
  try { url = new URL(publicUrl); } catch { throw new Error("Supply the public Room URL, for example https://room.example.test"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("Telegram webhooks need a plain https URL");
  if (url.pathname === "/" || url.pathname === "") {
    if (!validId(connectionId)) throw new Error("Supply --connection <id> together with the Room origin");
    return url.origin + webhookRoutePrefix + encodeURIComponent(connectionId);
  }
  const id = url.pathname.startsWith(webhookRoutePrefix) ? decodeURIComponent(url.pathname.slice(webhookRoutePrefix.length)) : null;
  if (!validId(id) || (connectionId !== null && connectionId !== id)) throw new Error("A full webhook URL must end in " + webhookRoutePrefix + "<connection id>");
  return url.origin + webhookRoutePrefix + encodeURIComponent(id);
}
// The Bot API call, with the secret only in `body` and the token only in `url`.
export function setWebhookPlan({ config, publicUrl, connectionId = null, remove = false, dropPending = false }) {
  if (!config.configured) throw new Error("Telegram is not configured: set " + [...config.missing, ...config.invalid].join(", "));
  if (remove) return { method: "deleteWebhook", url: config.methodUrl("deleteWebhook"), body: { drop_pending_updates: dropPending }, webhookUrl: null };
  const target = webhookUrl(publicUrl, connectionId);
  return { method: "setWebhook", url: config.methodUrl("setWebhook"), webhookUrl: target,
    body: { url: target, secret_token: config.webhookSecret(), allowed_updates: [...messageKinds], drop_pending_updates: dropPending, max_connections: 10 } };
}
export const redactPlan = plan => ({ method: plan.method, url: redactTelegram(plan.url), webhookUrl: plan.webhookUrl,
  body: Object.hasOwn(plan.body, "secret_token") ? { ...plan.body, secret_token: "<redacted>" } : plan.body });

export async function runSetWebhook(argv, { env = process.env, fetch = globalThis.fetch, stdout = process.stdout, stderr = process.stderr } = {}) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, options: { help: { type: "boolean" }, connection: { type: "string" }, "dry-run": { type: "boolean" }, delete: { type: "boolean" }, "drop-pending": { type: "boolean" } } });
  } catch (error) { stderr.write(error.message + "\n" + usage); return 2; }
  const { values, positionals } = parsed;
  if (values.help) { stdout.write(usage); return 0; }
  if (values.delete ? positionals.length > 1 : positionals.length !== 1) { stderr.write(usage); return 2; }
  let plan;
  try { plan = setWebhookPlan({ config: telegramConfig(env), publicUrl: positionals[0] ?? "https://unused.invalid/", connectionId: values.connection ?? null, remove: Boolean(values.delete), dropPending: Boolean(values["drop-pending"]) }); }
  catch (error) { stderr.write("telegram-set-webhook: " + redactTelegram(error.message) + "\n"); return 2; }
  if (values["dry-run"]) { stdout.write(JSON.stringify({ dryRun: true, ...redactPlan(plan) }, null, 2) + "\n"); return 0; }
  let result;
  try {
    const response = await fetch(plan.url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(plan.body), signal: AbortSignal.timeout(15000) });
    result = { status: response.status, ...(await response.json()) };
  } catch (error) { stderr.write("telegram-set-webhook: request failed: " + redactTelegram(error.message) + "\n"); return 1; }
  stdout.write(JSON.stringify({ method: plan.method, webhookUrl: plan.webhookUrl, ok: result.ok === true, status: result.status,
    description: redactTelegram(result.description ?? ""), result: result.result ?? null }, null, 2) + "\n");
  return result.ok === true ? 0 : 1;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = await runSetWebhook(process.argv.slice(2));
