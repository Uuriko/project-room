// OAuth resource and principal validation. This module does not mint agent
// identities or grant room membership. Wire it only after an explicit human
// consent flow selects an agent already sponsored by that human.
import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { OAUTH_SCOPES } from './oauth-provider.mjs';
import { ownMember } from '../src/events.js';
import { PILOT_LIMITS } from './store.mjs';
import { hasMessageAuthority } from './message-authority.mjs';
import { assertProjectionWrite } from './write-integrity.mjs';

export { mcpOAuthResourceMetadata } from "./oauth-metadata.mjs";

export function mcpOAuthChallenge(metadataUrl) {
  const url = new URL(metadataUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search
    || url.href !== metadataUrl || /["\r\n]/.test(metadataUrl)) throw new TypeError('Exact HTTPS metadata URL required');
  return { 'WWW-Authenticate': `Bearer resource_metadata="${metadataUrl}"` };
}

// Binding authorization consumes only membership metadata, never history. This
// does not certify unrelated message rows or change their recovery/count proof.
function canonicalOAuthBindingMembers(store, roomId, memberId) {
  // Existing lightweight store adapters retain their original room reader.
  if (typeof store.roomAuthority !== 'function' || typeof store.readTransaction !== 'function') return null;
  return store.readTransaction(() => {
    const db = store.db;
    const current = db.prepare("SELECT json_extract(projection,'$.normalizedCurrent.version') version FROM rooms WHERE id=?").get(roomId);
    if(current?.version === 1) return store.roomAuthority(roomId,{memberId}).members;
    const sizes = db.prepare(`SELECT length(CAST(r.projection AS BLOB)) AS projection_bytes,
      length(CAST(i.metadata_hash AS BLOB)) AS metadata_hash_bytes,
      COALESCE(length(CAST(i.projection_hash AS BLOB)),0) AS projection_hash_bytes,
      COALESCE(length(CAST(i.sequence AS BLOB)),0) AS sequence_bytes
      FROM rooms r LEFT JOIN integrity_room_state i ON i.room_id=r.id
      WHERE r.id=? AND json_type(r.projection,'$.messageAuthority') IS NOT NULL`).get(roomId);
    if (!sizes || sizes.metadata_hash_bytes === null) return null;
    if (sizes.metadata_hash_bytes !== 64 || Object.values(sizes).some(size => !Number.isSafeInteger(size) || size < 0))
      throw Error('projection_corrupt: invalid OAuth membership metadata proof');
    // Exceeding admission does not erase a present proof or excuse corruption.
    assertProjectionWrite(db, roomId);
    if (Object.values(sizes).reduce((sum, size) => sum + size, 0) > PILOT_LIMITS.projectionBytes) return null;
    const raw = JSON.parse(db.prepare('SELECT projection FROM rooms WHERE id=?').get(roomId).projection);
    if (!hasMessageAuthority(raw)) return null;
    if (Object.hasOwn(raw, 'messages')) throw Error('projection_corrupt: competing canonical message array');
    if (raw.messagesArchive || raw.room?.archivedAt) return null;
    return raw.members;
  });
}

// No fallback to room owner, invite issuer, display name, or human credentials.
// This check must run on issuance AND each request: ownership and membership
// may have changed since consent. The account check is intentionally repeated
// here so a provider built without isAccountActive cannot bypass it.
export function validateMcpOAuthBinding(store, userId, binding) {
  if (!binding || !userId) return null;
  const direct = binding.principalType === 'account-owned-agent';
  const fields = ['resource', 'roomId', 'identityId', 'memberId', 'humanMemberId', 'identityEpoch', ...(direct ? ['principalType','accountEpoch'] : [])];
  if (Object.keys(binding).length !== fields.length || fields.some(key => typeof binding[key] !== 'string' || !binding[key] || binding[key].length > 512)) return null;
  const { roomId, identityId, memberId, humanMemberId } = binding;
  const currentEpoch = mcpOAuthIdentityEpoch(store, identityId);
  if (!currentEpoch || binding.identityEpoch !== currentEpoch) return null;
  const account = store.db.prepare(direct ? 'SELECT active,auth_epoch FROM accounts WHERE id=?' : 'SELECT active FROM accounts WHERE id=?').get(userId);
  if (account?.active !== 1 || direct && binding.accountEpoch !== String(account.auth_epoch)) return null;
  const humanLink = store.db.prepare('SELECT account_id FROM member_accounts WHERE room_id=? AND member_id=?').get(roomId, humanMemberId);
  if (humanLink?.account_id !== userId) return null;
  const identityLink = store.db.prepare('SELECT member_id FROM identity_links WHERE room_id=? AND identity_id=?').get(roomId, identityId);
  if (identityLink?.member_id !== memberId) return null;
  let state;
  try {
    const members = canonicalOAuthBindingMembers(store, roomId, memberId);
    state = members === null ? store.room(roomId).state : { members, room: store.roomAuthority(roomId,{memberId}) };
  } catch { return null; }
  const human = ownMember(state.members,humanMemberId);
  const agent = ownMember(state.members,memberId);
  if (direct) {
    // Explicit account consent sponsors this existing seat, not its old API key.
    // Legacy rooms may bind the owner's account to an agent-shaped member.
    // The verified account link, current room ownership and accountable link
    // are all mandatory; neither a display name nor an owner bearer suffices.
    const ownerId = state.room?.ownerId;
    if (ownerId !== humanMemberId || human?.active !== true || memberId === humanMemberId
      || agent?.kind !== 'agent' || agent.active !== true
      || agent.accountableHumanId !== humanMemberId || agent.identityId !== identityId) return null;
    return Object.freeze({userId,roomId,identityId,memberId,humanMemberId,principalType:'account-owned-agent'});
  }
  if (human?.kind !== 'human' || human.active !== true || agent?.kind !== 'agent' || agent.active !== true
    || agent.accountableHumanId !== humanMemberId || agent.identityId !== identityId) return null;
  const connection = store.agentConnections?.row?.(roomId, memberId);
  if (!connection || connection.sponsor_account_id !== userId || connection.sponsor_member_id !== humanMemberId) return null;
  if (connection.status !== 'issued' || connection.expires_at <= store.now()
    || !store.agentConnections.authority(connection)
    || store.db.prepare('SELECT revoked FROM credentials WHERE hash=?').get(connection.credential_hash)?.revoked !== 0) return null;
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
  if (typeof token !== 'string' || !(/^(oat|iat)_/.test(token)) || !Array.isArray(requiredScopes)
    || requiredScopes.some(scope => !OAUTH_SCOPES.includes(scope))) return null;
  const grant = provider.verifyAccessToken(token, { resource });
  if (!grant?.binding || grant.binding.resource !== resource || grant.binding.roomId !== roomId
    || requiredScopes.some(scope => !grant.scopes.includes(scope))) return null;
  const principal = grant.binding.principalType === "invited-agent"
    ? validateMcpInviteOAuthBinding(store, grant.userId, grant.binding)
    : validateMcpOAuthBinding(store, grant.userId, grant.binding);
  return principal ? Object.freeze({ ...principal, principalType: principal.principalType ?? "account-agent",
    familyId: grant.familyId, resource, clientId: grant.clientId,
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

// Invitation consent is separate from chat/work. Existing grants gain no
// invitation tools; current Room authority is still checked by the service.
const scopeTools = {
  'members:invite': ['room_create_agent_invite'],
  'rooms:read': ['room_check_access'],
  'chat:read': ['room_read_messages', 'room_read_inbox', 'room_list_requests', 'room_read_request'],
  'chat:write': ['room_post_message', 'room_reply', 'room_request_reply', 'room_respond_to_request'],
  'work:read': ['room_list_work', 'room_read_board', 'room_read_work', 'room_read_work_discussion', 'room_read_result'],
  'work:write': ['room_claim', 'room_acquire_claim', 'room_release_claim', 'room_renew_claim', 'room_accept_work', 'room_start_work', 'room_block_work', 'room_resolve_blocker', 'room_handoff', 'room_submit_text_result'],
};
// Mixed projections must satisfy every data category, in discovery and dispatch.
// Keep this separate from membership checks: OAuth consent cannot widen them.
const compositeReadScopes = {
  room_read_inbox: ['chat:read', 'work:read'],
  room_list_work: ['chat:read', 'work:read'], // needs_me includes reply requests
  room_read_request: ['rooms:read', 'chat:read', 'work:read'], // preparation includes work and charter
  room_read_work: ['rooms:read', 'chat:read', 'work:read'], // source/discussion and room preparation
  room_read_work_discussion: ['chat:read', 'work:read'],
  room_activation_pack: ['rooms:read', 'chat:read', 'work:read'],
};
export function mcpOAuthToolAllowed(name, scopes) {
  if (Object.hasOwn(compositeReadScopes, name)) return compositeReadScopes[name].every(scope => scopes.includes(scope));
  return Object.entries(scopeTools).some(([scope, names]) => scopes.includes(scope) && names.includes(name));
}

export function listMcpOAuthAgents(store, userId, resource, {preferredRoomId,preferredMemberId}={}) {
  const humans = store.db.prepare('SELECT room_id,member_id FROM member_accounts WHERE account_id=?').all(userId);
  const result = [];
  for (const human of humans) {
    let state;
    try {
      if(preferredRoomId === human.room_id && preferredMemberId) {
        const authority=store.roomAuthority(human.room_id,{memberId:preferredMemberId});
        state={room:{id:human.room_id,ownerId:authority.ownerId},members:authority.members};
      } else state = store.room(human.room_id).state;
    } catch { continue; }
    for (const member of Object.values(state.members ?? {})) {
      if (member.kind !== 'agent' || member.accountableHumanId !== human.member_id || !member.identityId) continue;
      const binding = { resource, roomId: human.room_id, identityId: member.identityId, memberId: member.id, humanMemberId: human.member_id, identityEpoch: mcpOAuthIdentityEpoch(store, member.identityId) };
      const directBinding = {...binding, principalType:'account-owned-agent',accountEpoch:String(store.db.prepare('SELECT auth_epoch FROM accounts WHERE id=?').get(userId)?.auth_epoch)};
      // Accountability alone does not prove that the account controls an invited
      // agent. A durable owner grant starts from the explicitly configured seat
      // or the existing managed connection proof; never from every sponsored seat.
      const configured = preferredRoomId === human.room_id && preferredMemberId === member.id;
      const managed = validateMcpOAuthBinding(store,userId,binding);
      const selected = (configured || managed) && validateMcpOAuthBinding(store,userId,directBinding) ? directBinding
        : managed ? binding : null;
      if (selected) result.push({binding:selected, label:`${member.displayName || member.id} — ${state.room?.title || human.room_id}`});
    }
  }
  return result;
}

// An opaque verifier fingerprint fences grants after identity rotation without
// putting the secret verifier itself in browser consent or OAuth records.
export function mcpOAuthIdentityEpoch(store, identityId) {
  const row = store.db.prepare('SELECT secret_hash,revoked_at FROM agent_identities WHERE identity_id=?').get(identityId);
  if (!row || row.revoked_at !== null) return null;
  return createHash('sha256').update(`mcp-oauth-identity:${row.secret_hash}`).digest('hex');
}

export function validateMcpInviteOAuthBinding(store, grantId, binding) {
  const fields = ['principalType', 'invitationGrantId', 'resource', 'roomId', 'identityId', 'memberId', 'identityEpoch'];
  if (!binding || Object.keys(binding).length !== fields.length || binding.principalType !== 'invited-agent'
    || fields.some(key => typeof binding[key] !== 'string' || !binding[key]) || binding.invitationGrantId !== grantId) return null;
  const grant = store.db.prepare('SELECT * FROM oauth_invite_grants WHERE id=?').get(grantId);
  if (!grant || grant.revoked_at !== null || grant.expires_at <= store.now()
    || grant.room_id !== binding.roomId || grant.identity_id !== binding.identityId || grant.member_id !== binding.memberId
    || grant.identity_epoch !== binding.identityEpoch || mcpOAuthIdentityEpoch(store, binding.identityId) !== binding.identityEpoch) return null;
  const invite = store.db.prepare('SELECT redeemed_identity_id,revoked_at FROM agent_invite_codes WHERE code_hash=?').get(grant.invite_hash);
  if (!invite || invite.revoked_at !== null || invite.redeemed_identity_id !== binding.identityId) return null;
  let member;
  try { member = store.identities.resolveIdentityLink(binding.identityId, binding.roomId)?.member; } catch { return null; }
  if (!member || member.id !== binding.memberId || member.kind !== 'agent' || member.active !== true) return null;
  return Object.freeze({ principalType: 'invited-agent', invitationGrantId: grantId, roomId: binding.roomId,
    identityId: binding.identityId, memberId: binding.memberId, sponsorMemberId: grant.sponsor_member_id,
    controllerVerification: 'invitation-capability' });
}

export function mcpOAuthPrincipalDescriptor(principal) {
  return Object.freeze({ ...Object.fromEntries(['principalType', 'familyId', 'resource', 'roomId', 'identityId', 'memberId']
    .map(key => [key, principal[key]])), scopes: Object.freeze([...principal.scopes].sort()) });
}
export function authorizeMcpOAuthDescriptor({ store, accountProvider, inviteProvider, resource, descriptor, requiredScopes = ['chat:read'] }) {
  if (!descriptor || !['account-agent', 'account-owned-agent', 'invited-agent'].includes(descriptor.principalType) || descriptor.resource !== resource) return null;
  const provider = descriptor.principalType === 'invited-agent' ? inviteProvider : accountProvider;
  const grant = provider?.verifyGrantFamily(descriptor.familyId, { resource });
  if (!grant?.binding || requiredScopes.some(scope => !grant.scopes.includes(scope))
    || !Array.isArray(descriptor.scopes) || JSON.stringify(descriptor.scopes) !== JSON.stringify([...grant.scopes].sort())) return null;
  const principal = descriptor.principalType === 'invited-agent'
    ? validateMcpInviteOAuthBinding(store, grant.userId, grant.binding)
    : validateMcpOAuthBinding(store, grant.userId, grant.binding);
  if (!principal || (principal.principalType ?? 'account-agent') !== descriptor.principalType || ['roomId', 'identityId', 'memberId'].some(key => principal[key] !== descriptor[key])) return null;
  return Object.freeze({ ...principal, ...descriptor, clientId: grant.clientId, scopes: grant.scopes });
}
