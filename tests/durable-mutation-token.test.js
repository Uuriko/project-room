import test from 'node:test';
import assert from 'node:assert/strict';
import { DurableDatabase } from '../cloudflare/storage.mjs';

function fixture(execOverride) {
  const storage = { sql: { exec: execOverride ?? (() => ({ rowsRead: 0, rowsWritten: 0,
    toArray: () => [], one: () => ({ n: 0 }), *[Symbol.iterator]() {} })) }, transactionSync: fn => fn() };
  const db = new DurableDatabase(storage);
  db.isTransaction = true;
  return { db, storage };
}

test('mutation token changes for zero-row DDL through every execution method', () => {
  const { db } = fixture();
  assert.ok(db.mutationToken);
  for (const execute of [
    () => db.exec('DROP TABLE records'),
    () => db.prepare('CREATE TABLE records(id)').run(),
    () => db.prepare('DROP TABLE records').all(),
    () => db.prepare('CREATE TABLE records(id)').get(),
    () => [...db.prepare('ALTER TABLE records ADD COLUMN value').iterate()]
  ]) {
    const before = db.mutationToken;
    execute();
    assert.notEqual(db.mutationToken, before);
  }
  assert.equal(db.writeStatements, 0, 'diagnostic zero-row write count stays separate');
});

test('token is shared by storage wrappers, isolated across storage, and stable for reads', () => {
  const { db, storage } = fixture(), other = new DurableDatabase(storage), separate = fixture().db;
  assert.ok(db.mutationToken);
  assert.equal(other.mutationToken, db.mutationToken);
  assert.notEqual(separate.mutationToken, db.mutationToken);
  const before = db.mutationToken;
  db.prepare('SELECT 1').all(); db.prepare('SELECT 1').get(); [...db.prepare('SELECT 1').iterate()];
  assert.equal(db.mutationToken, before);
  other.prepare('UPDATE records SET value=1 WHERE 0').all();
  assert.notEqual(db.mutationToken, before);
  assert.equal(other.mutationToken, db.mutationToken);
});

test('invalidation happens before failed execution, including lazy iterators', () => {
  let before, called = 0;
  const { db } = fixture(() => { called++; assert.notEqual(db.mutationToken, before); throw Error('SQL failed'); });
  before = db.mutationToken;
  assert.throws(() => db.prepare('DROP TABLE missing').all(), /SQL failed/);
  before = db.mutationToken;
  const iterator = db.prepare('DROP TABLE missing').iterate();
  assert.equal(db.mutationToken, before, 'preparing an iterator does not execute SQL');
  assert.equal(called, 1);
  assert.throws(() => iterator.next(), /SQL failed/);
  assert.equal(called, 2);
});

test('observed iterator path and conservative unknown statements invalidate', () => {
  const { db } = fixture(); db.observeStatement = () => () => {};
  for (const sql of ['DROP TABLE empty', 'PRAGMA user_version=2', 'SELECT 1; DELETE FROM records']) {
    const before = db.mutationToken;
    [...db.prepare(sql).iterate()];
    assert.notEqual(db.mutationToken, before);
  }
});
