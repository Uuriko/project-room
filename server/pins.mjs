// Pinned messages (issue #6 B2): the HTTP-facing read and write for
// the pin reducers in src/events.js. Both entry points re-check membership on every call through
// store.authenticate, so a revoked member gets the same refusal as on every
// other room route. Pin and unpin go through store.command, the single write
// path (idempotency, write budget, event bound, protectWrite at the router);
// a request that asks for the state the room is already in appends nothing.
import { randomUUID } from "node:crypto";
import { ServiceError } from "./store.mjs";
import { EVENT_TYPES as T, PIN_LIMIT, pinnedMessages, validId } from "../src/events.js";

const fail = (status, code, message) => { throw new ServiceError(status, code, message); };

// Public view of one pin: the message body is included because the pinned
// list is read by members who can already read every message in the room.
function pinView({ messageId, pinnedById, pinnedAt, message }) {
  return {
    messageId, pinnedById, pinnedAt,
    authorId: message.authorId, body: message.body, createdAt: message.createdAt,
    workItemId: message.workItemId ?? null, replyToId: message.replyToId ?? null
  };
}

function listView(store, roomId) {
  const room = store.room(roomId);
  const pins = pinnedMessages(room.state).map(pinView);
  return { roomId, sequence: room.sequence, limit: PIN_LIMIT, count: pins.length, pins };
}

export function listPins(store, token, roomId, expectedSessionBinding = null) {
  return store.readTransaction(() => {
    store.authenticate(token, roomId, expectedSessionBinding);
    return listView(store, roomId);
  });
}

// Body: { messageId, pinned, requestId? }. requestId is the optional
// client-chosen idempotency key for the underlying command.
export function setPin(store, token, roomId, data, expectedSessionBinding = null) {
  if (!data || typeof data !== "object" || Array.isArray(data)) fail(422, "invalid_pin", "messageId and pinned are required");
  const keys = Object.keys(data);
  if (!keys.includes("messageId") || !keys.includes("pinned") || keys.some(key => !["messageId", "pinned", "requestId"].includes(key))) {
    fail(422, "invalid_pin", "messageId and pinned are required; optional: requestId");
  }
  if (typeof data.messageId !== "string" || !data.messageId.trim() || data.messageId.length > 384) fail(422, "invalid_pin", "messageId must be a message id");
  if (typeof data.pinned !== "boolean") fail(422, "invalid_pin", "pinned must be true or false");
  if (data.requestId !== undefined && !validId(data.requestId)) fail(422, "invalid_pin", "requestId must be a command id");
  const messageId = data.messageId;
  // Membership is checked before anything about the room is disclosed; the
  // early return for "already in the requested state" appends no event.
  const current = store.readTransaction(() => {
    store.authenticate(token, roomId, expectedSessionBinding);
    const room = store.room(roomId);
    const message = room.state.messages.find(m => m.id === messageId);
    if (!message) fail(404, "message_not_found", "No such message in this room");
    // 409 on both write paths: the same refusal through `commands` is 409 command_rejected (store.command maps the reducer message).
    if (data.pinned && (message.deletedAt || message.body == null)) fail(409, "message_deleted", "A deleted message cannot be pinned");
    return { pinned: Boolean(room.state.pins?.some(pin => pin.messageId === messageId)) };
  });
  let receipt = null;
  if (current.pinned !== data.pinned) {
    receipt = store.command(token, roomId, {
      id: data.requestId ?? randomUUID(),
      type: data.pinned ? T.MESSAGE_PINNED : T.MESSAGE_UNPINNED,
      data: { messageId }
    }, expectedSessionBinding);
  }
  return {
    messageId, pinned: data.pinned,
    changed: receipt !== null && receipt.duplicate === false,
    // The command receipt, when a command was issued; absent when the room was already in the requested state.
    ...(receipt ? { event: { id: receipt.event.id, sequence: receipt.sequence, duplicate: receipt.duplicate } } : {}),
    ...store.readTransaction(() => listView(store, roomId))
  };
}
