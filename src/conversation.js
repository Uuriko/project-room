// Conversation structure is derived from immutable reply links, including older logs.
export const REACTIONS = Object.freeze({ like: "👍", heart: "❤️", celebrate: "🎉", thinking: "🤔" });

export function conversationIndex(messages) {
  const byId = new Map(messages.map(message => [message.id, message]));
  const rootById = new Map(), threads = new Map(), roots = [];
  for (const message of messages) {
    // Parents must already exist when a message is committed. No recursive walk is needed.
    const rootId = rootById.get(message.replyToId) || message.id;
    rootById.set(message.id, rootId);
    if (rootId === message.id) { roots.push(message); threads.set(rootId, []); }
    threads.get(rootId).push(message);
  }
  return { byId, rootById, threads, roots };
}

// The input is the current authenticated room snapshot, never a cross-room index.
export function searchMessages(state, query, limit = 50) {
  const term = String(query).trim().slice(0, 200).toLocaleLowerCase();
  if (!term) return { messages: [], total: 0 };
  const matches = state.messages.filter(message =>
    message.body.toLocaleLowerCase().includes(term) ||
    (state.members[message.authorId]?.displayName || "").toLocaleLowerCase().includes(term));
  return { messages: matches.slice(-limit).reverse(), total: matches.length };
}

// In-memory only: every thread owns its text, recipient, reply target, retry ID, and send error.
// The containing session discards the entire instance on sign-out or revoked access.
export class ConversationDrafts {
  constructor() { this.entries = new Map(); }
  get(threadId = null) {
    if (!this.entries.has(threadId)) this.entries.set(threadId, { body: "", toMemberId: "", replyToId: threadId, pending: null, error: "" });
    return this.entries.get(threadId);
  }
  save(threadId, values) { Object.assign(this.get(threadId), values); }
  clear(threadId) { this.entries.delete(threadId); }
  hasText() { return [...this.entries.values()].some(draft => draft.body.trim()); }
}
