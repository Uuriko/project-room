// Room scope for agent webhook subscriptions.
//
// room_ids_json NULL means every room the identity is seated in (legacy
// rows, and an explicit "*"). A JSON array names the rooms that receive
// events. HTTP may omit rooms until WEBHOOK_ROOMS_REQUIRED_AT; after that
// the field is required. MCP omits rooms by subscribing to the current room.
import { validId } from "../src/events.js";
import { AgentPluginError } from "./agent-plugin-store.mjs";
import { scopedKeyRoomBinding } from "./room-key-presence.mjs";
import { memberIdForWakeIdentity } from "./wake-identity-resolution.mjs";
import { API_KEY_PREFIX } from "./agent-api-keys.mjs";

export const MAX_WEBHOOK_ROOMS = 50;
// Spec date 2026-10-24 plus 30 days. Omit is all-rooms before this instant
// and 422 rooms_required at and after it.
export const WEBHOOK_ROOMS_REQUIRED_AT = Date.UTC(2026, 10, 23);
export const WEBHOOK_ROOMS_ALL_WARNING =
  "This subscription receives events from every room this identity is seated in. Pass rooms to limit delivery. rooms is required after 2026-11-23.";

const fail = (status, code, message) => { throw new AgentPluginError(status, code, message); };

export function identitySeatedInRoom(store, identityId, roomId) {
  const memberId = memberIdForWakeIdentity(store.db, roomId, identityId);
  if (!memberId) return false;
  let members;
  try { members = store.roomAuthority(roomId).members; } catch { return false; }
  if (!members || !Object.hasOwn(members, memberId)) return false;
  const member = members[memberId];
  return !!member && member.active !== false;
}

// "*" stores NULL (every seated room). An array stores that room list.
// Duplicate ids collapse. Anything else is 422 invalid_subscription_request.
export function normalizeWebhookRooms(rooms) {
  if (rooms === "*") return null;
  if (!Array.isArray(rooms) || rooms.length < 1 || rooms.length > MAX_WEBHOOK_ROOMS) {
    fail(422, "invalid_subscription_request",
      `rooms must be "*" or 1 to ${MAX_WEBHOOK_ROOMS} room ids`);
  }
  const ids = [];
  const seen = new Set();
  for (const id of rooms) {
    if (!validId(id)) fail(422, "invalid_subscription_request", "rooms must name room ids");
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  if (ids.length < 1) {
    fail(422, "invalid_subscription_request",
      `rooms must be "*" or 1 to ${MAX_WEBHOOK_ROOMS} room ids`);
  }
  return ids;
}

export function assertWebhookRoomsSeated(store, identityId, roomIds) {
  for (const roomId of roomIds) {
    if (!identitySeatedInRoom(store, identityId, roomId)) {
      fail(422, "room_not_member", "This identity is not an active member of that room");
    }
  }
}

function scopedKeyRoom(store, secret) {
  if (typeof secret !== "string" || !secret.startsWith(API_KEY_PREFIX)) return null;
  const key = store.agentPlugin.verifyPresentedApiKey(secret);
  if (!key) return null;
  const roomScopes = key.scopes.filter(scope => scope.startsWith("mcp:room:"));
  if (roomScopes.length === 0) return null;
  return scopedKeyRoomBinding(store, { keyId: key.keyId, identityId: key.identityId, scopes: key.scopes }).roomId;
}

function queryRoom(searchParams) {
  if (!searchParams || typeof searchParams.get !== "function") return null;
  const room = searchParams.get("room") || searchParams.get("roomId");
  return typeof room === "string" && room.length > 0 ? room : null;
}

// MCP subscribe with rooms omitted. A resolved room is stored. No seat at
// all stays NULL so an unseated identity can still subscribe.
export function resolveMcpWebhookScope({ store, secret, identityId, searchParams, rooms }) {
  if (rooms !== undefined) {
    const roomIds = normalizeWebhookRooms(rooms);
    if (roomIds) assertWebhookRoomsSeated(store, identityId, roomIds);
    return { roomIds, roomsSpecified: true };
  }
  const scoped = scopedKeyRoom(store, secret);
  if (scoped) {
    assertWebhookRoomsSeated(store, identityId, [scoped]);
    return { roomIds: [scoped], roomsSpecified: true };
  }
  const queried = queryRoom(searchParams);
  if (queried && validId(queried) && identitySeatedInRoom(store, identityId, queried)) {
    return { roomIds: [queried], roomsSpecified: true };
  }
  const seats = store.identities.roomsForIdentity(identityId);
  if (seats.length === 0) return { roomIds: null, roomsSpecified: false };
  return { roomIds: [seats[0].roomId], roomsSpecified: true };
}

// HTTP subscribe. roomsSpecified false leaves an existing row's scope alone
// and stores NULL on a new row. The warning is returned only while omit is
// still accepted.
export function resolveHttpWebhookScope({ store, identityId, hasRooms, rooms, now }) {
  if (!hasRooms) {
    if (!(Number.isFinite(now) && now < WEBHOOK_ROOMS_REQUIRED_AT)) {
      fail(422, "rooms_required",
        'rooms is required. Pass room ids, or "*" for every room this identity is seated in.');
    }
    return { roomIds: null, roomsSpecified: false, warning: WEBHOOK_ROOMS_ALL_WARNING };
  }
  const roomIds = normalizeWebhookRooms(rooms);
  if (roomIds) assertWebhookRoomsSeated(store, identityId, roomIds);
  return { roomIds, roomsSpecified: true, warning: null };
}
