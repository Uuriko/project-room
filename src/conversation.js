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

// Opt-in, tab-scoped recovery. Read only after an authenticated room snapshot.
// No credentials or server receipts are stored. Browser storage is untrusted.
export class DraftRecovery {
  constructor(storage, now = Date.now) { this.storage = storage; this.now = now; this.key = "project-room:drafts:v1"; }
  clear() { try { this.storage?.removeItem(this.key); } catch {} }
  write(scope, drafts, threadId) {
    try {
      const entries = [...drafts.entries].filter(([, d]) => d.body.trim()).slice(-50).map(([id, d]) =>
        [id, { body: d.body, toMemberId: d.toMemberId, replyToId: d.replyToId,
          pending: d.pending ? { id: d.pending.command.id, contents: d.pending.contents } : null }]);
      this.storage.setItem(this.key, JSON.stringify({ scope, expires: this.now() + 12 * 60 * 60 * 1000, threadId, entries }));
      return true;
    } catch { this.clear(); return false; }
  }
  read(scope, state) {
    try {
      const raw = this.storage?.getItem(this.key);
      if (!raw) return null;
      if (raw.length > 500000) throw new Error("size");
      const saved = JSON.parse(raw);
      if (saved.scope !== scope || !Number.isFinite(saved.expires) || saved.expires <= this.now() || saved.expires > this.now() + 12 * 60 * 60 * 1000 || !Array.isArray(saved.entries) || saved.entries.length > 50) throw new Error("scope or expiry");
      const index = conversationIndex(state.messages), drafts = new ConversationDrafts();
      for (const [id, d] of saved.entries) {
        if (id !== null && !index.threads.has(id)) continue;
        if (typeof d.body !== "string" || d.body.length > 4000 || typeof d.toMemberId !== "string") continue;
        if (d.toMemberId && (!state.members[d.toMemberId] || state.members[d.toMemberId].active === false)) continue;
        if (d.replyToId !== null && (!index.byId.has(d.replyToId) || index.rootById.get(d.replyToId) !== id)) continue;
        const data = { body: d.body.trim(), toMemberId: d.toMemberId || null, replyToId: d.replyToId };
        const contents = JSON.stringify({ type: "message.posted", data, causationId: null });
        const pending = d.pending?.contents === contents && typeof d.pending.id === "string" && /^[a-zA-Z0-9-]{1,100}$/.test(d.pending.id)
          ? { contents, command: { id: d.pending.id, type: "message.posted", data } } : null;
        drafts.save(id, { ...data, body: d.body, toMemberId: d.toMemberId, pending });
      }
      return { drafts, threadId: drafts.entries.has(saved.threadId) ? saved.threadId : null };
    } catch { this.clear(); return null; }
  }
}
