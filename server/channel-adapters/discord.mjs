// Discord gateway shaped adapter. Normalizes recorded Gateway dispatch
// objects only: no bot token, gateway connection, webhook registration or
// send API lives here. MESSAGE_CREATE and MESSAGE_UPDATE normalize into
// envelopes; MESSAGE_DELETE surfaces as a retract change (handled by the
// discord-ingest pipeline); everything else is skipped, never imported.
import { createHash } from "node:crypto";
import { channelParticipant, channelProfile, exactFields, requireContract } from "../channel-connection.mjs";

export const channel = "discord";
export const provider = "discord-bot";
export const discordLimits = Object.freeze({ bodyBytes: 16384, attachments: 20, updates: 100, inputBytes: 1048576 });
const object = v => v !== null && typeof v === "object" && !Array.isArray(v);
const canonical = value => Array.isArray(value) ? "[" + value.map(canonical).join(",") + "]" : object(value)
  ? "{" + Object.keys(value).sort().map(k => JSON.stringify(k) + ":" + canonical(value[k])).join(",") + "}" : JSON.stringify(value);
const digest = value => createHash("sha256").update(canonical(value)).digest("hex");
const text = (value, max, { empty = false, multiline = false } = {}) => {
  requireContract(typeof value === "string" && value.isWellFormed() && (empty || value.trim().length > 0)
    && Buffer.byteLength(value) <= max && !(multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/).test(value), "invalid_discord_message");
  return value;
};
const opaqueId = value => text(value, 2048);
const snowflake = value => { requireContract(typeof value === "string" && /^\d{1,25}$/.test(value), "invalid_discord_update"); return value; };
// Discord timestamps are ISO 8601 with up to microsecond precision and an
// explicit +00:00 offset. They normalize to millisecond ISO Z strings; the
// year-9999 bound keeps a hostile timestamp a 422 contract error rather
// than a RangeError from toISOString.
const discordTimestamp = value => {
  requireContract(typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?\+00:00$/.test(value), "invalid_discord_update");
  const ms = Date.parse(value);
  requireContract(Number.isFinite(ms) && ms >= 0 && ms <= 253402300799000, "invalid_discord_update");
  return new Date(ms).toISOString();
};
const timestamp = value => {
  if (value === null) return null;
  requireContract(typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,7})?Z$/.test(value) && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString().slice(0, 19) === value.slice(0, 19), "invalid_discord_message");
  return value;
};
const count = (value, max) => { requireContract(Array.isArray(value) && value.length <= max, "invalid_discord_message"); return value; };
export function discordInput(value) {
  let serialized;
  try { serialized = JSON.stringify(value); } catch { requireContract(false, "invalid_discord_message"); }
  requireContract(typeof serialized === "string" && Buffer.byteLength(serialized) <= discordLimits.inputBytes, "discord_input_limit");
  return value;
}
export const discordConnection = value => { const c = channelProfile(value); requireContract(c.channel === channel && c.provider === provider, "unsupported_channel"); return c; };
// Same digest style as telegramSourceId: account, provider, application id,
// then the channel-qualified message id (Discord message ids are unique per
// channel only).
export const discordSourceId = (connection, messageId) => {
  const c = discordConnection(connection);
  return "discord-" + digest([c.accountId, c.provider, c.externalId, opaqueId(messageId)]);
};
export const messageKinds = Object.freeze(["message", "edited_message"]);
const attachmentKinds = Object.freeze(["photo", "document", "audio", "video"]);
function attachment(value) {
  requireContract(exactFields(value, ["id", "kind", "name", "contentType", "size"]) && attachmentKinds.includes(value.kind), "invalid_discord_attachment");
  requireContract(value.size === null || Number.isSafeInteger(value.size) && value.size >= 0, "invalid_discord_attachment");
  return { id: opaqueId(value.id), kind: value.kind, name: value.name === null ? null : text(value.name, 2048),
    contentType: value.contentType === null ? null : text(value.contentType, 240), size: value.size };
}
const messageFields = ["id", "revision", "threadId", "kind", "sentAt", "editedAt", "from", "to", "subject", "replyTo"];
export function createDiscordEnvelope(input) {
  discordInput(input);
  requireContract(exactFields(input, ["connection", "message", "body", "attachments"]), "invalid_discord_message");
  const connection = discordConnection(input.connection), m = input.message;
  requireContract(exactFields(m, messageFields) && messageKinds.includes(m.kind) && m.subject === null, "invalid_discord_message");
  const message = { id: opaqueId(m.id), revision: opaqueId(m.revision), threadId: opaqueId(m.threadId), kind: m.kind,
    sentAt: timestamp(m.sentAt), editedAt: timestamp(m.editedAt), from: channelParticipant(m.from),
    to: count(m.to, 10).map(channelParticipant), subject: null, replyTo: m.replyTo === null ? null : opaqueId(m.replyTo) };
  requireContract(/^\d{1,25}:\d{1,25}$/.test(message.id) && message.id.startsWith(message.threadId + ":")
    && message.id.length > message.threadId.length + 1, "invalid_discord_message");
  requireContract(exactFields(input.body, ["format", "content"]) && input.body.format === "text", "invalid_discord_message");
  const body = { format: "text", content: text(input.body.content, discordLimits.bodyBytes, { empty: true, multiline: true }) };
  const attachments = count(input.attachments, discordLimits.attachments).map(attachment);
  requireContract(new Set(attachments.map(a => a.id)).size === attachments.length, "duplicate_discord_attachment");
  const content = { connection, message, body, attachments };
  return { contractVersion: 1, channel, sourceId: discordSourceId(connection, message.id), sourceVersion: digest(content), ...content };
}
// Registry interface shared with the email adapter.
export const readEnvelope = value => readDiscordEnvelope(value);
export const sourceId = (connection, messageId) => discordSourceId(connection, messageId);
export const scope = () => "updates";
export function readDiscordEnvelope(value) {
  requireContract(exactFields(value, ["contractVersion", "channel", "sourceId", "sourceVersion", "connection", "message", "body", "attachments"]), "invalid_discord_message");
  const clean = createDiscordEnvelope({ connection: value.connection, message: value.message, body: value.body, attachments: value.attachments });
  requireContract(value.contractVersion === 1 && value.channel === channel && value.sourceId === clean.sourceId && value.sourceVersion === clean.sourceVersion, "discord_version_mismatch");
  return clean;
}

