// A bounded page of room messages. The default room snapshot and
// GET /api/rooms/:id/messages both use this so a busy room never ships its
// whole history on one response. `before` is the posting seq of the oldest
// message in the page (the member read cursor is a different field). The next
// page is every visible message strictly older than that seq.
import { messageRepository } from "./message-repository.mjs";
import { messageInHistory } from "./history-visibility.mjs";
import { redactMessageTree } from "./redact-read.mjs";
import { ServiceError } from "./service-error.mjs";

export const MESSAGE_PAGE_LIMIT = 100;
export const SNAPSHOT_PAGE_MESSAGES = 50;

let fullSnapshotReads = 0;
export function noteFullSnapshotRead() { fullSnapshotReads += 1; }
export function snapshotFullCompatReads() { return fullSnapshotReads; }

const fail = (status, code, message) => { throw new ServiceError(status, code, message); };

export function messageSeqs(db, roomId, ids) {
  const seqs = new Map();
  for (let start = 0; start < ids.length; start += 256) {
    const slice = ids.slice(start, start + 256);
    if (!slice.length) continue;
    for (const row of db.prepare(`SELECT message_id AS messageId, seq FROM messages
      WHERE room_id=? AND message_id IN (SELECT value FROM json_each(?))`).all(roomId, JSON.stringify(slice))) {
      seqs.set(row.messageId, row.seq);
    }
  }
  return seqs;
}

export function messagesPageOf(messages, seqs, hasMore) {
  const oldest = messages[0];
  const before = oldest && seqs.has(oldest.id) ? seqs.get(oldest.id) : null;
  return { before, hasMore: Boolean(hasMore) };
}

export function readMessagePage(store, token, roomId, { before = null, limit = SNAPSHOT_PAGE_MESSAGES, expectedSessionBinding = null } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MESSAGE_PAGE_LIMIT) fail(422, "invalid_message_page", "Choose a page of at most 100 messages");
  if (before !== null && (!Number.isSafeInteger(before) || before < 0)) fail(422, "invalid_message_page", "Choose a message cursor");
  return store.readTransaction(() => {
    const auth = store.authenticate(token, roomId, expectedSessionBinding);
    const room = store.room(roomId);
    const repository = messageRepository(store, roomId, room.state);
    const floor = store.historyFloor(roomId, auth.member.id);
    const visible = message => messageInHistory(message, floor)
      && (!message.toMemberId || message.authorId === auth.member.id || message.toMemberId === auth.member.id);
    const chosen = [];
    let hasMore = false;
    const consider = batch => {
      const seqs = messageSeqs(store.db, roomId, batch.map(message => message.id));
      for (const message of batch) {
        const seq = seqs.get(message.id);
        if (before !== null && (seq === undefined || seq >= before)) continue;
        if (chosen.length < limit) chosen.push({ message, seq: seq ?? null });
        else { hasMore = true; return true; }
      }
      return false;
    };
    const pending = [];
    for (const message of repository.records({ descending: true })) {
      if (!visible(message)) continue;
      pending.push(message);
      if (pending.length === 256 && consider(pending.splice(0, pending.length))) break;
    }
    if (!hasMore && pending.length) consider(pending);
    chosen.reverse();
    const oldest = chosen[0];
    return {
      messagesVersion: 1,
      roomId,
      sequence: room.sequence,
      messages: chosen.map(item => redactMessageTree(item.message)),
      messagesPage: { before: oldest?.seq ?? null, hasMore },
      viewerId: auth.member.id,
      viewerAccountId: auth.account?.id ?? null,
      viewerAuthEpoch: auth.account?.authEpoch ?? null,
      viewerSessionBinding: auth.sessionBinding,
      viewerSessionRevision: auth.sessionRevision ?? null
    };
  });
}
