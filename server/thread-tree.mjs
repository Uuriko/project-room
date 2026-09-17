// Threaded reply depth (K011). A pure thread-tree builder: given flat
// messages with replyTo references, build a nested thread tree, compute
// depth per message, and flatten with collapse state. The module is pure
// and dependency-free. Frozen outputs; malformed inputs throw ThreadError.
// Collapse/expand UI wiring is a later slice.
class ThreadError extends Error { constructor(code, message) { super(message); this.name = "ThreadError"; this.code = code; } }
const fail = (code, message) => { throw new ThreadError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_thread", message); };
// Build a thread tree from flat messages.
// messages: [{ messageId, replyTo (messageId or null), text }]
// Returns [{ messageId, depth, children }] — roots have depth 0.
export function buildThreadTree({ messages }) {
  check(Array.isArray(messages), "messages must be an array");
  const byId = new Map();
  for (const m of messages) {
    check(m !== null && typeof m === "object", "every message must be an object");
    check(typeof m.messageId === "string" && m.messageId.length > 0, "messageId must be non-empty");
    check(!byId.has(m.messageId), `duplicate messageId "${m.messageId}"`);
    byId.set(m.messageId, { ...m, children: [] });
  }
  const roots = [];
  for (const node of byId.values()) {
    if (node.replyTo && byId.has(node.replyTo)) {
      byId.get(node.replyTo).children.push(node);
    } else {
      roots.push(node);
    }
  }
  // Assign depth and freeze.
  const freezeNode = (node, depth) => {
    const children = node.children.map(c => freezeNode(c, depth + 1));
    return Object.freeze({ messageId: node.messageId, replyTo: node.replyTo || null,
      text: node.text || "", depth, children: Object.freeze(children) });
  };
  return Object.freeze(roots.map(r => freezeNode(r, 0)));
}
// Flatten a tree with collapse state. collapsedIds is a Set of messageIds
// whose children are hidden. Returns [{ messageId, depth, visible }].
export function flattenThreads({ tree, collapsedIds }) {
  check(Array.isArray(tree), "tree must be an array");
  check(collapsedIds instanceof Set, "collapsedIds must be a Set");
  const flat = [];
  const walk = (nodes, depth, hidden) => {
    for (const node of nodes) {
      const visible = !hidden;
      flat.push(Object.freeze({ messageId: node.messageId, depth, visible }));
      const collapsed = collapsedIds.has(node.messageId);
      walk(node.children, depth + 1, hidden || collapsed);
    }
  };
  walk(tree, 0, false);
  return Object.freeze(flat);
}
export { ThreadError };
