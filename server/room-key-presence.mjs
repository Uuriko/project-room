import { createHash } from "node:crypto";
import { ServiceError } from "./service-error.mjs";
import { isRoomAccessToken } from "./guest-agent-links.mjs";

const refuse = (code, message) => { throw new ServiceError(403, code, message); };

// A saved room access key is the seat a host already uses to read and post.
// It may report pull-only presence for that seat's linked identity so a
// mention can queue a wake on the existing heartbeat path. It cannot install
// a wake URL, a push subscription, or replace a host the identity secret
// registered as wakeable. A multi-room identity still uses its identity secret,
// so one room key cannot mark that identity online in every room.
export function roomKeyPresenceAuth(store, secret) {
  if (!isRoomAccessToken(secret)) throw new ServiceError(401, "unauthenticated", "Agent credential required");
  const auth = store.authenticate(secret);
  if (auth.credentialScope !== "room" || auth.kind !== "access" || auth.member?.kind !== "agent") {
    refuse("room_key_heartbeat_refused", "A room access key can register pull-only presence only for its own agent member");
  }
  const identityId = store.identities.identityIdForMember(auth.roomId, auth.member.id);
  if (!identityId || auth.member.identityId !== identityId) refuse("room_key_heartbeat_refused", "This room member is not a linked identity");
  const rooms = store.identities.roomsForIdentity(identityId);
  if (rooms.length !== 1 || rooms[0].roomId !== auth.roomId || rooms[0].memberId !== auth.member.id) {
    refuse("room_key_heartbeat_refused", "A room access key can register presence only for an identity linked to this room alone");
  }
  return { identityId, roomId: auth.roomId,
    hostPrefix: `rk_${createHash("sha256").update(secret).digest("hex")}_` };
}

export function assertRoomKeyPullOnly(store, identityId, data) {
  if (!data || data.mode !== "pull-only" || data.wakeUrl != null || data.pushNotification != null) {
    refuse("room_key_wake_refused", "A room access key can report pull-only presence. Wake URLs and push use the identity secret");
  }
  const existing = store.agentHeartbeats.statusOf(identityId).hosts.find(host => host.hostId === data.hostId);
  const push = store.db.prepare("SELECT push_url AS url FROM agent_push_configs WHERE agent_id=? AND host_id=?")
    .get(identityId, data.hostId);
  if ((existing && existing.mode === "wakeable") || push?.url) {
    refuse("room_key_wake_refused", "A room access key cannot replace a wakeable host");
  }
}

// Credential-derived host ids cannot collide with an existing identity-owned
// host by choosing its public name. No credential itself is stored or returned.
export function roomKeyHostId(auth, hostId) {
  if (typeof hostId !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(hostId)) {
    throw new ServiceError(422, "invalid_heartbeat", "hostId must match [A-Za-z0-9._-]{1,128}");
  }
  return auth.hostPrefix + createHash("sha256").update(hostId).digest("hex").slice(0, 48);
}

export function roomKeyPresenceView(store, auth) {
  const status = store.agentHeartbeats.statusOf(auth.identityId);
  const hosts = status.hosts.filter(host => host.hostId.startsWith(auth.hostPrefix) && host.mode === "pull-only")
    .map(host => ({ ...host, wakeUrl: null }));
  return { agentId: auth.identityId, hosts, lastSeenAt: hosts[0]?.lastSeenAt ?? null,
    status: hosts.some(host => host.state === "online") ? "online" : hosts.length ? "offline" : "unregistered" };
}

// ---- Scoped API keys (CX5-FIX) ----
//
// The credential standard setup saves is a rak_ API key whose scopes bind
// it to one room (exactly one mcp:room:<roomId> scope). Such a key is a
// genuinely scoped listener credential: it may run the room-hosted wake
// listener for its bound room and nothing else. The binding is derived
// from the key's stored scopes on EVERY authorization (heartbeat, poll,
// ack, presence) and the identity's membership in the bound room is
// re-verified each time, so revocation, expiry, rotation or unlinking the
// identity from the room ends the listener at the next call — and a held
// poll re-resolves authorization after its wait, so an unlink mid-wait
// kills it too. A key with heartbeat scopes but NO mcp:room: scope is an
// owner-issued identity-level key (the documented API-key surface) and is
// deliberately not rewritten by this binding; a key with several
// mcp:room: scopes names no single room and is refused scoped use rather
// than guessed at.
const SCOPED_KEY_REFUSAL = "scoped_key_room_refused";

