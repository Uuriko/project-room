// Facebook Messenger shaped adapter. Normalizes recorded webhook payloads
// only: no app secret, webhook verification, fetch, or send API lives here.
// HMAC verification lives in server/messenger-ingest.mjs; outbound payload
// building in server/messenger-outbound.mjs.
//
// A recorded payload is a Messenger `page` webhook body:
// { object: "page", entry: [{ id, time, messaging: [event] }] }. Each event
// carries sender/recipient ids, a timestamp, and one of message / postback /
// read / optin. Unknown event shapes are skipped, never imported.
import { createHash } from "node:crypto";
import { channelParticipant, channelProfile, exactFields, requireContract } from "../channel-connection.mjs";

export const channel = "messenger";
export const provider = "messenger-api";
export const messengerLimits = Object.freeze({ bodyBytes: 16384, attachments: 0, updates: 100, inputBytes: 1048576 });
const object = v => v !== null && typeof v === "object" && !Array.isArray(v);
const canonical = value => Array.isArray(value) ? "[" + value.map(canonical).join(",") + "]" : object(value)
  ? "{" + Object.keys(value).sort().map(k => JSON.stringify(k) + ":" + canonical(value[k])).join(",") + "}" : JSON.stringify(value);
const digest = value => createHash("sha256").update(canonical(value)).digest("hex");
// Control-character check without regex escapes: single-line text allows no
// C0 controls or DEL; multiline additionally allows tab, LF, and CR.
const hasControlChars = (value, multiline) => {
  for (const ch of value) {
    const c = ch.codePointAt(0);
    if (c === 0x7f) return true;
    if (c < 0x20 && !(multiline && (c === 0x09 || c === 0x0a || c === 0x0d))) return true;
  }
  return false;
};
const text = (value, max, { empty = false, multiline = false } = {}) => {
  requireContract(typeof value === "string" && value.isWellFormed() && (empty || value.trim().length > 0)
    && Buffer.byteLength(value) <= max && !hasControlChars(value, multiline), "invalid_messenger_message");
  return value;
};
const opaqueId = value => text(value, 2048);
const timestamp = value => {
  if (value === null) return null;
  requireContract(typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,7})?Z$/.test(value) && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString().slice(0, 19) === value.slice(0, 19), "invalid_messenger_message");
  return value;
};
const count = (value, max) => { requireContract(Array.isArray(value) && value.length <= max, "invalid_messenger_message"); return value; };
export function messengerInput(value) {
  let serialized;
  try { serialized = JSON.stringify(value); } catch { requireContract(false, "invalid_messenger_message"); }
  requireContract(typeof serialized === "string" && Buffer.byteLength(serialized) <= messengerLimits.inputBytes, "messenger_input_limit");
  return value;
}
export const messengerConnection = value => { const c = channelProfile(value); requireContract(c.channel === channel && c.provider === provider, "unsupported_channel"); return c; };
// Same digest style as smsSourceId: account, provider, page id, then the
// page-qualified event id (mids are unique per page).
export const messengerSourceId = (connection, messageId) => {
  const c = messengerConnection(connection);
  return "messenger-" + digest([c.accountId, c.provider, c.externalId, opaqueId(messageId)]);
};
// Postbacks carry the tap payload in the opaque revision slot; read receipts
// and optins have no human-readable body.
export const messageKinds = Object.freeze(["message", "postback", "read_receipt", "optin"]);
const messageFields = ["id", "revision", "threadId", "kind", "sentAt", "editedAt", "from", "to", "subject", "replyTo"];
export function createMessengerEnvelope(input) {
  messengerInput(input);
  requireContract(exactFields(input, ["connection", "message", "body", "attachments"]), "invalid_messenger_message");
  const connection = messengerConnection(input.connection), m = input.message;
  requireContract(exactFields(m, messageFields) && messageKinds.includes(m.kind) && m.subject === null && m.editedAt === null, "invalid_messenger_message");
  const message = { id: opaqueId(m.id), revision: opaqueId(m.revision), threadId: opaqueId(m.threadId), kind: m.kind,
    sentAt: timestamp(m.sentAt), editedAt: null, from: channelParticipant(m.from),
    to: count(m.to, 1).map(channelParticipant), subject: null, replyTo: null };
  requireContract(message.to.length === 1 && message.id.startsWith(message.to[0].id + ":")
    && message.id.length > message.to[0].id.length + 1, "invalid_messenger_message");
  requireContract(exactFields(input.body, ["format", "content"]) && input.body.format === "text", "invalid_messenger_message");
  const emptyOk = message.kind === "read_receipt" || message.kind === "optin";
  const body = { format: "text", content: text(input.body.content, messengerLimits.bodyBytes, { empty: emptyOk, multiline: true }) };
  const attachments = count(input.attachments, messengerLimits.attachments);
  const content = { connection, message, body, attachments };
  return { contractVersion: 1, channel, sourceId: messengerSourceId(connection, message.id), sourceVersion: digest(content), ...content };
}
// Registry interface shared with the sms adapter.
export const readEnvelope = value => readMessengerEnvelope(value);
export const sourceId = (connection, messageId) => messengerSourceId(connection, messageId);
export const scope = () => "updates";
export function readMessengerEnvelope(value) {
  requireContract(exactFields(value, ["contractVersion", "channel", "sourceId", "sourceVersion", "connection", "message", "body", "attachments"]), "invalid_messenger_message");
  const clean = createMessengerEnvelope({ connection: value.connection, message: value.message, body: value.body, attachments: value.attachments });
  requireContract(value.contractVersion === 1 && value.channel === channel && value.sourceId === clean.sourceId && value.sourceVersion === clean.sourceVersion, "messenger_version_mismatch");
  return clean;
}

