// Discord gateway event → envelope pipeline. Pure: recorded dispatch objects
// in, typed change records out. Covers MESSAGE_CREATE / MESSAGE_UPDATE
// (envelopes), MESSAGE_DELETE (retracts), MESSAGE_REACTION_ADD /
// MESSAGE_REACTION_REMOVE (reaction records), thread replies, and user
// mentions. Webhook signature verification is a pure Ed25519 helper; the
// public key is always passed in, never stored here.
import { createPublicKey, verify } from "node:crypto";
import { requireContract } from "./channel-connection.mjs";
import { discordConnection, normalizeDiscordEvent } from "./channel-adapters/discord.mjs";

const object = v => v !== null && typeof v === "object" && !Array.isArray(v);
export const discordIngestLimits = Object.freeze({ events: 100 });

// Ed25519 verify of Discord's `X-Signature-Ed25519` over the raw
// `X-Signature-Timestamp + body` bytes. Returns true/false; malformed key
// material or non-string inputs are contract errors, a bad signature is
// simply false. Pure: no network, no clock, no stored keys.
const ed25519SpkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
export function verifyDiscordSignature({ publicKey, signature, timestamp, body }) {
  requireContract(typeof publicKey === "string" && /^[0-9a-fA-F]{64}$/.test(publicKey), "invalid_discord_signature_input");
  requireContract(typeof signature === "string" && /^[0-9a-fA-F]{128}$/.test(signature), "invalid_discord_signature_input");
  requireContract(typeof timestamp === "string" && timestamp.length > 0 && timestamp.length <= 64, "invalid_discord_signature_input");
  requireContract(typeof body === "string", "invalid_discord_signature_input");
  const key = createPublicKey({ key: Buffer.concat([ed25519SpkiPrefix, Buffer.from(publicKey, "hex")]), format: "der", type: "spki" });
  return verify(null, Buffer.from(timestamp + body, "utf8"), key, Buffer.from(signature, "hex"));
}

export const discordIngestKinds = Object.freeze(["message_create", "message_update", "message_delete", "reaction_add", "reaction_remove"]);
export function discordEventKind(event) {
  if (!object(event) || event.op !== 0 || typeof event.t !== "string") return null;
  return { MESSAGE_CREATE: "message_create", MESSAGE_UPDATE: "message_update", MESSAGE_DELETE: "message_delete",
    MESSAGE_REACTION_ADD: "reaction_add", MESSAGE_REACTION_REMOVE: "reaction_remove" }[event.t] ?? null;
}
// Mentioned user ids from the mentions array plus `<@id>` / `<@!id>` tokens
// in the content (Discord omits the array on some edited payloads).
const mentionToken = /<@!?(\d{1,25})>/g;
export function mentionUserIds(event) {
  const d = object(event) ? event.d : null;
  if (!object(d)) return [];
  const ids = new Set();
  if (Array.isArray(d.mentions)) for (const user of d.mentions) if (object(user) && typeof user.id === "string") ids.add(user.id);
  if (typeof d.content === "string") for (const match of d.content.matchAll(mentionToken)) ids.add(match[1]);
  return [...ids];
}
// Thread context for a message event: an explicit reply reference, and —
// when the caller passes a recorded thread directory — the parent channel of
// a thread-channel message.
export function threadContext(event, { threads } = {}) {
  const d = object(event) ? event.d : null;
  if (!object(d) || typeof d.channel_id !== "string" || typeof d.id !== "string") return null;
  const context = {};
  if (typeof d.message_reference?.message_id === "string") context.replyToMessageId = d.channel_id + ":" + d.message_reference.message_id;
  if (threads !== undefined) {
    requireContract(object(threads), "invalid_discord_threads");
    if (typeof threads[d.channel_id] === "string") context.parentChannelId = threads[d.channel_id];
  }
  return Object.keys(context).length ? context : null;
}
const reactionRecord = (event, added) => {
  const d = event.d;
  requireContract(object(d) && typeof d.user_id === "string" && typeof d.channel_id === "string" && typeof d.message_id === "string"
    && object(d.emoji) && typeof d.emoji.name === "string", "invalid_discord_reaction");
  const emoji = typeof d.emoji.id === "string" && d.emoji.id ? d.emoji.name + ":" + d.emoji.id : d.emoji.name;
  return { action: "reaction", messageId: d.channel_id + ":" + d.message_id, emoji, userId: d.user_id, added };
};
// One gateway dispatch → one typed record. Envelopes come from the channel
// adapter's normalizeDiscordEvent; deletes and reactions are change records.
export function ingestDiscordEvent(connection, event, { threads } = {}) {
  const profile = discordConnection(connection);
  const kind = discordEventKind(event);
  if (kind === "message_create" || kind === "message_update") {
    const envelope = normalizeDiscordEvent(profile, event);
    return { action: "hydrate", kind, messageId: envelope.message.id, envelope,
      mentions: mentionUserIds(event), thread: threadContext(event, { threads }) };
  }
  if (kind === "message_delete") {
    const d = event.d;
    requireContract(object(d) && typeof d.id === "string" && typeof d.channel_id === "string", "invalid_discord_update");
    return { action: "retract", kind, messageId: d.channel_id + ":" + d.id };
  }
  if (kind === "reaction_add" || kind === "reaction_remove") return { ...reactionRecord(event, kind === "reaction_add"), kind };
  return { action: "skip", kind: null, reason: "unsupported_event" };
}
// A recorded dispatch batch → a page of change records plus the next sequence
// cursor. Skipped dispatches still advance the cursor.
export function ingestDiscordEvents(connectionValue, events, { cursor = null, limit = discordIngestLimits.events } = {}) {
  requireContract(Array.isArray(events) && events.length <= 1000, "invalid_discord_ingest");
  requireContract(Number.isSafeInteger(limit) && limit > 0 && limit <= discordIngestLimits.events, "invalid_discord_ingest");
  const profile = discordConnection(connectionValue);
  const start = cursor === null ? 0 : Number(cursor);
  requireContract(typeof cursor !== "string" || (/^\d{1,20}$/.test(cursor) && Number.isSafeInteger(start)), "invalid_discord_cursor");
  const changes = [];
  let previous = start - 1, consumed = 0;
  const qualifying = [];
  for (const event of events) {
    requireContract(object(event) && Number.isSafeInteger(event.s) && event.s >= 0, "invalid_discord_ingest");
    if (event.s >= start) qualifying.push(event);
  }
  for (const event of qualifying.slice(0, limit)) {
    consumed++;
    previous = Math.max(previous, event.s);
    const record = ingestDiscordEvent(profile, event);
    if (record.action !== "skip") changes.push({ sequence: event.s, ...record });
  }
  if (consumed === 0) return { contractVersion: 1, connection: profile, changes: [], cursor: cursor ?? "0", complete: true };
  return { contractVersion: 1, connection: profile, changes, cursor: String(previous + 1), complete: qualifying.length <= limit };
}
