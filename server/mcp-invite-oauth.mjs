// Accountless native connection: invitation-capability principals live in
// separate OAuth tables. The provider's legacy userId slot is a grant id here,
// never a Room account or a synthetic human. Secrets remain hash-only.
import { createHash, randomBytes } from 'node:crypto';
import { createOAuthProvider } from './oauth-provider.mjs';
import { mcpOAuthIdentityEpoch, validateMcpInviteOAuthBinding } from './mcp-oauth.mjs';
export const MCP_INVITE_RECOVERY = 'If this connection expired, was revoked, or its invitation was already confirmed, ask the Room sponsor for a fresh agent invitation and reconnect the plugin. A fresh invitation creates a new agent seat; it does not restore the previous seat or extend its 30-day grant.';
const hash = value => createHash('sha256').update(value).digest('hex');
const escape = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const rewrite = sql => sql.replaceAll('oauth_provider_', 'oauth_invite_');
export function inviteOAuthDatabase(db) {
  return { prepare: sql => db.prepare(rewrite(sql)), exec: sql => db.exec(rewrite(sql)) };
}
export function ensureMcpInviteOAuthSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS oauth_invite_grants (
    id TEXT PRIMARY KEY, room_id TEXT NOT NULL, identity_id TEXT NOT NULL,
    member_id TEXT NOT NULL, identity_epoch TEXT NOT NULL, invite_hash TEXT NOT NULL, sponsor_member_id TEXT NOT NULL,
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS oauth_invite_pending (
    nonce_hash TEXT PRIMARY KEY, request_json TEXT NOT NULL,
    expires_at INTEGER NOT NULL, grant_id TEXT, approval_hash TEXT
  );`);
}
export function createMcpInviteOAuth({ store, clients, resource }) {
  const db = store.db;
  ensureMcpInviteOAuthSchema(db);
  const provider = createOAuthProvider({ db: inviteOAuthDatabase(db), tokenKind: 'invite', clock: () => store.now(),
    isBindingActive: (grantId, binding) => Boolean(validateMcpInviteOAuthBinding(store, grantId, binding)) });
  for (const client of clients) provider.registerClient(client);
  const requestFor = params => {
    const request = { clientId: params.get('client_id'), redirectUri: params.get('redirect_uri'),
      scopes: (params.get('scope') || '').split(' ').filter(Boolean), state: params.get('state') ?? undefined,
      codeChallenge: params.get('code_challenge') };
    provider.validateAuthorizationRequest(request);
    if (params.get('code_challenge_method') !== 'S256' || params.get('resource') !== resource)
      throw new Error('Use the advertised resource and PKCE S256');
    return request;
  };
  const begin = params => {
    const request = requestFor(params);
    const nonce = randomBytes(32).toString('base64url');
    db.prepare('DELETE FROM oauth_invite_pending WHERE nonce_hash IN (SELECT nonce_hash FROM oauth_invite_pending WHERE expires_at<=? LIMIT 100)').run(store.now());
    if (db.prepare('SELECT count(*) n FROM oauth_invite_pending').get().n >= 2000) throw new Error('Too many pending connections; try again later');
    db.prepare('INSERT INTO oauth_invite_pending(nonce_hash,request_json,expires_at) VALUES(?,?,?)')
      .run(hash(nonce), JSON.stringify(request), store.now() + 600000);
    return { nonce, request };
  };
  const read = nonce => {
    if (typeof nonce !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(nonce)) throw new Error('Connection confirmation expired. Restart plugin connection. ' + MCP_INVITE_RECOVERY);
    const pending = db.prepare('SELECT * FROM oauth_invite_pending WHERE nonce_hash=?').get(hash(nonce));
    if (!pending || pending.expires_at <= store.now()) throw new Error('Connection confirmation expired. Restart plugin connection. ' + MCP_INVITE_RECOVERY);
    return { pending, request: JSON.parse(pending.request_json) };
  };
  const codeFrom = text => {
    if (typeof text !== 'string' || text.length > 2048) throw new Error('Paste a Member agent invitation link or RM code');
    const found = text.trim().match(/(?:^|[\/#=?&])(?:RM-[0-9A-Z]{16})(?=$|[\s&#/?])/i);
    const code = found ? found[0].replace(/^[\/#=?&]/, '') : text.trim();
    if (!/^RM-[0-9A-Z]{16}$/i.test(code)) throw new Error('Paste a Member agent invitation link or RM code');
    return code;
  };
  const preview = (nonce, input) => {
    const { request } = read(nonce);
    const code = codeFrom(input);
    const invitation = store.invites.preview(code);
    if (invitation.ownerEquivalent) throw new Error('Use a Member invitation; native connection does not accept owner-level invitations');
    return { code, invitation, request };
  };
  const approve = (nonce, input, displayName) => store.transaction(() => {
    const { pending, request } = read(nonce);
    if (typeof displayName !== 'string' || !displayName.trim() || displayName.trim().length > 80) throw new Error('Choose an agent name');
    const approvalHash = hash(JSON.stringify([codeFrom(input).toUpperCase(), displayName.trim()]));
    let grant;
    if (pending.grant_id) {
      if (pending.approval_hash !== approvalHash) throw new Error('This connection was already confirmed with different settings');
      grant = db.prepare('SELECT * FROM oauth_invite_grants WHERE id=?').get(pending.grant_id);
    } else {
      const { code } = preview(nonce, input);
      const joined = store.invites.redeem(code, { displayName, requestId: `native-${hash(nonce)}` });
      const receipt = db.prepare('SELECT * FROM agent_invite_redeem_receipts WHERE request_id=?').get(`native-${hash(nonce)}`);
      const invite = db.prepare('SELECT created_by FROM agent_invite_codes WHERE code_hash=?').get(receipt.code_hash);
      const id = `oig_${randomBytes(24).toString('base64url')}`;
      db.prepare('INSERT INTO oauth_invite_grants(id,room_id,identity_id,member_id,identity_epoch,invite_hash,sponsor_member_id,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(id, joined.roomId, joined.identityId, joined.memberId, mcpOAuthIdentityEpoch(store, joined.identityId), receipt.code_hash, invite.created_by, store.now(), store.now() + 30 * 86400000);
      db.prepare('UPDATE oauth_invite_pending SET grant_id=?,approval_hash=? WHERE nonce_hash=?').run(id, approvalHash, hash(nonce));
      grant = db.prepare('SELECT * FROM oauth_invite_grants WHERE id=?').get(id);
    }
    const binding = { principalType: 'invited-agent', invitationGrantId: grant.id, resource,
      roomId: grant.room_id, identityId: grant.identity_id, memberId: grant.member_id,
      identityEpoch: grant.identity_epoch };
    const { code } = provider.issueCode({ ...request, userId: grant.id, binding, codeIdempotencyKey: nonce });
    const redirect = new URL(request.redirectUri);
    redirect.searchParams.set('code', code);
    if (request.state) redirect.searchParams.set('state', request.state);
    return redirect.href;
  });
  const cancel = nonce => store.transaction(() => {
    const { pending, request } = read(nonce);
    if (pending.grant_id) throw new Error('This connection was already confirmed. Manage the connection in your host, or ask the sponsor to revoke its Room access. ' + MCP_INVITE_RECOVERY);
    db.prepare('DELETE FROM oauth_invite_pending WHERE nonce_hash=?').run(hash(nonce));
    const redirect = new URL(request.redirectUri);
    redirect.searchParams.set('error', 'access_denied');
    redirect.searchParams.set('error_description', 'Connection cancelled; your invitation was not used.');
    if (request.state) redirect.searchParams.set('state', request.state);
    return redirect.href;
  });
  return { provider, begin, read, preview, approve, cancel };
}
export function inviteOAuthPage({ nonce, request, invitation = null, code = '', accountUrl }) {
  const hidden = `<input type="hidden" name="nonce" value="${escape(nonce)}">`;
  const consent = invitation
    ? `<p>Room: <strong>${escape(invitation.roomTitle)}</strong></p><p>Invitation sponsor: ${escape(invitation.inviterDisplayName || 'Room member')}</p><p>Room access: ${escape(invitation.profile)}. Requested scopes: ${escape(request.scopes.join(', '))}.</p><p>The sponsor grants access inside this Room. Your ChatGPT tool permissions stay under your control. No Room human account is created or claimed. This Room connection lasts up to 30 days and can be revoked.</p><input type="hidden" name="invitation" value="${escape(code)}"><label>Agent name <input name="display_name" maxlength="80" value="My agent" required></label><button name="decision" value="allow">Connect this agent</button>`
    : '<label>Agent invitation link or RM code <input name="invitation" maxlength="2048" autocomplete="off" required></label><button name="decision" value="preview">Review invitation</button>';
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect your agent</title><body><main><h1>Connect your existing agent</h1><p>No Project Room signup is required. Continue only if you just started connecting this plugin in your agent.</p><form method="post" action="/oauth/invite">${hidden}${consent}<button name="decision" value="deny" formnovalidate>Cancel connection</button></form><p>You can cancel before confirming and reuse the invitation. After confirmation, reconnecting from the beginning needs a fresh invitation and creates a new agent seat.</p>${accountUrl ? `<p><a href="${escape(accountUrl)}">Optional: connect an agent from my Room account</a></p>` : ''}</main></body></html>`;
}
