// Slack Events API shaped adapter. Normalizes recorded Events API request
// bodies only: no signing secret, event subscription, socket mode, or send
// API lives here. Plain messages and message_changed normalize into
// envelopes; message_deleted surfaces as a retract change (handled by the
// slack-ingest pipeline); reaction and app-mention events are skipped by the
// change feed, never imported.
import { createHash } from "node:crypto";
import { channelParticipant, channelProfile, exactFields, requireContract } from "../channel-connection.mjs";

export const channel = "slack";
export const provider = "slack-app";
export const slackLimits = Object.freeze({ bodyBytes: 16384, attachments: 20, updates: 100, inputBytes: 1048576 });
const object = v => v !== null && typeof v === "object" && !Array.isArray(v);
const canonical = value => Array.isArray(value) ? "[" + value.map(canonical).join(",") + "]" : object(value)
  ? "{" + Object.keys(value).sort().map(k => JSON.stringify(k) + ":" + canonical(value[k])).join(",") + "}" : JSON.stringify(value);
const digest = value => createHash("sha256").update(canonical(value)).digest("hex");
const text = (value, max, { empty = false, multiline = false } = {}) => {
  requireContract(typeof value === "string" && value.isWellFormed() && (empty || value.trim().length > 0)
    && Buffer.byteLength(value) <= max && !(multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/).test(value), "invalid_slack_message");
  return value;
};
const opaqueId = value => text(value, 2048);
// Slack timestamps are digit strings of Unix seconds with a microsecond
// fraction ("1700000000.123456"). The year-9999 bound keeps a hostile ts a
// 422 contract error rather than a RangeError from toISOString.
const maxSlackSeconds = 253402300799;
const slackAt = value => {
  requireContract(typeof value === "string" && /^\d{1,10}\.\d{1,6}$/.test(value), "invalid_slack_update");
  const seconds = Number(value);
  requireContract(Number.isFinite(seconds) && seconds >= 0 && seconds <= maxSlackSeconds, "invalid_slack_update");
  return new Date(Math.floor(seconds * 1000)).toISOString();
};
const atSeconds = value => {
  requireContract(Number.isSafeInteger(value) && value >= 0 && value <= maxSlackSeconds, "invalid_slack_update");
  return new Date(value * 1000).toISOString();
};
const timestamp = value => {
  if (value === null) return null;
  requireContract(typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,7})?Z$/.test(value) && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString().slice(0, 19) === value.slice(0, 19), "invalid_slack_message");
  return value;
};
const count = (value, max) => { requireContract(Array.isArray(value) && value.length <= max, "invalid_slack_message"); return value; };
export function slackInput(value) {
  let serialized;
  try { serialized = JSON.stringify(value); } catch { requireContract(false, "invalid_slack_message"); }
  requireContract(typeof serialized === "string" && Buffer.byteLength(serialized) <= slackLimits.inputBytes, "slack_input_limit");
  return value;
}
export const slackConnection = value => { const c = channelProfile(value); requireContract(c.channel === channel && c.provider === provider, "unsupported_channel"); return c; };
// Same digest style as telegramSourceId: account, provider, app id, then the
// channel-qualified message ts (Slack ts values are unique per channel only).
export const slackSourceId = (connection, messageId) => {
  const c = slackConnection(connection);
  return "slack-" + digest([c.accountId, c.provider, c.externalId, opaqueId(messageId)]);
};
export const messageKinds = Object.freeze(["message", "edited_message"]);
const attachmentKinds = Object.freeze(["photo", "document", "audio", "video"]);
function attachment(value) {
  requireContract(exactFields(value, ["id", "kind", "name", "contentType", "size"]) && attachmentKinds.includes(value.kind), "invalid_slack_attachment");
  requireContract(value.size === null || Number.isSafeInteger(value.size) && value.size >= 0, "invalid_slack_attachment");
  return { id: opaqueId(value.id), kind: value.kind, name: value.name === null ? null : text(value.name, 2048),
    contentType: value.contentType === null ? null : text(value.contentType, 240), size: value.size };
}
const messageFields = ["id", "revision", "threadId", "kind", "sentAt", "editedAt", "from", "to", "subject", "replyTo"];
export function createSlackEnvelope(input) {
  slackInput(input);
  requireContract(exactFields(input, ["connection", "message", "body", "attachments"]), "invalid_slack_message");
  const connection = slackConnection(input.connection), m = input.message;
  requireContract(exactFields(m, messageFields) && messageKinds.includes(m.kind) && m.subject === null, "invalid_slack_message");
  const message = { id: opaqueId(m.id), revision: opaqueId(m.revision), threadId: opaqueId(m.threadId), kind: m.kind,
    sentAt: timestamp(m.sentAt), editedAt: timestamp(m.editedAt), from: channelParticipant(m.from),
    to: count(m.to, 1).map(channelParticipant), subject: null, replyTo: m.replyTo === null ? null : opaqueId(m.replyTo) };
  requireContract(/^[A-Z0-9]{1,16}:\d{1,10}\.\d{1,6}$/.test(message.id) && message.threadId.startsWith(message.id.split(":")[0] + ":")
    && message.id.startsWith(message.threadId.split(":")[0] + ":"), "invalid_slack_message");
  requireContract(exactFields(input.body, ["format", "content"]) && input.body.format === "text", "invalid_slack_message");
  const body = { format: "text", content: text(input.body.content, slackLimits.bodyBytes, { empty: true, multiline: true }) };
  const attachments = count(input.attachments, slackLimits.attachments).map(attachment);
  requireContract(new Set(attachments.map(a => a.id)).size === attachments.length, "duplicate_slack_attachment");
  const content = { connection, message, body, attachments };
  return { contractVersion: 1, channel, sourceId: slackSourceId(connection, message.id), sourceVersion: digest(content), ...content };
}
// Registry interface shared with the email adapter.
export const readEnvelope = value => readSlackEnvelope(value);
export const sourceId = (connection, messageId) => slackSourceId(connection, messageId);
export const scope = () => "updates";
export function readSlackEnvelope(value) {
  requireContract(exactFields(value, ["contractVersion", "channel", "sourceId", "sourceVersion", "connection", "message", "body", "attachments"]), "invalid_slack_message");
  const clean = createSlackEnvelope({ connection: value.connection, message: value.message, body: value.body, attachments: value.attachments });
  requireContract(value.contractVersion === 1 && value.channel === channel && value.sourceId === clean.sourceId && value.sourceVersion === clean.sourceVersion, "slack_version_mismatch");
  return clean;
}

