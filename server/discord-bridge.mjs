// Discord bridge (B022). Pure message-format mappers between Project Room
// messages and Discord's message shape. Room → Discord: build a Discord
// message payload (content, embeds, message_reference). Discord → Room:
// normalize an incoming Discord gateway event into a room message. No
// network I/O; API wiring is a later slice. Frozen outputs; malformed
// inputs throw DiscordError.
class DiscordError extends Error { constructor(code, message) { super(message); this.name = "DiscordError"; this.code = code; } }
const fail = (code, message) => { throw new DiscordError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_discord", message); };
// Convert a room message to a Discord message payload.
export function toDiscord({ message }) {
  check(message !== null && typeof message === "object", "message must be an object");
  check(typeof message.messageId === "string" && message.messageId.length > 0,
    "message must have messageId");
  check(typeof message.authorId === "string" && message.authorId.length > 0,
    "message must have authorId");
  check(typeof message.text === "string", "message must have text");
  check(message.text.length <= 2000, "Discord content is limited to 2000 chars");
  const payload = {
    content: `**${message.authorId}**: ${message.text}`,
    embeds: Object.freeze([
      Object.freeze({ description: message.text, footer: Object.freeze({ text: message.messageId }) }),
    ]),
  };
  if (message.replyTo) {
    check(typeof message.replyTo === "string", "replyTo must be a string");
    payload.message_reference = Object.freeze({ message_id: message.replyTo });
  }
  if (message.channelId) {
    check(typeof message.channelId === "string", "channelId must be a string");
    payload.channel_id = message.channelId;
  }
  return Object.freeze(payload);
}
// Normalize an incoming Discord gateway event into a room message shape.
export function fromDiscord({ event }) {
  check(event !== null && typeof event === "object", "event must be an object");
  check(event.t === "MESSAGE_CREATE", "only MESSAGE_CREATE events are supported");
  check(event.d !== null && typeof event.d === "object", "event must have d payload");
  const { d } = event;
  check(typeof d.content === "string", "message must have content");
  check(d.author !== null && typeof d.author === "object" &&
    typeof d.author.id === "string", "message must have author.id");
  check(typeof d.id === "string" && d.id.length > 0, "message must have id");
  const message = {
    messageId: `discord:${d.channel_id ?? "unknown"}:${d.id}`,
    authorId: d.author.id, text: d.content,
    channel: "discord", sourceMessageId: d.id,
  };
  if (d.channel_id) message.channelId = d.channel_id;
  if (d.message_reference?.message_id) message.replyTo = d.message_reference.message_id;
  return Object.freeze(message);
}
export { DiscordError };
