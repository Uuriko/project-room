// Telegram Bot API shaped adapter. Normalizes recorded Update objects only:
// no bot token, fetch, webhook registration or send API lives here.
import { createHash } from "node:crypto";
import { channelParticipant, channelProfile, exactFields, requireContract } from "../channel-connection.mjs";

export const channel = "telegram";
export const provider = "telegram-bot";
export const telegramLimits = Object.freeze({ bodyBytes: 16384, attachments: 20, updates: 100, inputBytes: 1048576 });
const object = v => v !== null && typeof v === "object" && !Array.isArray(v);
const canonical = value => Array.isArray(value) ? "[" + value.map(canonical).join(",") + "]" : object(value)
  ? "{" + Object.keys(value).sort().map(k => JSON.stringify(k) + ":" + canonical(value[k])).join(",") + "}" : JSON.stringify(value);
const digest = value => createHash("sha256").update(canonical(value)).digest("hex");
const text = (value, max, { empty = false, multiline = false } = {}) => {
  requireContract(typeof value === "string" && value.isWellFormed() && (empty || value.trim().length > 0)
    && Buffer.byteLength(value) <= max && !(multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/).test(value), "invalid_telegram_message");
  return value;
};
const opaqueId = value => text(value, 2048);
const timestamp = value => {
  if (value === null) return null;
  requireContract(typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,7})?Z$/.test(value) && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString().slice(0, 19) === value.slice(0, 19), "invalid_telegram_message");
  return value;
};
const count = (value, max) => { requireContract(Array.isArray(value) && value.length <= max, "invalid_telegram_message"); return value; };
export function telegramInput(value) {
  let serialized;
  try { serialized = JSON.stringify(value); } catch { requireContract(false, "invalid_telegram_message"); }
  requireContract(typeof serialized === "string" && Buffer.byteLength(serialized) <= telegramLimits.inputBytes, "telegram_input_limit");
  return value;
}
export const telegramConnection = value => { const c = channelProfile(value); requireContract(c.channel === channel && c.provider === provider, "unsupported_channel"); return c; };
// Same digest style as emailSourceId: account, provider, bot id, then the
// chat-qualified message id (Telegram message ids are unique per chat only).
export const telegramSourceId = (connection, messageId) => {
  const c = telegramConnection(connection);
  return "telegram-" + digest([c.accountId, c.provider, c.externalId, opaqueId(messageId)]);
};
export const messageKinds = Object.freeze(["message", "edited_message", "channel_post"]);
const attachmentKinds = Object.freeze(["photo", "document", "audio", "video", "voice", "sticker", "animation", "video_note"]);
function attachment(value) {
  requireContract(exactFields(value, ["id", "kind", "name", "contentType", "size"]) && attachmentKinds.includes(value.kind), "invalid_telegram_attachment");
  requireContract(value.size === null || Number.isSafeInteger(value.size) && value.size >= 0, "invalid_telegram_attachment");
  return { id: opaqueId(value.id), kind: value.kind, name: value.name === null ? null : text(value.name, 2048),
    contentType: value.contentType === null ? null : text(value.contentType, 240), size: value.size };
}
const messageFields = ["id", "revision", "threadId", "kind", "sentAt", "editedAt", "from", "to", "subject", "replyTo"];
export function createTelegramEnvelope(input) {
  telegramInput(input);
  requireContract(exactFields(input, ["connection", "message", "body", "attachments"]), "invalid_telegram_message");
  const connection = telegramConnection(input.connection), m = input.message;
  requireContract(exactFields(m, messageFields) && messageKinds.includes(m.kind) && m.subject === null, "invalid_telegram_message");
  const message = { id: opaqueId(m.id), revision: opaqueId(m.revision), threadId: opaqueId(m.threadId), kind: m.kind,
    sentAt: timestamp(m.sentAt), editedAt: timestamp(m.editedAt), from: channelParticipant(m.from),
    to: count(m.to, 1).map(channelParticipant), subject: null, replyTo: m.replyTo === null ? null : opaqueId(m.replyTo) };
  requireContract(message.to.length === 1 && /^-?\d{1,20}:\d{1,20}$/.test(message.id) && message.id.startsWith(message.to[0].id + ":"), "invalid_telegram_message");
  requireContract(exactFields(input.body, ["format", "content"]) && input.body.format === "text", "invalid_telegram_message");
  const body = { format: "text", content: text(input.body.content, telegramLimits.bodyBytes, { empty: true, multiline: true }) };
  const attachments = count(input.attachments, telegramLimits.attachments).map(attachment);
  requireContract(new Set(attachments.map(a => a.id)).size === attachments.length, "duplicate_telegram_attachment");
  const content = { connection, message, body, attachments };
  return { contractVersion: 1, channel, sourceId: telegramSourceId(connection, message.id), sourceVersion: digest(content), ...content };
}
// Registry interface shared with the email adapter.
export const readEnvelope = value => readTelegramEnvelope(value);
export const sourceId = (connection, messageId) => telegramSourceId(connection, messageId);
export const scope = () => "updates";
export function readTelegramEnvelope(value) {
  requireContract(exactFields(value, ["contractVersion", "channel", "sourceId", "sourceVersion", "connection", "message", "body", "attachments"]), "invalid_telegram_message");
  const clean = createTelegramEnvelope({ connection: value.connection, message: value.message, body: value.body, attachments: value.attachments });
  requireContract(value.contractVersion === 1 && value.channel === channel && value.sourceId === clean.sourceId && value.sourceVersion === clean.sourceVersion, "telegram_version_mismatch");
  return clean;
}

