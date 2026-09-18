// Slack Events API → envelope pipeline. Pure: recorded request bodies in,
// typed change records out. Covers message / message_changed /
// message_deleted, reaction_added / reaction_removed, thread replies, and
// user mentions. Request verification is a pure HMAC-SHA256 helper over the
// signing secret; the secret is always passed in, never stored here.
import { createHmac, timingSafeEqual } from "node:crypto";
import { requireContract } from "./channel-connection.mjs";
import { slackConnection, normalizeSlackEvent } from "./channel-adapters/slack.mjs";

const object = v => v !== null && typeof v === "object" && !Array.isArray(v);
export const slackIngestLimits = Object.freeze({ events: 100 });

// Slack's `X-Slack-Signature` is `v0=` + hex(HMAC-SHA256(signingSecret,
// `v0:${timestamp}:${body}`)). Returns true/false; malformed inputs are
// contract errors, a bad signature is simply false. Pure: no network, no
// clock, no stored secrets.
export function verifySlackSignature({ signingSecret, timestamp, body, signature }) {
  requireContract(typeof signingSecret === "string" && signingSecret.length > 0 && signingSecret.length <= 1024, "invalid_slack_signature_input");
  requireContract(typeof timestamp === "string" && /^\d{1,10}$/.test(timestamp), "invalid_slack_signature_input");
  requireContract(typeof body === "string", "invalid_slack_signature_input");
  requireContract(typeof signature === "string" && /^v0=[0-9a-f]{64}$/.test(signature), "invalid_slack_signature_input");
  const expected = "v0=" + createHmac("sha256", signingSecret).update("v0:" + timestamp + ":" + body, "utf8").digest("hex");
  return timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(signature, "utf8"));
}
// Replay guard companion to verifySlackSignature: the request timestamp must
// be within toleranceSeconds of now (default 300, Slack's recommendation).
export function isSlackTimestampFresh(timestamp, { now = Date.now(), toleranceSeconds = 300 } = {}) {
  requireContract(typeof timestamp === "string" && /^\d{1,10}$/.test(timestamp), "invalid_slack_signature_input");
  requireContract(Number.isFinite(now) && Number.isSafeInteger(toleranceSeconds) && toleranceSeconds > 0, "invalid_slack_signature_input");
  return Math.abs(now / 1000 - Number(timestamp)) <= toleranceSeconds;
}

export const slackIngestKinds = Object.freeze(["message", "message_update", "message_delete", "reaction_add", "reaction_remove", "challenge"]);
export function slackEventKind(envelope) {
  if (!object(envelope)) return null;
  if (envelope.type === "url_verification" && typeof envelope.challenge === "string") return "challenge";
  const event = envelope.event;
  if (!object(event) || typeof event.type !== "string") return null;
  if (event.type === "message") {
    const subtype = event.subtype;
    if (subtype === undefined || subtype === "bot_message") return "message";
    if (subtype === "message_changed") return "message_update";
    if (subtype === "message_deleted") return "message_delete";
    return null;
  }
  if (event.type === "app_mention") return "message";
  if (event.type === "reaction_added") return "reaction_add";
  if (event.type === "reaction_removed") return "reaction_remove";
  return null;
}
// Mentioned user ids from `<@U123ABC>` tokens in the message text. The
// inner message of a message_changed envelope is used.
const mentionToken = /<@([UW][A-Z0-9]{4,16})>/g;
const eventText = envelope => {
  const event = envelope.event;
  return typeof event?.message?.text === "string" ? event.message.text : typeof event?.text === "string" ? event.text : "";
};
export function mentionUserIds(envelope) {
  if (!object(envelope)) return [];
  const ids = new Set();
  for (const match of eventText(envelope).matchAll(mentionToken)) ids.add(match[1]);
  return [...ids];
}
// Thread context: a thread_ts marks a threaded message; when it differs
// from the message ts the message is a reply inside that thread.
export function threadContext(envelope) {
  const event = object(envelope) ? envelope.event : null;
  if (!object(event) || typeof event.channel !== "string") return null;
  const inner = object(event.message) ? event.message : event;
  if (typeof inner.thread_ts !== "string" || typeof inner.ts !== "string") return null;
  return { threadTs: event.channel + ":" + inner.thread_ts, isReply: inner.thread_ts !== inner.ts };
}
const reactionRecord = (envelope, added) => {
  const event = envelope.event;
  requireContract(typeof event.user === "string" && event.user.length > 0
    && typeof event.reaction === "string" && object(event.item) && event.item.type === "message"
    && typeof event.item.channel === "string" && typeof event.item.ts === "string", "invalid_slack_reaction");
  return { action: "reaction", messageId: event.item.channel + ":" + event.item.ts,
    emoji: event.reaction, userId: event.user, added };
};
// An app_mention is message-shaped but typed differently; the adapter
// normalizes message-typed events, so retype it before handing over.
const asMessageEvent = envelope => envelope.event.type === "app_mention"
  ? { ...envelope, event: { ...envelope.event, type: "message", subtype: undefined } } : envelope;
// One Events API request body → one typed record. Envelopes come from the
// channel adapter's normalizeSlackEvent; deletes and reactions are change
// records; url_verification challenges are never messages.
export function ingestSlackEvent(connection, envelope) {
  const profile = slackConnection(connection);
  const kind = slackEventKind(envelope);
  if (kind === "message" || kind === "message_update") {
    const normalized = asMessageEvent(envelope);
    const record = normalizeSlackEvent(profile, normalized);
    return { action: "hydrate", kind, messageId: record.message.id, envelope: record,
      mentions: mentionUserIds(envelope), thread: threadContext(envelope) };
  }
  if (kind === "message_delete") {
    const event = envelope.event;
    requireContract(typeof event.channel === "string" && typeof event.deleted_ts === "string", "invalid_slack_update");
    return { action: "retract", kind, messageId: event.channel + ":" + event.deleted_ts };
  }
  if (kind === "reaction_add" || kind === "reaction_remove") return { ...reactionRecord(envelope, kind === "reaction_add"), kind };
  if (kind === "challenge") return { action: "skip", kind, reason: "url_verification" };
  return { action: "skip", kind: null, reason: "unsupported_event" };
}
// A recorded request batch → a page of change records plus the next index
// cursor (Slack has no sequence numbers). Skipped requests still advance it.
export function ingestSlackEvents(connectionValue, envelopes, { cursor = null, limit = slackIngestLimits.events } = {}) {
  requireContract(Array.isArray(envelopes) && envelopes.length <= 1000, "invalid_slack_ingest");
  requireContract(Number.isSafeInteger(limit) && limit > 0 && limit <= slackIngestLimits.events, "invalid_slack_ingest");
  const profile = slackConnection(connectionValue);
  const start = cursor === null ? 0 : Number(cursor);
  requireContract(typeof cursor !== "string" || (/^\d{1,10}$/.test(cursor) && Number.isSafeInteger(start) && start >= 0), "invalid_slack_cursor");
  const changes = [];
  let consumed = 0;
  for (const envelope of envelopes.slice(start, start + limit)) {
    const record = ingestSlackEvent(profile, envelope);
    if (record.action !== "skip") changes.push({ index: start + consumed, ...record });
    consumed++;
  }
  return { contractVersion: 1, connection: profile, changes,
    cursor: String(start + consumed), complete: envelopes.length - start <= limit };
}
