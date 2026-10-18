// Derived data only: no authorization, cursor, clock, or private-mark cache.
// Weak keys follow projection lifetime; a new snapshot gets a new index.
const snapshots = new WeakMap();
const empty = Object.freeze([]);
const fields = ["id", "authorId", "toMemberId", "replyToId"];

function immutableRecord(message) {
  if (!message || typeof message !== "object" || Object.getPrototypeOf(message) !== Object.prototype
    || !Object.isFrozen(message)) return false;
  const descriptors = Object.getOwnPropertyDescriptors(message);
  if (Reflect.ownKeys(descriptors).some(key => !Object.hasOwn(descriptors[key], "value"))) return false;
  return fields.every(key => Object.hasOwn(descriptors, key) || !(key in message));
}

export function messageReadIndex(messages) {
  if (!Array.isArray(messages)) messages = empty;
  const cached = snapshots.get(messages);
  if (cached) return cached;
  let reusable = Object.getPrototypeOf(messages) === Array.prototype && Object.isFrozen(messages);
  const byId = new Map(), recipients = new Map(), replies = new Map();
  for (let i = 0; i < messages.length; i++) {
    const descriptor = reusable ? Object.getOwnPropertyDescriptor(messages, i) : null;
    const message = messages[i];
    if (reusable && (!descriptor || !Object.hasOwn(descriptor, "value") || !immutableRecord(message))) reusable = false;
    if (!message) continue;
    byId.set(message.id, message); // Match existing readers: last duplicate wins.
    if (message.toMemberId) {
      if (!recipients.has(message.toMemberId)) recipients.set(message.toMemberId, []);
      recipients.get(message.toMemberId).push(message);
    }
    if (message.replyToId) {
      if (!replies.has(message.authorId)) replies.set(message.authorId, new Set());
      replies.get(message.authorId).add(message.replyToId);
    }
  }
  for (const rows of recipients.values()) Object.freeze(rows);
  const index = Object.freeze({
    get: id => byId.get(id),
    receivedBy: memberId => recipients.get(memberId) ?? empty,
    hasReply: (authorId, messageId) => replies.get(authorId)?.has(messageId) ?? false
  });
  if (reusable) snapshots.set(messages, index);
  return index;
}
