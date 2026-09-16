// WhatsApp Cloud API shaped adapter. Normalizes recorded webhook payloads
// only: no access token, webhook verification, fetch, or send API lives here.
//
// A recorded payload is a Meta `whatsapp_business_account` webhook body:
// { object, entry: [{ id, changes: [{ value, field }] }] }. Each change value
// carries metadata (the business number), contacts (sender display names)
// and messages[]. Only text messages normalize; every other message type is
// skipped with a reason, status-only changes are ignored, and outbound is
// refused by design (B23: channel_sending_unavailable).
import { createHash } from "node:crypto";
import { ContractError, channelParticipant, channelProfile, exactFields, requireContract } from "../channel-connection.mjs";

export const channel = "whatsapp";
export const provider = "whatsapp-cloud";
// This slice carries no attachments: media arrives in a later task, so the
// attachment cap is 0 and every envelope ships with an empty list.
export const whatsappLimits = Object.freeze({ bodyBytes: 16384, attachments: 0, updates: 100, inputBytes: 1048576 });
const object = v => v !== null && typeof v === "object" && !Array.isArray(v);
const canonical = value => Array.isArray(value) ? "[" + value.map(canonical).join(",") + "]" : object(value)
  ? "{" + Object.keys(value).sort().map(k => JSON.stringify(k) + ":" + canonical(value[k])).join(",") + "}" : JSON.stringify(value);
const digest = value => createHash("sha256").update(canonical(value)).digest("hex");
const text = (value, max, { empty = false, multiline = false } = {}) => {
  requireContract(typeof value === "string" && value.isWellFormed() && (empty || value.trim().length > 0)
    && Buffer.byteLength(value) <= max && !(multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/).test(value), "invalid_whatsapp_message");
  return value;
};
const opaqueId = value => text(value, 2048);
const timestamp = value => {
  if (value === null) return null;
  requireContract(typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,7})?Z$/.test(value) && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString().slice(0, 19) === value.slice(0, 19), "invalid_whatsapp_message");
  return value;
};
const count = (value, max) => { requireContract(Array.isArray(value) && value.length <= max, "invalid_whatsapp_message"); return value; };
export function whatsappInput(value) {
  let serialized;
  try { serialized = JSON.stringify(value); } catch { requireContract(false, "invalid_whatsapp_message"); }
  requireContract(typeof serialized === "string" && Buffer.byteLength(serialized) <= whatsappLimits.inputBytes, "whatsapp_input_limit");
  return value;
}
export const whatsappConnection = value => { const c = channelProfile(value); requireContract(c.channel === channel && c.provider === provider, "unsupported_channel"); return c; };
// Same digest style as telegramSourceId: account, provider, business number,
// then the number-qualified message id (wamids are unique per business number).
export const whatsappSourceId = (connection, messageId) => {
  const c = whatsappConnection(connection);
  return "whatsapp-" + digest([c.accountId, c.provider, c.externalId, opaqueId(messageId)]);
};
export const messageKinds = Object.freeze(["message"]);
const messageFields = ["id", "revision", "threadId", "kind", "sentAt", "editedAt", "from", "to", "subject", "replyTo"];
export function createWhatsappEnvelope(input) {
  whatsappInput(input);
  requireContract(exactFields(input, ["connection", "message", "body", "attachments"]), "invalid_whatsapp_message");
  const connection = whatsappConnection(input.connection), m = input.message;
  requireContract(exactFields(m, messageFields) && messageKinds.includes(m.kind) && m.subject === null && m.editedAt === null, "invalid_whatsapp_message");
  const message = { id: opaqueId(m.id), revision: opaqueId(m.revision), threadId: opaqueId(m.threadId), kind: m.kind,
    sentAt: timestamp(m.sentAt), editedAt: null, from: channelParticipant(m.from),
    to: count(m.to, 1).map(channelParticipant), subject: null, replyTo: m.replyTo === null ? null : opaqueId(m.replyTo) };
  requireContract(message.to.length === 1 && message.id.startsWith(message.to[0].id + ":")
    && message.id.length > message.to[0].id.length + 1, "invalid_whatsapp_message");
  requireContract(exactFields(input.body, ["format", "content"]) && input.body.format === "text", "invalid_whatsapp_message");
  const body = { format: "text", content: text(input.body.content, whatsappLimits.bodyBytes, { empty: true, multiline: true }) };
  requireContract(Array.isArray(input.attachments) && input.attachments.length === 0, "invalid_whatsapp_message");
  const content = { connection, message, body, attachments: [] };
  return { contractVersion: 1, channel, sourceId: whatsappSourceId(connection, message.id), sourceVersion: digest(content), ...content };
}
// Registry interface shared with the email and telegram adapters.
export const readEnvelope = value => readWhatsappEnvelope(value);
export const sourceId = (connection, messageId) => whatsappSourceId(connection, messageId);
export const scope = () => "updates";
export function readWhatsappEnvelope(value) {
  requireContract(exactFields(value, ["contractVersion", "channel", "sourceId", "sourceVersion", "connection", "message", "body", "attachments"]), "invalid_whatsapp_message");
  const clean = createWhatsappEnvelope({ connection: value.connection, message: value.message, body: value.body, attachments: value.attachments });
  requireContract(value.contractVersion === 1 && value.channel === channel && value.sourceId === clean.sourceId && value.sourceVersion === clean.sourceVersion, "whatsapp_version_mismatch");
  return clean;
}

