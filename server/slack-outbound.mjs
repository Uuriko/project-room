// Room → Slack send payloads. Pure payload builders on top of the
// slack-bridge message mappers: thread_ts for threaded replies, an explicit
// channel target, and attachment blocks. No tokens, no HTTP; API wiring is
// a later slice. Frozen outputs; malformed inputs throw SlackError.
import { toSlack, SlackError } from "./slack-bridge.mjs";

const fail = (code, message) => { throw new SlackError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_slack_outbound", message); };
const object = v => v !== null && typeof v === "object" && !Array.isArray(v);
const text = (value, max, { empty = false } = {}) => {
  check(typeof value === "string" && value.isWellFormed() && (empty || value.trim().length > 0)
    && Buffer.byteLength(value) <= max && !/[\u0000-\u001f\u007f]/.test(value), "invalid_slack_outbound");
  return value;
};
const channelId = value => { check(typeof value === "string" && /^[A-Z0-9]{1,32}$/.test(value), "invalid_slack_outbound"); return value; };
const threadTs = value => { check(typeof value === "string" && /^\d{1,10}\.\d{1,6}$/.test(value), "invalid_slack_outbound"); return value; };
const messageShape = value => {
  check(object(value), "message must be an object");
  const message = { messageId: text(value.messageId, 256), authorId: text(value.authorId, 256), text: text(value.text, 40000) };
  if (value.threadId !== undefined && value.threadId !== null) message.threadId = threadTs(value.threadId);
  if (value.channelId !== undefined && value.channelId !== null) message.channelId = channelId(value.channelId);
  if (value.attachments !== undefined) {
    check(Array.isArray(value.attachments) && value.attachments.length <= 10, "invalid_slack_outbound");
    message.attachments = value.attachments.map(a => {
      check(object(a) && typeof a.name === "string", "invalid_slack_outbound");
      return { name: text(a.name, 256), url: a.url === undefined || a.url === null ? null : text(a.url, 2048),
        contentType: a.contentType === undefined || a.contentType === null ? null : text(a.contentType, 240) };
    });
  }
  return message;
};
// Compose a Slack message payload for a room message. A threadTs posts the
// message as a threaded reply under that parent ts; the channel defaults to
// the message's own channelId. Attachments become extra section blocks so
// nothing about the room message is dropped.
export function composeSlackMessage({ message, threadTs: thread = null, channelId: channel = null }) {
  const room = messageShape(message);
  if (thread !== null) threadTs(thread);
  if (channel !== null) channelId(channel);
  const base = toSlack({ message: { messageId: room.messageId, authorId: room.authorId, text: room.text,
    threadId: room.threadId, channelId: room.channelId } });
  const blocks = [...base.blocks];
  for (const attachment of room.attachments ?? []) {
    blocks.push(Object.freeze({ type: "section",
      text: Object.freeze({ type: "mrkdwn", text: "*" + attachment.name.replace(/\*/g, "\\*") + "*" }) }));
  }
  const payload = { ...base, blocks: Object.freeze(blocks) };
  if (thread !== null) payload.thread_ts = thread;
  if (channel !== null) payload.channel = channel;
  return Object.freeze(payload);
}
// Thread reference for a follow-up: thread_ts points at the parent message.
export function slackThreadTarget({ threadTs: thread }) {
  return { thread_ts: threadTs(thread) };
}
export { SlackError };
