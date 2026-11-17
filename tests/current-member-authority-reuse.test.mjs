// Member authority may be reused inside one read context only while nothing
// could have changed it: a context that asked for reuse (the command path),
// open transaction, no write by this connection. These tests hold each of those conditions to account against a
// real normalized store. Reuse must never survive a permission change.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { withCurrentReadContext } from '../server/current-room-repository.mjs';

function fixture(t) {
  const store = new RoomStore(':memory:');
  store.initialize(initialRoom(), { representation: 'normalized-current-v1' });
  t.after(() => store.close());
  const ownerKey = store.issueAccessKey('commons', 'owner');
  store.command(ownerKey, 'commons', { id: 'add-reviewer', type: 'member.added', data: { memberId: 'reviewer', displayName: 'Reviewer', kind: 'agent', permissions: ['verify'] } });
  const read = () => store.roomAuthority('commons', { memberId: 'reviewer' });
  const reusing = (operation, options = {}) => withCurrentReadContext(store.db, 'commons', operation, { reuseMemberAuthority: true, ...options });
  return { store, ownerKey, read, reusing };
}

test('a repeated member authority read in one transaction context costs one record and returns equal, separate objects', t => {
  const f = fixture(t);
  f.store.transaction(() => f.reusing(b => {
    const first = f.read(), afterFirst = b.records;
    const second = f.read(), afterSecond = b.records;
    assert.ok(afterFirst > 20, 'the first read verifies schema, head and member records');
    assert.equal(afterSecond - afterFirst, 1, 'the repeat is charged one record, not a second verification');
    assert.deepEqual(second, first);
    second.members.reviewer.permissions.push('manage_members');
    assert.deepEqual(f.read().members.reviewer.permissions, ['verify'], 'a caller cannot alter what the next reader receives');
    // Another member is a different key and is read from storage.
    const before = b.records;
    f.store.roomAuthority('commons', { memberId: 'owner' });
    assert.ok(b.records - before > 1, 'a different member is not served from the reviewer entry');
  }));
});

test('any write by this connection ends reuse: the next read is verified from storage and sees the change', t => {
  const f = fixture(t);
  f.store.transaction(() => f.reusing(b => {
    const first = f.read();
    assert.deepEqual(first.members.reviewer.permissions, ['verify']);
    f.read();
    const reused = b.records;
    // Any row change moves the connection's mutation counter.
    f.store.db.prepare("CREATE TEMP TABLE IF NOT EXISTS reuse_probe(n INTEGER)").run();
    f.store.db.prepare('INSERT INTO reuse_probe VALUES(1)').run();
    f.read();
    assert.ok(b.records - reused > 1, 'after a write the authority is read and verified again');
  }, { maxRecords: 512 }));
  // A real permission change through the command path is visible to the very next context.
  const seat = f.read().members.reviewer;
  f.store.command(f.ownerKey, 'commons', { id: 'strip', type: 'member.access_changed', data: { memberId: 'reviewer', expectedMemberRevision: seat.revision, active: true, permissions: [] } });
  f.store.transaction(() => f.reusing(() => {
    assert.deepEqual(f.read().members.reviewer.permissions, [], 'the stripped permission is read, not a remembered one');
    assert.deepEqual(f.read().members.reviewer.permissions, []);
  }));
});

test('there is no reuse outside a transaction, without the opt-in, or across contexts', t => {
  const f = fixture(t);
  // An ordinary read context, even in a transaction, never reuses: read costs are unchanged.
  f.store.transaction(() => withCurrentReadContext(f.store.db, 'commons', b => {
    f.read(); const afterFirst = b.records;
    f.read();
    assert.ok(b.records - afterFirst > 1, 'no opt-in, no reuse');
    // An inner context cannot switch reuse on for a budget it did not open.
    withCurrentReadContext(f.store.db, 'commons', inner => { const before = inner.records; f.read(); assert.ok(inner.records - before > 1); }, { reuseMemberAuthority: true });
  }));
  // A context without a transaction: another connection could commit between reads.
  f.reusing(b => {
    f.read(); const afterFirst = b.records;
    f.read();
    assert.ok(b.records - afterFirst > 1, 'no transaction, no reuse');
  });
  // No context at all: every read gets its own budget and verifies from storage.
  assert.deepEqual(f.read(), f.read());
  // Nothing is carried from one context to the next.
  f.store.transaction(() => f.reusing(() => { f.read(); }));
  f.store.transaction(() => f.reusing(b => {
    f.read();
    assert.ok(b.records > 20, 'a new context starts by verifying from storage');
  }));
});