export function scopedKeyRoomBinding(store, auth) {
  if (!auth || auth.keyId === null || auth.keyId === undefined) return null;
  const roomScopes = (auth.scopes ?? []).filter(scope => scope.startsWith("mcp:room:"));
  if (roomScopes.length === 0) return null;
  if (roomScopes.length > 1)
    refuse(SCOPED_KEY_REFUSAL, "This API key is scoped to several rooms; a scoped listener binds exactly one room");
  const roomId = roomScopes[0].slice("mcp:room:".length);
  if (!roomId) refuse(SCOPED_KEY_REFUSAL, "This API key's room scope names no room");
  const member = store.db.prepare(
    "SELECT 1 FROM identity_links WHERE room_id=? AND identity_id=? LIMIT 1").get(roomId, auth.identityId);
  if (!member)
    refuse(SCOPED_KEY_REFUSAL, "This API key's identity is not a member of its scoped room");
  return { roomId,
    hostPrefix: `ak_${createHash("sha256").update(auth.keyId).digest("hex").slice(0, 32)}_` };
}

// A scoped key's listener is the room-hosted poll: wakeable or pull-only
// mode, but no wake URL and no push subscription (those advertise
// reachability outside the room and stay on the identity secret), and it
// can never replace a host the identity secret registered as wakeable.
export function assertScopedKeyListener(store, identityId, data) {
  if (!data || data.wakeUrl != null || data.pushNotification != null) {
    refuse("scoped_key_wake_refused", "A room-scoped API key runs the room-hosted poll listener only. Wake URLs and push use the identity secret");
  }
  const existing = store.agentHeartbeats.statusOf(identityId).hosts.find(host => host.hostId === data.hostId);
  const push = store.db.prepare("SELECT push_url AS url FROM agent_push_configs WHERE agent_id=? AND host_id=?")
    .get(identityId, data.hostId);
  if ((existing && existing.mode === "wakeable") || push?.url) {
    refuse("scoped_key_wake_refused", "A room-scoped API key cannot replace a wakeable host");
  }
}

// Namespacing discipline follows roomKeyHostId: the stored id lives under
// the credential-derived prefix, so a scoped credential can neither
// collide with nor replace an identity-owned host. Unlike the legacy room
// key, the suffix keeps the caller's hostId readable when it fits the
// 128-char host-id bound (hashed only past it), and the scoped presence
// view strips the prefix — so the key's owner reads back the host ids it
// actually chose, and the standard wake client can confirm registration.
export function scopedKeyHostId(auth, hostId) {
  if (typeof hostId !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(hostId)) {
    throw new ServiceError(422, "invalid_heartbeat", "hostId must match [A-Za-z0-9._-]{1,128}");
  }
  if ((auth.hostPrefix + hostId).length <= 128) return auth.hostPrefix + hostId;
  return auth.hostPrefix + createHash("sha256").update(hostId).digest("hex").slice(0, 128 - auth.hostPrefix.length);
}

export function scopedKeyPresenceView(store, auth) {
  const status = store.agentHeartbeats.statusOf(auth.identityId);
  const hosts = status.hosts.filter(host => host.hostId.startsWith(auth.hostPrefix))
    .map(host => ({ ...host, hostId: host.hostId.slice(auth.hostPrefix.length), wakeUrl: null }));
  return { agentId: auth.identityId, hosts, lastSeenAt: hosts[0]?.lastSeenAt ?? null,
    status: hosts.some(host => host.state === "online") ? "online" : hosts.length ? "offline" : "unregistered" };
}
