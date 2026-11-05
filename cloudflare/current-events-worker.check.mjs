import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';
import {fileURLToPath} from 'node:url';
test('actual Worker event candidates are bounded before filters and hidden backlog continues',async()=>{
 const built=await build({entryPoints:[fileURLToPath(new URL('./current-events-worker.test-fixture.mjs',import.meta.url))],bundle:true,write:false,format:'esm',platform:'neutral',external:['node:*','cloudflare:*']});
 const directory=await mkdtemp(join(tmpdir(),'current-events-'));
 const create=()=>new Miniflare({durableObjectsPersist:directory,modules:true,script:built.outputFiles[0].text,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],durableObjects:{ROOM:{className:'CurrentEventsRoom',useSQLite:true}}});let mf=create();
 const call=async path=>{const r=await mf.dispatchFetch('http://localhost'+path);const body=await r.json();if(!(process.env.CURRENT_EVENTS_BASELINE==='1'&&r.status===409&&path.includes('after=')))assert.equal(r.status,200,JSON.stringify(body));return body;};
 const samples=[];
 try{
  for(const [surface,count]of [['small',1000],['large',5000]]){
   await call(`/seed?surface=${surface}&count=${count}`);
   const cold=await call(`/read?surface=${surface}&filter=1`),warm=await call(`/read?surface=${surface}&filter=1`),hidden=await call(`/read?surface=${surface}&after=5`),late=await call(`/read?surface=${surface}&after=${count+5}`),plan=await call(`/explain?surface=${surface}`),http=await call(`/http?surface=${surface}&after=${count+5}`);
   samples.push({count,cold:cold.cost,warm:warm.cost,hidden:hidden.cost,late:late.cost,http:http.cost,httpStatus:http.status,httpPage:http.page,lateError:late.error,filterPage:cold.page,hiddenPage:hidden.page,latePage:late.page,plan:plan.plan});
  }
  await mf.dispose();mf=create();
  for(const [i,surface]of ['small','large'].entries()){const cold=await call(`/read?surface=${surface}&filter=1`),warm=await call(`/read?surface=${surface}&filter=1`);samples[i].restartCold=cold.cost;samples[i].restartWarm=warm.cost;}
  console.log('CURRENT_EVENTS_WORKER '+JSON.stringify({baseline:process.env.CURRENT_EVENTS_BASELINE==='1',samples}));
  if(process.env.CURRENT_EVENTS_BASELINE==='1')return;
  for(const s of samples){assert.equal(s.hiddenPage.events.length,0);assert.equal(s.hiddenPage.next,21);assert.equal(s.hiddenPage.hasMore,true);assert.equal(s.filterPage.events.length,0);assert.ok(s.filterPage.hasMore);assert.equal(s.latePage.events.find(x=>x.event.type==='message.posted').event.data.body,'Saved current');assert.ok(s.plan.some(x=>/SEARCH events USING INDEX sqlite_autoindex_events_2/.test(x.detail)));assert.equal(s.warm.rowsWritten,0);assert.equal(s.warm.rawRuntime.rowsWritten,0);assert.equal(s.httpStatus,200);assert.equal(s.httpPage.events.find(x=>x.event.type==='message.posted').event.data.body,'Saved current');}
  assert.equal(samples[1].warm.rowsRead,samples[0].warm.rowsRead);assert.equal(samples[1].warm.eventPayloadBytes,samples[0].warm.eventPayloadBytes); // Total metadata envelopes vary; source admission is the fixed input here.
 }finally{await mf.dispose();await rm(directory,{recursive:true,force:true});}
});
