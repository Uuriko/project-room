import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
test('actual Worker HTTP work source pages stay bounded across excluded backlog and restart',{timeout:120000},async()=>{
 const built=await build({entryPoints:[fileURLToPath(new URL('./current-work-list-worker.test-fixture.mjs',import.meta.url))],bundle:true,write:false,format:'esm',platform:'neutral',external:['node:*','cloudflare:*']});
 const directory=await mkdtemp(join(tmpdir(),'current-work-list-'));
 const create=()=>new Miniflare({modules:true,script:built.outputFiles[0].text,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],durableObjectsPersist:directory,durableObjects:{ROOM:{className:'CurrentWorkListProbe',useSQLite:true}}});let mf=create();
 const call=async path=>{const response=await mf.dispatchFetch('http://localhost'+path),body=await response.json();assert.equal(response.status,200,JSON.stringify(body));assert.equal(body.cost.unknown,0);assert.equal(body.rawRuntime.unknown,0);return body;};
 const costs=[];
 try{
  for(const count of [32,128]){
   await call('/seed?count='+count+'&surface='+count);
   const first=await call('/list?focus=needs_me&surface='+count),warm=await call('/list?focus=needs_me&surface='+count);
   assert.equal(first.result.status,200,JSON.stringify(first));assert.equal(warm.result.status,200);
   assert.deepEqual(warm.result.page.work.map(item=>item.id),['task-'+String(count-1).padStart(4,'0')]);assert.deepEqual(warm.result.page.replyRequests.map(item=>item.id),['request-12']);assert.equal(warm.result.page.page.hasMore,false);assert.equal(warm.result.page.selection.source,'addressed-role-indexes');
   assert.equal(warm.cost.rowsWritten,0);assert.equal(warm.rawRuntime.rowsWritten,0);
   let pointer=warm.result.page.page.nextRead,pages=1;const ids=warm.result.page.work.map(item=>item.id),requests=warm.result.page.replyRequests.map(item=>item.id);
   while(pointer){const query=new URLSearchParams({...pointer.arguments,surface:count});const page=await call('/list?'+query);assert.equal(page.result.status,200,JSON.stringify(page));const value=page.result.page;ids.push(...value.work.map(w=>w.id));requests.push(...value.replyRequests.map(r=>r.id));assert.ok(value.selection.examinedWork<=4&&value.selection.examinedRequests<=4);assert.equal(page.cost.rowsWritten,0);pointer=value.page.nextRead;assert.ok(++pages<=40);}
   assert.deepEqual(ids,['task-'+String(count-1).padStart(4,'0')]);assert.deepEqual(requests,['request-12']);
   costs.push({count,warm:warm.cost,rawRuntime:warm.rawRuntime,pages});
  }
  assert.ok(costs.every(x=>x.warm.rowsRead<1024));
  assert.ok(Math.abs(costs[0].warm.rowsRead-costs[1].warm.rowsRead)<=16,'physical index height may differ; no excluded-record refill');
  await mf.dispose();mf=create();
  const cold=await call('/list?focus=needs_me&surface=128');assert.equal(cold.result.status,200);assert.equal(cold.result.page.page.hasMore,false);assert.deepEqual(cold.result.page.work.map(item=>item.id),['task-0127']);assert.deepEqual(cold.result.page.replyRequests.map(item=>item.id),['request-12']);assert.equal(cold.cost.rowsWritten,0);
  console.log('CURRENT_WORK_LIST_WORKER '+JSON.stringify({costs,cold:cold.cost,coldNative:cold.rawRuntime,sourceWindow:4,filteredEmptyIsComplete:false,syntheticRooms:true,historyCertified:false}));
 }finally{await mf.dispose();await rm(directory,{recursive:true,force:true});}
});


test('actual Worker invitation discovery follows bounded pages without hydrating the Room',{timeout:120000},async()=>{
 const built=await build({entryPoints:[fileURLToPath(new URL('./current-work-list-worker.test-fixture.mjs',import.meta.url))],bundle:true,write:false,format:'esm',platform:'neutral',external:['node:*','cloudflare:*']});
 const mf=new Miniflare({modules:true,script:built.outputFiles[0].text,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],durableObjects:{ROOM:{className:'CurrentWorkListProbe',useSQLite:true}}});
 const call=async path=>{const response=await mf.dispatchFetch('http://localhost'+path),body=await response.json();assert.equal(response.status,200,JSON.stringify(body));return body;};
 try{
  await call('/seed?count=32&help=1');let query=new URLSearchParams({focus:'help_wanted'}),pages=0,maxRead=0;const found=[];
  while(query){const page=await call('/list?'+query);assert.equal(page.result.status,200,JSON.stringify(page));const value=page.result.page;pages++;assert.equal(value.selection.examinedWork,1);assert.equal(page.cost.rowsWritten,0);assert.equal(page.rawRuntime.rowsWritten,0);assert.equal(page.cost.unknown,0);maxRead=Math.max(maxRead,page.cost.rowsRead);
   if(pages===1){assert.deepEqual(value.work,[]);assert.equal(value.page.hasMore,true);}
   for(const work of value.work){assert.equal(work.help.status,'open');assert.equal(work.help.authority,'invitation_only');assert.equal(work.offerEligibility.status,'unavailable');assert.equal(work.nextRead.arguments.includeOffers,undefined);found.push(work.id);}
   query=value.page.nextRead?new URLSearchParams(value.page.nextRead.arguments):null;assert.ok(pages<=32);
  }
  assert.equal(pages,32);assert.deepEqual(found,['task-0031']);assert.ok(maxRead<1024);
  console.log('CURRENT_HELP_LIST_WORKER '+JSON.stringify({sources:32,pages,found,maxRead,rowsWritten:0,offerEligibility:'unavailable',syntheticRoom:true}));
 }finally{await mf.dispose();}
});
