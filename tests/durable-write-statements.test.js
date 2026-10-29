import test from 'node:test';
import assert from 'node:assert/strict';
import { DurableDatabase, isWriteSql as durableIsWriteSql } from '../cloudflare/storage.mjs';
import { isWriteSql } from '../server/sql-write-classification.mjs';

test('Durable storage uses the shared SQL classification implementation', () => {
  assert.equal(durableIsWriteSql, isWriteSql);
});

test('isWriteSql counts every write shape and no plain read', () => {
  for (const sql of ['INSERT INTO t VALUES(1)', '  update t set a=1', 'DELETE FROM t', 'REPLACE INTO t VALUES(1)',
    'INSERT OR REPLACE INTO t VALUES(1)', 'WITH a AS (SELECT 1) INSERT INTO t SELECT * FROM a']) assert.equal(isWriteSql(sql), true, sql);
  for (const sql of ['SELECT 1', "SELECT * FROM t WHERE note='update'", 'SELECT MIN(seq) FROM messages']) assert.equal(isWriteSql(sql), false, sql);
});

// Codex review of 259f812a: these shapes must count as writes, not slip
// through as reads. Unknown statement kinds count too (over-count is safe).
test('isWriteSql is a read allowlist: commented, multi-statement, PRAGMA and DDL count as writes', () => {
  for (const sql of ['-- explanation\nINSERT INTO t VALUES(1)', '/* explanation */ UPDATE t SET a=1',
    'SELECT 1; DELETE FROM t', 'SELECT 1;DELETE FROM t;', '/* unterminated SELECT 1', 'PRAGMA user_version = 3',
    'CREATE TABLE IF NOT EXISTS t(a)', 'DROP TABLE t', 'WITH a AS (SELECT 1) DELETE FROM t WHERE x IN a',
    "SELECT ';' AS s; UPDATE t SET a=1"]) assert.equal(isWriteSql(sql), true, sql);
  for (const sql of ['-- why\nSELECT 1', '/* a */ /* b */\n  SELECT 1', 'SELECT 1;', '  select count(*) from t  ;  ',
    'WITH a AS (SELECT 1) SELECT * FROM a']) assert.equal(isWriteSql(sql), false, sql);
});

test('writeStatements counts writes that changed rows; reads never touch rowsWritten', () => {
  let readsOfWriteCounter = 0, written = 1;
  const exec = sql => ({ rowsRead: 1, get rowsWritten() { if (!/^\s*(INSERT|UPDATE|DELETE|REPLACE)/i.test(sql)) throw new Error('read touched rowsWritten'); readsOfWriteCounter++; return written; },
    toArray: () => [{ n: 0 }], one: () => ({ n: 1 }), *[Symbol.iterator]() { yield 1; } });
  const db = new DurableDatabase({ sql: { exec }, transactionSync: fn => fn() });
  db.isTransaction = true;
  db.prepare('SELECT 1').get(); [...db.prepare('SELECT 1').iterate()];
  assert.equal(db.writeStatements, 0); assert.equal(readsOfWriteCounter, 0);
  db.prepare('INSERT INTO t VALUES(1)').run(); db.prepare('UPDATE t SET a=1').all(); [...db.prepare('DELETE FROM t').iterate()]; db.exec('INSERT INTO t VALUES(2)');
  assert.equal(db.writeStatements, 4);
  // A guarded UPDATE that matched nothing (agent activation after the first request) does not count.
  written = 0; db.prepare('UPDATE agent_identities SET activated_at=? WHERE activated_at IS NULL').run(1);
  assert.equal(db.writeStatements, 4);
  // An unknown count is treated as a write.
  const unknown = new DurableDatabase({ sql: { exec: () => ({ rowsRead: 0, get rowsWritten() { throw new Error('unavailable'); }, toArray: () => [], one: () => ({ n: 0 }) }) }, transactionSync: fn => fn() });
  unknown.isTransaction = true; unknown.prepare('UPDATE t SET a=1').run();
  assert.equal(unknown.writeStatements, 1);
});
