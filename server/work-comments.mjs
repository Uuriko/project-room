// Work-item comments with @mentions (K026). A pure comment manager:
// add comments to work items, extract @mentions, list by work item.
// All state is caller-owned (a Map); the module is pure and
// dependency-free: createdAt is caller-supplied (ISO string) or null —
// no wall-clock reads. Comment IDs (c-N) are unique within a manager
// instance only; durable IDs are a persistence-slice concern. Frozen
// outputs; malformed inputs throw CommentError. UI wiring is a later slice.
class CommentError extends Error { constructor(code, message) { super(message); this.name = "CommentError"; this.code = code; } }
const fail = (code, message) => { throw new CommentError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_comment", message); };
// Extract @mentions from text. Returns array of usernames (without @).
export function extractMentions(text) {
  check(typeof text === "string", "text must be a string");
  const mentions = [];
  const regex = /@([a-zA-Z0-9_]+)/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    if (!mentions.includes(match[1])) mentions.push(match[1]);
  }
  return Object.freeze(mentions);
}
// Create a comment manager. store is a caller-owned Map (workItemId -> comments[]).
export function createComments({ store } = {}) {
  check(store === undefined || store instanceof Map, "store must be a Map if given");
  const comments = store ?? new Map();
  let commentCounter = 0;
  // Add a comment to a work item. commentId/createdAt are optional and
  // caller-supplied; createdAt defaults to null (no wall-clock read).
  const add = (workItemId, { authorId, text, commentId, createdAt }) => {
    check(typeof workItemId === "string" && workItemId.length > 0, "workItemId must be non-empty");
    check(typeof authorId === "string" && authorId.length > 0, "authorId must be non-empty");
    check(typeof text === "string" && text.trim().length > 0, "text must be non-empty");
    check(text.length <= 5000, "text must be 5000 chars or less");
    check(commentId === undefined || (typeof commentId === "string" && commentId.length > 0),
      "commentId must be a non-empty string if given");
    check(createdAt === undefined || (typeof createdAt === "string" && createdAt.length > 0),
      "createdAt must be a non-empty string if given");
    if (!comments.has(workItemId)) comments.set(workItemId, []);
    const comment = Object.freeze({ commentId: commentId ?? `c-${++commentCounter}`,
      workItemId, authorId, text: text.trim(),
      mentions: extractMentions(text), createdAt: createdAt ?? null });
    comments.get(workItemId).push(comment);
    return comment;
  };
  // List comments for a work item.
  const list = workItemId => {
    check(typeof workItemId === "string" && workItemId.length > 0, "workItemId must be non-empty");
    return Object.freeze([...(comments.get(workItemId) || [])]);
  };
  return Object.freeze({ add, list });
}
export { CommentError };
