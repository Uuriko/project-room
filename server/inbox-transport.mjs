// Fixture qualification driver. Real providers require a separately reviewed
// adapter, credentials, capabilities and external-send authority.
import { createHash } from "node:crypto";
import { ServiceError } from "./store.mjs";
import { previewProvider } from "./inbox-outbox.mjs";

const operation = (kind, value) => kind + "-" + createHash("sha256").update(JSON.stringify(value)).digest("hex");
export class SyntheticInboxTransport {
  constructor(inbox, adapter) {
    if (typeof adapter?.kind !== "string" || !adapter.kind || typeof adapter.submit !== "function" || typeof adapter.lookup !== "function")
      throw new TypeError("A submit/lookup adapter with a provider kind is required");
    this.inbox = inbox; this.adapter = adapter;
  }
  current(token, sourceId, sendId, binding) {
    const view = this.inbox.sends(token, sourceId, binding), send = view.sends.find(s => s.id === sendId);
    if (!send) throw new ServiceError(404, "inbox_send_not_found", "Reply attempt not found.");
    // An attempt only ever reaches the transport for its own provider.
    if (previewProvider(send.envelope) !== this.adapter.kind) throw new ServiceError(409, "inbox_transport_mismatch", "This reply belongs to a different provider.");
    return send;
  }
  correlation(send) { return operation("reply", [send.envelope.accountId, send.id, send.envelope.previewVersion]); }
  async dispatch(token, sourceId, sendId, binding) {
    const send = this.current(token, sourceId, sendId, binding);
    if (send.status !== "queued") return send;
    const started = this.inbox.transport(token, { action: "send.dispatch", requestId: operation("dispatch", [sendId, send.revision]),
      sourceId, sendId, expectedRevision: send.revision }, binding);
    if (started.duplicate) return this.current(token, sourceId, sendId, binding);
    let observed;
    try { observed = await this.adapter.submit({ operationId: this.correlation(send), envelope: structuredClone(send.envelope) }); }
    catch { return this.current(token, sourceId, sendId, binding); }
    return this.observe(token, started.receipt.send, observed, binding);
  }
  async reconcile(token, sourceId, sendId, binding) {
    const send = this.current(token, sourceId, sendId, binding);
    if (!["unknown", "accepted"].includes(send.status)) return send;
    let observed;
    try { observed = await this.adapter.lookup({ operationId: this.correlation(send), previewVersion: send.envelope.previewVersion }); }
    catch { return this.current(token, sourceId, sendId, binding); }
    return this.observe(token, send, observed, binding);
  }
  observe(token, send, observed, binding) {
    // Missing, uncorrelated and unsupported evidence leaves the attempt unknown;
    // "not found" cannot establish that another request was never accepted.
    if (!observed || observed.operationId !== this.correlation(send) || observed.previewVersion !== send.envelope.previewVersion
      || !["accepted", "delivered", "rejected", "bounced"].includes(observed.outcome))
      return this.current(token, send.sourceId, send.id, binding);
    if (send.status === observed.outcome && send.providerId === observed.providerId)
      return this.current(token, send.sourceId, send.id, binding);
    const request = { action: "send.observe", requestId: operation("observation", [send.id, send.revision, observed]),
      sourceId: send.sourceId, sendId: send.id, expectedRevision: send.revision, outcome: observed.outcome, providerId: observed.providerId };
    try { return this.inbox.transport(token, request, binding).receipt.send; }
    catch (error) {
      if (["stale_inbox_send", "conflicting_inbox_observation", "invalid_inbox_send"].includes(error.code))
        return this.current(token, send.sourceId, send.id, binding);
      throw error;
    }
  }
}

