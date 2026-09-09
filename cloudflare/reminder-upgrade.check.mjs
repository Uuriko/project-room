import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { createAcceptanceFixture } from '../scripts/acceptance-fixture.mjs';
import { durableFenceDefinitions } from './storage.mjs';

test('real Workers v7→v22 migration fences a cached legacy adapter, rolls back failures and survives restart', { timeout: 90000 }, async () => {
  const fixture = createAcceptanceFixture(), db = fixture.store.db;
  const persistence = mkdtempSync(join(tmpdir(), 'room-reminder-upgrade-'));
  const schema = db.prepare("SELECT name,type,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT GLOB 'writer_v*' AND name NOT GLOB 'private_reminder*' AND name NOT GLOB 'private_inbox*' AND name NOT GLOB 'private_email*' AND name NOT GLOB 'agent_connection*' ORDER BY rowid").all();
  const tables = schema.filter(row => row.type === 'table').map(row => row.name);
  const rows = tables.flatMap(table => db.prepare(`SELECT * FROM ${table}`).all().map(row => ({ table, columns: Object.keys(row), values: Object.values(row) })));
  const account = fixture.store.accountForMember('commons', 'owner').id;
  const bundled = await build({ entryPoints: [fileURLToPath(new URL('./reminder-upgrade.test-fixture.mjs', import.meta.url))], bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['node:*', 'cloudflare:*'] });
  const config = { modules: true, script: bundled.outputFiles[0].text, compatibilityDate: '2026-07-30', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { ROOM: { className: 'ReminderUpgradeRoom', useSQLite: true } }, durableObjectsPersist: persistence,
    bindings: { SCHEMA: JSON.stringify([...schema.map(row => row.sql), ...durableFenceDefinitions(7).map(def => def.sql)]), ROWS: JSON.stringify(rows), TABLES: JSON.stringify(tables), ACCOUNT: account, TOKEN: fixture.keys.owner } };
  let mf = new Miniflare(config);
  const call = async path => { const result = await mf.dispatchFetch(`http://localhost${path}`); assert.equal(result.status, 200, await result.clone().text()); return result.json(); };
  try {
    assert.deepEqual(await call('/initialize'), { version: 7 });
    assert.deepEqual(await call('/failed-upgrade'), { rolledBack: true });
    assert.deepEqual(await call('/upgrade'), { migrated: true, legacyRejected: true, reminders: 1 });
    await call('/initialize?case=corrupt'); assert.deepEqual(await call('/corrupt?case=corrupt'), { rejected: true });
    await mf.dispose(); mf = new Miniflare(config);
    assert.deepEqual(await call('/restart'), { recovered: true });
  } finally { await mf.dispose(); fixture.store.close(); rmSync(fixture.directory, { recursive: true, force: true }); rmSync(persistence, { recursive: true, force: true }); }
});
