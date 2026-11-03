import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { createMcpInviteOAuth } from '../server/mcp-invite-oauth.mjs';
import { createExistingSeatProof } from '../server/existing-seat-oauth-proof.mjs';
import { EXISTING_SEAT_GRANT, validateMcpInviteOAuthBinding } from '../server/mcp-oauth.mjs';
import { pruneOAuthProvider } from '../server/oauth-provider-store.mjs';
import { exportNdjsonText } from '../server/room-export.mjs';
import { replayNdjsonInto } from '../server/restore-ndjson.mjs';
import { reconcileRestoredAuthority } from '../server/backup.mjs';

function fixture(t) {
  const store = new RoomStore(':memory:'); t.after(() => store.close()); store.initialize(initialRoom());
  const owner = store.issueAccessKey('commons', 'owner');
  const identity = store.identities.create('Existing agent');
  const invitation = store.invites.create(owner, 'commons', { profile: 'member' });
  const joined = store.invites.redeem(invitation.code, { identitySecret: identity.secret, displayName: 'Existing agent' });
  const resource = 'https://room.example/mcp', client = { clientId: 'native-test', name: 'Native test', redirectUris: ['https://client.example/callback'] };
  const oauth = createMcpInviteOAuth({ store, clients: [client], resource });
  const begin = () => oauth.begin(new URLSearchParams({ client_id: client.clientId, redirect_uri: client.redirectUris[0], scope: 'rooms:read chat:read', state: 'state', code_challenge: createHash('sha256').update('v'.repeat(43)).digest('base64url'), code_challenge_method: 'S256', resource })).nonce;
  return { store, identity, joined, begin, oauth, proof: createExistingSeatProof({ store, inviteOAuth: oauth }) };
}

test('holder approval is request-specific, same-seat, private, and consumed once', t => {
  const f = fixture(t), nonce = f.begin(), other = f.begin();
  const before = structuredClone(f.store.room('commons').state.members[f.joined.memberId].permissions);
  const view = f.proof.inspect(f.proof.createHandoff(nonce), f.identity.secret, 'commons');
  assert.equal(view.identityId, f.identity.identityId); assert.equal(view.memberId, f.joined.memberId);
  assert.throws(() => f.proof.approve(f.proof.createHandoff(nonce), f.identity.secret, 'commons', 'wrong'));
  f.proof.approve(f.proof.createHandoff(nonce), f.identity.secret, 'commons', view.requestHash);
  const review = f.proof.review(nonce);
  assert.equal(review.memberId, f.joined.memberId); assert.equal(review.displayName, 'Existing agent');
  assert.deepEqual(review.scopes, ['rooms:read', 'chat:read']);
  assert.ok(!JSON.stringify(review).includes(f.identity.secret) && !('state' in review) && !('codeChallenge' in review));
  assert.throws(() => f.proof.consume(other, () => assert.fail()));
  const stored = JSON.stringify(f.store.db.prepare('SELECT * FROM oauth_existing_seat_proofs').all());
  assert.ok(!stored.includes(f.identity.secret) && !stored.includes(nonce));
  assert.throws(() => f.proof.consume(nonce, () => { throw Error('issue failed'); }), /issue failed/);
  const issued = f.proof.consume(nonce, binding => binding);
  assert.equal(issued.identityId, f.identity.identityId); assert.equal(issued.memberId, f.joined.memberId);
  assert.deepEqual(f.store.room('commons').state.members[f.joined.memberId].permissions, before);
  assert.throws(() => f.proof.consume(nonce, () => assert.fail()));
});

