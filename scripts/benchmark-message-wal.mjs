// Local synthetic disk benchmark. No network, credentials or production data.
// Equal command sequences in independent databases; alternating mode order.
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { event } from '../src/events.js';

const sizes = process.argv.slice(2).map(Number);
if (!sizes.length) sizes.push(1000, 10000);
if (sizes.some(n => !Number.isSafeInteger(n) || n < 10 || n > 100000)) throw new Error('Choose message counts between 10 and 100000');
const percentile = (rows, key, p) => rows.map(row => row[key]).sort((a,b)=>a-b)[Math.ceil(rows.length*p)-1];
const results = [];
for (const size of sizes) {
  const directory = mkdtempSync(join(tmpdir(), 'message-wal-'));
  const stores = new Map();
  try {
    const events = initialRoom();
    for (let i=0;i<size;i++) events.push(event({id:`seed-${i}`,idempotencyKey:`seed-${i}`,roomId:'commons',actorId:'owner',type:'message.posted',at:new Date(Date.UTC(2026,0,1)+i*1000).toISOString(),data:{messageId:`m-${i}`,body:`Settled record ${i}. ${'content '.repeat(64)}`}}));
    for (const mode of ['inline', 'references']) {
      const path = join(directory, `${mode}.sqlite`);
      const store = new RoomStore(path, {messageProjectionWindow:8,messageEntityProjection:mode==='references'});
      stores.set(mode, {store,path,samples:[]});
      store.initialize(events);store.roomFlood={consume(){}};
      const fixture=stores.get(mode);fixture.token=store.issueAccessKey('commons','owner');
      while(!store.backfillMessages({limit:1000}).done) {}
      if(!store.checkMessagesParity().ok)throw new Error('Fixture parity failed');
      store.archiveMessages('commons',{keepNewest:8,dryRun:false});
      store.db.exec('PRAGMA wal_autocheckpoint=0');
    }
    for(let i=0;i<14;i++) for(const mode of i%2?['inline','references']:['references','inline']) {
      const {store,path,token,samples}=stores.get(mode);
      const checkpoint=store.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
      if(checkpoint.busy)throw new Error('Benchmark WAL checkpoint busy');
      const start=performance.now();
      store.command(token,'commons',{id:`edit-${i}`,type:'message.edited',data:{messageId:`m-${size-1}`,body:`Correction ${i}. ${'content '.repeat(64)}`,expectedMessageRevision:i}});
      const ms=performance.now()-start;
      const walBytes=statSync(`${path}-wal`).size;
      if(i>=2)samples.push({ms,walBytes,projectionBytes:Buffer.byteLength(store.db.prepare("SELECT projection FROM rooms WHERE id='commons'").get().projection)});
    }
    results.push({messages:size,modes:Object.fromEntries([...stores].map(([mode,{store,samples}])=>{
      if(!store.checkMessagesParity().ok)throw new Error('Post-benchmark parity failed');
      return [mode,{samples:samples.length,medianMs:percentile(samples,'ms',.5),p95Ms:percentile(samples,'ms',.95),medianWalBytes:percentile(samples,'walBytes',.5),maxWalBytes:Math.max(...samples.map(x=>x.walBytes)),finalProjectionBytes:samples.at(-1).projectionBytes}];
    }))});
  } finally {
    for(const {store} of stores.values())store.close();
    rmSync(directory,{recursive:true,force:true});
  }
}
console.log(JSON.stringify({workload:'committed recent edits; equal revisions in separate databases, alternating modes, two warmups; WAL truncated outside timed command; synchronous FULL',runtime:process.version,platform:process.platform,results},null,2));
