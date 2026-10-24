// Synthetic Worker entry point. Never deploy this fixture.
// SPILL-1: the messages-archive job tick inside a SQLite Durable Object
// (workerd) instead of node:sqlite — the worker door runs the same
// server/jobs.mjs registry in production, with the Durable Object's own
// store passed to job.run. This fixture drives the tick core
// (runMessagesArchiveTick) against a DO-backed RoomStore and exposes the
// reader surface around it, so the check can pin dry-run posture, the
// live archive, and two-leg read parity under workerd storage.
import { DurableObject } from 'cloudflare:workers';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { EVENT_TYPES as T, event } from '../src/events.js';
import { runMessagesArchiveTick, roomsOverArchiveTrigger } from '../server/messages-archive.mjs';
import { messageRepository } from '../server/message-repository.mjs';
import { DurableDatabase, durableStorage } from './storage.mjs';

const ROOM = 'archive-job-room';
const at = offset => new Date(Date.UTC(2026, 9, 4) + offset * 1000).toISOString();
const bytes = db => db.prepare(`SELECT LENGTH(CAST(projection AS BLOB)) AS n FROM rooms WHERE id='${ROOM}'`).get().n;

export class ArchiveJobRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.db = new DurableDatabase(ctx.storage);
    this.store = new RoomStore(null, { database: this.db, storagePlatform: durableStorage });
    this.store.roomFlood = { consume: () => false };
  }
  async fetch(request) {
    const store = this.store, db = this.db, url = new URL(request.url), path = url.pathname;
    if (path === '/seed') {
      const count = Number(url.searchParams.get('count') ?? 2100);
      const events = [...initialRoom(ROOM)];
      for (let i = 0; i < count; i++) {
        events.push(event({
          type: T.MESSAGE_POSTED, actorId: 'owner', roomId: ROOM, id: `seed-ev-${i}`,
          idempotencyKey: `seed-ev-${i}-key`, at: at(100 + i),
          data: { messageId: `seed-${i}`, body: `seed ${i} ` + 'x'.repeat(420) }
        }));
      }
      store.initialize(events);
      return Response.json({ projectionBytes: bytes(db), messages: store.room(ROOM).state.messages.length });
    }
    if (path === '/capture') {
      const repo = messageRepository(store, ROOM);
      const records = [...repo.records()];
      return Response.json({
        ids: records.map(m => m.id),
        first: records[0] ? { id: records[0].id, body: records[0].body } : null,
        last: records.at(-1) ? { id: records.at(-1).id, body: records.at(-1).body } : null,
        count: repo.countMetadata(() => true)
      });
    }
    if (path === '/tick') {
      const env = url.searchParams.get('live') === '1' ? { ROOM_MESSAGES_ARCHIVE_LIVE: '1' } : {};
      const result = runMessagesArchiveTick(store, { env });
      return Response.json({
        rooms: result.rooms, dryRun: result.dryRun, archived: result.archived, roomId: result.roomId,
        due: roomsOverArchiveTrigger(store).map(r => r.roomId),
        projectionBytes: bytes(db),
        messages: store.room(ROOM).state.messages.length,
        marker: Boolean(store.room(ROOM).state.messagesArchive)
      });
    }
    return new Response('Not found', { status: 404 });
  }
}
export default { fetch(request, env) { return env.ROOM.getByName('archive-job-fixture').fetch(request); } };