// Raw webhook shapes. wamids stay opaque strings; nothing is fetched.
// Meta timestamps are digit strings of Unix seconds; the ISO range Date can
// format (year 9999) keeps a hostile `timestamp` a 422 contract error rather
// than a RangeError from toISOString.
const maxWhatsAppSeconds = 253402300799;
const at = value => {
  requireContract(typeof value === "string" && /^\d{1,15}$/.test(value), "invalid_whatsapp_update");
  const seconds = Number(value);
  requireContract(Number.isSafeInteger(seconds) && seconds <= maxWhatsAppSeconds, "invalid_whatsapp_update");
  return new Date(seconds * 1000).toISOString();
};
const metadata = value => {
  requireContract(object(value) && object(value.metadata), "invalid_whatsapp_update");
  const { phone_number_id, display_phone_number } = value.metadata;
  requireContract(typeof phone_number_id === "string" && /^\d{1,20}$/.test(phone_number_id), "invalid_whatsapp_update");
  requireContract(typeof display_phone_number === "string" && display_phone_number.length > 0, "invalid_whatsapp_update");
  return { numberId: phone_number_id, displayNumber: display_phone_number };
};
const displayNameFor = (value, waId) => {
  if (value.contacts === undefined) return "";
  requireContract(Array.isArray(value.contacts), "invalid_whatsapp_update");
  for (const contact of value.contacts) {
    requireContract(object(contact) && typeof contact.wa_id === "string", "invalid_whatsapp_update");
    if (contact.wa_id !== waId) continue;
    if (contact.profile === undefined) return "";
    requireContract(object(contact.profile), "invalid_whatsapp_update");
    if (contact.profile.name === undefined) return "";
    requireContract(typeof contact.profile.name === "string", "invalid_whatsapp_update");
    return contact.profile.name;
  }
  return "";
};
// Flat (value, message) pairs for every message in a webhook payload.
// Status-only or foreign-product changes carry no messages and are ignored.
function messageItems(payload) {
  requireContract(object(payload) && payload.object === "whatsapp_business_account" && Array.isArray(payload.entry), "invalid_whatsapp_update");
  const items = [];
  for (const entry of payload.entry) {
    requireContract(object(entry) && Array.isArray(entry.changes), "invalid_whatsapp_update");
    for (const change of entry.changes) {
      requireContract(object(change) && (change.value === undefined || object(change.value)), "invalid_whatsapp_update");
      const value = change.value;
      // Changes without message-shaped data (status receipts, value-less
      // signals) carry nothing to import.
      if (!object(value) || value.messages === undefined) continue;
      // Message-shaped data for another product is refused loudly, never
      // silently dropped.
      requireContract(value.messaging_product === "whatsapp", "unsupported_whatsapp_update");
      requireContract(Array.isArray(value.messages), "invalid_whatsapp_update");
      for (const message of value.messages) {
        requireContract(object(message) && typeof message.type === "string" && typeof message.id === "string", "invalid_whatsapp_update");
        items.push({ value, message });
      }
    }
  }
  return items;
}
const sender = (value, message) => {
  requireContract(typeof message.from === "string" && /^\d{1,20}$/.test(message.from), "invalid_whatsapp_update");
  return { kind: "user", id: message.from, handle: "", displayName: displayNameFor(value, message.from) };
};
const recipient = (numberId, displayNumber) => ({ kind: "bot", id: numberId, handle: "", displayName: displayNumber });
export function normalizeWhatsappUpdate(connection, update) {
  whatsappInput({ connection, update });
  requireContract(exactFields(update, ["value", "message"]), "invalid_whatsapp_update");
  const { value, message } = update;
  requireContract(object(value) && value.messaging_product === "whatsapp", "unsupported_whatsapp_update");
  requireContract(object(message), "invalid_whatsapp_update");
  // Non-text messages are well formed but out of scope for this slice: the
  // paging layer skips them with a reason, direct normalization refuses.
  requireContract(message.type === "text" && object(message.text) && typeof message.text.body === "string", "unsupported_whatsapp_message");
  requireContract(typeof message.id === "string" && message.id.length > 0 && message.id.length <= 512, "invalid_whatsapp_update");
  const { numberId, displayNumber } = metadata(value);
  const messageId = numberId + ":" + message.id;
  const sentAt = at(message.timestamp);
  let replyTo = null;
  if (message.context !== undefined) {
    requireContract(object(message.context) && typeof message.context.id === "string" && message.context.id.length > 0, "invalid_whatsapp_update");
    replyTo = numberId + ":" + message.context.id;
  }
  return createWhatsappEnvelope({ connection,
    message: { id: messageId, revision: String(Math.floor(Date.parse(sentAt) / 1000)), threadId: numberId + ":" + message.from,
      kind: "message", sentAt, editedAt: null, from: sender(value, message),
      to: [recipient(numberId, displayNumber)], subject: null, replyTo },
    body: { format: "text", content: message.text.body }, attachments: [] });
}
// Normalize a whole webhook payload: one envelope per text message, plus the
// skipped non-text messages with their reasons.
export function normalizeWhatsappPayload(connection, payload) {
  whatsappInput({ connection, payload });
  const profile = whatsappConnection(connection);
  const envelopes = [], skipped = [];
  for (const { value, message } of messageItems(payload)) {
    if (message.type !== "text") {
      const numberId = object(value.metadata) && typeof value.metadata.phone_number_id === "string" ? value.metadata.phone_number_id : "?";
      skipped.push({ messageId: numberId + ":" + message.id, reason: "unsupported_whatsapp_message_type:" + message.type });
      continue;
    }
    envelopes.push(normalizeWhatsappUpdate(profile, { value, message }));
  }
  return { envelopes, skipped };
}
// A recorded delivery batch: the webhook payloads Meta would have POSTed,
// flattened into one change per text message. Non-text messages are listed
// under `skipped` with a reason, never imported.
export function whatsappUpdates(connectionValue, response, { offset = null, limit = whatsappLimits.updates } = {}) {
  whatsappInput(response);
  const connection = whatsappConnection(connectionValue);
  requireContract(object(response) && response.ok === true && Array.isArray(response.result) && response.result.length <= limit, "invalid_whatsapp_updates");
  const consumed = offset === null ? 0 : Number(qualifyWhatsappCursor(offset));
  const changes = [], skipped = [];
  for (const payload of response.result) {
    const { envelopes, skipped: payloadSkipped } = normalizeWhatsappPayload(connection, payload);
    for (const envelope of envelopes) changes.push({ messageId: envelope.message.id, action: "hydrate" });
    skipped.push(...payloadSkipped);
  }
  return { contractVersion: 1, connection, changes, skipped, cursor: String(consumed + response.result.length), complete: response.result.length < limit };
}
export function qualifyWhatsappCursor(cursor) {
  requireContract(typeof cursor === "string" && /^\d{1,20}$/.test(cursor) && Number.isSafeInteger(Number(cursor)), "invalid_whatsapp_cursor");
  return cursor;
}

