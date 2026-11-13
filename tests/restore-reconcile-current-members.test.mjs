import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomStore, ServiceError } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { event } from '../src/events.js';
import { reconcileRestoredAuthority } from '../server/backup.mjs';

function fixture(t, representation, { restored = false, history = 0, empty = false } = {}) {
  const store = new RoomStore(':memory:');
  t.after(() => store.close());
  if (empty) return store;
  const events = initialRoom();
  const add = id => events.push(event({ roomId: 'commons', actorId: 'owner', type: 'member.added',
    data: { memberId: id, displayName: id, kind: 'human', permissions: [] } }));
  const deactivate = id => events.push(event({ roomId: 'commons', actorId: 'owner', type: 'member.access_changed',
    data: { memberId: id, expectedMemberRevision: 0, permissions: [], active: false } }));
  for (const id of ['kept', 'revoked', 'historical']) add(id);
  deactivate('historical');
  if (restored) add('missing');
  else deactivate('revoked');
  // Valid historical churn; never exceed the active member admission cap.
  for (let i = 0; i < history; i += 1) { add(`old-${i}`); deactivate(`old-${i}`); }
  store.initialize(events, representation === 'legacy' ? {} : { representation: 'normalized-current-v1' });
  return store;
}

for (const restoredFormat of ['legacy', 'current']) {
  for (const currentFormat of ['legacy', 'current']) {
    test(`${restoredFormat} restore versus ${currentFormat} current: exact stale membership report`, t => {
      const restored = fixture(t, restoredFormat, { restored: true });
      const current = fixture(t, currentFormat);
      const report = reconcileRestoredAuthority(restored, current);
      assert.deepEqual(report.stale.filter(row => row.kind === 'member').sort((a, b) => a.id.localeCompare(b.id)), [
        { kind: 'member', id: 'commons/missing', detail: 'active membership unknown to the current store' },
        { kind: 'member', id: 'commons/revoked', detail: 'membership was deactivated after the backup' }
      ]);
      assert.equal(report.checked.rooms, 1);
      assert.equal(report.checkedClasses.member, 1);
    });
  }
}

test('normalized restored members are all reported when the current room is absent', t => {
  const restored = fixture(t, 'current', { restored: true });
  const current = fixture(t, 'current', { empty: true });
  const report = reconcileRestoredAuthority(restored, current);
  assert.deepEqual(new Set(report.stale.filter(row => row.kind === 'member').map(row => row.id)),
    new Set(['commons/owner', 'commons/kept', 'commons/revoked', 'commons/missing']));
  assert.equal(report.checked.rooms, 1);
});

for (const side of ['restored', 'current']) {
  test(`normalized ${side} census refuses over-budget history instead of a partial report`, t => {
    const restored = fixture(t, 'current', { restored: true, history: side === 'restored' ? 101 : 0 });
    const current = fixture(t, 'current', { history: side === 'current' ? 101 : 0 });
    assert.throws(() => reconcileRestoredAuthority(restored, current), error =>
      error.status === 409 && error.code === 'current_room_context_unavailable');
  });
}

test('non-missing canonical authority failures propagate rather than becoming unknown members', t => {
  const restored = fixture(t, 'current', { restored: true });
  const current = fixture(t, 'current');
  for (const failure of [new ServiceError(503, 'storage_unavailable', 'Synthetic authority read unavailable'),
    new Error('current_room_corrupt: synthetic authority proof failure')]) {
    // Fault the existing authority dependency; no test-only production seam,
    // forged proof, table edit or disabled writer guard is introduced.
    current.roomAuthority = () => { throw failure; };
    assert.throws(() => reconcileRestoredAuthority(restored, current), error => error === failure);
  }
});
