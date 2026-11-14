import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { exportNdjsonText } from '../server/room-export.mjs';
import { EVENT_TYPES as T } from '../src/events.js';
import { STORE_SCHEMA_VERSION } from '../server/writer-fence.mjs';

const script = fileURLToPath(new URL('../scripts/replay-room-export.mjs', import.meta.url));
const privateBody = 'Synthetic private message: do not include in the replay receipt';
const integrationValue = 'synthetic receipt fixture';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'replay-receipt-'));
  const store = new RoomStore(join(directory, 'source.sqlite'));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.initialize(initialRoom());
  const key = store.issueAccessKey('commons', 'owner');
  store.command(key, 'commons', {
    id: 'synthetic-receipt-message', type: T.MESSAGE_POSTED, data: { body: privateBody }
  });
  store.transaction(() => store.db.prepare(`INSERT INTO oauth_pending_states
    (state_hash, provider, slot_token, expected_revision, verifier, expires_at, link, used, created_at)
    VALUES (?, 'google', ?, 0, ?, 9999999999999, 0, 0, 1)`)
    .run('ab'.repeat(32), integrationValue, integrationValue));
  const rows = exportNdjsonText(store.db).trimEnd().split('\n').map(line => JSON.parse(line));
  // Runtime-only source markers are explicitly skipped rather than imported.
  rows.push({ table: 'room_runtime_version', row: { singleton: 1, version: 41 } });
  return {
    rows,
    run(input) {
      const source = join(directory, 'export.ndjson');
      writeFileSync(source, input.map(row => JSON.stringify(row)).join('\n') + '\n');
      const result = spawnSync(process.execPath, [script, '--from', source, '--to', join(directory, 'restored.sqlite')], {
        encoding: 'utf8', timeout: 30000
      });
      assert.ifError(result.error);
      for (const text of [result.stdout, result.stderr]) {
        assert.equal(text.includes(privateBody), false);
        assert.equal(text.includes(directory), false);
        assert.equal(text.includes(key), false);
        assert.equal(text.includes(integrationValue), false);
      }
      return result;
    }
  };
}

for (const level of ['full', 'events-only', 'watermark-only']) {
  test(`replay CLI identifies ${level} verification without exposing source data`, t => {
    const f = fixture(t);
    let rows = f.rows;
    if (level === 'events-only') {
      rows = rows.map(row => {
        if (row.kind !== 'trailer') return row;
        const { tables: _tables, ...trailer } = row;
        return { ...trailer, version: 1 };
      });
    } else if (level === 'watermark-only') rows = rows.filter(row => row.kind !== 'trailer');
    const result = f.run(rows);
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.verified, true);
    assert.equal(receipt.contentVerification, level);
    assert.equal(receipt.trailer, level === 'watermark-only' ? 'absent' : 'verified');
    assert.deepEqual(receipt.audit, { ok: true });
    assert.equal(typeof receipt.events, 'number');
    assert.deepEqual(Object.keys(receipt).sort(), [
      'audit', 'contentVerification', 'events', 'sanitizedCells', 'skippedTables', 'trailer', 'verified', 'writeProofs'
    ].sort());
    assert.deepEqual(receipt.writeProofs, {
      sourceSchemaVersion: STORE_SCHEMA_VERSION,
      metadataProofsAdded: 0,
      historicalVerification: 'unchanged'
    });
    assert.deepEqual(receipt.sanitizedCells.oauth_pending_states, { slot_token: 1, verifier: 1 });
    assert.equal(receipt.skippedTables.room_runtime_version, 1);
    for (const count of Object.values(receipt.skippedTables)) assert.ok(Number.isSafeInteger(count) && count >= 0);
  });
}

test('replay CLI refuses digest tampering without a success receipt or private error detail', t => {
  const f = fixture(t);
  const credential = f.rows.find(row => row.table === 'credentials' && row.row?.expires_at != null);
  assert.ok(credential, 'fixture includes a credential expiry covered by the table digest');
  credential.row.expires_at += 1;
  const result = f.run(f.rows);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Replay failed verification\. The destination was not promoted\./);
  assert.equal(result.stderr.includes('Error:'), false);
});