// Raw gateway dispatch shapes. Snowflakes stay opaque strings; nothing is fetched.
function authorParticipant(author) {
  requireContract(object(author) && typeof author.id === "string", "invalid_discord_update");
  const username = typeof author.username === "string" ? author.username : "";
  const displayName = typeof author.global_name === "string" && author.global_name ? author.global_name : username;
  return { kind: author.bot === true ? "bot" : "user", id: snowflake(author.id),
    handle: username ? "@" + username : "", displayName };
}
function channelParticipantOf(d) {
  // Guild text channels and threads normalize as channels; DMs have no
  // guild_id and normalize as the peer user.
  return { kind: d.guild_id === undefined ? "user" : "channel", id: snowflake(d.channel_id), handle: "", displayName: "" };
}
const kindFromContentType = contentType => {
  if (typeof contentType !== "string") return "document";
  if (contentType.startsWith("image/")) return "photo";
  if (contentType.startsWith("audio/")) return "audio";
  if (contentType.startsWith("video/")) return "video";
  return "document";
};
function attachments(d) {
  requireContract(d.attachments === undefined || Array.isArray(d.attachments), "invalid_discord_update");
  return (d.attachments ?? []).map(a => {
    requireContract(object(a) && typeof a.id === "string", "invalid_discord_update");
    return { id: snowflake(a.id), kind: kindFromContentType(a.content_type),
      name: typeof a.filename === "string" ? a.filename : null,
      contentType: typeof a.content_type === "string" ? a.content_type : null,
      size: a.size ?? null };
  });
}
export const updateKind = event => object(event) && event.op === 0 && typeof event.t === "string"
  ? { MESSAGE_CREATE: "message", MESSAGE_UPDATE: "edited_message" }[event.t] ?? null : null;
