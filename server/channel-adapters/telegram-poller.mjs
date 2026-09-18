// Live Telegram getUpdates driver. A `LiveTelegramPoller` is the live
// counterpart to `RecordedTelegramBot`: it performs real getUpdates long-poll
// requests against the Bot API (token from the configured bindings, never
// hardcoded) and satisfies the reader contract that `bind` in telegram.mjs
// turns into the bound-adapter interface (changes/hydrate/submit/lookup).
// Use it for local development and environments where Telegram cannot reach
// a webhook; the fixture stays the default until bindings exist
// (`telegramReadAdapter` selects between them).
//
// Reads and writes stay separate drivers behind one interface: the poller
// only ever reads. `submit`/`lookup` delegate to an optional sender (a
// `TelegramTransport` built from the same config); without one they report
// honestly unavailable. Fetch, sleep and the clock are injected so tests
// never touch the network.
import { provider, telegramConnection, telegramLimits, messageKinds, qualifyTelegramCursor, bind, isTelegramReader } from "./telegram.mjs";
import { redactTelegram } from "./telegram-config.mjs";
import { requireContract } from "../channel-connection.mjs";
import { ServiceError } from "../store.mjs";

const object = v => v !== null && typeof v === "object" && !Array.isArray(v);
const fail = (status, code, message, headers = null) => { throw new ServiceError(status, code, message, headers); };
// Telegram caps the long-poll `timeout` at 50 seconds; the HTTP request needs
// slack above it or the client's own abort wins the race with Telegram's.
export const telegramPollLimits = Object.freeze({ longPollSecs: 30, maxLongPollSecs: 50, timeoutSlackMs: 15000,
  limit: telegramLimits.updates, maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 15000, seenCap: 10000 });
// The pure Bot API request for one long-poll. Only the update kinds the
// normalizer understands are requested; anything else would arrive, be
// skipped, and still consume the offset cursor's attention.
export function telegramGetUpdatesRequest({ offset = null, limit = telegramPollLimits.limit, timeout = telegramPollLimits.longPollSecs } = {}) {
  requireContract(offset === null || Number.isSafeInteger(offset) && offset >= 0, "invalid_telegram_cursor");
  requireContract(Number.isSafeInteger(limit) && limit >= 1 && limit <= telegramLimits.updates, "invalid_telegram_updates");
  requireContract(Number.isSafeInteger(timeout) && timeout >= 1 && timeout <= telegramPollLimits.maxLongPollSecs, "invalid_telegram_updates");
  const body = { limit, timeout, allowed_updates: [...messageKinds] };
  if (offset !== null) body.offset = offset;
  return { method: "getUpdates", body };
}
// Retry only on answers that may succeed unchanged later; a 429 honors Telegram's retry_after hint.
export const retryablePollStatus = status => status === 429 || status >= 500;
export function telegramPollRetryDelay({ attempt, retryAfter = null, baseDelayMs = telegramPollLimits.baseDelayMs, maxDelayMs = telegramPollLimits.maxDelayMs }) {
  const hinted = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : baseDelayMs * 2 ** attempt;
  return Math.min(maxDelayMs, Math.round(hinted));
}

