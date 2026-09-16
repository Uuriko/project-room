// Thread view (A010). A pure thread builder: given a list of message
// envelopes, it groups them by threadId, rebuilds the reply tree from
// inReplyTo references, and flattens each thread with depth so the UI can
// indent replies. Pure, dependency-free, deterministic; cycles and dangling
// references are tolerated (they become top-level), never throw. No store
// reads or writes — the caller supplies the messages; store wiring is a
// later slice.
class ThreadError extends Error { constructor(code, message) { super(message); this.name = "ThreadError"; this.code = code; } }
const fail = (code, message) => { throw new ThreadError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_thread_input", message); };

const messageOf = value => {
  check(value !== null && typeof value === "object" && !Array.isArray(value), "messages must be objects");
  check(typeof value.id === "string" && value.id.length > 0 && value.id.length <= 512, "message id must be 1..512 characters");
  check(typeof value.occurredAt === "string" && Number.isFinite(Date.parse(value.occurredAt)), "message occurredAt must be a parseable timestamp");
  if (value.threadId !== undefined && value.threadId !== null)
    check(typeof value.threadId === "string" && value.threadId.length > 0, "threadId must be text when present");
  if (value.inReplyTo !== undefined && value.inReplyTo !== null)
    check(typeof value.inReplyTo === "string" && value.inReplyTo.length > 0, "inReplyTo must be text when present");
  return value;
};
const byTime = (a, b) => a.occurredAt.localeCompare(b.occurredAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
// Build threads. Messages without a threadId form singleton threads keyed by
// their own id. Each thread flattens oldest-first with depth.
export function buildThreads(messages) {
  check(Array.isArray(messages) && messages.length <= 10000, "messages must be a list of at most 10000");
  const checked = messages.map(messageOf);
  const groups = new Map();
  for (const message of checked) {
    const key = message.threadId ?? message.id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(message);
  }
  const threads = [...groups.entries()].map(([threadId, group]) => {
    const nodes = new Map(group.map(message => [message.id, { message, children: [] }]));
    const roots = [];
    for (const message of [...group].sort(byTime)) {
      const parent = message.inReplyTo ? nodes.get(message.inReplyTo) : null;
      const node = nodes.get(message.id);
      // Cycles/dangling refs: guard with a depth cap and fall back to root.
      if (parent && parent !== node && depthOf(nodes, message.inReplyTo, 0) < 64) parent.children.push(node);
      else roots.push(node);
    }
    roots.sort((a, b) => byTime(a.message, b.message));
    const flat = [];
    const walk = (node, depth) => { flat.push(Object.freeze({ message: node.message, depth })); node.children.sort((a, b) => byTime(a.message, b.message)).forEach(child => walk(child, depth + 1)); };
    roots.forEach(root => walk(root, 0));
    const sorted = [...group].sort(byTime);
    return Object.freeze({ threadId, messageCount: group.length, depth: flat.reduce((max, entry) => Math.max(max, entry.depth), 0),
      firstAt: sorted[0].occurredAt, lastAt: sorted[sorted.length - 1].occurredAt, entries: Object.freeze(flat) });
  });
  threads.sort((a, b) => b.lastAt.localeCompare(a.lastAt) || (a.threadId < b.threadId ? -1 : 1));
  return Object.freeze(threads);
}
const depthOf = (nodes, id, depth) => {
  const node = nodes.get(id);
  if (!node || !node.message.inReplyTo || depth > 64) return depth;
  return depthOf(nodes, node.message.inReplyTo, depth + 1);
}
// Convenience: the single thread containing a message id, or null.
export function threadFor(messages, messageId) {
  check(typeof messageId === "string" && messageId.length > 0, "messageId must be text");
  return buildThreads(messages).find(thread => thread.entries.some(entry => entry.message.id === messageId)) ?? null;
}
export { ThreadError };
