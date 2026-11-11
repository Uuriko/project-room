import test from'node:test';import assert from'node:assert/strict';import{build}from'esbuild';import{Miniflare}from'miniflare';import{mkdtemp,rm}from'node:fs/promises';import{tmpdir}from'node:os';import{join}from'node:path';import{fileURLToPath}from'node:url';
test('actual Worker ownership transfer and deletion inventory use protected addressed facts at4 and100 members',{timeout:60000},async()=>{
 const built=await build({entryPoints:[fileURLToPath(new URL('./project-continuity-worker.test-fixture.mjs',import.meta.url))],bundle:true,write:false,format:'esm',platform:'neutral',external:['node:*','cloudflare:*']}),directory=await mkdtemp(join(tmpdir(),'addressed-auth-'));
 const create=()=>new Miniflare({modules:true,script:built.outputFiles[0].text,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],durableObjectsPersist:directory,durableObjects:{ROOM:{className:'ProjectContinuityRoom',useSQLite:true}}});let mf=create();
 const call=async path=>{const response=await mf.dispatchFetch('http://localhost'+path),body=await response.json();assert.equal(response.status,200,JSON.stringify(body));return body;};
 try{
  for(const [surface,count]of[['small',4],['large',100]])await call(`/seed?surface=${surface}&count=${count}`);
  await mf.dispose();mf=create();const samples=[];
  for(const [surface,count]of[['small',4],['large',100]]){
   const coldPlan=await call(`/plan?surface=${surface}`),warmPlan=await call(`/plan?surface=${surface}`),transfer=await call(`/transfer?surface=${surface}`),retry=await call(`/transfer?surface=${surface}`),post=await call(`/post?surface=${surface}`);
   assert.equal(warmPlan.result.transfer[0].toMemberId,'successor');assert.equal(transfer.result.ownerId,'successor');assert.equal(transfer.result.duplicate,false);assert.equal(retry.result.duplicate,true);assert.equal(post.result.event.actorId,'successor');
   assert.equal(warmPlan.cost.rowsWritten,0);assert.equal(warmPlan.cost.rawRuntime.rowsWritten,0);assert.equal(retry.cost.rowsWritten,0);assert.equal(retry.cost.rawRuntime.rowsWritten,2);
   for(const read of[coldPlan,warmPlan,transfer,retry,post]){assert.equal(read.cost.unknown,0);assert.equal(read.cost.rawRuntime.unknown,0);}
   samples.push({surface,count,coldPlan:coldPlan.cost,warmPlan:warmPlan.cost,transfer:transfer.cost,retry:retry.cost,post:post.cost});
  }
  // The inventory admits one complete <=100 member-key census. It never
  // opens all work/history or unrelated advertised member profile bodies.
  assert.ok(samples[1].warmPlan.rowsRead<=samples[0].warmPlan.rowsRead+100,JSON.stringify(samples));
  for(const phase of['transfer','retry'])assert.ok(samples[1][phase].rowsRead<=samples[0][phase].rowsRead+8,JSON.stringify(samples));
  await mf.dispose();mf=create();for(const surface of['small','large']){const coldRetry=await call(`/transfer?surface=${surface}`);assert.equal(coldRetry.result.duplicate,true);assert.equal(coldRetry.cost.rowsWritten,0);}
  console.log('PROJECT_CONTINUITY_WORKER '+JSON.stringify(samples));
 }finally{await mf.dispose();await rm(directory,{recursive:true,force:true});}
});
