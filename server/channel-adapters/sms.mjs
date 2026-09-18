// SMS gateway shaped adapter. Normalizes recorded gateway payloads only\u000a// (Twilio-shaped fixtures): no auth token, signature secret, webhook\u000a// registration, or send API lives here. Signature verification and delivery\u000a// callbacks live in server/sms-ingest.mjs; outbound payload building in\u000a// server/sms-outbound.mjs.
import { createHash } from "node:crypto";
import { channelParticipant, channelProfile, exactFields, requireContract } from "../channel-connection.mjs";

export const channel = "sms";
export const provider = "sms-gateway";
// SMS bodies are short; attachments are not a thing on this slice (MMS\u000a// arrives in a later task), so the attachment cap is 0.
export const smsLimits = Object.freeze({ bodyBytes: 4096, attachments: 0, updates: 100, inputBytes: 1048576 });
const object = v => v !== null && typeof v === "object" && !Array.isArray(v);
const canonical = value => Array.isArray(value) ? "[" + value.map(canonical).join(",") + "]" : object(value)
  ? "{" + Object.keys(value).sort().map(k => JSON.stringify(k) + ":" + canonical(value[k])).join(",") + "}" : JSON.stringify(value);
const digest = value => createHash("sha256").update(canonical(value)).digest("hex");
const text = (value, max, { empty = false, multiline = false } = {}) => {
  requireContract(typeof value === "string" && value.isWellFormed() && (empty || value.trim().length > 0)
    && Buffer.byteLength(value) <= max && !(multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/).test(value), "invalid_sms_message");
  return value;
};
const opaqueId = value => text(value, 2048);
const timestamp = value => {
  if (value === null) return null;
  requireContract(typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,7})?Z$/.test(value) && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString().slice(0, 19) === value.slice(0, 19), "invalid_sms_message");
  return value;
};
const count = (value, max) => { requireContract(Array.isArray(value) && value.length <= max, "invalid_sms_message"); return value; };
export function smsInput(value) {
  let serialized;
  try { serialized = JSON.stringify(value); } catch { requireContract(false, "invalid_sms_message"); }
  requireContract(typeof serialized === "string" && Buffer.byteLength(serialized) <= smsLimits.inputBytes, "sms_input_limit");
  return value;
}
export const smsConnection = value => { const c = channelProfile(value); requireContract(c.channel === channel && c.provider === provider, "unsupported_channel"); return c; };
// Same digest style as telegramSourceId: account, provider, gateway number,\u000a// then the gateway-number-qualified message id (Sids are unique per account,\u000a// qualified here so two bound numbers can never collide).
export const smsSourceId = (connection, messageId) => {
  const c = smsConnection(connection);
  return "sms-" + digest([c.accountId, c.provider, c.externalId, opaqueId(messageId)]);
};
// Delivery receipts arrive as a separate envelope kind: the room can thread\u000a// "sent / delivered / failed" under the outbound it references.
export const messageKinds = Object.freeze(["message", "delivery_receipt"]);
export const deliveryStatuses = Object.freeze(["queued", "sent", "delivered", "failed", "undelivered"]);
const messageFields = ["id", "revision", "threadId", "kind", "sentAt", "editedAt", "from", "to", "subject", "replyTo"];
export function createSmsEnvelope(input) {
  smsInput(input);
  requireContract(exactFields(input, ["connection", "message", "body", "attachments"]), "invalid_sms_message");
  const connection = smsConnection(input.connection), m = input.message;
  requireContract(exactFields(m, messageFields) && messageKinds.includes(m.kind) && m.subject === null && m.editedAt === null, "invalid_sms_message");
  const message = { id: opaqueId(m.id), revision: opaqueId(m.revision), threadId: opaqueId(m.threadId), kind: m.kind,
    sentAt: timestamp(m.sentAt), editedAt: null, from: channelParticipant(m.from),
    to: count(m.to, 1).map(channelParticipant), subject: null, replyTo: null };
  requireContract(message.to.length === 1 && message.id.startsWith(message.to[0].id + ":")
    && message.id.length > message.to[0].id.length + 1, "invalid_sms_message");
  if (message.kind === "delivery_receipt") {
    // Receipts carry the terminal status in the opaque revision slot\u000a    // ("delivered", "failed#30007"); they have no human-readable body.
    requireContract(deliveryStatuses.includes(message.revision.split("#")[0]), "invalid_sms_receipt");
  }
  requireContract(exactFields(input.body, ["format", "content"]) && input.body.format === "text", "invalid_sms_message");
  const body = { format: "text", content: text(input.body.content, smsLimits.bodyBytes, { empty: true, multiline: true }) };
  const attachments = count(input.attachments, smsLimits.attachments);
  const content = { connection, message, body, attachments };
  return { contractVersion: 1, channel, sourceId: smsSourceId(connection, message.id), sourceVersion: digest(content), ...content };
}
// Registry interface shared with the telegram adapter.
export const readEnvelope = value => readSmsEnvelope(value);
export const sourceId = (connection, messageId) => smsSourceId(connection, messageId);
export const scope = () => "updates";
export function readSmsEnvelope(value) {
  requireContract(exactFields(value, ["contractVersion", "channel", "sourceId", "sourceVersion", "connection", "message", "body", "attachments"]), "invalid_sms_message");
  const clean = createSmsEnvelope({ connection: value.connection, message: value.message, body: value.body, attachments: value.attachments });
  requireContract(value.contractVersion === 1 && value.channel === channel && value.sourceId === clean.sourceId && value.sourceVersion === clean.sourceVersion, "sms_version_mismatch");
  return clean;
}