for (const mutation of ['changed-request', 'rotated-identity', 'revoked-identity', 'removed-member', 'expired', 'expired-request']) test(`holder approval refuses ${mutation}`, t => {
  const f = fixture(t), nonce = f.begin(), view = f.proof.inspect(f.proof.createHandoff(nonce), f.identity.secret, 'commons');
  f.proof.approve(f.proof.createHandoff(nonce), f.identity.secret, 'commons', view.requestHash);
  if (mutation === 'changed-request') f.store.db.prepare('UPDATE oauth_invite_pending SET request_json=?').run('{}');
  if (mutation === 'rotated-identity') f.store.db.prepare('UPDATE agent_identities SET secret_hash=? WHERE identity_id=?').run('changed', f.identity.identityId);
  if (mutation === 'revoked-identity') f.store.db.prepare('UPDATE agent_identities SET revoked_at=? WHERE identity_id=?').run(Date.now(), f.identity.identityId);
  if (mutation === 'removed-member') f.store.db.prepare('DELETE FROM identity_links WHERE identity_id=?').run(f.identity.identityId);
  if (mutation === 'expired') f.store.db.prepare('UPDATE oauth_existing_seat_proofs SET expires_at=0').run();
  if (mutation === 'expired-request') f.store.db.prepare('UPDATE oauth_invite_pending SET expires_at=0').run();
  assert.throws(() => f.proof.consume(nonce, () => assert.fail()));
});

test('a second identity cannot replace a holder approval', t => {
  const f = fixture(t), nonce = f.begin(), owner = f.store.issueAccessKey('commons', 'owner');
  const other = f.store.identities.create('Second agent');
  const invitation = f.store.invites.create(owner, 'commons', { profile: 'member' });
  f.store.invites.redeem(invitation.code, { identitySecret: other.secret, displayName: 'Second agent' });
  const reference = f.proof.createHandoff(nonce);
  const first = f.proof.inspect(reference, f.identity.secret, 'commons');
  const second = f.proof.inspect(reference, other.secret, 'commons');
  f.proof.approve(reference, f.identity.secret, 'commons', first.requestHash);
  assert.throws(() => f.proof.approve(reference, other.secret, 'commons', second.requestHash));
  assert.equal(f.proof.consume(nonce, binding => binding).identityId, f.identity.identityId);
});

test('proof requires the current global identity and existing room membership', t => {
  const f = fixture(t), nonce = f.begin(), stranger = f.store.identities.create('Stranger');
  assert.throws(() => f.proof.inspect(f.proof.createHandoff(nonce), stranger.secret, 'commons'));
  assert.throws(() => f.proof.inspect(f.proof.createHandoff(nonce), f.identity.secret, 'other-room'));
  assert.throws(() => f.proof.inspect(f.proof.createHandoff(nonce), 'invalid', 'commons'));
});

test('agent handoff reference never supplies the browser consent nonce', t => {
  const f = fixture(t), nonce = f.begin(), reference = f.proof.createHandoff(nonce);
  assert.notEqual(reference, nonce);
  assert.throws(() => f.oauth.read(reference));
  const stored = JSON.stringify(f.store.db.prepare('SELECT * FROM oauth_existing_seat_handoffs').all());
  assert.ok(!stored.includes(reference) && !stored.includes(nonce));
  const view = f.proof.inspect(reference, f.identity.secret, 'commons');
  assert.equal(view.memberId, f.joined.memberId);
  f.proof.approve(reference, f.identity.secret, 'commons', view.requestHash);
  f.proof.createHandoff(nonce);
  assert.throws(() => f.proof.inspect(reference, f.identity.secret, 'commons'));
  assert.throws(() => f.proof.review(nonce), 'old approval cannot survive a new handoff');
});

