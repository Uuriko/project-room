// Room → Discord send payloads. Pure payload builders on top of the
// discord-bridge message mappers: thread references (posting into a thread
// targets the thread channel), explicit reply references, and attachment
// embeds. No tokens, no HTTP; API wiring is a later slice. Frozen outputs;
// malformed inputs throw DiscordError.
import { toDiscord, DiscordError } from "./discord-bridge.mjs";

const fail = (code, message) => { throw new DiscordError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_discord_outbound", message); };
const object = v => v !== null && typeof v === "object" && !Array.isArray(v);
const text = (value, max, { empty = false } = {}) => {
  check(typeof value === "string" && value.isWellFormed() && (empty || value.trim().length > 0)
    && Buffer.byteLength(value) <= max && !/[\u0000-\u001f\u007f]/.test(value), "invalid_discord_outbound");
  return value;
};
const snowflake = value => { check(typeof value === "string" && /^\d{1,25}$/.test(value), "invalid_discord_outbound"); return value; };
const messageShape = value => {
  check(object(value), "message must be an object");
  const message = { messageId: text(value.messageId, 256), authorId: text(value.authorId, 256), text: text(value.text, 2000) };
  if (value.replyTo !== undefined && value.replyTo !== null) message.replyTo = snowflake(value.replyTo);
  if (value.channelId !== undefined && value.channelId !== null) message.channelId = snowflake(value.channelId);
  if (value.attachments !== undefined) {
    check(Array.isArray(value.attachments) && value.attachments.length <= 10, "invalid_discord_outbound");
    message.attachments = value.attachments.map(a => {
      check(object(a) && typeof a.name === "string", "invalid_discord_outbound");
      return { name: text(a.name, 256), url: a.url === undefined || a.url === null ? null : text(a.url, 2048),
        contentType: a.contentType === undefined || a.contentType === null ? null : text(a.contentType, 240) };
    });
  }
  return message;
};
// Compose a Discord message payload for a room message. A threadId posts the
// message into that thread (channel_id = thread id); an explicit replyTo
// keeps its message_reference. Attachments become extra embeds so nothing
// about the room message is dropped.
export function composeDiscordMessage({ message, threadId = null, channelId = null }) {
  const room = messageShape(message);
  if (threadId !== null) snowflake(threadId);
  if (channelId !== null) snowflake(channelId);
  const base = toDiscord({ message: { messageId: room.messageId, authorId: room.authorId, text: room.text,
    replyTo: room.replyTo, channelId: room.channelId } });
  const embeds = [...base.embeds];
  for (const attachment of room.attachments ?? []) {
    const embed = { title: attachment.name.slice(0, 256) };
    if (attachment.url) embed.url = attachment.url;
    if (attachment.contentType) embed.description = attachment.contentType;
    embeds.push(Object.freeze(embed));
  }
  const payload = { ...base, embeds: Object.freeze(embeds) };
  const target = threadId ?? channelId ?? room.channelId;
  if (target) payload.channel_id = target;
  return Object.freeze(payload);
}
// Thread reference for a follow-up: posting into the thread channel keeps the
// conversation threaded without an explicit reply reference.
export function discordThreadTarget({ threadId }) {
  return { channel_id: snowflake(threadId) };
}
export { DiscordError };