// Inert stand-in for a channel provider whose live bindings are not set. It
// records what would have been sent and answers "accepted" so the reply
// journey can be exercised end to end; nothing leaves the process and the
// browser labels every outcome a sample. `mode = "rejected"` rehearses a
// definitive provider refusal.
export class FixtureChannelSender {
  #sent = new Map(); #status; #scope; #now;
  mode = "accepted";
  constructor({ kind, status = null, accountId = null, connectionId = null, now = () => Date.now() }) {
    if (typeof kind !== "string" || !kind) throw new TypeError("A provider kind is required");
    this.kind = kind; this.#status = status; this.#scope = { accountId, connectionId }; this.#now = now;
  }
  async submit({ operationId, envelope }) {
    const prior = this.#sent.get(operationId);
    if (prior && prior.previewVersion !== envelope.previewVersion) throw new ServiceError(409, "conflicting_inbox_observation", "This operation key already recorded a different reply.");
    if (!prior) {
      const outcome = this.mode === "rejected" ? "rejected" : "accepted";
      this.#sent.set(operationId, { operationId, previewVersion: envelope.previewVersion, outcome, providerId: outcome === "accepted" ? "fixture:" + operationId : null,
        ...(outcome === "rejected" ? { code: "fixture_rejected" } : {}) });
      this.#status?.sent(this.#scope.accountId, this.#scope.connectionId, { at: this.#now(), outcome, code: "fixture" });
    }
    return structuredClone(this.#sent.get(operationId));
  }
  async lookup({ operationId }) { const receipt = this.#sent.get(operationId); return receipt ? structuredClone(receipt) : null; }
  get submits() { return this.#sent.size; }
}

// ---------------------------------------------------------------------------
// Direct live sends: compose → provider, without an inbox source. These are the
// delivery drivers for POST /api/inbox/channel-sends {channel, to, subject,
// body, threadId?}. Every driver is honest about missing credentials: a
// channel that is not connected reports it instead of faking a send, and no
// tokens, bodies or credentials are ever logged.

export const directSendChannels = Object.freeze(["gmail", "telegram"]);
const GMAIL_SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
const GMAIL_TOKEN_URL = "https://oauth2.googleapis.com/token";
const gmailFail = (status, code, message) => { throw new ServiceError(status, code, message); };

// Stored Gmail send credentials for the account, or null. Today this always
// returns null: Google sign-in is OIDC-only (`openid email profile` scope,
// `access_type: 'online'`), so no OAuth tokens are stored and no gmail.send
// grant exists. A future encrypted token-storage upgrade plugs in here; until
// then GmailSender honestly reports gmail_not_connected.
export function gmailCredentialsFor(store, accountId) {
  void store; void accountId;
  return null;
}

// Minimal RFC 2822 message for users.messages.send: headers + plain-text body,
// base64url-encoded. Pure, so tests can inspect it without touching the API.
export function buildGmailRawMessage({ to, subject, body }) {
  if (typeof to !== "string" || typeof subject !== "string" || typeof body !== "string") gmailFail(422, "invalid_direct_send", "A recipient, subject and body are required.");
  const lines = [`To: ${to}`, `Subject: ${subject.replace(/[\r\n]+/g, " ")}`, "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "", body];
  return Buffer.from(lines.join("\r\n"), "utf8").toString("base64url");
}

export class GmailSender {
  #fetch; #credentialProvider;
  constructor({ fetchImpl = globalThis.fetch, credentialProvider = null } = {}) {
    if (typeof fetchImpl !== "function") throw new TypeError("A fetch implementation is required");
    this.#fetch = fetchImpl; this.#credentialProvider = credentialProvider;
  }
  async #credentials() {
    try { return await this.#credentialProvider?.(); }
    catch { return null; }
  }
  async #post(raw, accessToken) {
    let response;
    try {
      response = await this.#fetch(GMAIL_SEND_URL, { method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + accessToken },
        body: JSON.stringify({ raw }), signal: AbortSignal.timeout(15000) });
    } catch { gmailFail(502, "gmail_unavailable", "Gmail could not be reached. Nothing was sent."); }
    let value = null;
    try { value = await response.json(); } catch { value = null; }
    return { status: response.status, value };
  }
  async #refresh(refreshToken, clientId, clientSecret) {
    let response;
    try {
      response = await this.#fetch(GMAIL_TOKEN_URL, { method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" }).toString(),
        signal: AbortSignal.timeout(15000) });
    } catch { gmailFail(502, "gmail_unavailable", "Gmail could not be reached. Nothing was sent."); }
    if (!response.ok) gmailFail(422, "gmail_not_connected", "Gmail access expired. Reconnect Gmail; nothing was sent.");
    let value = null;
    try { value = await response.json(); } catch { value = null; }
    if (typeof value?.access_token !== "string" || !value.access_token) gmailFail(422, "gmail_not_connected", "Gmail access expired. Reconnect Gmail; nothing was sent.");
    return value.access_token;
  }
  async send({ to, subject, body }) {
    const creds = await this.#credentials();
    if (!creds || typeof creds.accessToken !== "string" || !creds.accessToken)
      gmailFail(422, "gmail_not_connected", "Gmail sending is not connected for this account. Nothing was sent.");
    const raw = buildGmailRawMessage({ to, subject, body });
    let token = creds.accessToken;
    for (let attempt = 0; attempt < 2; attempt++) {
      const { status, value } = await this.#post(raw, token);
      if (status === 401 || status === 403) {
        if (attempt === 0 && typeof creds.refreshToken === "string" && creds.refreshToken && creds.clientId && creds.clientSecret) {
          token = await this.#refresh(creds.refreshToken, creds.clientId, creds.clientSecret);
          continue;
        }
        gmailFail(422, "gmail_not_connected", status === 403
          ? "Gmail refused the send: the connected account lacks the Gmail send permission. Reconnect with Gmail access; nothing was sent."
          : "Gmail access expired. Reconnect Gmail; nothing was sent.");
      }
      if (status === 429 || status >= 500) gmailFail(502, "gmail_unavailable", "Gmail is temporarily unavailable. Nothing was confirmed sent; check before retrying.");
      if (status < 200 || status >= 300 || typeof value?.id !== "string")
        gmailFail(502, "gmail_send_failed", "Gmail did not confirm the send. Nothing was confirmed sent.");
      return { id: value.id, threadId: typeof value.threadId === "string" ? value.threadId : null };
    }
    gmailFail(422, "gmail_not_connected", "Gmail access expired. Reconnect Gmail; nothing was sent.");
  }
}

