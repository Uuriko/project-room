// Live Telegram sendMessage transport. It is a submit/lookup adapter for
// SyntheticInboxTransport (kind "telegram-bot"), driven by an injected fetch so
// tests never reach the network. One outbox attempt maps to one operation key:
// a retried submit with the same key replays the recorded receipt instead of
// posting again. Telegram's transient answers (429 with retry_after, 5xx,
// network failures) are retried with bounded backoff; everything that is
// still uncertain afterwards is reported as unavailable, which leaves the
// attempt "unknown" in the send journal rather than guessing.
import { ServiceError } from "../store.mjs";
import { requireContract } from "../channel-connection.mjs";
import { provider, channel } from "./telegram.mjs";
import { redactTelegram } from "./telegram-config.mjs";

export const telegramSendLimits = Object.freeze({ textChars: 4096, maxAttempts: 4, baseDelayMs: 500, maxDelayMs: 5000, timeoutMs: 10000 });
const object = v => v !== null && typeof v === "object" && !Array.isArray(v);
const digits = /^-?\d{1,20}$/;
const fail = (status, code, message, headers = null) => { throw new ServiceError(status, code, message, headers); };
const slug = text => String(text ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 64) || "unknown";

// The Bot API request for one outbox envelope; pure, so tests can inspect it.
export function telegramSendRequest(envelope) {
  requireContract(object(envelope) && envelope.adapter === channel && envelope.provider === provider && object(envelope.target), "telegram_transport_mismatch");
  const { chatId, replyToMessageId, threadId } = envelope.target;
  requireContract(digits.test(chatId) && (replyToMessageId === null || /^\d{1,20}$/.test(replyToMessageId)) && typeof threadId === "string", "telegram_transport_mismatch");
  requireContract(typeof envelope.body === "string" && envelope.body.trim() && envelope.body.length <= telegramSendLimits.textChars && envelope.body.isWellFormed(), "telegram_transport_mismatch");
  const body = { chat_id: Number(chatId), text: envelope.body };
  if (replyToMessageId !== null) body.reply_parameters = { message_id: Number(replyToMessageId), allow_sending_without_reply: true };
  const [, topic] = threadId.split("/");
  if (topic !== undefined) { requireContract(/^\d{1,20}$/.test(topic), "telegram_transport_mismatch"); body.message_thread_id = Number(topic); }
  return { method: "sendMessage", body };
}
// Retry only on answers that may succeed unchanged later.
export const retryableTelegramStatus = status => status === 429 || status >= 500;
export function telegramRetryDelay({ attempt, retryAfter = null, baseDelayMs = telegramSendLimits.baseDelayMs, maxDelayMs = telegramSendLimits.maxDelayMs }) {
  const hinted = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : baseDelayMs * 2 ** attempt;
  return Math.min(maxDelayMs, Math.round(hinted));
}

