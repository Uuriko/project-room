// Transaction-scoped message command admission. RoomStore owns authentication,
// idempotency and commit; this boundary owns archived entity restoration and
// reference conflicts. Keep these phases separate so existing admission order
// and error precedence remain stable during the writer migration.
import { EVENT_TYPES as T } from '../src/events.js';
import { archivedMessageRow, restoreArchivedMessage, restoreArchivedReference } from './messages-store.mjs';
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
  // The author or the Room owner can still delete an archived message: bring
  // that one message back into the projection (it stays retained) and let the
  // normal delete and redaction run. Anyone else falls through to the
  // archived-message refusal below, which confirms nothing to a non-party.
  if (command.type === T.MESSAGE_DELETED && typeof command.data?.messageId === "string") {
    const archivedRow = archivedMessageRow(store.db, roomId, command.data.messageId);
    if (archivedRow && (archivedRow.author_id === actorId || room.state.room?.ownerId === actorId)
        && restoreArchivedMessage(store, roomId, command.data.messageId)) room = store.room(roomId);
  }
  // Normalized-tail mode loads only the referenced archived record and its
  // ancestor chain for the existing reducer. Visibility is checked before
  // restoration; permissions and revision checks remain in applyEvent.
  if (store.messageProjectionWindow !== null) {
    const reference = command.data?.[RESTORED_REF_FIELDS[command.type]];
    if (restoreArchivedReference(store, roomId, reference, actorId)) room = store.room(roomId);
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
