// F1: open-questions radar. A pure derivation over the room's message list:
// an "open question" is a non-deleted message whose body contains "?" with
// no reply from a different author — neither a direct replyToId reply nor a
// later message in the same thread by someone other than the asker. The
// asker's own follow-ups never count as answers. Frozen outputs; malformed
// inputs throw OpenQuestionsError.
//
// DM scoping: a DM belongs to its two parties, so a viewer sees their own
// DMs plus public messages; everyone else's DMs are invisible to the radar.
// An answer the asker could not read (a DM to someone else) does not close
// the question.
import { ServiceError } from "./store.mjs";
import { messageInHistory } from "./history-visibility.mjs";

const fail = (status, code, message) => { throw new ServiceError(status, code, message); };

export const OPEN_QUESTIONS_DEFAULT_LIMIT = 50;
export const OPEN_QUESTIONS_MAX_LIMIT = 100;
const EXCERPT_LENGTH = 160;

// A message's thread root: itself when top-level. Walks the reply chain so
// every message in one conversation shares a root. A parent that is not in
// this projection is still the shared root — two replies to the same missing
// id are one thread. Stopping on the child splits that thread and leaves an
// answered question open.
function threadRootOf(byId, messageId) {
  let node = byId.get(messageId);
  const seen = new Set();
  while (node?.replyToId && !seen.has(node.id)) {
    seen.add(node.id);
    const parent = byId.get(node.replyToId);
    if (!parent) return node.replyToId;
    node = parent;
  }
  return node?.id ?? messageId;
}

const excerptOf = body => String(body).replace(/\s+/g, " ").trim().slice(0, EXCERPT_LENGTH);

// Pure derivation. `messages` is the room state's message list (plain
// objects with id/authorId/body/replyToId/toMemberId/createdAt/deletedAt).
// `viewerId` scopes DMs; null means public messages only.
export function findOpenQuestions({ messages, viewerId = null }) {
  if (!Array.isArray(messages)) throw new Error("messages must be an array");
  const byId = new Map();
  for (const message of messages) {
    if (message && typeof message.id === "string") byId.set(message.id, message);
  }
  const rootOf = id => threadRootOf(byId, id);
  const visible = message => {
    if (!message || message.deletedAt) return false;
    if (!message.toMemberId) return true; // public
    if (!viewerId) return false;
    return message.toMemberId === viewerId || message.authorId === viewerId;
  };
  const isQuestion = message => typeof message.body === "string" && message.body.includes("?");
  // True when someone other than the asker spoke in the question's thread at
  // or after the question, or replied to it directly. A reply the asker
  // cannot read (someone else's DM) never closes the question. Response
  // candidates must also be visible to the viewer of this projection.
  const answered = question => {
    const root = rootOf(question.id);
    const askedAt = Date.parse(question.createdAt) || 0;
    for (const message of messages) {
      if (!message || message.id === question.id || message.deletedAt) continue;
      if (message.authorId === question.authorId) continue; // own follow-up
      if (message.toMemberId && message.toMemberId !== question.authorId) continue; // unreadable answer
      if (!visible(message)) continue;
      if (message.replyToId === question.id) return true;
      if (rootOf(message.id) === root && (Date.parse(message.createdAt) || 0) >= askedAt) return true;
    }
    return false;
  };
  const open = [];
  for (const message of messages) {
    if (!visible(message) || !isQuestion(message) || answered(message)) continue;
    open.push(Object.freeze({
      messageId: message.id,
      authorId: message.authorId,
      excerpt: excerptOf(message.body),
      askedAt: message.createdAt ?? null,
      threadRootId: rootOf(message.id),
    }));
  }
  open.sort((a, b) => String(b.askedAt ?? "").localeCompare(String(a.askedAt ?? "")));
  return Object.freeze(open.slice(0, OPEN_QUESTIONS_MAX_LIMIT));
}

