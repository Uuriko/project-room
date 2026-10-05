// Synthetic local fixture only. Never deploy this entrypoint.
import assert from 'node:assert/strict';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { EVENT_TYPES as T } from '../src/events.js';
import { DurableDatabase, durableStorage, durableFenceDefinitions } from './storage.mjs';

function finish(store) {
  for (let i = 0; i < 20; i++) if (store.backfillMessages({ limit: 400 }).done) return;
  assert.fail('Small synthetic replay did not finish');
}

export class MessageFidelityRoom {
  constructor(ctx) {
    this.db = new DurableDatabase(ctx.storage);
    this.store = new RoomStore(null, { database: this.db, storagePlatform: durableStorage });
  }
  async fetch(request) {
    const store = this.store, path = new URL(request.url).pathname;
    if (path === '/seed-v37') {
      store.initialize(initialRoom('fidelity'));
      const owner = store.issueAccessKey('fidelity', 'owner');
      store.command(owner, 'fidelity', { id: 'post', type: T.MESSAGE_POSTED, data: { messageId: 'message', body: 'synthetic retained text' } });
      finish(store);
      assert.equal(store.checkMessagesParity().checked, 1);
      // Construct an actual v37 SQLite/permit/fence shape after provisioning.
      // This is test-only migration input; all production behavior below uses
      // the shared RoomStore and real Durable Object adapter.
      store.transaction(() => {
        for (const row of this.db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name GLOB 'writer_v38_*'").all()) this.db.exec(`DROP TRIGGER ${row.name}`);
        this.db.exec('ALTER TABLE messages DROP COLUMN record_json');
        for (const { sql } of durableFenceDefinitions(37)) this.db.exec(sql);
        this.db.storage.sql.exec('DROP TABLE room_writer_permit');
        this.db.storage.sql.exec('CREATE TABLE room_writer_permit (singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL CHECK(version IN (0,37)))');
        this.db.storage.sql.exec('INSERT INTO room_writer_permit VALUES(1,37)');
        durableStorage.setVersion(this.db, 37);
      });
      assert.throws(() => store.createAccount('old-writer'), /reconciliation|unsupported database writer/);
      return Response.json({ owner });
    }
    if (path === '/resume-v38') {
      const { owner } = await request.json();
      assert.equal(durableStorage.version(this.db), 38);
      assert.equal(this.db.prepare("SELECT record_json FROM messages WHERE message_id='message'").get().record_json, null);
      assert.equal(store.checkMessagesParity().checked, 0);
      finish(store);
      assert.equal(store.checkMessagesParity().checked, 1);
      assert.equal(JSON.parse(this.db.prepare("SELECT record_json FROM messages WHERE message_id='message'").get().record_json).body, 'synthetic retained text');
      store.command(owner, 'fidelity', { id: 'edit', type: T.MESSAGE_EDITED, data: { messageId: 'message', body: 'synthetic edited text', expectedMessageRevision: 0 } });
      finish(store);
      assert.equal(store.checkMessagesParity().checked, 1);
      const record = JSON.parse(this.db.prepare("SELECT record_json FROM messages WHERE message_id='message'").get().record_json);
      assert.equal(record.revision, 1);
      assert.equal(Object.hasOwn(record, 'editHistory'), false);
      store.command(owner, 'fidelity', { id: 'delete', type: T.MESSAGE_DELETED, data: { messageId: 'message', expectedMessageRevision: 1 } });
      const tombstone = JSON.parse(this.db.prepare("SELECT record_json FROM messages WHERE message_id='message'").get().record_json);
      assert.equal(tombstone.body, null);
      assert.equal(tombstone.redacted, true);
      assert.equal(this.db.prepare("SELECT state_json FROM messages_backfill_cursor WHERE room_id='fidelity'").get().state_json, null);
      finish(store);
      assert.equal(store.checkMessagesParity().checked, 1);
      return Response.json({ migrated: true, recordPreserved: true, deleted: true });
    }
    return new Response('Not found', { status: 404 });
  }
}
export default { fetch(request, env) { return env.ROOM.getByName('message-fidelity-fixture').fetch(request); } };
