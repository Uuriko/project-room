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
  if (!identityId || auth.member.identityId !== identityId) {
    refuse("room_key_heartbeat_refused", "This room member is not a linked identity");
  }
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
  if (existing?.mode === "wakeable" || push?.url) {
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
  const hosts = store.agentHeartbeats.statusOf(auth.identityId).hosts
    .filter(host => host.hostId.startsWith(auth.hostPrefix) && host.mode === "pull-only")
    .map(host => ({ ...host, wakeUrl: null }));
  return { agentId: auth.identityId, hosts, lastSeenAt: hosts[0]?.lastSeenAt ?? null,
    status: !hosts.length ? "unregistered" : hosts.some(host => host.state === "online") ? "online" : "offline" };
}
