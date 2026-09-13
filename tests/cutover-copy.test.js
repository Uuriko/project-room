import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { cutoverCopy } from '../scripts/cutover-copy.mjs';
import { STORE_SCHEMA_VERSION } from '../server/writer-fence.mjs';

test('copy-first cutover opens dest at schema 33 and refuses live object id', t => {
  const dir = mkdtempSync(join(tmpdir(), 'cutover-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const src = join(dir, 'source.sqlite');
  const dest = join(dir, 'dest.sqlite');
  const store = new RoomStore(src);
  store.initialize(initialRoom('commons'));
  store.close();
  const result = cutoverCopy(src, dest);
  assert.equal(result.ok, true);
  assert.equal(result.schema, STORE_SCHEMA_VERSION);
  const copy = new RoomStore(dest);
  t.after(() => copy.close());
  assert.ok(copy.db.prepare('SELECT 1 FROM rooms WHERE id=?').get('commons'));
  assert.throws(() => cutoverCopy(src, dest), /Dest must not exist/);
  assert.throws(() => cutoverCopy('relative.sqlite', dest), /absolute/);
  assert.throws(() => cutoverCopy(join(dir, 'a5f2dca.sqlite'), join(dir, 'out.sqlite')), /a5f2dca/);
});
