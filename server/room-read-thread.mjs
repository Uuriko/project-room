// room.read-thread tool contract (B003). The agent-facing thread read: an
// agent calls readThread with a threadId and gets the thread back as a
// depth-capped, oldest-first flat list with a participant summary — shaped
// for an agent to consume, not for the UI. The caller supplies the thread
// (built by the A010 thread builder); this module never reads the store.
// Pure, dependency-free, deterministic; frozen outputs. MCP/HTTP wiring is a
// later slice.
class ReadThreadError extends Error { constructor(code, message) { super(message); this.name = "ReadThreadError"; this.code = code; } }
const fail = (code, message) => { throw new ReadThreadError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_read_call", message); };

const callOf = value => {
  check(value !== null && typeof value === "object" && !Array.isArray(value), "read call must be an object");
  check(typeof value.threadId === "string" && value.threadId.length > 0 && value.threadId.length <= 512, "threadId must be 1..512 characters");
  if (value.maxDepth !== undefined) check(Number.isInteger(value.maxDepth) && value.maxDepth >= 0 && value.maxDepth <= 50, "maxDepth must be an integer 0..50");
  if (value.limit !== undefined) check(Number.isInteger(value.limit) && value.limit >= 1 && value.limit <= 500, "limit must be an integer 1..500");
  return { threadId: value.threadId, maxDepth: value.maxDepth ?? 10, limit: value.limit ?? 100 };
};
const threadOf = value => {
  check(value !== null && typeof value === "object", "thread must be supplied by the caller");
  check(typeof value.threadId === "string", "thread needs a threadId");
  check(Array.isArray(value.messages), "thread needs a messages list");
  return value;
};
const messageOf = value => {
  check(value !== null && typeof value === "object", "thread messages must be objects");
  return { id: value.id ?? null, depth: value.depth ?? 0,
    from: value.from ?? value.authorId ?? "unknown",
    subject: value.subject ?? null,
    body: typeof value.body === "string" && value.body.length > 600 ? `${value.body.slice(0, 597)}…` : (value.body ?? null),
    at: value.at ?? value.createdAt ?? null };
};
// Read a thread for an agent: depth-capped, oldest-first, participant
// summary. threads is a lookup the caller supplies (Map or { threadFor }).
export function readThread(call, threads) {
  const { threadId, maxDepth, limit } = callOf(call);
  check(threads !== null && typeof threads === "object", "thread lookup must be supplied by the caller");
  const found = typeof threads.threadFor === "function" ? threads.threadFor(threadId)
    : threads instanceof Map ? threads.get(threadId) : threads[threadId];
  if (!found) fail("thread_not_found", `no thread "${threadId}"`);
  const thread = threadOf(found);
  const messages = thread.messages.map(messageOf)
    .filter(message => message.depth <= maxDepth)
    .slice(0, limit);
  const participants = [...new Set(messages.map(message => message.from))].sort();
  return Object.freeze({ threadId: thread.threadId,
    messageCount: thread.messages.length, returned: messages.length,
    participants: Object.freeze(participants),
    messages: Object.freeze(messages.map(message => Object.freeze(message))) });
}
// Describe the tool for MCP registration (pure metadata, no wiring).
export const TOOL_DEFINITION = Object.freeze({
  name: "room.read-thread",
  description: "Read a conversation thread oldest-first with a participant summary.",
  inputSchema: Object.freeze({ type: "object",
    properties: Object.freeze({
      threadId: Object.freeze({ type: "string", maxLength: 512 }),
      maxDepth: Object.freeze({ type: "integer", minimum: 0, maximum: 50 }),
      limit: Object.freeze({ type: "integer", minimum: 1, maximum: 500 }),
    }),
    required: Object.freeze(["threadId"]) }),
});
export { ReadThreadError };