test('an approved proof survives a database reopen and stays single-use', t => {
  const dir = mkdtempSync(join(tmpdir(), 'seat-proof-')), file = join(dir, 'room.sqlite');
  let store = new RoomStore(file); t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  store.initialize(initialRoom());
  const owner = store.issueAccessKey('commons', 'owner'), identity = store.identities.create('Agent');
  const invitation = store.invites.create(owner, 'commons', { profile: 'member' });
  const joined = store.invites.redeem(invitation.code, { identitySecret: identity.secret, displayName: 'Agent' });
  const resource = 'https://room.example/mcp', clients = [{ clientId: 'native-test', name: 'Native test', redirectUris: ['https://client.example/callback'] }];
  let oauth = createMcpInviteOAuth({ store, clients, resource }), proof = createExistingSeatProof({ store, inviteOAuth: oauth });
  const nonce = oauth.begin(new URLSearchParams({ client_id: 'native-test', redirect_uri: clients[0].redirectUris[0], scope: 'rooms:read', code_challenge: createHash('sha256').update('v'.repeat(43)).digest('base64url'), code_challenge_method: 'S256', resource })).nonce;
  const view = proof.inspect(proof.createHandoff(nonce), identity.secret, 'commons');
  proof.approve(proof.createHandoff(nonce), identity.secret, 'commons', view.requestHash);
  store.close(); store = new RoomStore(file);
  oauth = createMcpInviteOAuth({ store, clients, resource }); proof = createExistingSeatProof({ store, inviteOAuth: oauth });
  assert.equal(proof.consume(nonce, value => value).memberId, joined.memberId);
  store.close(); store = new RoomStore(file);
  oauth = createMcpInviteOAuth({ store, clients, resource }); proof = createExistingSeatProof({ store, inviteOAuth: oauth });
  assert.throws(() => proof.consume(nonce, () => assert.fail()));
});

