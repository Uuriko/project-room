// A scoped credential identifies its holder, not a physical device or process.
// No caller-supplied runtime name can satisfy this binding.
import { ServiceError } from './service-error.mjs';
import { validId, ownMember } from '../src/events.js';
export function requestRuntimeAccess(store, roomId, request, auth) {
  const keyId = request?.targetRuntimeKeyId;
  if (keyId === undefined) return null;
  const key = validId(keyId) && store.db.prepare('SELECT identity_id, scopes_json, expires_at, revoked FROM agent_api_keys WHERE key_id=?').get(keyId);
  let eligible = false;
  if (key && !key.revoked && (key.expires_at === null || key.expires_at > store.now())) {
    const scopes = JSON.parse(key.scopes_json);
    const rooms = scopes.filter(scope => scope.startsWith('mcp:room:'));
    const identityId = store.identities.identityIdForMember(roomId, request.recipientId);
    const member = ownMember(store.roomAuthority(roomId, {memberId: request.recipientId}).members, request.recipientId);
    eligible = rooms.length === 1 && rooms[0] === `mcp:room:${roomId}`
      && scopes.includes('rooms:read') && scopes.includes('rooms:write')
      && identityId === key.identity_id && member?.kind === 'agent' && member.active !== false
      && Boolean(store.agentConnections.identityAuthority(roomId, request.recipientId));
  }
  return { targetRuntimeKeyId: keyId, eligible,
    authorized: eligible && auth?.kind === 'api-key' && auth.apiKeyId === keyId };
}
export function requireRequestRuntime(store, roomId, request, auth, { opening = false } = {}) {
  const access = requestRuntimeAccess(store, roomId, request, auth);
  if (access && !(opening ? access.eligible : access.authorized))
    throw new ServiceError(403, 'request_runtime_denied', 'This request requires its active recipient-owned, room-scoped runtime credential. No request was changed.');
  return access;
}
