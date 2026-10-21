// Transaction-scoped message command admission. RoomStore owns authentication,
// idempotency and the transaction; this boundary owns message persistence and
// reference conflicts. Keep these phases separate so existing admission order
// and error precedence remain stable during the writer migration.
import { EVENT_TYPES as T } from '../src/events.js';
import { affectedMessageIds, captureMessageCertification, advanceMessageCertification, syncMessageRows, archivedMessageRow, archivedMessageCommandContext } from './messages-store.mjs';
import { storedProjection } from './projection-at-rest.mjs';
import { ServiceError } from './service-error.mjs';
const fail = (status, code, message) => { throw new ServiceError(status, code, message); };

// Commands that name an existing message, and which field names it.
const ARCHIVED_REF_FIELDS = Object.freeze({
  [T.MESSAGE_EDITED]: "messageId", [T.MESSAGE_DELETED]: "messageId", [T.MESSAGE_REDACTED]: "messageId",
  [T.POLL_VOTED]: "messageId", [T.MESSAGE_PINNED]: "messageId", [T.MESSAGE_UNPINNED]: "messageId",
  [T.MESSAGE_POSTED]: "replyToId"
});

// Cross-domain commands also need an entity, but keep their legacy error
// contracts when rolling migration is disabled.
const RESTORED_REF_FIELDS = Object.freeze({ ...ARCHIVED_REF_FIELDS,
  [T.WORK_PROPOSED]: "sourceMessageId", [T.WORK_COMPLETED]: "evidenceMessageId",
  [T.CLAIM_RENEWED]: "progressMessageId", [T.DECISION_RECORDED]: "sourceMessageId",
  [T.OWNER_DECISION_RECORDED]: "sourceMessageId"
});

export function prepareMessageCommand(store, roomId, room, command, actorId) {
  // Preserve deletion admission even when rolling mode is disabled. The owner
  // may remove an archived private target, but this must not load its ancestry.
  if (command.type === T.MESSAGE_DELETED && typeof command.data?.messageId === "string") {
    const archivedRow = archivedMessageRow(store.db, roomId, command.data.messageId);
    if (archivedRow && (archivedRow.author_id === actorId || room.state.room?.ownerId === actorId)) {
      return archivedMessageCommandContext(store, roomId, room, command.data.messageId,
        { actorId, ancestors: false, allowPrivate: true });
    }
  }
  // The reducer still owns permissions, revisions and receipt withdrawal.
  // Preparing an entity context never writes an intermediate room projection.
  if (store.messageProjectionWindow !== null) {
    return archivedMessageCommandContext(store, roomId, room,
      command.data?.[RESTORED_REF_FIELDS[command.type]], { actorId });
  }

  return room;
}

export function assertMessageCommandReferences(store, roomId, state, command, actorId) {
  // Archived messages are not in the projection, so the reducer cannot change
  // them or thread under them. Refuse with a clear error. A DM the actor is
  // not a party to reads like an unknown id, so nothing about it is confirmed.
  const archivedRef = ARCHIVED_REF_FIELDS[command.type];
  if (archivedRef) {
    const refId = command.data?.[archivedRef];
    if (typeof refId === "string" && refId && !(state.messages || []).some(m => m.id === refId)) {
      const archivedRow = archivedMessageRow(store.db, roomId, refId);
      const party = archivedRow && (!archivedRow.to_member_id || archivedRow.author_id === actorId || archivedRow.to_member_id === actorId);
      // An archived message can still hold a pin (older archives did not retain pins).
      // Unpinning is allowed for anyone who may see the message and refused, like a
      // live DM, for a non-party; the reducer cannot check it without the message.
      const stillPinned = command.type === T.MESSAGE_UNPINNED && (state.pins ?? []).some(pin => pin.messageId === refId);
      if (archivedRow && stillPinned) {
        if (!party) fail(422, "command_rejected", "Cannot unpin a direct message you are not a party to");
      } else if (party) {
        fail(409, "message_archived", "That message is archived and cannot be changed or replied to");
      }
    }
  }
  // A new post cannot reuse the id of an archived message: the reducer only
  // sees the projection, so it would otherwise accept a second message under
  // that id. Same refusal as a live duplicate; it reads the same for a DM.
  if (command.type === T.MESSAGE_POSTED) {
    const newId = command.data?.messageId || command.id;
    if (typeof newId === "string" && newId && !(state.messages || []).some(m => m.id === newId)
        && archivedMessageRow(store.db, roomId, newId)) {
      fail(409, "command_rejected", "Message already exists");
    }
  }
}


// Prepare after reducer/authority validation, inside the command transaction.
// RoomStore persists the returned carrier alongside its event and receipt, then
// invokes persistEntities before any observer can see the transaction. Pending
// references are safe only because both writes share that transaction.
export function prepareMessageWrite(store, { roomId, previous, state, event, sequence }) {
  const certificate = store.maintainMessageCertification
    ? captureMessageCertification(store.db, {roomId,sequence:previous.sequence,event,state:previous.state}) : null;
  const projection = store.messageEntityProjection && certificate
    ? storedProjection(store.db,roomId,state,{messageEntities:true,pendingMessageIds:affectedMessageIds(event)})
    : store.storedProjection(roomId,state);
  return {
    projection,
    persistEntities() {
      syncMessageRows(store.db, {roomId,sequence,event,state});
      advanceMessageCertification(store.db,certificate,{sequence,event,state});
    }
  };
}
