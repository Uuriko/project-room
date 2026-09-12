// Explicit synthetic storage qualification, not an attachment feature test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Miniflare } from 'miniflare';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const sizes = [0, 1, 256, 65536, 1048576];

test('Node SQLite binary storage: exact bytes, rollback, conflict, restart and deletion', () => {
  const dir = mkdtempSync(join(tmpdir(), 'room-file-node-'));
  const path = join(dir, 'files.sqlite');
  let db = new DatabaseSync(path);
  try {
    db.exec('CREATE TABLE files (id TEXT PRIMARY KEY, bytes BLOB NOT NULL)');
    const hashes = new Map();
    for (const size of sizes) {
      const bytes = randomBytes(size), id = String(size);
      db.prepare('INSERT INTO files VALUES (?, ?)').run(id, bytes);
      const actual = db.prepare('SELECT bytes FROM files WHERE id=?').get(id).bytes;
      assert.equal(actual.byteLength, size);
      assert.equal(digest(actual), digest(bytes));
      hashes.set(id, digest(bytes));
    }
    db.exec('BEGIN');
    db.prepare('INSERT INTO files VALUES (?, ?)').run('rollback', randomBytes(256));
    db.exec('ROLLBACK');
    assert.equal(db.prepare('SELECT 1 FROM files WHERE id=?').get('rollback'), undefined);
    assert.throws(() => db.prepare('INSERT INTO files VALUES (?, ?)').run('256', randomBytes(3)));
    db.close(); db = new DatabaseSync(path);
    for (const [id, hash] of hashes) assert.equal(digest(db.prepare('SELECT bytes FROM files WHERE id=?').get(id).bytes), hash);
    db.prepare('DELETE FROM files WHERE id=?').run('1048576');
    db.close(); db = new DatabaseSync(path);
    assert.equal(db.prepare('SELECT 1 FROM files WHERE id=?').get('1048576'), undefined);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('Worker SQLite binary storage: exact bytes, rollback, conflict, restart and deletion', { timeout: 60000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'room-file-worker-'));
  const config = {
    modules: true,
    script: readFileSync(new URL('./attachment-storage.test-fixture.mjs', import.meta.url), 'utf8'),
    compatibilityDate: '2026-07-30',
    durableObjects: { FILES: { className: 'AttachmentStorageExperiment', useSQLite: true } },
    durableObjectsPersist: dir
  };
  let mf = new Miniflare(config);
  const call = (id, options) => mf.dispatchFetch('http://localhost/' + id, options);
  const hashes = new Map();
  try {
    for (const size of sizes) {
      const bytes = randomBytes(size), id = String(size);
      const write = await call(id, { method: 'PUT', body: bytes });
      assert.equal(write.status, 201, await write.text());
      const read = await call(id);
      assert.equal(read.status, 200);
      const actual = Buffer.from(await read.arrayBuffer());
      assert.equal(actual.byteLength, size);
      assert.equal(digest(actual), digest(bytes));
      hashes.set(id, digest(bytes));
    }
    assert.equal((await call('rollback', { method: 'PUT', headers: { 'x-test-rollback': '1' }, body: randomBytes(256) })).status, 409);
    assert.equal((await call('rollback')).status, 404);
    assert.equal((await call('256', { method: 'PUT', body: randomBytes(3) })).status, 409);
    await mf.dispose(); mf = new Miniflare(config);
    for (const [id, hash] of hashes) {
      const read = await call(id);
      assert.equal(read.status, 200);
      assert.equal(digest(Buffer.from(await read.arrayBuffer())), hash);
    }
    assert.equal((await call('1048576', { method: 'DELETE' })).status, 204);
    await mf.dispose(); mf = new Miniflare(config);
    assert.equal((await call('1048576')).status, 404);
  } finally { await mf.dispose(); rmSync(dir, { recursive: true, force: true }); }
});