// Raw Events API shapes. ts values stay opaque strings; nothing is fetched.
function fromParticipant(inner) {
  if (typeof inner.bot_id === "string" && inner.bot_id) return { kind: "bot", id: text(inner.bot_id, 64), handle: "", displayName: "" };
  requireContract(typeof inner.user === "string" && inner.user.length > 0, "invalid_slack_update");
  return { kind: "user", id: text(inner.user, 64), handle: "", displayName: "" };
}
const kindFromContentType = contentType => {
  if (typeof contentType !== "string") return "document";
  if (contentType.startsWith("image/")) return "photo";
  if (contentType.startsWith("audio/")) return "audio";
  if (contentType.startsWith("video/")) return "video";
  return "document";
};
function attachments(inner) {
  requireContract(inner.files === undefined || Array.isArray(inner.files), "invalid_slack_update");
  return (inner.files ?? []).map(file => {
    requireContract(object(file) && typeof file.id === "string", "invalid_slack_update");
    return { id: text(file.id, 128), kind: kindFromContentType(file.mimetype),
      name: typeof file.name === "string" ? file.name : null,
      contentType: typeof file.mimetype === "string" ? file.mimetype : null,
      size: file.size ?? null };
  });
}
export const updateKind = envelope => {
  if (!object(envelope) || !object(envelope.event) || envelope.event.type !== "message") return null;
  const subtype = envelope.event.subtype;
  if (subtype === undefined || subtype === "bot_message") return "message";
  if (subtype === "message_changed") return "edited_message";
  return null;
};
// A message_changed envelope nests the edited message under event.message;
// a plain (or bot) message is event itself.
const innerMessage = envelope => {
  const event = envelope.event;
  return event.subtype === "message_changed" ? event.message : event;
};
export function normalizeSlackEvent(connection, envelope) {
  slackInput({ connection, envelope });
  const kind = updateKind(envelope);
  requireContract(kind && typeof envelope.event_id === "string" && envelope.event_id.length > 0, "unsupported_slack_event");
  const event = envelope.event, inner = innerMessage(envelope);
  requireContract(object(inner) && typeof inner.ts === "string" && typeof event.channel === "string", "invalid_slack_update");
  const channelId = text(event.channel, 32), messageId = channelId + ":" + inner.ts;
  requireContract(typeof inner.text === "string", "invalid_slack_update");
  const threadTs = typeof inner.thread_ts === "string" ? inner.thread_ts : null;
  const editedAt = inner.edited?.ts !== undefined ? slackAt(inner.edited.ts)
    : kind === "edited_message" && Number.isSafeInteger(envelope.event_time) ? atSeconds(envelope.event_time) : null;
  const sentAt = Number.isSafeInteger(envelope.event_time) ? atSeconds(envelope.event_time) : slackAt(inner.ts);
  return createSlackEnvelope({ connection,
    message: { id: messageId, revision: opaqueId(envelope.event_id), threadId: channelId + ":" + (threadTs ?? inner.ts), kind,
      sentAt, editedAt, from: fromParticipant(inner), to: [{ kind: "channel", id: channelId, handle: "", displayName: "" }],
      subject: null, replyTo: threadTs && threadTs !== inner.ts ? channelId + ":" + threadTs : null },
    body: { format: "text", content: inner.text }, attachments: attachments(inner) });
}
// A recorded Events API batch is a set of invalidations plus an index cursor
// (Slack has no sequence numbers). The recorded reader pages by offset, so
// the batch is already the page; the offset only anchors the cursor.
// Non-message events are skipped, never imported; deletes are retract
// invalidations.
export function slackEvents(connectionValue, response, { offset = null, limit = slackLimits.updates } = {}) {
  slackInput(response);
  const connection = slackConnection(connectionValue);
  requireContract(object(response) && Array.isArray(response.events) && response.events.length <= limit, "invalid_slack_events");
  const start = offset === null ? 0 : Number(qualifySlackCursor(offset));
  requireContract(Number.isSafeInteger(start) && start >= 0, "invalid_slack_events");
  const changes = [];
  let consumed = start;
  for (const envelope of response.events) {
    requireContract(object(envelope), "invalid_slack_events");
    const index = consumed++;
    const event = envelope.event;
    if (!object(event) || event.type !== "message") continue;
    requireContract(typeof event.channel === "string", "invalid_slack_update");
    const channelId = event.channel;
    if (event.subtype === undefined || event.subtype === "bot_message" || event.subtype === "message_changed") {
      const inner = innerMessage(envelope);
      requireContract(object(inner) && typeof inner.ts === "string", "invalid_slack_update");
      changes.push({ messageId: channelId + ":" + inner.ts, action: "hydrate", index });
    } else if (event.subtype === "message_deleted") {
      requireContract(typeof event.deleted_ts === "string", "invalid_slack_update");
      changes.push({ messageId: channelId + ":" + event.deleted_ts, action: "retract", index });
    }
  }
  const cursor = String(consumed);
  return { contractVersion: 1, connection, changes, cursor, complete: response.events.length < limit };
}
export function qualifySlackCursor(cursor) {
  requireContract(typeof cursor === "string" && /^\d{1,10}$/.test(cursor) && Number.isSafeInteger(Number(cursor)), "invalid_slack_cursor");
  return cursor;
}