// Twilio-shaped webhook fields. NumSegments records the concatenation count\u000a// for multipart bodies; the fixture body is already concatenated.
const phone = value => { requireContract(typeof value === "string" && /^\+[1-9]\d{1,14}$/.test(value), "invalid_sms_update"); return value; };
const sid = value => { requireContract(typeof value === "string" && /^[A-Za-z0-9]{1,64}$/.test(value), "invalid_sms_update"); return value; };
const segments = value => { requireContract(value === undefined || (Number.isSafeInteger(value) && value >= 1 && value <= 255), "invalid_sms_update"); return value ?? 1; };
// Concatenation metadata for a recorded payload: how many segments the\u000a// carrier stitched into this body. Pure; the fixture body is already joined.
export function concatenationInfo(payload) {
  smsInput(payload);
  requireContract(object(payload), "invalid_sms_update");
  return { segments: segments(payload.NumSegments), multipart: segments(payload.NumSegments) > 1 };
}
export function normalizeSmsWebhook(connection, payload) {
  smsInput({ connection, payload });
  requireContract(object(payload) && typeof payload.MessageSid === "string", "invalid_sms_update");
  const from = phone(payload.From), to = phone(payload.To), messageSid = sid(payload.MessageSid);
  const messageId = to + ":" + messageSid;
  const info = concatenationInfo(payload);
  return createSmsEnvelope({ connection,
    message: { id: messageId, revision: messageSid, threadId: to + "|" + from, kind: "message", sentAt: null, editedAt: null,
      from: { kind: "user", id: from, handle: from, displayName: from },
      to: [{ kind: "user", id: to, handle: to, displayName: to }], subject: null, replyTo: null },
    body: { format: "text", content: typeof payload.Body === "string" ? payload.Body : "" }, attachments: [] });
}
// A Twilio StatusCallback payload normalizes to a delivery_receipt envelope\u000a// referencing the original send via its MessageSid.
export function normalizeSmsStatusCallback(connection, payload) {
  smsInput({ connection, payload });
  requireContract(object(payload) && typeof payload.MessageSid === "string", "invalid_sms_update");
  const status = typeof payload.MessageStatus === "string" ? payload.MessageStatus : "";
  requireContract(deliveryStatuses.includes(status), "invalid_sms_receipt");
  const from = phone(payload.From), to = phone(payload.To), messageSid = sid(payload.MessageSid);
  const revision = payload.ErrorCode === undefined || payload.ErrorCode === null ? status : status + "#" + String(payload.ErrorCode);
  return createSmsEnvelope({ connection,
    message: { id: to + ":" + messageSid + ":receipt", revision, threadId: to + "|" + from, kind: "delivery_receipt",
      sentAt: null, editedAt: null,
      from: { kind: "user", id: from, handle: from, displayName: from },
      to: [{ kind: "user", id: to, handle: to, displayName: to }], subject: null, replyTo: null },
    body: { format: "text", content: "" }, attachments: [] });
}

// Recorded gateway: a fixture standing in for the provider webhook stream and\u000a// send endpoint. Mirrors RecordedTelegramBot (kind "sms-gateway").
export class RecordedSmsGateway {
  #connection; #inbound; #sent = new Map();
  kind = provider;
  mode = "accepted";
  constructor(recording) {
    smsInput(recording);
    requireContract(object(recording) && Array.isArray(recording.inbound) && recording.inbound.length <= 1000, "invalid_sms_recording");
    this.#connection = smsConnection(recording.connection);
    this.#inbound = structuredClone(recording.inbound);
  }
  get connection() { return structuredClone(this.#connection); }
  inbound() { return structuredClone(this.#inbound); }
  async submit({ operationId, envelope }) {
    requireContract(envelope?.provider === provider && envelope.adapter === channel, "sms_transport_mismatch");
    const prior = this.#sent.get(operationId);
    if (prior && prior.previewVersion !== envelope.previewVersion) throw new Error("SMS correlation conflict");
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
  requireContract(reader instanceof RecordedSmsGateway, "sms_fixture_reader_required");
  const profile = smsConnection(connection);
  return {
    channel, provider,
    normalize: raw => normalizeSmsWebhook(profile, raw),
    normalizeStatus: raw => normalizeSmsStatusCallback(profile, raw),
    sourceId: messageId => smsSourceId(profile, messageId),
    scope: () => "updates",
    async changes({ cursor = null } = {}) {
      requireContract(cursor === null || (typeof cursor === "string" && /^\d+$/.test(cursor)), "invalid_sms_cursor");
      const start = cursor === null ? 0 : Number(cursor);
      const page = reader.inbound().slice(start, start + smsLimits.updates);
      return { contractVersion: 1, connection: profile, changes: page.map((raw, i) => ({ messageId: "cursor:" + (start + i), action: "hydrate", updateId: start + i })), cursor: String(start + page.length), complete: page.length < smsLimits.updates };
    },
    async hydrate(messageId) { const m = /^cursor:(\d+)$/.exec(messageId); return m ? reader.inbound()[Number(m[1])] ?? null : null; },
    submit: request => reader.submit(request),
    lookup: request => reader.lookup(request)
  };
}
