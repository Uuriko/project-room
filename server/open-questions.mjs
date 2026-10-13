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

// Grow `keep` (ids the archive already keeps: pins, work, the newest tail) until
// nothing new is kept, so that no reader's open-questions list changes when
// everything else is archived:
//  - every reply ancestor of a kept message stays (replies thread under it);
//  - every question that is open for some viewer stays: a public question when it
//    is open for the public view (which sees the fewest answers, so that covers
//    every viewer), a DM question when it is open for its recipient;
//  - every kept question brings what could close it, so archiving an answer cannot
//    reopen it: the latest public closer, the latest DM to the asker per author,
//    and direct replies the asker can read (a direct reply closes whatever its clock).
// The rules feed each other (an ancestor can be an answered question whose answer
// must then stay), so this is a worklist over newly kept ids: indexes are built
// once, and each id is processed once, so the cost is linear in messages plus kept
// questions' closers. The 100-newest cap belongs to the reader, not the archive.
// Mutates and returns `keep`.
export function closeKeepSet(messages, keep = new Set()) {
  const byId = new Map();
  for (const message of messages ?? []) if (message && typeof message.id === "string") byId.set(message.id, message);
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
  // once: the two latest public messages by different authors (so one of them is
  // never the asker), the latest DM per (recipient, author), and replies by parent.
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
      // Indexed by recipient, then author, so a question reads only DMs to its asker.
      let toRecipient = thread.dms.get(message.toMemberId);
      if (!toRecipient) thread.dms.set(message.toMemberId, toRecipient = new Map());
      const held = toRecipient.get(message.authorId);
      if (!held || held.time <= entry.time) toRecipient.set(message.authorId, entry);
    }
    if (typeof message.replyToId === "string") {
      if (!replies.has(message.replyToId)) replies.set(message.replyToId, []);
      replies.get(message.replyToId).push(message);
    }
  }
  const latestPublic = (thread, notAuthor) => thread?.top.find(item => item.authorId !== notAuthor) ?? null;
  const readableReplies = question => (replies.get(question.id) ?? []).filter(reply =>
    reply.authorId !== question.authorId && (!reply.toMemberId || reply.toMemberId === question.authorId));
  const queue = [];
  const add = id => { if (!keep.has(id)) { keep.add(id); queue.push(id); } };
  for (const id of [...keep]) queue.push(id);
  // Questions open for the weakest viewer: the public view, or a DM's recipient.
  for (const question of byId.values()) {
    if (!isQuestion(question)) continue;
    const viewerId = question.toMemberId ?? null;
    const thread = threads.get(rootOf(question.id));
    const asked = at(question);
    const publicCloser = latestPublic(thread, question.authorId);
    const recipientDm = viewerId ? thread?.dms.get(question.authorId)?.get(viewerId) : null;
    const answered = (publicCloser && publicCloser.time >= asked) || (recipientDm && recipientDm.time >= asked)
      || (replies.get(question.id) ?? []).some(reply => reply.authorId !== question.authorId
        && (reply.toMemberId ? reply.toMemberId === question.authorId && reply.authorId === viewerId : true));
    if (!answered) add(question.id);
  }
  for (let next = 0; next < queue.length; next++) {
    const message = byId.get(queue[next]);
    if (!message) continue;
    for (let parent = byId.get(message.replyToId), hops = 0; parent && !keep.has(parent.id) && hops < 1000; parent = byId.get(parent.replyToId), hops++) add(parent.id);
    if (!isQuestion(message)) continue;
    const thread = threads.get(rootOf(message.id));
    const asked = at(message);
    const publicCloser = latestPublic(thread, message.authorId);
    if (publicCloser && publicCloser.time >= asked) add(publicCloser.id);
    for (const [author, entry] of thread?.dms.get(message.authorId) ?? []) {
      if (author !== message.authorId && entry.time >= asked) add(entry.id);
    }
    for (const reply of readableReplies(message)) add(reply.id);
  }
  return keep;
}

// What closeKeepSet adds on top of `alsoKeep` (ancestors, open questions, closers).
export function openQuestionRetention(messages, alsoKeep = new Set()) {
  return closeKeepSet(messages, new Set(alsoKeep));
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
