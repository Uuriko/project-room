import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { EVENT_TYPES as T, PERMISSIONS } from '../src/events.js';
import { auditRecovery } from '../server/recovery.mjs';

function fixture(t, roomId = 'muse-room') {
  const dir = mkdtempSync(join(tmpdir(), 'muse-access-'));
  const store = new RoomStore(join(dir, 'room.sqlite'));
  store.initialize(initialRoom(roomId));
  const owner = store.issueAccessKey(roomId, 'owner');
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const command = (key, type, data) => store.command(key, roomId, { id: randomUUID(), type, data });
  const enable = enabled => command(owner, T.ROOM_DEVELOPMENT_ACCESS_SET, { enabled });
  const mint = (key, access = 'co_owner') => {
    const linkToken = randomBytes(32).toString('base64url');
    const member = store.authenticate(key, roomId).member;
    const result = store.shareLinks.create(key, roomId, { requestId: randomUUID(), linkToken, access,
      expiresAt: store.now() + 3600000, maxJoins: 5, expectedMemberRevision: member.revision }, null,
    { emailVerificationUnachievable: true });
    return { ...result, linkToken };
  };
  return { store, roomId, owner, command, enable, mint };
}

test('Muse opt-in lets an invited agent invite another full co-owner, audited and replayable', t => {
  const f = fixture(t);
  assert.throws(() => f.mint(f.owner), { code: 'link_access_denied' });
  f.enable(true);
  const link = f.mint(f.owner);
  const agent = f.store.identities.create('First collaborator');
  const joined = f.store.shareLinks.joinAgent(agent.secret, link.linkToken, 'First collaborator');
  assert.deepEqual(joined.permissions, PERMISSIONS);
  assert.equal(f.store.room(f.roomId).state.room.ownerId, 'owner');
  const next = f.store.invites.create(agent.secret, f.roomId, { ownerEquivalent: true });
  assert.deepEqual(f.store.invites.preview(next.code).permissions, PERMISSIONS);
  const second = f.store.invites.redeem(next.code, { displayName: 'Second collaborator' });
  assert.deepEqual(second.permissions, PERMISSIONS);
  assert.doesNotThrow(() => f.mint(second.identitySecret));
  assert.doesNotThrow(() => f.store.shareLinks.verify());
  assert.doesNotThrow(() => auditRecovery(f.store));
});

test('same Muse invitation admits account-bound humans with full permissions and onward invitations', t => {
  const f = fixture(t); f.enable(true);
  const { linkToken } = f.mint(f.owner);
  const slot = f.store.createAccountSessionSlot();
  const account = f.store.createAccount('collaborator-account', 'test');
  f.store.loginAccountSession(slot.token, f.store.issueAccountAccessKey(account.id), slot.session.sessionRevision);
  const current = f.store.accountSessionSlot(slot.token);
  const joined = f.store.shareLinks.join(slot.token, linkToken, { displayName: 'Human collaborator', redemptionId: randomUUID(),
    expectedSessionRevision: current.sessionRevision, expectedSessionBinding: current.sessionBinding });
  assert.equal(joined.session.member.kind, 'human');
  assert.deepEqual(joined.session.member.permissions, PERMISSIONS);
  const key = f.store.issueAccessKey(f.roomId, joined.session.member.id);
  assert.doesNotThrow(() => f.mint(key));
  assert.doesNotThrow(() => f.store.shareLinks.verify());
  assert.doesNotThrow(() => auditRecovery(f.store));
});

test('ordinary rooms cannot enable development access or issue co-owner links', t => {
  const f = fixture(t, 'ordinary');
  assert.throws(() => f.enable(true), /only available in Muse/);
  assert.throws(() => f.mint(f.owner), { code: 'link_access_denied' });
  const invite = f.store.invites.create(f.owner, f.roomId, { ownerEquivalent: true });
  const peer = f.store.invites.redeem(invite.code, { displayName: 'Ordinary coowner' });
  assert.throws(() => f.store.invites.create(peer.identitySecret, f.roomId, { ownerEquivalent: true }), { code: 'owner_equivalent_forbidden' });
});

test('ordinary Muse members cannot enable the setting or mint co-owner access; disabling invalidates pending development grants', t => {
  const f = fixture(t);
  const ordinary = f.store.invites.create(f.owner, f.roomId, { profile: 'contribute' });
  const peer = f.store.invites.redeem(ordinary.code, { displayName: 'Contributor' });
  assert.throws(() => f.command(peer.identitySecret, T.ROOM_DEVELOPMENT_ACCESS_SET, { enabled: true }), /administrator/);
  f.enable(true);
  assert.throws(() => f.store.invites.create(peer.identitySecret, f.roomId, { ownerEquivalent: true }), { code: 'owner_equivalent_forbidden' });
  const link = f.mint(f.owner);
  const invited = f.store.identities.create('Dev peer');
  f.store.shareLinks.joinAgent(invited.secret, link.linkToken, 'Dev peer');
  const onward = f.store.invites.create(invited.secret, f.roomId, { ownerEquivalent: true });
  const shared = f.mint(invited.secret);
  f.enable(false);
  assert.throws(() => f.store.invites.preview(onward.code), { code: 'invite_authority_changed' });
  assert.equal(f.store.shareLinks.list(f.owner, f.roomId).links.find(l => l.id === shared.link.id).status, 'authority_changed');
});

test('enabling Muse never upgrades existing links, and demoting the issuer ends pending co-owner grants', t => {
  const f = fixture(t);
  const old = f.mint(f.owner, 'co_admin');
  f.enable(true);
  assert.equal(f.store.shareLinks.preview(old.linkToken).link.permissions.includes('manage_members'), false);
  const invite = f.store.invites.create(f.owner, f.roomId, {ownerEquivalent:true});
  const peer = f.store.invites.redeem(invite.code, {displayName:'Revocable collaborator'});
  const pending = f.mint(peer.identitySecret);
  const code = f.store.invites.create(peer.identitySecret, f.roomId, {ownerEquivalent:true});
  const member = f.store.room(f.roomId).state.members[peer.memberId];
  f.command(f.owner, T.MEMBER_ACCESS_CHANGED, {memberId:member.id, expectedMemberRevision:member.revision,
    permissions:['accept_work'], active:true});
  assert.throws(()=>f.store.invites.redeem(code.code,{displayName:'Rejected collaborator'}), {code:'invite_authority_changed'});
  assert.equal(f.store.shareLinks.list(f.owner,f.roomId).links.find(l=>l.id===pending.link.id).status,'authority_changed');
  assert.doesNotThrow(()=>auditRecovery(f.store));
});

test('malformed settings cannot enable development access', t => {
  const f=fixture(t);
  assert.throws(()=>f.command(f.owner,T.ROOM_DEVELOPMENT_ACCESS_SET,{enabled:'true'}),/Invalid field: enabled/);
  assert.throws(()=>f.command(f.owner,T.ROOM_DEVELOPMENT_ACCESS_SET,{enabled:true,roomId:'ordinary'}),/boolean|field/);
  assert.equal(f.store.room(f.roomId).state.room.developmentAccess,undefined);
});
