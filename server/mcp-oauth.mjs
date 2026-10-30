// OAuth resource and principal validation. This module does not mint agent
// identities or grant room membership. Wire it only after an explicit human
// consent flow selects an agent already sponsored by that human.
import { OAUTH_SCOPES } from './oauth-provider.mjs';

export function mcpOAuthResourceMetadata(resource, issuer) {
  for (const value of [resource, issuer]) {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search || url.href !== value)
      throw new TypeError('Exact HTTPS resource and issuer required');
  }
  return Object.freeze({ resource, authorization_servers: [issuer],
    bearer_methods_supported: ['header'], scopes_supported: [...OAUTH_SCOPES] });
}

export function mcpOAuthChallenge(metadataUrl) {
  const url = new URL(metadataUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search
    || url.href !== metadataUrl || /["\r\n]/.test(metadataUrl)) throw new TypeError('Exact HTTPS metadata URL required');
  return { 'WWW-Authenticate': `Bearer resource_metadata="${metadataUrl}"` };
}

// No fallback to room owner, invite issuer, display name, or human credentials.
// This check must run on issuance AND each request: ownership and membership
// may have changed since consent. The account check is intentionally repeated
// here so a provider built without isAccountActive cannot bypass it.
export function validateMcpOAuthBinding(store, userId, binding) {
  if (!binding || !userId) return null;
  const fields = ['resource', 'roomId', 'identityId', 'memberId', 'humanMemberId'];
  if (fields.some(key => typeof binding[key] !== 'string' || !binding[key])) return null;
  const { roomId, identityId, memberId, humanMemberId } = binding;
  const account = store.db.prepare('SELECT active FROM accounts WHERE id=?').get(userId);
  if (account?.active !== 1) return null;
  const humanLink = store.db.prepare('SELECT account_id FROM member_accounts WHERE room_id=? AND member_id=?').get(roomId, humanMemberId);
  if (humanLink?.account_id !== userId) return null;
  const identityLink = store.db.prepare('SELECT member_id FROM identity_links WHERE room_id=? AND identity_id=?').get(roomId, identityId);
  if (identityLink?.member_id !== memberId) return null;
  let state;
  try { state = store.room(roomId).state; } catch { return null; }
  const human = state.members?.[humanMemberId];
  const agent = state.members?.[memberId];
  if (human?.kind !== 'human' || human.active !== true || agent?.kind !== 'agent' || agent.active !== true
    || agent.accountableHumanId !== humanMemberId || agent.identityId !== identityId) return null;
  return Object.freeze({ userId, roomId, identityId, memberId, humanMemberId });
}

// Returns a principal, NEVER a reusable pri_/rak_ secret or expanded grant.
// Callers still run ordinary Room command authorization as this agent member.
export function resolveMcpOAuthPrincipal({ store, provider, token, resource, roomId, requiredScopes = [] }) {
  if (typeof token !== 'string' || !token.startsWith('oat_') || !Array.isArray(requiredScopes)
    || requiredScopes.some(scope => !OAUTH_SCOPES.includes(scope))) return null;
  const grant = provider.verifyAccessToken(token, { resource });
  if (!grant?.binding || grant.binding.resource !== resource || grant.binding.roomId !== roomId
    || requiredScopes.some(scope => !grant.scopes.includes(scope))) return null;
  const principal = validateMcpOAuthBinding(store, grant.userId, grant.binding);
  return principal ? Object.freeze({ ...principal, clientId: grant.clientId,
    scopes: Object.freeze([...grant.scopes]) }) : null;
}