// Recorded Cloud API: a fixture standing in for webhook delivery. It mirrors
// RecordedTelegramBot and doubles as a fixture transport (kind "whatsapp-cloud").
// There is no send path: outbound stays refused by bind, never recorded.
export class RecordedWhatsAppCloud {
  #connection; #payloads;
  kind = provider;
  limit;
  constructor(recording) {
    whatsappInput(recording);
    requireContract(object(recording) && Array.isArray(recording.payloads) && recording.payloads.length <= 1000, "invalid_whatsapp_recording");
    this.#connection = whatsappConnection(recording.connection);
    this.limit = recording.limit ?? whatsappLimits.updates;
    requireContract(Number.isSafeInteger(this.limit) && this.limit > 0 && this.limit <= whatsappLimits.updates, "invalid_whatsapp_recording");
    for (const payload of recording.payloads) requireContract(object(payload), "invalid_whatsapp_recording");
    this.#payloads = structuredClone(recording.payloads);
  }
  get connection() { return structuredClone(this.#connection); }
  async getUpdates({ offset = null } = {}) {
    const start = offset === null ? 0 : Number(qualifyWhatsappCursor(offset));
    return { ok: true, result: structuredClone(this.#payloads.slice(start, start + this.limit)) };
  }
}
// Bound adapter: the uniform interface every channel driver presents to the importer.
export function bind({ reader, connection }) {
  requireContract(reader instanceof RecordedWhatsAppCloud, "whatsapp_fixture_reader_required");
  const profile = whatsappConnection(connection), latest = new Map();
  return {
    channel, provider,
    normalize: raw => normalizeWhatsappUpdate(profile, raw),
    sourceId: messageId => whatsappSourceId(profile, messageId),
    scope: () => "updates",
    async changes({ cursor = null } = {}) {
      const response = await reader.getUpdates({ offset: cursor });
      const page = whatsappUpdates(profile, response, { offset: cursor, limit: reader.limit });
      for (const payload of response.result) {
        for (const { value, message } of messageItems(payload)) {
          if (message.type !== "text") continue;
          latest.set(metadata(value).numberId + ":" + message.id, { value: structuredClone(value), message: structuredClone(message) });
        }
      }
      return page;
    },
    async hydrate(messageId) { return latest.has(messageId) ? structuredClone(latest.get(messageId)) : null; },
    // Outbound is off by design (B23): there is no fixture send path, so the
    // driver refuses instead of pretending a send happened.
    async submit() { throw new ContractError("channel_sending_unavailable"); },
    async lookup() { throw new ContractError("channel_sending_unavailable"); }
  };
}