export function normalizeDiscordEvent(connection, event) {
  discordInput({ connection, event });
  const kind = updateKind(event);
  requireContract(kind && Number.isSafeInteger(event.s) && event.s >= 0, "unsupported_discord_event");
  const d = event.d;
  requireContract(object(d) && typeof d.id === "string" && typeof d.channel_id === "string", "invalid_discord_update");
  const channelId = snowflake(d.channel_id), messageId = channelId + ":" + snowflake(d.id);
  requireContract(typeof d.content === "string", "invalid_discord_update");
  requireContract(object(d.author), "invalid_discord_update");
  const mentions = Array.isArray(d.mentions) ? d.mentions : [];
  const to = mentions.length ? mentions.map(authorParticipant) : [channelParticipantOf(d)];
  const reference = d.message_reference?.message_id === undefined ? null : channelId + ":" + snowflake(d.message_reference.message_id);
  return createDiscordEnvelope({ connection,
    message: { id: messageId, revision: String(event.s), threadId: channelId, kind,
      sentAt: discordTimestamp(d.timestamp), editedAt: d.edited_timestamp === null || d.edited_timestamp === undefined ? null : discordTimestamp(d.edited_timestamp),
      from: authorParticipant(d.author), to, subject: null, replyTo: reference },
    body: { format: "text", content: d.content }, attachments: attachments(d) });
}
// A recorded gateway batch is a set of invalidations plus the next sequence
// cursor. Non-message dispatches are skipped, never imported; deletes are
// retract invalidations.
export function discordEvents(connectionValue, response, { offset = null, limit = discordLimits.updates } = {}) {
  discordInput(response);
  const connection = discordConnection(connectionValue);
  requireContract(object(response) && Array.isArray(response.events) && response.events.length <= limit, "invalid_discord_events");
  let previous = offset === null ? -1 : Number(qualifyDiscordCursor(offset)) - 1;
  const changes = [];
  for (const event of response.events) {
    requireContract(object(event) && Number.isSafeInteger(event.s) && event.s > previous, "invalid_discord_events");
    previous = event.s;
    const kind = updateKind(event);
    if (kind) {
      requireContract(object(event.d) && typeof event.d.id === "string" && typeof event.d.channel_id === "string", "invalid_discord_update");
      changes.push({ messageId: event.d.channel_id + ":" + event.d.id, action: "hydrate", sequence: event.s });
    } else if (object(event) && event.op === 0 && event.t === "MESSAGE_DELETE"
      && object(event.d) && typeof event.d.id === "string" && typeof event.d.channel_id === "string") {
      changes.push({ messageId: event.d.channel_id + ":" + event.d.id, action: "retract", sequence: event.s });
    }
  }
  const cursor = response.events.length ? String(previous + 1) : offset ?? "0";
  return { contractVersion: 1, connection, changes, cursor, complete: response.events.length < limit };
}
export function qualifyDiscordCursor(cursor) {
  requireContract(typeof cursor === "string" && /^\d{1,20}$/.test(cursor) && Number.isSafeInteger(Number(cursor)), "invalid_discord_cursor");
  return cursor;
}

// Recorded gateway: a fixture standing in for the Discord gateway and the
// message send endpoint. It mirrors RecordedTelegramBot and doubles as a
// fixture transport (kind "discord-bot").
export class RecordedDiscordGateway {
  #connection; #events; #sent = new Map();
  kind = provider;
  mode = "accepted";
  limit;
  constructor(recording) {
    discordInput(recording);
    requireContract(object(recording) && Array.isArray(recording.events) && recording.events.length <= 1000, "invalid_discord_recording");
    this.#connection = discordConnection(recording.connection);
    this.limit = recording.limit ?? discordLimits.updates;
    requireContract(Number.isSafeInteger(this.limit) && this.limit > 0 && this.limit <= discordLimits.updates, "invalid_discord_recording");
    let previous = -1;
    for (const event of recording.events) {
      requireContract(object(event) && Number.isSafeInteger(event.s) && event.s > previous, "invalid_discord_recording");
      previous = event.s;
    }
    this.#events = structuredClone(recording.events);
  }
  get connection() { return structuredClone(this.#connection); }
  async getEvents({ offset = null } = {}) {
    const start = offset === null ? 0 : Number(qualifyDiscordCursor(offset));
    return { events: structuredClone(this.#events.filter(event => event.s >= start).slice(0, this.limit)) };
  }
  async submit({ operationId, envelope }) {
    requireContract(envelope?.provider === provider && envelope.adapter === channel, "discord_transport_mismatch");
    const prior = this.#sent.get(operationId);
    if (prior && prior.previewVersion !== envelope.previewVersion) throw new Error("Discord correlation conflict");
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
  requireContract(reader instanceof RecordedDiscordGateway, "discord_fixture_reader_required");
  const profile = discordConnection(connection), latest = new Map();
  return {
    channel, provider,
    normalize: raw => normalizeDiscordEvent(profile, raw),
    sourceId: messageId => discordSourceId(profile, messageId),
    scope: () => "updates",
    async changes({ cursor = null } = {}) {
      const response = await reader.getEvents({ offset: cursor });
      const page = discordEvents(profile, response, { offset: cursor, limit: reader.limit });
      for (const event of response.events) {
        const kind = updateKind(event);
        if (kind) latest.set(event.d.channel_id + ":" + event.d.id, structuredClone(event));
      }
      return page;
    },
    async hydrate(messageId) { return latest.has(messageId) ? structuredClone(latest.get(messageId)) : null; },
    submit: request => reader.submit(request),
    lookup: request => reader.lookup(request)
  };
}
