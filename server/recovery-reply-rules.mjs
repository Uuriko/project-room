// Original independent reply-history predicates shared by full and durable recovery.
import {isDeepStrictEqual} from 'node:util';
import {validId,MAX_MESSAGE_BODY_CHARS} from '../src/events.js';
import {prepareReplyPost,recordReplyPost,cancelReplyRequest,REPLY_CANCELLED,progressReplyRequest,REPLY_PROGRESSED} from '../src/reply-requests.js';
const check = condition => { if (!condition) throw new Error("Reply request history requires operator reconciliation"); };
const messageFields = ["id", "authorId", "body", "workItemId", "replyToId", "toMemberId", "createdAt"];
export const exactReplyAuditMessage = message => Object.fromEntries(messageFields.map(key => [key, message[key]]));
export function compareReplyRequestAudit(actual, expected) {
  check(Object.hasOwn(actual, "replyRequests") === Object.hasOwn(expected, "replyRequests"));
  check(isDeepStrictEqual(actual.replyRequests, expected.replyRequests));
  // Once requests exist, every immutable message link can affect their context.
  // Reactions/proposal metadata remain the responsibility of their own audits.
  if (expected.replyRequests) check(isDeepStrictEqual(actual.messages.map(exactReplyAuditMessage), expected.messages));
}

// Reconstruct only membership availability, work existence, messages and requests.
// Unrelated historical work transitions may predate today's rules; do not replay
// them to establish the request proof hidden behind a projection checkpoint.
// archivedIds: messages moved out of the stored projection; the replay keeps them
// (the checkpoint is a full copy) but the live state no longer does.
export function auditReplyRequests(state, history, checkpoint = null, archivedIds = null) {
  const projected = { room: null, members: {}, workItems: {}, messages: [] }, posts = new Map(), ids = new Set();
  let checkpointChecked = !checkpoint;
  if (checkpoint?.sequence === 0) { compareReplyRequestAudit(JSON.parse(checkpoint.projection), projected); checkpointChecked = true; }
  for (const row of history) {
    advanceReplyRequestAudit(projected, row, {posts,ids});
    if (checkpoint && row.sequence === checkpoint.sequence) {
      compareReplyRequestAudit(JSON.parse(checkpoint.projection), projected); checkpointChecked = true;
    }
  }
  check(checkpointChecked);
  compareReplyRequestAudit(state, archivedIds?.size ? { ...projected, messages: projected.messages.filter(message => !archivedIds.has(message.id)) } : projected);
}

export function advanceReplyRequestAudit(projected, row, {posts,ids}) {
  const ownMember = memberId => Object.hasOwn(projected.members, memberId) ? projected.members[memberId] : undefined;
    const e = typeof row.body === "string" ? JSON.parse(row.body) : row.event, data = e.data;
    if (e.type === "room.created") { check(!projected.room); projected.room = { id: e.roomId, ownerId: data.ownerId }; }
    // A room can change hands, and cancelReplyRequest below authorizes against
    // state.room.ownerId. Taking the owner from room.created alone meant an
    // owner who RECEIVED the room cancelling somebody else's request replayed
    // as "Only the requester or Room owner may cancel" and threw, which fails
    // auditRecovery and takes backupRoom down for the whole database
    // permanently. The same mistake auditCharters and auditWorkHelp each made.
    //
    // Only ownerId is replayed here, unlike auditWorkHelp: this projection
    // holds no permissions or revisions to keep in step, and prepareReplyPost
    // and cancelReplyRequest read nothing else off the room.
    if (e.type === "ownership.transferred") {
      check(projected.room && validId(data.toMemberId) && Object.hasOwn(projected.members, data.toMemberId)
        && e.actorId === projected.room.ownerId);
      projected.room.ownerId = data.toMemberId;
    }
    if (["member.added", "member.joined_via_invitation"].includes(e.type)) {
      check(validId(data.memberId) && !Object.hasOwn(projected.members, data.memberId));
      projected.members[data.memberId] = { id: data.memberId, kind: data.kind ?? "human", active: true };
    }
    if (e.type === "member.access_changed") {
      // A truthy map lookup treats toString as a member and writes active onto
      // the prototype function, so the audit accepts an access change for nobody.
      const person = ownMember(data.memberId);
      check(person && typeof data.active === "boolean");
      person.active = data.active;
    }
    if (e.type === "work.proposed") { check(validId(data.workItemId)); projected.workItems[data.workItemId] = {}; }
    if (e.type === "message.posted") {
      const mode = prepareReplyPost(projected, e), messageId = data.messageId || e.id;
      check(validId(messageId) && !ids.has(messageId)); ids.add(messageId);
      // PRIV-1: a redacted post replays with a null body. The projection body is null too.
      const redactedPost = data.redacted === true && data.body == null;
      check(validId(e.actorId) && (redactedPost || (typeof data.body === "string" && data.body.length <= MAX_MESSAGE_BODY_CHARS && data.body.trim().length > 0)));
      for (const key of ["messageId", "workItemId", "replyToId", "toMemberId"]) check(data[key] == null || validId(data[key]));
      check(!data.replyToId || projected.messages.some(message => message.id === data.replyToId));
      if (mode || projected.replyRequests) {
        check(ownMember(e.actorId)?.active === true);
        check(!data.workItemId || Object.hasOwn(projected.workItems, data.workItemId));
        if (data.toMemberId) {
          const addressed = ownMember(data.toMemberId);
          check(addressed && (mode === "respond" || addressed.active === true));
        }
      }
      if (mode === "respond") check(posts.get(data.contextSequence) === data.contextEventId);
      projected.messages.push({ id: messageId, authorId: e.actorId, body: redactedPost ? null : data.body,
        workItemId: data.workItemId || null, replyToId: data.replyToId || null, toMemberId: data.toMemberId || null, createdAt: e.at });
      recordReplyPost(projected, e, mode); posts.set(row.sequence, e.id);
    }
    // Messages are not immutable: message.edited and message.deleted are
    // ordinary commands. Without these two branches the rebuild keeps the body
    // as first posted while the live projection carries the edit, and compare()
    // holds every message body against it once any request exists - so a single
    // edit to any message in the room, related to a request or not, failed this
    // audit permanently. auditRecovery gates backupRoom, so that took the whole
    // database's backup and restore path down over a corrected typo.
    // Mirror src/events.js editMessage/deleteMessage for the compared fields
    // only: body is the single field of exactMessage that either one changes.
    if (e.type === "message.edited") {
      const message = projected.messages.find(entry => entry.id === data.messageId);
      // The live engine refuses an edit to a message it cannot find, so a log
      // containing one is a real inconsistency and still fails here.
      const redactedEdit = data.redacted === true && data.body == null;
      check(Boolean(message) && (redactedEdit || typeof data.body === "string"));
      message.body = redactedEdit ? null : data.body;
    }
    if (e.type === "message.deleted") {
      const message = projected.messages.find(entry => entry.id === data.messageId);
      check(Boolean(message));
      message.body = null; // A tombstone keeps who and when, never the text.
    }
    if (e.type === REPLY_CANCELLED) cancelReplyRequest(projected, e);
    if (e.type === REPLY_PROGRESSED) progressReplyRequest(projected, e);
}

