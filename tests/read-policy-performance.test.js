import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createAcceptanceFixture } from '../scripts/acceptance-fixture.mjs';
import { retiredNeedsMeKeys, projectRoomUpdates } from '../server/updates.mjs';

function fixture(t) {
  const f = createAcceptanceFixture();
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  return f;
}

test('history policy reads stay fresh across same-sequence writes, fallback key ordering and rollback', t => {
  const { store } = fixture(t);
  const write = (value, reverse = false) => store.transaction(() => {
    const row = store.db.prepare('SELECT projection FROM rooms WHERE id=?').get('commons');
    const state = JSON.parse(row.projection);
    state.room.historyVisibility = { value, revision: 1 };
    state.room.historyDefaultsVersion = 1;
    const stored = reverse ? Object.fromEntries(Object.entries(state).reverse()) : state;
    store.db.prepare('UPDATE rooms SET projection=? WHERE id=?').run(JSON.stringify(stored), 'commons');
  });
  for (const reverse of [false, true]) {
    write('all', reverse);
    assert.equal(store.historyFloor('commons', 'guest'), null);
    write('since_join', reverse);
    const policy = store.roomAuthority('commons', { includeHistory: true });
    assert.deepEqual(policy.historyVisibility, { value: 'since_join', revision: 1 });
    assert.equal(policy.historyDefaultsVersion, 1);
    assert.ok(store.historyFloor('commons', 'guest'));
    assert.throws(() => store.transaction(() => { write('all', reverse); throw new Error('rollback'); }), /rollback/);
    assert.ok(store.historyFloor('commons', 'guest'));
  }
  store.room = () => assert.fail('Policy read must not hydrate conversation');
  assert.ok(store.historyFloor('commons', 'guest'));
});

test('needs-me retirement never scans claim, joined-agent or owner administrative sources', t => {
  const { store } = fixture(t);
  const prepare = store.db.prepare.bind(store.db), seen = [];
  store.db.prepare = sql => { seen.push(sql); return prepare(sql); };
  retiredNeedsMeKeys(store, 'commons', 'owner');
  assert.equal(seen.some(sql => /work_claim.updated|joinedVia|FROM membership_invitations|FROM access_requests/.test(sql)), false);
  seen.length = 0;
  projectRoomUpdates(store, 'commons', 'owner');
  assert.ok(seen.some(sql => sql.includes('work_claim.updated')));
  assert.ok(seen.some(sql => sql.includes('joinedVia')));
});
