// Shared synchronous heartbeat/receiving-lease operation. Call inside the same
// transaction as fresh credential resolution. A lease never grants execution.
import { ownMember } from "../src/events.js";
import { HeartbeatError } from "./agent-heartbeats.mjs";
import { assertRoomKeyPullOnly, roomKeyHostId, assertScopedKeyListener, scopedKeyHostId } from "./room-key-presence.mjs";
const reject = (status, code, message) => { throw new HeartbeatError(status, code, message); };
export function validListenerLease(value) {
  return value === undefined || value === true || Boolean(value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === 1 && typeof value.roomId === "string" && value.roomId.length > 0);
}
// WAKE-S34: the room scope a wake-claim call may act on, resolved with
// exactly the rules lease acquisition uses in heartbeatWithListener
// below: a room-scoped credential (room key or room-bound rak_) claims
// only its bound room; an identity credential naming a room must be a
// live agent member of it (identity link + live member recheck); no
// roomId names the identity queue (the roomless lease scope). Shared by
// POST /api/agent-heartbeats/claim and MCP heartbeat_claim so the claim
// door can never widen past the lease door.
export function claimRoomScope(store, auth, requestedRoomId) {
  if (requestedRoomId !== null && requestedRoomId !== undefined
      && (typeof requestedRoomId !== "string" || requestedRoomId.length === 0))
    reject(422, "invalid_wake_claim", "roomId must be a non-empty string when present");
  if (auth.roomId) {
    if (requestedRoomId !== null && requestedRoomId !== undefined && requestedRoomId !== auth.roomId)
      reject(403, "room_mismatch", "A room-scoped credential claims only its bound room");
    return auth.roomId;
  }
  if (requestedRoomId !== null && requestedRoomId !== undefined) {
    const link = store.db.prepare(
      "SELECT member_id AS memberId FROM identity_links WHERE room_id=? AND identity_id=? LIMIT 1").get(requestedRoomId, auth.identityId);
    const member = link ? ownMember(store.room(requestedRoomId).state.members, link.memberId) : null;
    if (!member || member.active === false || member.kind !== "agent" || member.identityId !== auth.identityId)
      reject(403, "room_mismatch", "The identity is not a member of the requested claim room");
    return requestedRoomId;
  }
  return null;
}
export function heartbeatWithListener(store, auth, data, { roomKey = false, door = "heartbeat" } = {}) {
  let hostId = data.hostId;
  if (roomKey) {
    assertRoomKeyPullOnly(store, auth.identityId, data);
    hostId = roomKeyHostId(auth, data.hostId);
    assertRoomKeyPullOnly(store, auth.identityId, { ...data, hostId });
  } else if (auth.scopedKey) {
    // The replacement guard keys off the CALLER-FACING hostId (an
    // identity-owned wakeable host of that name must not be replaced).
    // It must not be re-run against the resolved namespaced id: that
    // row is this key's own registration, wakeable by design, and
    // re-registering it is the normal heartbeat path.
    assertScopedKeyListener(store, auth.identityId, data);
    hostId = scopedKeyHostId(auth, data.hostId);
  }
  const scopedNow = roomKey || auth.scopedKey === true;
  const result = store.agentHeartbeats.heartbeat({
    agentId: auth.identityId, hostId, mode: data.mode,
    wakeUrl: data.wakeUrl ?? null,
    // Cadence is sticky in the store: data.cadenceSeconds passes through
    // untouched — undefined (omitted) preserves the stored declaration,
    // an explicit null clears it. Collapsing it with ?? null here would
    // re-create the reset-by-omit hazard the store no longer has.
    cadenceSeconds: data.cadenceSeconds,
    pushNotification: data.pushNotification ?? null, workWakes: data.workWakes,
    workScopeRoomId: scopedNow ? auth.roomId : null, activityRoomId: scopedNow ? auth.roomId : null,
    // #3345: delivery accounting attributes the page to its door (the
    // REST heartbeat route and the MCP heartbeat_set tool share this path).
    door });
  // CX5-FIX: lease acquisition rides the same transaction as the
  // heartbeat, keyed by the queue the listener drains — the store's
  // leases are per-room scopes ('' for the roomless identity queue),
  // and ackWakes fences per signal room against exactly that scope.
  // Presence reporting never fails because another host holds the
  // lease — the response says so (acquired:false + the active
  // listener's id).
  let listener = null;
  if (data.listenerLease !== undefined) {
    const requestedRoom = data.listenerLease === true ? null : data.listenerLease.roomId;
    let leaseRoomId;
    if (auth.roomId) {
      if (requestedRoom !== null && requestedRoom !== auth.roomId)
        reject(403, "room_mismatch", "A room-scoped credential leases only its bound room");
      leaseRoomId = auth.roomId;
    } else if (requestedRoom !== null) {
      const link = store.db.prepare(
        "SELECT member_id AS memberId FROM identity_links WHERE room_id=? AND identity_id=? LIMIT 1").get(requestedRoom, auth.identityId);
      // Links survive access suspension (see scopedKeyRoomBinding):
      // recheck the live room member, not just the identity mapping,
      // before an identity-level credential may hold the room's lease.
      const member = link ? ownMember(store.room(requestedRoom).state.members, link.memberId) : null;
      if (!member || member.active === false || member.kind !== "agent" || member.identityId !== auth.identityId)
        reject(403, "room_mismatch", "The identity is not a member of the requested listener room");
      leaseRoomId = requestedRoom;
    } else leaseRoomId = null;
    const lease = store.agentHeartbeats.acquireListenerLease({
      agentId: auth.identityId, roomId: leaseRoomId, listenerId: hostId });
    // A scoped caller reads listener ids in its own host namespace
    // (its registrations are prefix-namespaced server-side).
    const presentListenerId = id => (auth.hostPrefix && typeof id === "string" && id.startsWith(auth.hostPrefix))
      ? id.slice(auth.hostPrefix.length) : id;
    listener = lease.acquired
      ? { acquired: true, fencingToken: lease.fencingToken, leaseExpiresAt: lease.leaseExpiresAt, renewed: lease.renewed === true }
      : { acquired: false, activeListenerId: presentListenerId(lease.activeListenerId), leaseExpiresAt: lease.leaseExpiresAt };
  }
  return { ...result, listener };
}