// Raw Bot API shapes. Integers become opaque strings; nothing is fetched.
const integer = value => { requireContract(Number.isSafeInteger(value), "invalid_telegram_update"); return String(value); };
// Unix seconds within the ISO range Date can format (year 9999), so a hostile
// `date` is a 422 contract error rather than a RangeError from toISOString.
const maxTelegramSeconds = 253402300799;
const at = seconds => { requireContract(Number.isSafeInteger(seconds) && seconds >= 0 && seconds <= maxTelegramSeconds, "invalid_telegram_update"); return new Date(seconds * 1000).toISOString(); };
const name = user => [user.first_name, user.last_name].filter(v => typeof v === "string" && v).join(" ");
function participant(user, chat) {
  if (user) {
    requireContract(object(user) && Number.isSafeInteger(user.id), "invalid_telegram_update");
    return { kind: user.is_bot === true ? "bot" : "user", id: String(user.id), handle: typeof user.username === "string" ? "@" + user.username : "", displayName: name(user) };
  }
  requireContract(object(chat) && Number.isSafeInteger(chat.id), "invalid_telegram_update");
  const kind = { private: "user", group: "group", supergroup: "group", channel: "channel" }[chat.type];
  requireContract(kind, "unsupported_telegram_chat");
  return { kind: kind === "user" ? "chat" : kind, id: String(chat.id), handle: typeof chat.username === "string" ? "@" + chat.username : "",
    displayName: typeof chat.title === "string" ? chat.title : name(chat) };
}
function attachments(m) {
  const items = [];
  if (Array.isArray(m.photo) && m.photo.length) {
    const largest = m.photo.at(-1); // PhotoSize list is ordered smallest to largest.
    items.push({ id: largest?.file_id, kind: "photo", name: null, contentType: null, size: largest?.file_size ?? null });
  }
  for (const kind of attachmentKinds.filter(k => k !== "photo")) {
    const file = m[kind];
    if (file === undefined) continue;
    requireContract(object(file), "invalid_telegram_update");
    items.push({ id: file.file_id, kind, name: typeof file.file_name === "string" ? file.file_name : null,
      contentType: typeof file.mime_type === "string" ? file.mime_type : null, size: file.file_size ?? null });
  }
  return items;
}
export const updateKind = update => messageKinds.find(kind => object(update) && Object.hasOwn(update, kind)) ?? null;
export function normalizeTelegramUpdate(connection, update) {
  telegramInput({ connection, update });
  const kind = updateKind(update);
  requireContract(kind && Number.isSafeInteger(update.update_id), "unsupported_telegram_update");
  const m = update[kind];
  requireContract(object(m) && object(m.chat), "invalid_telegram_update");
  const chat = participant(null, m.chat), messageId = integer(m.chat.id) + ":" + integer(m.message_id);
  const content = typeof m.text === "string" ? m.text : typeof m.caption === "string" ? m.caption : "";
  return createTelegramEnvelope({ connection,
    message: { id: messageId, revision: integer(update.update_id), threadId: integer(m.chat.id) + (m.message_thread_id === undefined ? "" : "/" + integer(m.message_thread_id)),
      kind, sentAt: at(m.date), editedAt: m.edit_date === undefined ? null : at(m.edit_date),
      from: participant(m.from ?? null, m.sender_chat ?? m.chat), to: [chat], subject: null,
      replyTo: m.reply_to_message === undefined ? null : integer(m.chat.id) + ":" + integer(m.reply_to_message?.message_id) },
    body: { format: "text", content }, attachments: attachments(m) });
}
// A getUpdates response is a batch of invalidations plus the next offset cursor.
// Non-message updates (callbacks, member changes) are skipped, never imported.
export function telegramUpdates(connectionValue, response, { offset = null, limit = telegramLimits.updates } = {}) {
  telegramInput(response);
  const connection = telegramConnection(connectionValue);
  requireContract(object(response) && response.ok === true && Array.isArray(response.result) && response.result.length <= limit, "invalid_telegram_updates");
  let previous = offset === null ? -1 : Number(qualifyTelegramCursor(offset)) - 1;
  const changes = [];
  for (const update of response.result) {
    requireContract(object(update) && Number.isSafeInteger(update.update_id) && update.update_id > previous, "invalid_telegram_updates");
    previous = update.update_id;
    const kind = updateKind(update);
    if (!kind) continue;
    requireContract(object(update[kind]) && object(update[kind].chat), "invalid_telegram_update");
    changes.push({ messageId: integer(update[kind].chat.id) + ":" + integer(update[kind].message_id), action: "hydrate", updateId: update.update_id });
  }
  const cursor = response.result.length ? String(previous + 1) : offset ?? "0";
  return { contractVersion: 1, connection, changes, cursor, complete: response.result.length < limit };
}
export function qualifyTelegramCursor(cursor) {
  requireContract(typeof cursor === "string" && /^\d{1,20}$/.test(cursor) && Number.isSafeInteger(Number(cursor)), "invalid_telegram_cursor");
  return cursor;
}

