// Live Telegram configuration. The bot token and the webhook secret are
// deployment bindings (Worker secrets or local environment variables) that a
// person sets; they are never in code, journals, logs or API responses. The
// reader exposes a "not configured" state instead of failing, and keeps the
// values behind accessors so a serialized config never carries them.
import { createHash } from "node:crypto";
import { webhookRotationView } from "./telegram-rotation.mjs";

export const telegramBindings = Object.freeze({ token: "TELEGRAM_BOT_TOKEN", webhookSecret: "TELEGRAM_WEBHOOK_SECRET", apiBase: "TELEGRAM_API_BASE" });
export const telegramApiDefault = "https://api.telegram.org";
// Bot API tokens look like "<bot id>:<35 url-safe chars>"; setWebhook accepts a
// 1-256 character secret of A-Z a-z 0-9 _ - and the webhook route needs 16+.
const tokenPattern = /^\d{5,12}:[A-Za-z0-9_-]{30,64}$/;
const secretPattern = /^[A-Za-z0-9_-]{16,256}$/;
export const hashWebhookSecret = secret => createHash("sha256").update(secret).digest("hex");
const bindingValue = (env, name) => typeof env?.[name] === "string" && env[name].trim() ? env[name].trim() : null;

export function telegramConfig(env = process.env) {
  const token = bindingValue(env, telegramBindings.token), secret = bindingValue(env, telegramBindings.webhookSecret);
  const apiBase = bindingValue(env, telegramBindings.apiBase) ?? telegramApiDefault;
  const missing = [token ? null : telegramBindings.token, secret ? null : telegramBindings.webhookSecret].filter(Boolean);
  const invalid = [token && !tokenPattern.test(token) ? telegramBindings.token : null, secret && !secretPattern.test(secret) ? telegramBindings.webhookSecret : null].filter(Boolean);
  let base;
  try { base = new URL(apiBase); if (base.protocol !== "https:" || base.origin !== apiBase) base = null; } catch { base = null; }
  if (!base) invalid.push(telegramBindings.apiBase);
  const state = missing.length ? "not_configured" : invalid.length ? "invalid" : "configured";
  const configured = state === "configured";
  const unavailable = () => { throw new Error("Telegram is not configured: set " + [...missing, ...invalid].join(", ")); };
  // Values stay in this closure: JSON.stringify(config) shows state and binding names only.
  return Object.freeze({
    state, configured, missing: Object.freeze(missing), invalid: Object.freeze(invalid), bindings: Object.freeze(Object.values(telegramBindings)),
    apiBase: configured ? apiBase : telegramApiDefault,
    botToken: () => configured ? token : unavailable(),
    webhookSecret: () => configured ? secret : unavailable(),
    webhookSecretHash: () => configured ? hashWebhookSecret(secret) : unavailable(),
    // Method URL without the token, for logs and dry runs.
    methodPath: method => "/bot<redacted>/" + method,
    methodUrl: method => configured ? apiBase + "/bot" + token + "/" + method : unavailable()
  });
}
export const notConfiguredTelegram = () => telegramConfig({});
// Strip a token out of any text before it reaches a log or a response.
export const redactTelegram = text => String(text).replace(/(bot)?\d{5,12}:[A-Za-z0-9_-]{30,64}/g, (_, prefix) => (prefix ?? "") + "<redacted>");

// Per-connection live facts that no journal recorded: the last webhook
// delivery and the last send result. In process memory only; DurableTelegramLiveStatus
// (server/channel-live-status.mjs) is the durable replacement behind the same
// received()/sent()/snapshot() methods, and createRoomServer uses it whenever
// the store is available.
export class TelegramLiveStatus {
  #rows = new Map();
  #key(accountId, connectionId) { return JSON.stringify([accountId, connectionId]); }
  received(accountId, connectionId, { at, count = 1 }) {
    const row = this.#row(accountId, connectionId);
    row.lastUpdateReceivedAt = at; row.receivedUpdates += count;
  }
  sent(accountId, connectionId, { at, outcome, code = null }) {
    this.#row(accountId, connectionId).lastSendResult = { at, outcome, code };
  }
  #row(accountId, connectionId) {
    const key = this.#key(accountId, connectionId);
    if (!this.#rows.has(key)) this.#rows.set(key, { lastUpdateReceivedAt: null, receivedUpdates: 0, lastSendResult: null });
    return this.#rows.get(key);
  }
  snapshot(accountId, connectionId) { return structuredClone(this.#rows.get(this.#key(accountId, connectionId)) ?? { lastUpdateReceivedAt: null, receivedUpdates: 0, lastSendResult: null }); }
}
const iso = ms => Number.isSafeInteger(ms) ? new Date(ms).toISOString() : null;
// What the connection card shows. Binding names and states only; never values or hashes.
// sendBudget is an optional diagnostics attachment from the send-budget
// registry (task #41): { remaining, resetsAtMs }. It is included only when
// provided, so callers without budgets see the previous shape unchanged.
export function telegramLiveView({ config, connection, record, status = null, importAvailable = false, sendBudget = null, now = Date.now() }) {
  if (record.channel !== "telegram") return null;
  const live = status ? status.snapshot(record.accountId, record.id) : { lastUpdateReceivedAt: null, receivedUpdates: 0, lastSendResult: null };
  const storedHash = connection?.webhook?.secretHash ?? null;
  const webhook = !storedHash ? "unset" : !config.configured ? "set" : storedHash === config.webhookSecretHash() ? "matches" : "differs";
  const view = { contractVersion: 1, channel: "telegram", state: config.state, bindings: config.bindings, missing: config.missing, invalid: config.invalid,
    webhook, webhookSetAt: iso(connection?.webhook?.updatedAt), lastUpdateReceivedAt: iso(live.lastUpdateReceivedAt), receivedUpdates: live.receivedUpdates,
    lastSendResult: live.lastSendResult ? { at: iso(live.lastSendResult.at), outcome: live.lastSendResult.outcome, code: live.lastSendResult.code } : null,
    importAvailable, rotation: webhookRotationView(connection?.webhook, now) };
  if (sendBudget !== null && typeof sendBudget === "object")
    view.sendBudget = { remaining: sendBudget.remaining ?? null, resetsAt: iso(sendBudget.resetsAtMs ?? null) };
  return view;
}
