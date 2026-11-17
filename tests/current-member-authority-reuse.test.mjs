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

// Codex's review of 64f6bd11: SQLite's mutation counter does not move back on
// rollback. If reuse were only "cleared and refilled" after a write, a read
// inside a savepoint would be stored under the moved counter and still match
// it after the savepoint rolled back. Reuse therefore ends for good at the
// first write the context observes, counted from when the context opened.
const access = (f, permissions, id) => f.store.command(f.ownerKey, 'commons', { id, type: 'member.access_changed',
  data: { memberId: 'reviewer', expectedMemberRevision: f.read().members.reviewer.revision, active: true, permissions } });
const rolledBack = (f, operation) => assert.throws(() => f.store.transaction(() => { operation(); throw new Error('roll this back'); }, { isolated: true }), /roll this back/);

test('a permission change that rolls back never survives in a later read (grant, then revocation)', t => {
  const f = fixture(t);
  f.store.transaction(() => f.reusing(() => {
    assert.deepEqual(f.read().members.reviewer.permissions, ['verify']);
    rolledBack(f, () => {
      access(f, ['verify', 'accept_work'], 'temporary-grant');
      assert.deepEqual(f.read().members.reviewer.permissions, ['verify', 'accept_work'], 'inside the savepoint the grant is visible');
      assert.deepEqual(f.read().members.reviewer.permissions, ['verify', 'accept_work']);
    });
    assert.deepEqual(f.read().members.reviewer.permissions, ['verify'], 'the rolled-back grant is gone');
    assert.deepEqual(f.read().members.reviewer.permissions, ['verify']);
  }, { maxRecords: 1024 }));
  f.store.transaction(() => f.reusing(() => {
    rolledBack(f, () => {
      access(f, [], 'temporary-revocation');
      assert.deepEqual(f.read().members.reviewer.permissions, []);
    });
    assert.deepEqual(f.read().members.reviewer.permissions, ['verify'], 'the rolled-back revocation is undone');
  }, { maxRecords: 1024 }));
  assert.deepEqual(f.read().members.reviewer.permissions, ['verify'], 'nothing was persisted');
});

test('the first read may happen inside the savepoint: a write before any read still ends reuse', t => {
  const f = fixture(t);
  f.store.transaction(() => f.reusing(() => {
    rolledBack(f, () => {
      access(f, ['verify', 'accept_work'], 'grant-before-first-read');
      assert.deepEqual(f.read().members.reviewer.permissions, ['verify', 'accept_work']);
    });
    assert.deepEqual(f.read().members.reviewer.permissions, ['verify']);
  }, { maxRecords: 1024 }));
});

test('nested savepoints: an inner rollback inside an outer rollback, then a committed change, are each read as stored', t => {
  const f = fixture(t);
  f.store.transaction(() => f.reusing(b => {
    assert.deepEqual(f.read().members.reviewer.permissions, ['verify']);
    rolledBack(f, () => {
      access(f, ['verify', 'accept_work'], 'outer-grant');
      rolledBack(f, () => {
        access(f, ['verify', 'accept_work', 'complete_work'], 'inner-grant');
        assert.deepEqual(f.read().members.reviewer.permissions, ['verify', 'accept_work', 'complete_work']);
      });
      assert.deepEqual(f.read().members.reviewer.permissions, ['verify', 'accept_work'], 'only the inner change rolled back');
    });
    assert.deepEqual(f.read().members.reviewer.permissions, ['verify']);
    // A change that commits inside the same context is seen, and reuse stays off afterwards.
    f.store.transaction(() => access(f, ['verify', 'complete_work'], 'kept-grant'), { isolated: true });
    assert.deepEqual(f.read().members.reviewer.permissions, ['verify', 'complete_work']);
    const before = b.records;
    f.read();
    assert.ok(b.records - before > 1, 'after any write the context verifies every read from storage');
  }, { maxRecords: 1024 }));
  // The next transaction starts clean and reads what was committed.
  f.store.transaction(() => f.reusing(b => {
    assert.deepEqual(f.read().members.reviewer.permissions, ['verify', 'complete_work']);
    const afterFirst = b.records;
    f.read();
    assert.equal(b.records - afterFirst, 1, 'a fresh context with no write reuses again');
  }));
});