// Recorded bot: a fixture standing in for getUpdates and sendMessage. It mirrors
// RecordedGraphMailbox and doubles as a fixture transport (kind "telegram-bot").
export class RecordedTelegramBot {
  #connection; #updates; #sent = new Map();
  kind = provider;
  mode = "accepted";
  limit;
  constructor(recording) {
    telegramInput(recording);
    requireContract(object(recording) && Array.isArray(recording.updates) && recording.updates.length <= 1000, "invalid_telegram_recording");
    this.#connection = telegramConnection(recording.connection);
    this.limit = recording.limit ?? telegramLimits.updates;
    requireContract(Number.isSafeInteger(this.limit) && this.limit > 0 && this.limit <= telegramLimits.updates, "invalid_telegram_recording");
    let previous = -1;
    for (const update of recording.updates) {
      requireContract(object(update) && Number.isSafeInteger(update.update_id) && update.update_id > previous, "invalid_telegram_recording");
      previous = update.update_id;
    }
    this.#updates = structuredClone(recording.updates);
  }
  get connection() { return structuredClone(this.#connection); }
  async getUpdates({ offset = null } = {}) {
    const start = offset === null ? 0 : Number(qualifyTelegramCursor(offset));
    return { ok: true, result: structuredClone(this.#updates.filter(update => update.update_id >= start).slice(0, this.limit)) };
  }
  async submit({ operationId, envelope }) {
    requireContract(envelope?.provider === provider && envelope.adapter === channel, "telegram_transport_mismatch");
    const prior = this.#sent.get(operationId);
    if (prior && prior.previewVersion !== envelope.previewVersion) throw new Error("Telegram correlation conflict");
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
  requireContract(reader instanceof RecordedTelegramBot, "telegram_fixture_reader_required");
  const profile = telegramConnection(connection), latest = new Map();
  return {
    channel, provider,
    normalize: raw => normalizeTelegramUpdate(profile, raw),
    sourceId: messageId => telegramSourceId(profile, messageId),
    scope: () => "updates",
    async changes({ cursor = null } = {}) {
      const response = await reader.getUpdates({ offset: cursor });
      const page = telegramUpdates(profile, response, { offset: cursor, limit: reader.limit });
      for (const update of response.result) { const kind = updateKind(update); if (kind) latest.set(integer(update[kind].chat.id) + ":" + integer(update[kind].message_id), structuredClone(update)); }
      return page;
    },
    async hydrate(messageId) { return latest.has(messageId) ? structuredClone(latest.get(messageId)) : null; },
    submit: request => reader.submit(request),
    lookup: request => reader.lookup(request)
  };
}
