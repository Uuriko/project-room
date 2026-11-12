import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { writeDoc, getDoc } from '../server/room-docs.mjs';
import { exportNdjsonText, replayNdjson } from '../server/room-export.mjs';
import { createOperatorPurge } from '../server/operator-purge.mjs';

test('document revisions survive full export/replay and room purge removes only target docs', t => {
  const dir = mkdtempSync(join(tmpdir(), 'docs-replay-'));
  const store = new RoomStore(':memory:');
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  for (const roomId of ['docs-purge', 'docs-retain']) {
    store.initialize(initialRoom(roomId));
    writeDoc(store, { roomId, docId: 'spec', title: 'Spec', body: 'original ' + roomId, baseRev: 0, author: 'owner' });
    writeDoc(store, { roomId, docId: 'spec', title: 'Spec', body: 'updated ' + roomId, baseRev: 1, author: 'owner' });
  }
  const filename = join(dir, 'restored.sqlite');
  replayNdjson(exportNdjsonText(store.db), filename);
  const restored = new RoomStore(filename);
  try {
    assert.equal(getDoc(restored.db, { roomId: 'docs-purge', docId: 'spec', rev: 1 }).body, 'original docs-purge');
    assert.equal(getDoc(restored.db, { roomId: 'docs-retain', docId: 'spec' }).rev, 2);
  } finally { restored.close(); }
  const purge = createOperatorPurge(store);
  const plan = purge.plan({ targets: [{ kind: 'room', id: 'docs-purge' }], reason: 'Remove synthetic fixture', allowActiveMembers: true }, 'plan-docs');
  purge.execute({ planId: plan.planId, confirmToken: plan.confirmToken }, 'purge-docs');
  assert.equal(getDoc(store.db, { roomId: 'docs-purge', docId: 'spec' }), null);
  assert.equal(getDoc(store.db, { roomId: 'docs-purge', docId: 'spec', rev: 1 }), null);
  assert.equal(getDoc(store.db, { roomId: 'docs-retain', docId: 'spec' }).rev, 2);
});
