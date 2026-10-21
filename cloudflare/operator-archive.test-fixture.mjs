// Synthetic Worker entry point. Never deploy this fixture.
// r59: the legacy-shape upgrade and the operator archive door (both r58),
// run inside a SQLite Durable Object (workerd) instead of node:sqlite.
import { DurableObject } from 'cloudflare:workers';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { operatorArchive } from '../server/operator-archive.mjs';
import { EVENT_TYPES as T, event } from '../src/events.js';
import { DurableDatabase, durableStorage } from './storage.mjs';

const ROOM = 'archive-room';
const body = i => `message ${i} `.padEnd(220, 'abcdefghij');
const stored = db => JSON.parse(db.prepare(`SELECT projection FROM rooms WHERE id='${ROOM}'`).get().projection);
const bytes = db => db.prepare(`SELECT LENGTH(CAST(projection AS BLOB)) AS n FROM rooms WHERE id='${ROOM}'`).get().n;
const audit = db => { try { return db.prepare('SELECT target, reactions_removed, receipt_ids_added FROM projection_shape_upgrades ORDER BY target').all().map(row => ({ ...row })); } catch { return []; } };
const legacyLeft = db => { const messages = stored(db).messages;
  return { cardMissingReceiptId: !Object.hasOwn(messages.find(m => m.id === 'card'), 'receiptId'), m1HasReactions: Object.hasOwn(messages.find(m => m.id === 'm1'), 'reactions') }; };

export class ArchiveRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.count = Number(env.ARCHIVE_MESSAGES ?? 700);
    this.db = new DurableDatabase(ctx.storage);
    this.store = new RoomStore(null, { database: this.db, storagePlatform: durableStorage });
    this.store.roomFlood = { consume: () => false };
  }
  call(input) {
    try { return { status: 200, body: operatorArchive(this.store, input, 'r59-fixture') }; }
    catch (error) { return { status: error.status ?? 500, code: error.code ?? null, message: String(error.message).slice(0, 300) }; }
  }
  async fetch(request) {
    const store = this.store, db = this.db, url = new URL(request.url), path = url.pathname;
    if (path === '/seed') {
      store.initialize([...initialRoom(ROOM), event({ type: T.MESSAGE_POSTED, actorId: 'owner', roomId: ROOM, id: 'ev-card', idempotencyKey: 'k-card',
        at: new Date(Date.UTC(2026, 9, 3)).toISOString(),
        data: { messageId: 'card', body: 'Closed', kind: 'receipt_card', claimId: 'CLAIM-1', title: 'Done', closedBy: 'Owner', deliveryMode: 'merged', evidence: 'Merged PR 1 abc. Source completion only.' } })]);
      const owner = store.issueAccessKey(ROOM, 'owner');
      for (let i = 0; i < this.count; i++) store.command(owner, ROOM, { id: `post-${i}`, type: 'message.posted', data: { messageId: `m${i}`, body: body(i) } });
      // Legacy shapes as r57 found them on prod: a receipt card without
      // receiptId, and a message still carrying a reactions map.
      const projection = stored(db);
      delete projection.messages.find(m => m.id === 'card').receiptId;
      projection.messages.find(m => m.id === 'm1').reactions = { '👀': ['owner'] };
      db.prepare(`UPDATE rooms SET projection=? WHERE id='${ROOM}'`).run(JSON.stringify(projection));
      store._projectionCache?.clear?.();
      return Response.json({ projectionBytes: bytes(db), messages: projection.messages.length, sequence: store.room(ROOM).sequence, legacy: legacyLeft(db) });
    }
    if (path === '/state') return Response.json({ legacy: legacyLeft(db), audit: audit(db), projectionBytes: bytes(db) });
    const REQUEST = { roomId: ROOM, keepNewest: Number(url.searchParams.get('keep') ?? 500), reason: 'r59 workerd check' };
    if (path === '/plan') return Response.json(this.call(REQUEST));
    if (path === '/upgrade') return Response.json({ result: store.upgradeLegacyMessageShapes(), audit: audit(db) });
    if (path === '/archive') {
      const plan = this.call(REQUEST);
      if (plan.status !== 200) return Response.json({ plan });
      const before = bytes(db);
      const done = this.call({ ...REQUEST, dryRun: false, expect: plan.body.expect });
      const after = stored(db);
      return Response.json({ plan, done, before, after: bytes(db), messagesLeft: after.messages.length });
    }
    return new Response('Not found', { status: 404 });
  }
}
export default { fetch(request, env) { return env.ROOM.getByName('archive-fixture').fetch(request); } };
