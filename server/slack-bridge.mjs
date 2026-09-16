// Slack bridge (B021). Pure message-format mappers between Project Room
// messages and Slack's message shape. Room → Slack: build a Slack
// message payload (text, blocks, thread_ts). Slack → Room: normalize an
// incoming Slack event into a room message. No network I/O; API wiring is
// a later slice. Frozen outputs; malformed inputs throw SlackError.
class SlackError extends Error { constructor(code, message) { super(message); this.name = "SlackError"; this.code = code; } }
const fail = (code, message) => { throw new SlackError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_slack", message); };
// Convert a room message to a Slack message payload.
export function toSlack({ message }) {
  check(message !== null && typeof message === "object", "message must be an object");
  check(typeof message.messageId === "string" && message.messageId.length > 0,
    "message must have messageId");
  check(typeof message.authorId === "string" && message.authorId.length > 0,
    "message must have authorId");
  check(typeof message.text === "string", "message must have text");
  const payload = {
    text: `[${message.authorId}] ${message.text}`,
    blocks: Object.freeze([
      Object.freeze({ type: "section",
        text: Object.freeze({ type: "mrkdwn", text: message.text }) }),
    ]),
  };
  if (message.threadId) {
    check(typeof message.threadId === "string", "threadId must be a string");
    payload.thread_ts = message.threadId;
  }
  if (message.channelId) {
    check(typeof message.channelId === "string", "channelId must be a string");
    payload.channel = message.channelId;
  }
  return Object.freeze(payload);
}
// Normalize an incoming Slack event into a room message shape.
export function fromSlack({ event }) {
  check(event !== null && typeof event === "object", "event must be an object");
  check(event.type === "message", "only message events are supported");
  check(typeof event.text === "string", "event must have text");
  check(typeof event.user === "string" && event.user.length > 0, "event must have user");
  check(typeof event.ts === "string" && event.ts.length > 0, "event must have ts");
  const message = {
    messageId: `slack:${event.channel ?? "unknown"}:${event.ts}`,
    authorId: event.user, text: event.text,
    channel: "slack",
    sourceMessageId: event.ts,
  };
  if (event.channel) message.channelId = event.channel;
  if (event.thread_ts) message.threadId = event.thread_ts;
  return Object.freeze(message);
}
export { SlackError };
