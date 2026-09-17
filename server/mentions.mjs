// Mentions and push notifications (A021). A pure mention parser and
// notification router: extract @mentions from message text, build
// notification records per mentioned agent, and track delivery state
// (queued → sent → failed). Push transport wiring is a later slice.
// All state is caller-owned (a Map); the module is pure and
// dependency-free. Frozen outputs; malformed inputs throw MentionError.
class MentionError extends Error { constructor(code, message) { super(message); this.name = "MentionError"; this.code = code; } }
const fail = (code, message) => { throw new MentionError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_mention", message); };
const MENTION = /(^|[\s,;:!?()[\]{}])@([a-zA-Z0-9][a-zA-Z0-9._-]{0,63})/g;
// Extract unique @mentions from text, in order of first appearance.
export function extractMentions(text) {
  check(typeof text === "string", "text must be a string");
  const names = [];
  const seen = new Set();
  for (const match of text.matchAll(MENTION)) {
    const name = match[2].replace(/[._-]+$/, ""); // strip trailing punctuation-ish
    if (name.length > 0 && !seen.has(name)) { seen.add(name); names.push(name); }
  }
  return Object.freeze(names);
}
// Create a notification router. store is a caller-owned Map (notificationId -> notification).
export function createNotificationRouter({ store } = {}) {
  check(store === undefined || store instanceof Map, "store must be a Map if given");
  const notifications = store ?? new Map();
  let counter = 0;
  const nextId = () => `notif-${++counter}`;
  // Route a message's mentions into notification records.
  const route = ({ messageId, roomId, senderId, text }) => {
    check(typeof messageId === "string" && messageId.length > 0, "messageId must be a non-empty string");
    check(typeof roomId === "string" && roomId.length > 0, "roomId must be a non-empty string");
    check(typeof senderId === "string" && senderId.length > 0, "senderId must be a non-empty string");
    const mentions = extractMentions(text).filter(name => name !== senderId); // no self-notify
    const created = mentions.map(agentId => {
      const notification = Object.freeze({ notificationId: nextId(), messageId, roomId,
        agentId, mentionedBy: senderId, state: "queued", error: null });
      notifications.set(notification.notificationId, notification);
      return notification;
    });
    return Object.freeze(created);
  };
  const markSent = notificationId => {
    check(notifications.has(notificationId), `unknown notification "${notificationId}"`);
    const current = notifications.get(notificationId);
    check(current.state === "queued", `notification "${notificationId}" is ${current.state}, not queued`);
    const updated = Object.freeze({ ...current, state: "sent" });
    notifications.set(notificationId, updated);
    return updated;
  };
  const markFailed = (notificationId, error) => {
    check(notifications.has(notificationId), `unknown notification "${notificationId}"`);
    check(typeof error === "string" && error.length > 0, "error must be a non-empty string");
    const updated = Object.freeze({ ...notifications.get(notificationId), state: "failed", error });
    notifications.set(notificationId, updated);
    return updated;
  };
  // List queued notifications for an agent.
  const queuedFor = agentId => {
    check(typeof agentId === "string" && agentId.length > 0, "agentId must be a non-empty string");
    return Object.freeze([...notifications.values()].filter(n => n.agentId === agentId && n.state === "queued"));
  };
  return Object.freeze({ route, markSent, markFailed, queuedFor, size: () => notifications.size });
}
export { MentionError };