// Raw webhook shapes. PSIDs/mids are opaque strings; nothing is fetched.
const psid = value => { requireContract(typeof value === "string" && /^[0-9]{1,32}$/.test(value), "invalid_messenger_update"); return value; };
const mid = value => { requireContract(typeof value === "string" && value.length >= 1 && value.length <= 512 && value.isWellFormed(), "invalid_messenger_update"); return value; };
const pageId = value => { requireContract(typeof value === "string" && /^[0-9]{1,32}$/.test(value), "invalid_messenger_update"); return value; };
// Webhook timestamps are Unix millis within the ISO range Date can format.
const maxMessengerMillis = 253402300799999;
const at = millis => { requireContract(Number.isSafeInteger(millis) && millis >= 0 && millis <= maxMessengerMillis, "invalid_messenger_update"); return new Date(millis).toISOString(); };
// Event classifier: exactly one known shape per messaging event; anything
// else is skipped by the importer (returns null), never normalized.
export const eventKind = event => {
  if (!object(event)) return null;
  if (object(event.message) && typeof event.message.mid === "string") return "message";
  if (object(event.postback) && typeof event.postback.payload === "string") return "postback";
  if (object(event.read)) return "read_receipt";
  if (object(event.optin)) return "optin";
  return null;
};
function participants(event, page) {
  const from = { kind: "user", id: psid(event.sender?.id), handle: "", displayName: "" };
  const to = { kind: "user", id: psid(event.recipient?.id), handle: "", displayName: "page:" + page };
  return { from, to };
}
export function normalizeMessengerEvent(connection, page, event) {
  messengerInput({ connection, page, event });
  const kind = eventKind(event);
  requireContract(kind, "unsupported_messenger_event");
  const pageStr = pageId(page);
  const { from, to } = participants(event, pageStr);
  const sentAt = event.timestamp === undefined ? null : at(event.timestamp);
  const threadId = pageStr + "|" + from.id;
  const base = { threadId, kind, sentAt, editedAt: null, from, to: [to], subject: null, replyTo: null };
  if (kind === "message") {
    const m = event.message, messageId = pageStr + ":" + mid(m.mid);
    const quickReply = object(m.quick_reply) && typeof m.quick_reply.payload === "string" ? m.quick_reply.payload : null;
    return createMessengerEnvelope({ connection,
      message: { ...base, id: messageId, revision: quickReply === null ? mid(m.mid) : quickReply },
      body: { format: "text", content: typeof m.text === "string" ? m.text : "" }, attachments: [] });
  }
  if (kind === "postback") {
    const p = event.postback, messageId = pageStr + ":" + (typeof p.mid === "string" ? mid(p.mid) : "postback-" + String(event.timestamp ?? "0"));
    return createMessengerEnvelope({ connection,
      message: { ...base, id: messageId, revision: text(p.payload, 2048) },
      body: { format: "text", content: typeof p.title === "string" ? p.title : p.payload }, attachments: [] });
  }
  if (kind === "read_receipt") {
    const watermark = event.read.watermark;
    requireContract(Number.isSafeInteger(watermark), "invalid_messenger_update");
    return createMessengerEnvelope({ connection,
      message: { ...base, id: pageStr + ":read:" + String(watermark), revision: "read:" + String(watermark) },
      body: { format: "text", content: "" }, attachments: [] });
  }
  const ref = event.optin.ref;
  return createMessengerEnvelope({ connection,
    message: { ...base, id: pageStr + ":optin:" + String(event.timestamp ?? "0"), revision: typeof ref === "string" ? ref : "optin" },
    body: { format: "text", content: "" }, attachments: [] });
}
// A recorded `page` webhook body normalizes to zero or more envelopes; the
// importer skips unknown event shapes with their positions recorded.
export function normalizeMessengerWebhook(connection, payload) {
  messengerInput(payload);
  requireContract(object(payload) && payload.object === "page" && Array.isArray(payload.entry), "invalid_messenger_update");
  const envelopes = [], skipped = [];
  for (const entry of payload.entry) {
    requireContract(object(entry) && Array.isArray(entry.messaging), "invalid_messenger_update");
    const page = pageId(entry.id);
    for (const event of entry.messaging) {
      if (!eventKind(event)) { skipped.push({ page }); continue; }
      envelopes.push(normalizeMessengerEvent(connection, page, event));
    }
  }
  return { envelopes, skipped };
}