export class TelegramTransport {
  #config; #fetch; #sleep; #now; #receipts; #inflight = new Map(); #status; #limits;
  kind = provider;
  constructor({ config, fetch = globalThis.fetch, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = () => Date.now(),
    receipts = new Map(), status = null, accountId = null, connectionId = null, ...limits } = {}) {
    if (!config?.configured || typeof config.methodUrl !== "function") throw new TypeError("A configured Telegram config is required");
    if (typeof fetch !== "function") throw new TypeError("A fetch implementation is required");
    if (typeof receipts?.get !== "function" || typeof receipts?.set !== "function") throw new TypeError("A get/set receipt store is required");
    this.#config = config; this.#fetch = fetch; this.#sleep = sleep; this.#now = now; this.#receipts = receipts; this.#status = status;
    this.scope = { accountId, connectionId };
    this.#limits = { ...telegramSendLimits, ...limits };
    for (const k of ["maxAttempts", "baseDelayMs", "maxDelayMs", "timeoutMs"]) if (!Number.isSafeInteger(this.#limits[k]) || this.#limits[k] < 1) throw new TypeError("Invalid transport limit " + k);
  }
  #record(outcome, code = null) { this.#status?.sent(this.scope.accountId, this.scope.connectionId, { at: this.#now(), outcome, code }); }
  async submit({ operationId, envelope }) {
    requireContract(typeof operationId === "string" && operationId.length > 0 && operationId.length <= 256, "telegram_transport_mismatch");
    const request = telegramSendRequest(envelope);
    const prior = await this.#receipts.get(operationId);
    if (prior) {
      if (prior.previewVersion !== envelope.previewVersion) fail(409, "conflicting_inbox_observation", "This operation key already recorded a different reply.");
      return structuredClone(prior);
    }
    // Concurrent retries of one key share one HTTP attempt.
    if (this.#inflight.has(operationId)) return structuredClone(await this.#inflight.get(operationId));
    const attempt = this.#send(operationId, envelope.previewVersion, request).finally(() => this.#inflight.delete(operationId));
    this.#inflight.set(operationId, attempt);
    return structuredClone(await attempt);
  }
  async lookup({ operationId }) {
    const receipt = await this.#receipts.get(operationId);
    return receipt ? structuredClone(receipt) : null;
  }
  async #send(operationId, previewVersion, request) {
    const url = this.#config.methodUrl(request.method), body = JSON.stringify(request.body);
    let lastStatus = null, retryAfter = null;
    for (let attempt = 0; attempt < this.#limits.maxAttempts; attempt++) {
      if (attempt) await this.#sleep(telegramRetryDelay({ attempt: attempt - 1, retryAfter, baseDelayMs: this.#limits.baseDelayMs, maxDelayMs: this.#limits.maxDelayMs }));
      let response, value = null;
      try {
        response = await this.#fetch(url, { method: "POST", body, headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(this.#limits.timeoutMs) });
        try { value = await response.json(); } catch { value = null; }
      } catch {
        // The request may or may not have reached Telegram: keep the attempt unknown.
        lastStatus = "network"; retryAfter = null; this.#record("failed", "network"); continue;
      }
      lastStatus = response.status; retryAfter = Number(value?.parameters?.retry_after) || null;
      if (response.ok && value?.ok === true && object(value.result) && Number.isSafeInteger(value.result.message_id)) {
        const receipt = { operationId, previewVersion, outcome: "accepted", providerId: "telegram:" + request.body.chat_id + ":" + value.result.message_id };
        await this.#receipts.set(operationId, receipt); this.#record("accepted"); return receipt;
      }
      const description = redactTelegram(value?.description ?? "");
      if (response.status === 401 || response.status === 404) { this.#record("failed", "unauthorized"); fail(409, "channel_connection_unavailable", "Telegram rejected the bot token. Check TELEGRAM_BOT_TOKEN."); }
      if (retryableTelegramStatus(response.status)) { this.#record("failed", response.status === 429 ? "rate_limited" : "server_error"); continue; }
      // 400 / 403 and other definitive answers: the reply will never be delivered as written.
      const receipt = { operationId, previewVersion, outcome: "rejected", providerId: null, code: slug(description) };
      await this.#receipts.set(operationId, receipt); this.#record("rejected", receipt.code); return receipt;
    }
    const headers = lastStatus === 429 && retryAfter ? { "Retry-After": Math.ceil(retryAfter) } : null;
    fail(503, "channel_sending_unavailable", lastStatus === "network" ? "Telegram could not be reached. The attempt stays unknown until reconciled."
      : lastStatus === 429 ? "Telegram is rate limiting this bot. Try again later." : "Telegram is unavailable. Try again later.", headers);
  }
}
// The fixture bot stays the default until a person sets the bindings.
export function telegramSendAdapter({ config, fixture, ...options }) {
  if (!config?.configured) return fixture;
  return new TelegramTransport({ config, ...options });
}