// One Telegram sendMessage call for a direct send. Pure request builder, so
// tests can inspect it without a bot token.
export function buildTelegramDirectRequest({ to, text }) {
  if (!/^-?\d{1,20}$/.test(to)) gmailFail(422, "invalid_direct_send", "A Telegram chat id is required.");
  if (typeof text !== "string" || !text.trim() || text.length > 4096 || !text.isWellFormed())
    gmailFail(422, "invalid_direct_send", "Message text must be 1–4096 characters.");
  return { method: "sendMessage", body: { chat_id: Number(to), text } };
}

export async function sendTelegramDirect({ config, to, text, fetchImpl = globalThis.fetch }) {
  if (!config || config.configured !== true || typeof config.methodUrl !== "function")
    gmailFail(422, "telegram_not_connected", "Telegram sending is not configured here. Nothing was sent.");
  const request = buildTelegramDirectRequest({ to, text });
  let response, value = null;
  try {
    response = await fetchImpl(config.methodUrl(request.method), { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(request.body), signal: AbortSignal.timeout(15000) });
    try { value = await response.json(); } catch { value = null; }
  } catch { gmailFail(502, "telegram_unavailable", "Telegram could not be reached. Nothing was confirmed sent."); }
  if (response.status === 400 || response.status === 403)
    gmailFail(422, "telegram_send_rejected", "Telegram refused the message (unknown chat, blocked, or bad request). Nothing was sent.");
  if (response.status === 401)
    gmailFail(422, "telegram_not_connected", "Telegram refused the bot token. Check the connection; nothing was sent.");
  if (response.status === 429 || response.status >= 500)
    gmailFail(502, "telegram_unavailable", "Telegram is temporarily unavailable. Nothing was confirmed sent; check before retrying.");
  if (!response.ok || value?.ok !== true || typeof value?.result?.message_id === "undefined")
    gmailFail(502, "telegram_send_failed", "Telegram did not confirm the send. Nothing was confirmed sent.");
  return { messageId: String(value.result.message_id) };
}