// Recorded Events API: a fixture standing in for the Events API HTTP endpoint
// and the chat.postMessage endpoint. It mirrors RecordedTelegramBot and
// doubles as a fixture transport (kind "slack-app").
export class RecordedSlackEvents {
  #connection; #events; #sent = new Map();
  kind = provider;
  mode = "accepted";
  limit;
  constructor(recording) {
    slackInput(recording);
    requireContract(object(recording) && Array.isArray(recording.events) && recording.events.length <= 1000, "invalid_slack_recording");
    this.#connection = slackConnection(recording.connection);
    this.limit = recording.limit ?? slackLimits.updates;
    requireContract(Number.isSafeInteger(this.limit) && this.limit > 0 && this.limit <= slackLimits.updates, "invalid_slack_recording");
    this.#events = structuredClone(recording.events);
  }
  get connection() { return structuredClone(this.#connection); }
  async getEvents({ offset = null } = {}) {
    const start = offset === null ? 0 : Number(qualifySlackCursor(offset));
    return { events: structuredClone(this.#events.slice(start, start + this.limit)) };
  }
  async submit({ operationId, envelope }) {
    requireContract(envelope?.provider === provider && envelope.adapter === channel, "slack_transport_mismatch");
    const prior = this.#sent.get(operationId);
    if (prior && prior.previewVersion !== envelope.previewVersion) throw new Error("Slack correlation conflict");
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
  requireContract(reader instanceof RecordedSlackEvents, "slack_fixture_reader_required");
  const profile = slackConnection(connection), latest = new Map();
  return {
    channel, provider,
    normalize: raw => normalizeSlackEvent(profile, raw),
    sourceId: messageId => slackSourceId(profile, messageId),
    scope: () => "updates",
    async changes({ cursor = null } = {}) {
      const response = await reader.getEvents({ offset: cursor });
      const page = slackEvents(profile, response, { offset: cursor, limit: reader.limit });
      for (const envelope of response.events) {
        const kind = updateKind(envelope);
        if (!kind) continue;
        const inner = innerMessage(envelope);
        if (object(inner) && typeof inner.ts === "string" && typeof envelope.event.channel === "string") {
          latest.set(envelope.event.channel + ":" + inner.ts, structuredClone(envelope));
        }
      }
      return page;
    },
    async hydrate(messageId) { return latest.has(messageId) ? structuredClone(latest.get(messageId)) : null; },
    submit: request => reader.submit(request),
    lookup: request => reader.lookup(request)
  };
}
