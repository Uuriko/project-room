import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAcceptanceFixture } from '../scripts/acceptance-fixture.mjs';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { createRoomServer } from '../server/http.mjs';

test('private inbox dump restores grants; room export omits them; HTTP import stays 409', async t => {
  const f = createAcceptanceFixture();
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const account = f.store.accountForMember('commons', 'owner');
  const slot = f.store.createAccountSessionSlot();
  const session = f.store.loginAccountSession(slot.token, f.store.issueAccountAccessKey(account.id), 0);
  const apply = r => f.store.inbox.apply(slot.token, r, session.sessionBinding);
  apply({ action: 'source.save', requestId: 'source', sourceId: 'source', expectedRevision: 0,
    data: { adapter: 'synthetic', sender: 'secret@example.test', recipient: 'owner@example.test', subject: 'Private subject', paragraphs: ['Selected private context', 'Unselected secret'] } });
  const grantId = apply({ action: 'source.grant', requestId: randomUUID(), sourceId: 'source', sourceRevision: 1,
    roomId: 'commons', audienceVersion: f.store.inbox.shareContext(slot.token, 'source', 'commons', session.sessionBinding).audienceVersion,
    paragraphs: [0], memberIds: ['producer'] }).receipt.grantId;
  const dump = f.store.inbox.dumpJournal();
  assert.equal(dump.format, 'project-room-private-inbox-v1');
  assert.ok(dump.tables.private_inbox_commands.length >= 1);
  const exportBlob = JSON.stringify([...f.store.exportEvents(f.keys.owner, 'commons')]);
  assert.doesNotMatch(exportBlob, new RegExp(grantId));
  assert.doesNotMatch(exportBlob, /Selected private context/);
  assert.throws(() => f.store.inbox.restoreJournal(dump), /empty tables/);
  const dir = mkdtempSync(join(tmpdir(), 'inbox-restore-'));
  const next = new RoomStore(join(dir, 'room.sqlite'));
  t.after(() => { next.close(); rmSync(dir, { recursive: true, force: true }); });
  const now = next.now();
  next.db.prepare('INSERT INTO accounts(id,active,revision,auth_epoch,origin,created_at) VALUES(?,1,0,0,?,?)').run(account.id, 'restored', now);
  next.initialize(initialRoom('commons'));
  next.inbox.restoreJournal(dump);
  assert.equal(next.db.prepare('SELECT count(*) n FROM private_inbox_commands').get().n, dump.tables.private_inbox_commands.length);
  assert.match(JSON.stringify(next.db.prepare('SELECT receipt_json FROM private_inbox_commands').all()), new RegExp(grantId));
  assert.match(JSON.stringify(dump.tables.private_inbox_commands), /Selected private context/);
  const server = createRoomServer({ store: f.store });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(r => server.close(r)); });
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/rooms/commons/import`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + f.keys.owner, Origin: `http://127.0.0.1:${server.address().port}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ events: [] })
  });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.error?.code || body.code, 'recovery_requires_maintenance');
});
