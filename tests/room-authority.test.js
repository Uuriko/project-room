import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { createAcceptanceFixture } from '../scripts/acceptance-fixture.mjs';
import { RoomStore } from '../server/store.mjs';
import { createRoomServer } from '../server/http.mjs';
import { RoomAgentClient } from '../client/room-agent.mjs';
import { auditRecovery } from '../server/recovery.mjs';

function fixture(t, managedProducer = true) {
  const f = createAcceptanceFixture({ managedProducer });
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  return f;
}
const send = (f, type, data) => f.store.command(f.keys.owner, 'commons', { id: crypto.randomUUID(), type, data });

test('narrow authority preserves exact members, provenance and sequence without exposing other room data or sharing objects', t => {
  const f = fixture(t), { sequence, state } = f.store.room('commons');
  const before = auditRecovery(f.store).dataSha256;
  const authority = f.store.roomAuthority('commons');
  assert.deepEqual(authority, { sequence, ownerId: state.room.ownerId, members: state.members });
  assert.deepEqual(Object.keys(authority).sort(), ['members', 'ownerId', 'sequence']);
  authority.members.producer.permissions.push('not-a-real-permission');
  assert.deepEqual(f.store.roomAuthority('commons').members, state.members);
  assert.equal(auditRecovery(f.store).dataSha256, before);
  assert.throws(() => f.store.roomAuthority('missing'), { code: 'room_not_found', status: 404 });
});

test('legacy, managed, human-room and account-session authentication no longer require a full room decode', t => {
  for (const managed of [false, true]) {
    const f = fixture(t, managed), session = f.store.createSession(f.keys.owner);
    const account = f.store.accountForMember('commons', 'owner'), slot = f.store.createAccountSessionSlot();
    const accountSession = f.store.loginAccountSession(slot.token, f.store.issueAccountAccessKey(account.id), 0);
    const invitedSlot = f.store.createAccountSessionSlot();
    const invited = f.store.shareLinks.join(invitedSlot.token, f.links.valid, { displayName: 'Invited 🪷 participant',
      redemptionId: crypto.randomUUID(), expectedSessionRevision: 0, expectedSessionBinding: invitedSlot.session.sessionBinding });
    const expected = f.store.room('commons').state.members, before = auditRecovery(f.store).dataSha256;
    const room = f.store.room; f.store.room = () => assert.fail('Authentication must not decode the full room');
    try {
      for (const [token, memberId, binding] of [[f.keys.producer, 'producer', null], [f.keys.guest, 'guest', null],
        [f.keys.owner, 'owner', null], [session.token, 'owner', session.session.sessionBinding],
        [slot.token, 'owner', accountSession.sessionBinding], [invitedSlot.token, invited.session.member.id, invited.session.sessionBinding]]) {
        assert.deepEqual(f.store.authenticate(token, 'commons', binding).member, expected[memberId]);
      }
      assert.throws(() => f.store.authenticate(session.token, 'commons', 'wrong'), { code: 'session_binding_changed' });
      assert.throws(() => f.store.authenticate(slot.token, 'commons', 'wrong'), { code: 'session_binding_changed' });
    } finally { f.store.room = room; }
    assert.equal(auditRecovery(f.store).dataSha256, before);
  }
});

test('narrow authority follows the transaction snapshot and refreshes after commit', t => {
  const f = fixture(t), other = new RoomStore(join(f.directory, 'room.sqlite'));
  try {
    let initial;
    f.store.readTransaction(() => {
      initial = f.store.roomAuthority('commons');
      other.command(f.keys.owner, 'commons', { id: crypto.randomUUID(), type: 'member.access_changed',
        data: { memberId: 'guest', expectedMemberRevision: 0, active: true, permissions: ['accept_work'] } });
      assert.deepEqual(f.store.roomAuthority('commons'), initial, 'Same committed snapshot inside the read');
    });
    const fresh = f.store.roomAuthority('commons');
    assert.ok(fresh.sequence > initial.sequence);
    assert.deepEqual(fresh.members.guest.permissions, ['accept_work']);
    assert.equal(f.store.authenticate(f.keys.guest, 'commons').member.revision, fresh.members.guest.revision);
  } finally { other.close(); }
});

for (const phase of ['after-identity', 'before-committed-read']) {
  for (const change of ['member', 'sponsor', 'credential']) {
    test(`managed discovery rechecks ${change} changes ${phase}`, async t => {
      const f = createAcceptanceFixture({ managedProducer: true }), server = createRoomServer({ store: f.store });
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      t.after(async () => { server.closeStreams(); server.closeAllConnections();
        await new Promise(resolve => server.close(resolve)); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
      const origin = `http://127.0.0.1:${server.address().port}`, originalRead = f.store.readTransaction;
      let changed = false, armed = false, requests = 0;
      const mutate = () => {
        changed = true;
        if (change === 'credential') f.store.revoke(f.keys.producer);
        else {
          const memberId = change === 'member' ? 'producer' : 'owner';
          const member = f.store.roomAuthority('commons').members[memberId];
          send(f, 'member.access_changed', { memberId, expectedMemberRevision: member.revision,
            active: true, permissions: member.permissions });
        }
      };
      f.store.readTransaction = function(fn) {
        if (phase === 'before-committed-read' && armed && !changed) mutate();
        return originalRead.call(this, fn);
      };
      const client = new RoomAgentClient({ origin, roomId: 'commons', memberId: 'producer', token: f.keys.producer,
        fetchImpl: async (url, options) => {
          requests++;
          const response = await fetch(url, options);
          if (new URL(url).pathname === '/api/session') {
            assert.equal(response.status, 200); armed = true;
            if (phase === 'after-identity') mutate();
          }
          return response;
        } });
      await assert.rejects(client.orient({ focus: 'needs_me', query: 'agenda' }), error => [401, 403].includes(error.status));
      assert.equal(changed, true); assert.equal(requests, 2, 'No weaker retry after changed authority');
      f.store.readTransaction = originalRead;
      const before = auditRecovery(f.store).dataSha256;
      assert.throws(() => f.store.authenticate(f.keys.producer, 'commons'));
      assert.equal(auditRecovery(f.store).dataSha256, before);
    });
  }
}