export class LiveTelegramPoller {
  #config; #connection; #fetch; #sleep; #now; #sender; #status; #limits;
  #cursor = null; // Next offset to ask for: max update_id seen + 1, as a string, or null for "from now".
  #seen = new Set(); // update_ids already emitted, so a redelivered offset cannot duplicate a change.
  #closed = false;
  #inflight = null; // AbortController for the request currently awaiting Telegram.
  #accountId; #connectionId;
  kind = provider;
  mode = "live";
  limit;
  constructor({ config, connection, fetch = globalThis.fetch, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = () => Date.now(),
    sender = null, status = null, accountId = null, connectionId = null, ...limits } = {}) {
    if (!config?.configured || typeof config.methodUrl !== "function") throw new TypeError("A configured Telegram config is required");
    if (typeof fetch !== "function") throw new TypeError("A fetch implementation is required");
    if (sender !== null && (typeof sender.submit !== "function" || typeof sender.lookup !== "function")) throw new TypeError("A sender needs submit and lookup");
    this.#config = config; this.#fetch = fetch; this.#sleep = sleep; this.#now = now; this.#sender = sender; this.#status = status;
    this.#accountId = accountId; this.#connectionId = connectionId;
    this.#connection = telegramConnection(connection);
    this.#limits = { ...telegramPollLimits, ...limits };
    const { longPollSecs, maxLongPollSecs, timeoutSlackMs, limit, maxAttempts, baseDelayMs, maxDelayMs, seenCap } = this.#limits;
    if (!Number.isSafeInteger(longPollSecs) || longPollSecs < 1 || longPollSecs > maxLongPollSecs) throw new TypeError("Invalid poller longPollSecs");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > telegramLimits.updates) throw new TypeError("Invalid poller limit");
    for (const [name, value] of [["timeoutSlackMs", timeoutSlackMs], ["maxAttempts", maxAttempts], ["baseDelayMs", baseDelayMs], ["maxDelayMs", maxDelayMs], ["seenCap", seenCap]])
      if (!Number.isSafeInteger(value) || value < (name === "maxAttempts" || name === "seenCap" ? 1 : 0)) throw new TypeError("Invalid poller limit " + name);
    this.limit = limit;
  }
  get connection() { return structuredClone(this.#connection); }
  get closed() { return this.#closed; }
  #remember(updateId) {
    this.#seen.add(updateId);
    if (this.#seen.size > this.#limits.seenCap) this.#seen.delete(this.#seen.values().next().value); // Oldest first; insertion ordered.
  }
  // One long-poll against Telegram. The returned shape matches the Bot API
  // response the fixture reader produces, so `bind` consumes it unchanged.
  // An explicit offset re-asks from there (redeliveries are deduped); omitted,
  // the poller advances from the highest update_id it has emitted. `signal`
  // aborts the request; an abort while closed or signalled is a shutdown,
  // never a transient failure.
  async getUpdates({ offset = null, signal = null } = {}) {
    if (this.#closed) fail(503, "channel_poller_closed", "The Telegram poller is closed.");
    const from = offset === null ? this.#cursor : qualifyTelegramCursor(offset);
    const value = await this.#request(telegramGetUpdatesRequest({ offset: from === null ? null : Number(from), limit: this.limit, timeout: this.#limits.longPollSecs }), signal);
    requireContract(object(value) && value.ok === true && Array.isArray(value.result), "invalid_telegram_updates");
    const fresh = [];
    for (const update of value.result) {
      requireContract(object(update) && Number.isSafeInteger(update.update_id) && update.update_id >= 0, "invalid_telegram_updates");
      if (this.#seen.has(update.update_id)) continue;
      this.#remember(update.update_id); fresh.push(update);
    }
    // Telegram returns update_ids ascending, so the last fresh one sets the cursor.
    if (fresh.length) this.#cursor = String(fresh[fresh.length - 1].update_id + 1);
    if (fresh.length) this.#status?.received(this.#accountId, this.#connectionId, { at: this.#now(), count: fresh.length });
    return { ok: true, result: fresh };
  }
  async #request(request, signal = null) {
    const url = this.#config.methodUrl(request.method), body = JSON.stringify(request.body);
    const timeoutMs = (this.#limits.longPollSecs + 1) * 1000 + this.#limits.timeoutSlackMs;
    let lastStatus = null, retryAfter = null;
    for (let attempt = 0; attempt < this.#limits.maxAttempts; attempt++) {
      if (attempt) await this.#sleep(telegramPollRetryDelay({ attempt: attempt - 1, retryAfter, baseDelayMs: this.#limits.baseDelayMs, maxDelayMs: this.#limits.maxDelayMs }));
      if (this.#closed) fail(503, "channel_poller_closed", "The Telegram poller is closed.");
      const controller = new AbortController();
      this.#inflight = controller;
      const signals = [AbortSignal.timeout(timeoutMs), controller.signal];
      if (signal) signals.push(signal);
      let response, value = null;
      try {
        response = await this.#fetch(url, { method: "POST", body, headers: { "Content-Type": "application/json" }, signal: AbortSignal.any(signals) });
        try { value = await response.json(); } catch { value = null; }
      } catch (error) {
        this.#inflight = null;
        // An abort the poller itself caused (close) or the caller requested
        // (signal) is a shutdown, not a network failure: never retried.
        if (error?.name === "AbortError" && (this.#closed || signal?.aborted)) fail(503, "channel_poller_closed", "The Telegram poller was stopped.");
        lastStatus = "network"; retryAfter = null; continue;
      }
      this.#inflight = null;
      lastStatus = response.status; retryAfter = Number(value?.parameters?.retry_after) || null;
      if (response.ok && value?.ok === true) return value;
      if (response.status === 401 || response.status === 404) fail(409, "channel_connection_unavailable", "Telegram rejected the bot token. Check TELEGRAM_BOT_TOKEN.");
      if (retryablePollStatus(response.status)) continue;
      // 400/403 and other definitive answers: redelivering the same long-poll changes nothing.
      fail(503, "channel_poller_unavailable", "Telegram refused the long-poll: " + redactTelegram(value?.description ?? "unknown error"));
    }
    const headers = lastStatus === 429 && retryAfter ? { "Retry-After": Math.ceil(retryAfter) } : null;
    fail(503, "channel_poller_unavailable", lastStatus === "network" ? "Telegram could not be reached. The poller made no progress; nothing was imported or skipped."
      : lastStatus === 429 ? "Telegram is rate limiting this bot. Try again later." : "Telegram is unavailable. Try again later.", headers);
  }
  // The long-poll driver loop: yields non-empty batches until closed or the
  // signal aborts. The signal flows into the in-flight request, so aborting
  // stops promptly instead of waiting out Telegram's timeout. Transient
  // failures are retried inside getUpdates; anything still failing afterwards
  // propagates so a dev daemon dies loudly instead of spinning silently.
  async *poll({ signal = null } = {}) {
    while (true) {
      if (this.#closed || signal?.aborted) return;
      let response;
      try { response = await this.getUpdates({ signal }); }
      catch (error) { if (error?.code === "channel_poller_closed" || this.#closed || signal?.aborted) return; throw error; }
      if (response.result.length) yield response;
    }
  }
  // The poller only reads; sending belongs to a TelegramTransport attached as
  // the sender. Without one the bound adapter reports honestly unavailable.
  async submit(request) {
    if (!this.#sender) fail(409, "channel_send_unavailable", "Live Telegram sending needs a sender; the poller only reads.");
    return this.#sender.submit(request);
  }
  async lookup(request) {
    if (!this.#sender) fail(409, "channel_send_unavailable", "Live Telegram sending needs a sender; the poller only reads.");
    return this.#sender.lookup(request);
  }
  // Graceful shutdown: no new requests, and the in-flight long-poll is
  // aborted so `poll` exits instead of waiting out Telegram's timeout.
  close() { this.#closed = true; this.#inflight?.abort(); }
}
// Config-selected read driver behind the bound-adapter interface: the fixture
// stays the default until the Telegram bindings exist, exactly like
// telegramSendAdapter on the send side. `fixture` is any reader (the
// RecordedTelegramBot in tests and dev); extra options flow to the poller.
export function telegramReadAdapter({ config, fixture, connection, sender = null, status = null, ...options } = {}) {
  const profile = telegramConnection(connection);
  if (!config?.configured) {
    if (!isTelegramReader(fixture)) throw new TypeError("A fixture reader is required until Telegram is configured");
    return bind({ reader: fixture, connection: profile });
  }
  return bind({ reader: new LiveTelegramPoller({ config, connection: profile, sender, status, ...options }), connection: profile });
}