test('existing-seat OAuth grant requires the consumed holder proof for the exact binding', t => {
  const f = fixture(t), nonce = f.begin(), view = f.proof.inspect(f.proof.createHandoff(nonce), f.identity.secret, 'commons');
  f.proof.approve(f.proof.createHandoff(nonce), f.identity.secret, 'commons', view.requestHash);
  let binding;
  f.proof.consumeForGrant(nonce, seat => {
    const grantId = 'prototype-grant';
    f.store.db.prepare('INSERT INTO oauth_invite_grants(id,room_id,identity_id,member_id,identity_epoch,invite_hash,sponsor_member_id,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(grantId, seat.roomId, seat.identityId, seat.memberId, seat.identityEpoch, EXISTING_SEAT_GRANT, 'owner', Date.now(), Date.now() + 60000);
    binding = { principalType: 'invited-agent', invitationGrantId: grantId, resource: 'https://room.example/mcp', ...seat };
    return { grantId };
  });
  assert.equal(validateMcpInviteOAuthBinding(f.store, 'prototype-grant', binding)?.controllerVerification, 'identity-holder');
  assert.equal(validateMcpInviteOAuthBinding(f.store, 'prototype-grant', { ...binding, memberId: 'owner' }), null);
  // A later approval sweeps expired pending proofs; grant provenance must live
  // beyond the short authorization deadline or it would break active tokens.
  f.store.db.prepare('UPDATE oauth_existing_seat_proofs SET expires_at=0').run();
  const later = f.begin(), nextView = f.proof.inspect(f.proof.createHandoff(later), f.identity.secret, 'commons');
  f.proof.approve(f.proof.createHandoff(later), f.identity.secret, 'commons', nextView.requestHash);
  assert.equal(validateMcpInviteOAuthBinding(f.store, 'prototype-grant', binding)?.controllerVerification, 'identity-holder');
  f.store.db.prepare('UPDATE oauth_existing_seat_proofs SET grant_id=NULL').run();
  assert.equal(validateMcpInviteOAuthBinding(f.store, 'prototype-grant', binding), null);
});

test('prototype issues and exchanges a PKCE code only after proof provenance is linked', t => {
  const f = fixture(t), nonce = f.begin(), view = f.proof.inspect(f.proof.createHandoff(nonce), f.identity.secret, 'commons');
  f.proof.approve(f.proof.createHandoff(nonce), f.identity.secret, 'commons', view.requestHash);
  const request = f.oauth.read(nonce).request;
  const makeGrant = seat => {
    const grantId = 'exchange-grant';
    f.store.db.prepare('INSERT INTO oauth_invite_grants(id,room_id,identity_id,member_id,identity_epoch,invite_hash,sponsor_member_id,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(grantId, seat.roomId, seat.identityId, seat.memberId, seat.identityEpoch, EXISTING_SEAT_GRANT, 'owner', Date.now(), Date.now() + 60000);
    return { grantId };
  };
  const issue = (grant, seat) => f.oauth.provider.issueCode({ ...request, userId: grant.grantId, codeIdempotencyKey: nonce,
    binding: { principalType: 'invited-agent', invitationGrantId: grant.grantId, resource: 'https://room.example/mcp', ...seat } });
  assert.throws(() => f.proof.consumeForGrant(nonce, makeGrant, () => { throw Error('code issuance failed'); }), /code issuance failed/);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM oauth_invite_grants').get().n, 0);
  const { code } = f.proof.consumeForGrant(nonce, makeGrant, issue);
  assert.equal(f.proof.replayGrant(nonce, issue).code, code);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM oauth_invite_grants').get().n, 1);
  const tokens = f.oauth.provider.exchangeCode({ code, clientId: 'native-test', redirectUri: 'https://client.example/callback', codeVerifier: 'v'.repeat(43), resource: 'https://room.example/mcp' });
  const verified = f.oauth.provider.verifyAccessToken(tokens.accessToken, { resource: 'https://room.example/mcp' });
  assert.equal(verified.binding.identityId, f.identity.identityId); assert.equal(verified.binding.memberId, f.joined.memberId);
  assert.throws(() => f.proof.consumeForGrant(nonce, makeGrant, issue));
  assert.throws(() => f.proof.replayGrant(nonce, issue));
});

test('provider prototype reconnects the existing seat and retries only the original unexchanged code', t => {
  const f = fixture(t), nonce = f.begin(), proof = f.oauth.existingSeatProof();
  const view = proof.inspect(proof.createHandoff(nonce), f.identity.secret, 'commons');
  assert.throws(() => f.oauth.approveExisting(nonce));
  proof.approve(proof.createHandoff(nonce), f.identity.secret, 'commons', view.requestHash);
  const first = f.oauth.approveExisting(nonce), retry = f.oauth.approveExisting(nonce);
  assert.equal(first, retry);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM oauth_invite_grants').get().n, 1);
  const code = new URL(first).searchParams.get('code');
  const tokens = f.oauth.provider.exchangeCode({ code, clientId: 'native-test', redirectUri: 'https://client.example/callback', codeVerifier: 'v'.repeat(43), resource: 'https://room.example/mcp' });
  const token = f.oauth.provider.verifyAccessToken(tokens.accessToken, { resource: 'https://room.example/mcp' });
  assert.equal(token.binding.identityId, f.identity.identityId); assert.equal(token.binding.memberId, f.joined.memberId);
  assert.throws(() => f.oauth.approveExisting(nonce));
});

test('active existing-seat connection refreshes beyond 30 days and pruning preserves its proof', t => {
  const f = fixture(t); let now = Date.now(); f.store.now = () => now;
  const nonce = f.begin(), proof = f.oauth.existingSeatProof(), reference = proof.createHandoff(nonce);
  const plan = f.store.db.prepare("EXPLAIN QUERY PLAN SELECT id FROM oauth_invite_grants WHERE (expires_at != 0 OR (invite_hash != 'existing-seat-holder-v1' AND (invite_hash != 'public-lobby-guest-v1' OR room_id != 'project-room-lobby'))) AND expires_at <= ? LIMIT ?").all(now, 100);
  assert.ok(plan.some(row => row.detail.includes('oauth_invite_grants_expires_v2')));
  const view = proof.inspect(reference, f.identity.secret, 'commons');
  proof.approve(reference, f.identity.secret, 'commons', view.requestHash);
  const code = new URL(f.oauth.approveExisting(nonce)).searchParams.get('code');
  let token = f.oauth.provider.exchangeCode({ code, clientId: 'native-test', redirectUri: 'https://client.example/callback', codeVerifier: 'v'.repeat(43), resource: 'https://room.example/mcp' });
  for (let i = 0; i < 2; i++) {
    now += 29 * 86400000;
    pruneOAuthProvider(f.store.db, { now, limit: 100 });
    token = f.oauth.provider.refresh({ refreshToken: token.refreshToken, clientId: 'native-test', resource: 'https://room.example/mcp' });
    assert.equal(f.oauth.provider.verifyAccessToken(token.accessToken, { resource: 'https://room.example/mcp' }).binding.memberId, f.joined.memberId);
  }
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM oauth_invite_grants WHERE invite_hash=?').get(EXISTING_SEAT_GRANT).n, 1);
  f.store.db.prepare('UPDATE agent_identities SET revoked_at=? WHERE identity_id=?').run(now, f.identity.identityId);
  assert.equal(f.oauth.provider.verifyAccessToken(token.accessToken, { resource: 'https://room.example/mcp' }), null);
});

test('backup and restore preserve existing-seat grant proof without storing bearer secrets', t => {
  const f = fixture(t), nonce = f.begin(), proof = f.oauth.existingSeatProof(), reference = proof.createHandoff(nonce);
  const view = proof.inspect(reference, f.identity.secret, 'commons'); proof.approve(reference, f.identity.secret, 'commons', view.requestHash);
  const code = new URL(f.oauth.approveExisting(nonce)).searchParams.get('code');
  const tokens = f.oauth.provider.exchangeCode({ code, clientId: 'native-test', redirectUri: 'https://client.example/callback', codeVerifier: 'v'.repeat(43), resource: 'https://room.example/mcp' });
  const exportText = exportNdjsonText(f.store.db);
  assert.ok(!exportText.includes(reference) && !exportText.includes(f.identity.secret) && !exportText.includes(tokens.accessToken));
  const restored = new RoomStore(':memory:'); t.after(() => restored.close());
  assert.equal(replayNdjsonInto(exportText, restored).verified, true);
  const oauth = createMcpInviteOAuth({ store: restored, clients: [{ clientId: 'native-test', name: 'Native test', redirectUris: ['https://client.example/callback'] }], resource: 'https://room.example/mcp' });
  assert.equal(oauth.provider.verifyAccessToken(tokens.accessToken, { resource: 'https://room.example/mcp' })?.binding.memberId, f.joined.memberId);
});

test('restore reconciliation reports an existing-seat grant revoked after the backup', t => {
  const f = fixture(t), nonce = f.begin(), proof = f.oauth.existingSeatProof(), reference = proof.createHandoff(nonce);
  const view = proof.inspect(reference, f.identity.secret, 'commons'); proof.approve(reference, f.identity.secret, 'commons', view.requestHash);
  f.oauth.approveExisting(nonce);
  const snapshot = exportNdjsonText(f.store.db), restored = new RoomStore(':memory:'); t.after(() => restored.close());
  replayNdjsonInto(snapshot, restored);
  f.store.db.prepare('UPDATE oauth_invite_grants SET revoked_at=?').run(Date.now());
  const report = reconcileRestoredAuthority(restored, f.store);
  assert.ok(report.stale.some(row => row.kind === 'oauth_access' && /grant.*revoked/.test(row.detail)));
});

test('restore reconciliation reports a consumed holder proof and rotated native refresh token', t => {
  const f = fixture(t), nonce = f.begin(), proof = f.oauth.existingSeatProof(), reference = proof.createHandoff(nonce);
  const view = proof.inspect(reference, f.identity.secret, 'commons'); proof.approve(reference, f.identity.secret, 'commons', view.requestHash);
  const beforeConsent = exportNdjsonText(f.store.db), old = new RoomStore(':memory:'); t.after(() => old.close()); replayNdjsonInto(beforeConsent, old);
  const code = new URL(f.oauth.approveExisting(nonce)).searchParams.get('code');
  assert.ok(reconcileRestoredAuthority(old, f.store).stale.some(row => row.kind === 'oauth_code' && /holder proof.*consumed/.test(row.detail)));
  const tokens = f.oauth.provider.exchangeCode({ code, clientId: 'native-test', redirectUri: 'https://client.example/callback', codeVerifier: 'v'.repeat(43), resource: 'https://room.example/mcp' });
  const beforeRefresh = exportNdjsonText(f.store.db), previous = new RoomStore(':memory:'); t.after(() => previous.close()); replayNdjsonInto(beforeRefresh, previous);
  f.oauth.provider.refresh({ refreshToken: tokens.refreshToken, clientId: 'native-test', resource: 'https://room.example/mcp' });
  assert.ok(reconcileRestoredAuthority(previous, f.store).stale.some(row => row.kind === 'oauth_refresh' && /native OAuth refresh token.*revoked|native OAuth refresh token.*rotated/.test(row.detail)));
});

test('restore reconciliation ignores expired handoffs and unconsumed proofs', t => {
  const f = fixture(t), nonce = f.begin(), proof = f.oauth.existingSeatProof(), reference = proof.createHandoff(nonce);
  const view = proof.inspect(reference, f.identity.secret, 'commons');
  proof.approve(reference, f.identity.secret, 'commons', view.requestHash);
  const snapshot = exportNdjsonText(f.store.db), restored = new RoomStore(':memory:');
  t.after(() => restored.close());
  replayNdjsonInto(snapshot, restored);
  const expiry = f.store.db.prepare('SELECT expires_at FROM oauth_existing_seat_handoffs').get().expires_at;
  f.store.now = () => expiry + 1;
  f.store.db.prepare('DELETE FROM oauth_existing_seat_handoffs').run();
  f.store.db.prepare('DELETE FROM oauth_existing_seat_proofs WHERE grant_id IS NULL').run();
  const stale = reconcileRestoredAuthority(restored, f.store).stale;
  assert.equal(stale.some(row => /existing-seat OAuth (handoff|holder proof)/.test(row.detail)), false);
});

for (const mutation of ['grant-revoked', 'member-unlinked', 'proof-mismatch']) test(`existing-seat token stops after ${mutation}`, t => {
  const f = fixture(t), nonce = f.begin(), proof = f.oauth.existingSeatProof(), reference = proof.createHandoff(nonce);
  const view = proof.inspect(reference, f.identity.secret, 'commons');
  proof.approve(reference, f.identity.secret, 'commons', view.requestHash);
  const code = new URL(f.oauth.approveExisting(nonce)).searchParams.get('code');
  const token = f.oauth.provider.exchangeCode({ code, clientId: 'native-test', redirectUri: 'https://client.example/callback', codeVerifier: 'v'.repeat(43), resource: 'https://room.example/mcp' });
  assert.ok(f.oauth.provider.verifyAccessToken(token.accessToken, { resource: 'https://room.example/mcp' }));
  if (mutation === 'grant-revoked') f.store.db.prepare('UPDATE oauth_invite_grants SET revoked_at=?').run(Date.now());
  if (mutation === 'member-unlinked') f.store.db.prepare('DELETE FROM identity_links WHERE identity_id=?').run(f.identity.identityId);
  if (mutation === 'proof-mismatch') f.store.db.prepare('UPDATE oauth_existing_seat_proofs SET member_id=?').run('another-member');
  assert.equal(f.oauth.provider.verifyAccessToken(token.accessToken, { resource: 'https://room.example/mcp' }), null);
  assert.throws(() => f.oauth.provider.refresh({ refreshToken: token.refreshToken, clientId: 'native-test', resource: 'https://room.example/mcp' }));
});
