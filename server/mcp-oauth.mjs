// OAuth resource and principal validation. This module does not mint agent
// identities or grant room membership. Wire it only after an explicit human
// consent flow selects an agent already sponsored by that human.
import { AsyncLocalStorage } from 'node:async_hooks';
import { OAUTH_SCOPES } from './oauth-provider.mjs';

export function mcpOAuthResourceMetadata(resource, issuer) {
  for (const value of [resource, issuer]) {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search || (url.href !== value && url.origin !== value))
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
  if (Object.keys(binding).length !== fields.length || fields.some(key => typeof binding[key] !== 'string' || !binding[key] || binding[key].length > 512)) return null;
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
  const connection = store.agentConnections?.row?.(roomId, memberId);
  if (connection && (connection.status !== 'issued' || connection.expires_at <= store.now()
    || !store.agentConnections.authority(connection)
    || store.db.prepare('SELECT revoked FROM credentials WHERE hash=?').get(connection.credential_hash)?.revoked !== 0)) return null;
  if (store.agentConnections?.identityAuthority && !store.agentConnections.identityAuthority(roomId, memberId)) return null;
  if (store.identities?.resolveIdentityLink) {
    try {
      if (store.identities.resolveIdentityLink(identityId, roomId)?.member?.id !== memberId) return null;
    } catch { return null; }
  }
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

// A request-local gate keeps OAuth tokens confined to their MCP resource. REST
// handlers cannot use these tokens, and concurrent requests cannot borrow auth.
const oauthRequests = new AsyncLocalStorage();
export function runMcpOAuthRequest(options, callback) {
  return oauthRequests.run(options, callback);
}
export function authenticateMcpOAuthRequest(store, token, roomId) {
  const current = oauthRequests.getStore();
  if (!current || current.store !== store || current.token !== token || current.roomId !== roomId) return null;
  return resolveMcpOAuthPrincipal(current);
}

const scopeTools = {
  'rooms:read': ['room_check_access'],
  'chat:read': ['room_read_messages', 'room_read_inbox', 'room_list_requests', 'room_read_request'],
  'chat:write': ['room_post_message', 'room_reply', 'room_request_reply', 'room_respond_to_request'],
  'work:read': ['room_list_work', 'room_read_board', 'room_read_work', 'room_read_work_discussion', 'room_read_result'],
  'work:write': ['room_claim', 'room_accept_work', 'room_start_work', 'room_block_work', 'room_resolve_blocker', 'room_handoff', 'room_submit_text_result'],
};
export function mcpOAuthToolAllowed(name, scopes) {
  return Object.entries(scopeTools).some(([scope, names]) => scopes.includes(scope) && names.includes(name));
}

export function listMcpOAuthAgents(store, userId, resource) {
  const humans = store.db.prepare('SELECT room_id,member_id FROM member_accounts WHERE account_id=?').all(userId);
  const result = [];
  for (const human of humans) {
    let state;
    try { state = store.room(human.room_id).state; } catch { continue; }
    for (const member of Object.values(state.members ?? {})) {
      if (member.kind !== 'agent' || member.accountableHumanId !== human.member_id || !member.identityId) continue;
      const binding = { resource, roomId: human.room_id, identityId: member.identityId, memberId: member.id, humanMemberId: human.member_id };
      if (validateMcpOAuthBinding(store, userId, binding)) result.push({ binding,
        label: `${member.displayName || member.id} — ${state.room?.title || human.room_id}` });
    }
  }
  return result;
}
