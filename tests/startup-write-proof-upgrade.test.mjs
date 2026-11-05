import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createRuntimePackage } from '../scripts/runtime-package.mjs';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { projectionDigest } from '../server/write-integrity.mjs';

// Genuine v43 writers: one has historical content baselines, the other
// predates them. Lowering user_version on a new database cannot test this.
const sources = {
  strong: '4b060ff07ce0bbedb3eae216e40825315cc9eff5',
  weak: '72a7d6e4d7e67e866b6314c2218e8a2a0cac8fc5',
};
const snapshot = db => ({
  version: db.prepare('PRAGMA user_version').get().user_version,
  schema: db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').all(),
  projection: db.prepare("SELECT projection FROM rooms WHERE id='commons'").get().projection,
  proofs: db.prepare('SELECT * FROM integrity_room_state ORDER BY room_id').all(),
});

for (const variant of ['intact', 'corrupt', 'weak']) {
  test(`genuine v43 ${variant} write-proof migration is atomic across reopen`, async t => {
    const root = mkdtempSync(join(tmpdir(), 'startup-proof-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const runtime = join(root, 'prior');
    createRuntimePackage({ repository: process.cwd(), commit: sources[variant === 'weak' ? 'weak' : 'strong'], destination: runtime });
    const { RoomStore: OldStore } = await import(pathToFileURL(join(runtime, 'server/store.mjs')));
    const filename = join(root, 'room.sqlite');
    const old = new OldStore(filename);
    let token, before;
    try {
      old.initialize(initialRoom());
      token = old.issueAccessKey('commons', 'owner');
      if (variant !== 'weak') {
        await old.verifyRoomIntegrity({ yieldBetween: async () => {} });
        await old.verifyRoomIntegrity({ yieldBetween: async () => {} });
        assert.match(old.db.prepare("SELECT projection_hash FROM integrity_room_state WHERE room_id='commons'").get().projection_hash, /^[a-f0-9]{64}$/);
      }
      if (variant === 'corrupt') {
        const raw = old.db.prepare("SELECT projection FROM rooms WHERE id='commons'").get().projection;
        const changed = raw.replace('Commons', 'Xommons');
        assert.notEqual(changed, raw);
        old.db.prepare("UPDATE rooms SET projection=? WHERE id='commons'").run(changed);
      }
      before = snapshot(old.db);
      assert.equal(before.version, 43);
    } finally { old.close(); }

    if (variant === 'corrupt') {
      for (let attempt = 0; attempt < 2; attempt++) {
        assert.throws(() => new RoomStore(filename, { integrity: attempt ? 'deferred' : 'eager' }), /projection_corrupt: legacy content does not match its baseline/);
        const inspect = new DatabaseSync(filename, { readOnly: true });
        try { assert.deepEqual(snapshot(inspect), before, 'refusal preserves schema, projection, and proofs'); }
        finally { inspect.close(); }
      }
      return;
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      const current = new RoomStore(filename, { integrity: attempt ? 'deferred' : 'eager' });
      try {
        const row = current.db.prepare("SELECT projection FROM rooms WHERE id='commons'").get();
        const proof = current.db.prepare("SELECT metadata_hash,projection_hash FROM integrity_room_state WHERE room_id='commons'").get();
        assert.equal(proof.metadata_hash, projectionDigest(row.projection));
        if (variant === 'weak') assert.equal(proof.projection_hash, null, 'migration cannot invent historical verification');
        const id = `after-upgrade-${attempt}`;
        current.command(token, 'commons', { id, type: 'message.posted', data: { messageId: id, body: 'Preserved Unicode: café 🧪' } });
        assert.equal(current.room('commons').state.messages.at(-1).body, 'Preserved Unicode: café 🧪');
      } finally { current.close(); }
    }
  });
}
