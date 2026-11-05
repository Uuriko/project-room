import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

const fixture = `
import { DurableDatabase } from './storage.mjs';
import { createDurableWorkClaimRegistry, workClaimSchema, workClaimInboxIndexSchema } from '../server/work-claim-sqlite.mjs';
// Isolate registry SQL costs from the RoomStore writer-fence setup.
// Node tests separately exercise the real atomic RoomStore migration.
export class InboxTestRoom {
 constructor(ctx) { this.ctx=ctx; this.db=new DurableDatabase(ctx.storage); this.db.isTransaction=true; }
 async fetch(request) {
  const db=this.db, registry=createDurableWorkClaimRegistry(db);
  if(new URL(request.url).pathname==='/setup') {
   db.exec(workClaimSchema);
   this.ctx.storage.transactionSync(()=>{
    for(let i=0;i<1000;i++) registry.set('room',{id:'c'+i,state:'in_progress',owner:i<3?'me':'other',tags:i===999?['rev-me']:[],history:[{note:'x'.repeat(12000)}]});
   });
   this.ctx.storage.transactionSync(()=>db.exec(workClaimInboxIndexSchema));
  }
  const before=db.rowsRead;
  const assignments=[...registry.inboxCandidates('room','me')];
  const reviews=[...registry.inboxCandidates('room','me',{review:true})];
  const indexedRowsRead=db.rowsRead-before;
  const oldBefore=db.rowsRead;
  const all=registry.list('room');
  return Response.json({assignments:assignments.map(x=>x.id),reviews:reviews.map(x=>x.id), indexedRowsRead, fullRowsRead:db.rowsRead-oldBefore,
   compactBytes:JSON.stringify([...assignments,...reviews]).length,fullBytes:JSON.stringify(all).length});
 }
}
export default {fetch(request,env){return env.ROOM.get(env.ROOM.idFromName('test')).fetch(request)}};
`;

test('actual Workers SQLite uses inbox indexes and preserves discovery after eviction', async () => {
  const bundled = await build({ stdin: { contents: fixture, resolveDir: fileURLToPath(new URL('.', import.meta.url)), sourcefile: 'inbox-claim-fixture.mjs' }, bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['node:*', 'cloudflare:*'] });
  const persistence = await mkdtemp(join(tmpdir(), 'inbox-claim-worker-'));
  const config = { modules: true, script: bundled.outputFiles[0].text, compatibilityDate: '2026-07-30', compatibilityFlags: ['nodejs_compat'], durableObjects: { ROOM: { className: 'InboxTestRoom', useSQLite: true } }, durableObjectsPersist: persistence };
  let worker = new Miniflare(config);
  try {
    const response = await worker.dispatchFetch('https://example.test/setup');
    assert.equal(response.status, 200, await response.clone().text());
    const before = await response.json();
    assert.deepEqual(before.assignments, ['c0', 'c1', 'c2']);
    assert.deepEqual(before.reviews, ['c999']);
    assert.ok(before.indexedRowsRead < 30, JSON.stringify(before));
    assert.ok(before.fullRowsRead >= 1000, JSON.stringify(before));
    assert.ok(before.compactBytes * 100 < before.fullBytes, JSON.stringify(before));
    await worker.dispose(); worker = new Miniflare(config);
    const restarted = await worker.dispatchFetch('https://example.test/read');
    assert.equal(restarted.status, 200, await restarted.clone().text());
    assert.deepEqual(await restarted.json(), before);
    console.log('inbox-claim-worker-evidence', JSON.stringify(before));
  } finally { await worker.dispose(); await rm(persistence, { recursive: true, force: true }); }
});
