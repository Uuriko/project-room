// Digest mode (A015). A pure digest builder: bundle messages from chosen
// senders into a single daily digest instead of per-message noise. The
// module groups messages by sender, builds per-sender summaries, and
// produces a digest record. All state is caller-owned; the module is pure
// and dependency-free. Frozen outputs; malformed inputs throw
// DigestError. Scheduling/delivery wiring is a later slice.
class DigestError extends Error { constructor(code, message) { super(message); this.name = "DigestError"; this.code = code; } }
const fail = (code, message) => { throw new DigestError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_digest", message); };
// Build a digest from messages. senders is the set of chosen sender ids
// to include; messages outside the set are excluded.
export function buildDigest({ messages, senders, date }) {
  check(Array.isArray(messages), "messages must be an array");
  check(senders instanceof Set || Array.isArray(senders), "senders must be a Set or array");
  check(typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date), "date must be YYYY-MM-DD");
  const senderSet = senders instanceof Set ? senders : new Set(senders);
  check(senderSet.size > 0, "senders must not be empty");
  const included = messages.filter(m => {
    check(m !== null && typeof m === "object", "each message must be an object");
    check(typeof m.messageId === "string" && typeof m.senderId === "string" &&
      typeof m.subject === "string", "message must have messageId, senderId, subject");
    return senderSet.has(m.senderId);
  });
  // Group by sender.
  const bySender = new Map();
  for (const message of included) {
    if (!bySender.has(message.senderId)) bySender.set(message.senderId, []);
    bySender.get(message.senderId).push(message);
  }
  const sections = [...bySender.entries()].map(([senderId, msgs]) => Object.freeze({
    senderId, count: msgs.length,
    subjects: Object.freeze(msgs.map(m => m.subject)),
    messageIds: Object.freeze(msgs.map(m => m.messageId)),
  }));
  sections.sort((a, b) => b.count - a.count); // busiest senders first
  return Object.freeze({ date, totalMessages: included.length,
    senderCount: bySender.size, sections: Object.freeze(sections) });
}
// Check if a message should be digested (vs delivered immediately).
export function shouldDigest({ senderId, senders }) {
  check(typeof senderId === "string" && senderId.length > 0, "senderId must be a non-empty string");
  check(senders instanceof Set || Array.isArray(senders), "senders must be a Set or array");
  const senderSet = senders instanceof Set ? senders : new Set(senders);
  return senderSet.has(senderId);
}
export { DigestError };
