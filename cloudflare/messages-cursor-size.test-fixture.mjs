// Synthetic Worker entry point. Never deploy this fixture.
import assert from 'node:assert/strict';
import { DurableObject } from 'cloudflare:workers';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { DurableDatabase, durableStorage } from './storage.mjs';

// COUNT messages of 60,000 characters (default 40): the stored projection
// stays slim because bodies are at rest, but the replay state carries
// COUNT * 60 KB of message text: ~2.4 MB at 40 (over the documented 2 MB row
// limit) and ~9 MB at 150 (over workerd's 8 MiB + 34 B row limit since
// v1.20260925.1). It is saved in parts.
const CHARS = 60000;
const long = i => `message ${i} `.padEnd(CHARS, 'abcdefghij');

export class CursorSizeRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.count = Number(env.CURSOR_MESSAGES ?? 40);
    this.db = new DurableDatabase(ctx.storage);
    this.store = new RoomStore(null, { database: this.db, storagePlatform: durableStorage, bodiesAtRest: true });
    // Same double the Node tests use: only consume() is replaced.
    this.store.roomFlood = { consume: () => false };
  }
  async fetch(request) {
    const store = this.store, COUNT = this.count, path = new URL(request.url).pathname;
    if (path === '/seed') {
      store.initialize(initialRoom('big-room'));
      const owner = store.issueAccessKey('big-room', 'owner');
      for (let i = 0; i < COUNT; i++) store.command(owner, 'big-room', { id: `post-${i}`, type: 'message.posted', data: { messageId: `m${i}`, body: long(i) } });
      const projection = this.db.prepare("SELECT LENGTH(CAST(projection AS BLOB)) AS n FROM rooms WHERE id='big-room'").get().n;
      assert.ok(projection < 1024 * 1024, `slim projection is ${projection} bytes`);
      return Response.json({ projection });
    }
    if (path === '/backfill') {
      let result = null;
      for (let i = 0; i < 50 && !result?.done; i++) result = store.backfillMessages({ limit: 400 });
      assert.equal(result.done, true);
      assert.equal(store.checkMessagesParity().checked, 1);
      const parts = this.db.prepare("SELECT LENGTH(CAST(json AS BLOB)) AS n FROM messages_backfill_state WHERE room_id='big-room' ORDER BY part").all().map(row => row.n);
      assert.ok(parts.length >= 2, `${parts.length} state parts`);
      const cursor = Math.max(...parts);
      const stateBytes = parts.reduce((sum, n) => sum + n, 0);
      const rows = this.db.prepare("SELECT message_id, body FROM messages WHERE room_id='big-room' ORDER BY seq").all();
      assert.equal(rows.length, COUNT);
      rows.forEach((row, i) => assert.equal(row.body, long(i)));
      return Response.json({ certified: true, cursorBytes: cursor, stateBytes, parts: parts.length, rows: rows.length });
    }
    return new Response('Not found', { status: 404 });
  }
}
export default { fetch(request, env) { return env.ROOM.getByName('cursor-size-fixture').fetch(request); } };