// Ids an archive must keep so that no reader's open-questions list changes.
// One pass, no per-viewer calls. A question is kept when it is open for some
// viewer: a public question is open for the public view exactly when it is open
// for anyone (the public view sees the fewest answers); a DM question is open
// for its recipient whenever it is open for its author, so the recipient's view
// decides. Every message that could close a kept question (a reply to it, or
// another author's later message in its thread) is kept too, so archiving the
// answer cannot reopen it. `alsoKeep` is a set of message ids the caller already
// keeps (pins, work); questions among them keep their closers as well. No cap
// is applied here: the 100-newest cap belongs to the reader, not the archive.
export function openQuestionRetention(messages, alsoKeep = new Set()) {
  const keep = new Set();
  const byId = new Map();
  for (const message of messages) if (message && typeof message.id === "string") byId.set(message.id, message);
  // Thread roots, shared along each reply chain (same answers as threadRootOf).
  const roots = new Map();
  const rootOf = id => {
    const path = [];
    const seen = new Set();
    let node = byId.get(id), root;
    while (true) {
      if (!node) { root = id; break; }
      if (roots.has(node.id)) { root = roots.get(node.id); break; }
      if (!node.replyToId || seen.has(node.id)) { root = node.id; break; }
      seen.add(node.id);
      path.push(node.id);
      const parent = byId.get(node.replyToId);
      if (!parent) { root = node.replyToId; break; }
      node = parent;
    }
    for (const visited of path) roots.set(visited, root);
    if (!roots.has(id)) roots.set(id, root);
    return root;
  };
  const at = message => Date.parse(message.createdAt) || 0;
  const isQuestion = message => !message.deletedAt && typeof message.body === "string" && message.body.includes("?");
  // Per thread, the latest candidate answers that can close a question, found
  // once: the two latest public messages by different authors (so one of them
  // is never the asker), the latest DM per (recipient, author), and replies by
  // parent id. A question then costs a few lookups, not a scan of its thread.
  const threads = new Map();
  const replies = new Map();
  for (const message of byId.values()) {
    if (message.deletedAt) continue;
    const root = rootOf(message.id);
    let thread = threads.get(root);
    if (!thread) threads.set(root, thread = { top: [], dms: new Map() });
    const entry = { id: message.id, authorId: message.authorId, time: at(message) };
    if (!message.toMemberId) {
      const same = thread.top.findIndex(item => item.authorId === entry.authorId);
      if (same >= 0) { if (thread.top[same].time <= entry.time) thread.top[same] = entry; } else thread.top.push(entry);
      thread.top.sort((x, y) => y.time - x.time);
      if (thread.top.length > 2) thread.top.length = 2;
    } else {
      const key = `${message.toMemberId}\n${message.authorId}`;
      const held = thread.dms.get(key);
      if (!held || held.time <= entry.time) thread.dms.set(key, entry);
    }
    if (typeof message.replyToId === "string") {
      if (!replies.has(message.replyToId)) replies.set(message.replyToId, []);
      replies.get(message.replyToId).push(message);
    }
  }
  const latestPublic = (thread, notAuthor) => thread?.top.find(item => item.authorId !== notAuthor) ?? null;
  const directReplies = (question, viewerId) => (replies.get(question.id) ?? []).filter(reply =>
    reply.authorId !== question.authorId
    && (reply.toMemberId ? reply.toMemberId === question.authorId && reply.authorId === viewerId : true));
  for (const question of byId.values()) {
    if (!isQuestion(question)) continue;
    const viewerId = question.toMemberId ?? null;
    const thread = threads.get(rootOf(question.id));
    const asked = at(question);
    // The weakest viewer: the public view, or the recipient of a DM question.
    const publicCloser = latestPublic(thread, question.authorId);
    const recipientDm = viewerId ? thread?.dms.get(`${question.authorId}\n${viewerId}`) : null;
    const answered = (publicCloser && publicCloser.time >= asked) || (recipientDm && recipientDm.time >= asked)
      || directReplies(question, viewerId).length > 0;
    if (answered && !alsoKeep.has(question.id)) continue;
    keep.add(question.id);
    // Keep what closes it for any viewer: the latest public closer, the latest DM
    // to the asker per author, and direct replies the asker can read.
    if (publicCloser && publicCloser.time >= asked) keep.add(publicCloser.id);
    for (const [key, entry] of thread?.dms ?? []) {
      const [to, author] = key.split("\n");
      if (to === question.authorId && author !== question.authorId && entry.time >= asked) keep.add(entry.id);
    }
    for (const reply of directReplies(question, undefined)) keep.add(reply.id);
    for (const reply of replies.get(question.id) ?? []) if (reply.authorId !== question.authorId && reply.toMemberId === question.authorId) keep.add(reply.id);
  }
  return keep;
}

// HTTP-facing read: membership is re-checked on every call; DMs outside the
// caller's parties are excluded by the pure derivation above.
export function listOpenQuestions(store, token, roomId, params = {}, expectedSessionBinding = null) {
  const auth = store.authenticate(token, roomId, expectedSessionBinding);
  if (!auth.member || auth.member.active === false) fail(403, "access_denied", "Room membership is inactive");
  const { limit = OPEN_QUESTIONS_DEFAULT_LIMIT } = params ?? {};
  const count = Number(limit);
  if (!Number.isInteger(count) || count < 1 || count > OPEN_QUESTIONS_MAX_LIMIT) {
    fail(422, "invalid_open_questions_limit", `Choose a limit between 1 and ${OPEN_QUESTIONS_MAX_LIMIT}`);
  }
  return store.readTransaction(() => {
    const room = store.room(roomId);
    const member = room.state.members[auth.member.id] ?? auth.member;
    // PRIV-2: questions from before a since_join reader joined stay out.
    const floor = store.historyFloor(roomId, member.id);
    const messages = (room.state.messages ?? []).filter(message => messageInHistory(message, floor));
    const questions = findOpenQuestions({ messages, viewerId: member.id });
    return {
      roomId,
      viewerId: member.id,
      evaluatedAt: store.now(),
      openQuestions: questions.slice(0, count),
    };
  });
}
