import test from'node:test';import assert from'node:assert/strict';import{build}from'esbuild';import{Miniflare}from'miniflare';import{mkdtemp,rm}from'node:fs/promises';import{tmpdir}from'node:os';import{join}from'node:path';import{fileURLToPath}from'node:url';
test('actual Worker normalized reply list and selected source costs remain bounded across 1k and5k background messages at legal500 request capacity',{timeout:180000},async()=>{
 const built=await build({entryPoints:[fileURLToPath(new URL('./current-replies-worker.test-fixture.mjs',import.meta.url))],bundle:true,write:false,format:'esm',platform:'neutral',external:['node:*','cloudflare:*']}),directory=await mkdtemp(join(tmpdir(),'current-replies-'));
 const create=()=>new Miniflare({modules:true,script:built.outputFiles[0].text,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],durableObjectsPersist:directory,durableObjects:{ROOM:{className:'CurrentRepliesRoom',useSQLite:true}}});let mf=create();
 const call=async(path)=>{const response=await mf.dispatchFetch('http://localhost'+path),body=await response.json();assert.equal(response.status,200,JSON.stringify(body));return body;};
 try{
  for(const [surface,count]of [['small',1000],['large',5000]])await call(`/seed?surface=${surface}&count=${count}`);
  await mf.dispose();mf=create();const samples=[];
  for(const [surface,count]of [['small',1000],['large',5000]]){
   const cold=await call(`/list?surface=${surface}`),warm=await call(`/list?surface=${surface}`),selected=await call(`/selected?surface=${surface}`),history=await call(`/history?surface=${surface}`);
   // #5948: the addressed open ask leads page one (open-request index head start); the witnessed scan still follows.
   assert.deepEqual(warm.result.requests.map(r=>r.id),['zz-question']);assert.equal(warm.result.page.hasMore,true);assert.equal(warm.result.sourceWindow.complete,false);
   assert.equal(JSON.stringify(warm.result).includes('a-hidden-'),false);
   assert.equal(selected.result.page.items[0].message.id,'zz-question');assert.equal(selected.result.page.hasMore,true);assert.equal(selected.result.current.answerBasis,null);
   assert.equal(history.result.page.hasMore,true);assert.deepEqual(history.result.page.items,[]);
   assert.match(JSON.stringify(selected.plans.list),/current_reply_request_keys/);assert.match(JSON.stringify(selected.plans.selected),/messages_room_thread_seq/);assert.match(JSON.stringify(selected.plans.history),/SEARCH events/);
   for(const read of[cold,warm,selected,history]){assert.equal(read.cost.rowsWritten,0);assert.equal(read.cost.rawRuntime.rowsWritten,0);assert.equal(read.cost.unknown,0);}
   samples.push({count,cold:cold.cost,warm:warm.cost,selected:selected.cost,history:history.cost,plans:selected.plans});
  }
  assert.equal(samples[1].history.rowsRead,samples[0].history.rowsRead,JSON.stringify(samples));
  assert.equal(samples[1].warm.rowsRead,samples[0].warm.rowsRead,JSON.stringify(samples));
  // Independent immutable proof envelopes can straddle initialization receipt
  // batches differently. Each of the at-most eight admitted source candidates
  // can add a pair of indexed receipt point reads; this reservation follows
  // the source cap rather than a measured timing/row threshold.
  assert.ok(samples[1].selected.rowsRead<=samples[0].selected.rowsRead+2*8,JSON.stringify(samples));
  console.log('CURRENT_REPLY_WORKER '+JSON.stringify(samples));
 }finally{await mf.dispose();await rm(directory,{recursive:true,force:true});}
});
