// Run explicitly; keep Cloudflare tooling out of the Node-only test job.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Miniflare } from 'miniflare';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { writerFenceDefinitions, WRITER_FUNCTION } from '../server/writer-fence.mjs';

const script = await readFile(new URL('./compatibility-worker.mjs', import.meta.url), 'utf8');
const store = new RoomStore(':memory:');
store.initialize(initialRoom('compatibility', 'owner'));
// Extract schema from the REAL current store, not a hand-maintained copy.
const nativeSchema = store.db.prepare("SELECT name,type,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY rowid").all();
const fences = new Map(writerFenceDefinitions.map(({ name, sql }) => [name, sql]));
const schema = nativeSchema.map(row => {
  if (!fences.has(row.name)) return row.sql;
  assert.equal(row.sql, fences.get(row.name));
  return row.sql.replace(`${WRITER_FUNCTION}()`, '(SELECT version FROM room_runtime_version WHERE singleton=1)');
});
const fixture = [];
for (const row of nativeSchema.filter(row => row.type === 'table')) {
  assert.match(row.name, /^[a-z_]+$/);
  for (const value of store.db.prepare(`SELECT * FROM ${row.name}`).all()) {
    fixture.push({ table: row.name, columns: Object.keys(value), values: Object.values(value) });
  }
}
const expected = store.db.prepare('SELECT id,sequence,projection FROM rooms ORDER BY id').all().map(row => ({ ...row }));
store.close();

const options = {
  modules: true, script, compatibilityDate: '2026-07-30',
  durableObjects: { ROOM: { className: 'CompatibilityRoom', useSQLite: true } },
  bindings: { SCHEMA: JSON.stringify(schema), FIXTURE: JSON.stringify(fixture) },
};
async function request(mf, path) {
  const response = await mf.dispatchFetch(`http://localhost${path}`);
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return JSON.parse(text);
}

test('current Node-specific assumptions are explicitly incompatible', async () => {
  const mf = new Miniflare(options);
  try {
    const results = await request(mf, '/native');
    for (const result of results.slice(0, 3)) {
      assert.equal(result.supported, false, JSON.stringify(result));
      console.log(`${result.name}: ${result.error}`);
    }
    assert.equal(results[3].result.foreign_keys, 1);
  } finally { await mf.dispose(); }
});

test('explicitly adapted schema preserves rollback, foreign keys and version fences across runtime restart', async () => {
  const persistence = await mkdtemp(join(tmpdir(), 'project-room-cf-compat-'));
  const config = { ...options, durableObjectsPersist: persistence };
  let mf = new Miniflare(config);
  try {
    const initialized = await request(mf, '/initialize');
    assert.ok(initialized.tables >= 17);
    const result = await request(mf, '/prove');
    assert.equal(result.rollbackClean, true);
    assert.equal(result.foreignKey.supported, false);
    assert.match(result.foreignKey.error, /FOREIGN KEY/i);
    for (const guard of [result.writeGuard, result.missingGuard]) {
      assert.equal(guard.supported, false);
      assert.match(guard.error, /unsupported database writer/);
    }
    assert.deepEqual(result.integrity, []);
    assert.deepEqual(result.rooms, expected);
    assert.ok(result.eventCount > 0);
    await mf.dispose();
    mf = new Miniflare(config);
    assert.deepEqual(await request(mf, '/read'), expected);
    console.log('Persisted synthetic runtime evidence retained at', persistence);
  } finally { await mf.dispose(); }
});
