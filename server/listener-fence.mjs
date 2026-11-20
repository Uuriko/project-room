// Optional runtime fence. Call inside the mutation transaction after fresh
// authentication; this narrows a credential's authority and never grants it.
import { ServiceError } from './service-error.mjs';
export const LISTENER_TOKEN_HEADER = 'x-room-listener-token';
export function assertListenerFence(store, auth, roomId, token) {
  if (token === undefined) return;
  if (typeof token !== 'string' || !token.trim() || token.length > 256)
    throw new ServiceError(422, 'invalid_listener_token', 'A non-empty listener token is required');
  const identityId = auth.identityId ?? auth.member?.identityId;
  const link = identityId && store.db.prepare('SELECT member_id AS memberId FROM identity_links WHERE room_id=? AND identity_id=?').get(roomId, identityId);
  const member = link && store.roomAuthority(roomId, { memberId: link.memberId }).members?.[link.memberId];
  if (!member || member.active === false || member.kind !== 'agent' || auth.member && auth.member.id !== link.memberId)
    throw new ServiceError(403, 'listener_identity_mismatch', 'The listener identity must be an active agent in this room');
  store.agentHeartbeats.ensureListenerSchema();
  const lease = store.db.prepare('SELECT fencing_token AS token, lease_expires_at AS expires FROM agent_wake_listener_leases WHERE agent_id=? AND room_key=?').get(identityId, roomId);
  if (!lease || lease.token !== token || lease.expires <= store.agentHeartbeats.now())
    throw new ServiceError(409, 'stale_listener', 'The runtime no longer holds this room listener lease');
}

// True while this credential's identity holds an unexpired room listener lease.
export function liveListenerLease(store, auth, roomId) {
  const identityId = auth.identityId ?? auth.member?.identityId;
  if (!identityId) return false;
  store.agentHeartbeats.ensureListenerSchema();
  const lease = store.db.prepare('SELECT lease_expires_at AS expires FROM agent_wake_listener_leases WHERE agent_id=? AND room_key=?').get(identityId, roomId);
  return Boolean(lease && lease.expires > store.agentHeartbeats.now());
}
