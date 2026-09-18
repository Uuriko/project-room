// Rotate the Telegram webhook secret without an outage.
//
//   node scripts/telegram-rotate-webhook.mjs --generate [--window-hours 24]
//
// Prints one fresh crypto-secure secret and the exact follow-up steps:
//
//   1. Store the printed secret as the TELEGRAM_WEBHOOK_SECRET Worker secret
//      (wrangler secret put TELEGRAM_WEBHOOK_SECRET), never in chat or email.
//   2. Re-register with Telegram through the existing setWebhook path, with
//      the NEW secret in the environment:
//        TELEGRAM_BOT_TOKEN=... TELEGRAM_WEBHOOK_SECRET=<new secret> \
//          node scripts/telegram-set-webhook.mjs https://<room origin> --connection <id>
//   3. Press Reconnect on the Telegram connection card: the server starts the
//      rotation window (default 24h, --window-hours to change) and dual-accepts
//      the old and new secrets until the window ends, so in-flight Telegram
//      deliveries are never refused mid-swap. The card shows the rotation as
//      pending with its window expiry, then complete.
//
// The secret is printed exactly once, on this machine, for the operator to
// store; this script never writes it to a file, a journal, or a log. The
// server only ever sees SHA-256 digests. Exit code 2 for a usage problem.
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { generateWebhookSecret, hashRotationSecret, webhookRotationDefaults } from "../server/channel-adapters/telegram-rotation.mjs";

export const usage = `Usage: node scripts/telegram-rotate-webhook.mjs --generate [--window-hours <hours>]
  --generate            Print one fresh crypto-secure webhook secret and the rotation runbook
  --window-hours <n>    Dual-accept window for the old secret, 1h to 168h (default 24)
The printed secret goes straight into the TELEGRAM_WEBHOOK_SECRET Worker secret;
re-register with scripts/telegram-set-webhook.mjs, then Reconnect on the card.\n`;

export function runRotateWebhook(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, options: { help: { type: "boolean" }, generate: { type: "boolean" }, "window-hours": { type: "string" } } });
  } catch (error) { stderr.write(error.message + "\n" + usage); return 2; }
  const { values, positionals } = parsed;
  if (values.help) { stdout.write(usage); return 0; }
  if (!values.generate || positionals.length) { stderr.write(usage); return 2; }
  const hours = values["window-hours"] === undefined ? 24 : Number(values["window-hours"]);
  if (!Number.isInteger(hours) || hours < 1 || hours > 168) { stderr.write("Choose a window of 1 to 168 hours.\n" + usage); return 2; }
  const windowMs = hours * 3600 * 1000;
  if (windowMs < webhookRotationDefaults.minWindowMs || windowMs > webhookRotationDefaults.maxWindowMs) { stderr.write("Choose a window of 1 to 168 hours.\n" + usage); return 2; }
  const secret = generateWebhookSecret();
  // Prove the fresh secret passes the server's strength gate before printing it.
  hashRotationSecret(secret);
  stdout.write("New TELEGRAM_WEBHOOK_SECRET (store it now; it is shown only here):\n" + secret + "\n\n"
    + "1. wrangler secret put TELEGRAM_WEBHOOK_SECRET   # paste the secret above\n"
    + "2. TELEGRAM_BOT_TOKEN=... TELEGRAM_WEBHOOK_SECRET=<the secret above> \\\n"
    + "     node scripts/telegram-set-webhook.mjs https://<room origin> --connection <id>\n"
    + "3. In the inbox, press Reconnect on the Telegram card: the server starts a " + hours + "h\n"
    + "   dual-accept window for the old secret, then the rotation completes.\n");
  return 0;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = await runRotateWebhook(process.argv.slice(2));