// Recorded page: a fixture standing in for the Messenger webhook stream and
// send endpoint. Mirrors RecordedSmsGateway (kind "messenger-api").
export class RecordedMessengerPage {
  #connection; #events; #sent = new Map();
  kind = provider;
  mode = "accepted";
  constructor(recording) {
    messengerInput(recording);
    requireContract(object(recording) && Array.isArray(recording.events) && recording.events.length <= 1000, "invalid_messenger_recording");
    this.#connection = messengerConnection(recording.connection);
    this.#events = structuredClone(recording.events);
  }
  get connection() { return structuredClone(this.#connection); }
  events() { return structuredClone(this.#events); }
  async submit({ operationId, envelope }) {
    requireContract(envelope?.provider === provider && envelope.adapter === channel, "messenger_transport_mismatch");
    const prior = this.#sent.get(operationId);
    if (prior && prior.previewVersion !== envelope.previewVersion) throw new Error("Messenger correlation conflict");
    if (!prior) {
      const outcome = this.mode === "rejected" ? "rejected" : "accepted";
      this.#sent.set(operationId, { operationId, previewVersion: envelope.previewVersion, outcome, providerId: outcome === "rejected" ? null : operationId, envelope: structuredClone(envelope) });
    }
    const { envelope: _envelope, ...receipt } = this.#sent.get(operationId);
    return receipt;
  }
  async lookup({ operationId }) {
    const row = this.#sent.get(operationId);
    if (!row) return null;
    const { envelope: _envelope, ...receipt } = row;
    return receipt;
  }
  sent() { return [...this.#sent.values()].map(row => structuredClone(row.envelope)); }
}
// Bound adapter: the uniform interface every channel driver presents to the importer.
export function bind({ reader, connection }) {
  requireContract(reader instanceof RecordedMessengerPage, "messenger_fixture_reader_required");
  const profile = messengerConnection(connection);
  return {
    channel, provider,
    normalize: raw => normalizeMessengerEvent(profile, raw.page, raw.event),
    normalizeWebhook: raw => normalizeMessengerWebhook(profile, raw),
    sourceId: messageId => messengerSourceId(profile, messageId),
    scope: () => "updates",
    async changes({ cursor = null } = {}) {
      requireContract(cursor === null || (typeof cursor === "string" && /^\d+$/.test(cursor)), "invalid_messenger_cursor");
      const start = cursor === null ? 0 : Number(cursor);
      const page = reader.events().slice(start, start + messengerLimits.updates);
      return { contractVersion: 1, connection: profile, changes: page.map((raw, i) => ({ messageId: "cursor:" + (start + i), action: "hydrate", updateId: start + i })), cursor: String(start + page.length), complete: page.length < messengerLimits.updates };
    },
    async hydrate(messageId) { const m = /^cursor:(\d+)$/.exec(messageId); return m ? reader.events()[Number(m[1])] ?? null : null; },
    submit: request => reader.submit(request),
    lookup: request => reader.lookup(request)
  };
}
