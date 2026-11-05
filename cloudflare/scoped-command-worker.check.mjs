import test from'node:test';import assert from'node:assert/strict';import{build}from'esbuild';import{Miniflare}from'miniflare';import{mkdtemp,rm}from'node:fs/promises';import{tmpdir}from'node:os';import{join}from'node:path';import{fileURLToPath}from'node:url';
test('actual Worker ordinary commands stay bounded with100 legal members and large unrelated profiles',{timeout:60000},async()=>{
 const built=await build({entryPoints:[fileURLToPath(new URL('./scoped-command-worker.test-fixture.mjs',import.meta.url))],bundle:true,write:false,format:'esm',platform:'neutral',external:['node:*','cloudflare:*']}),directory=await mkdtemp(join(tmpdir(),'addressed-auth-'));
 const create=()=>new Miniflare({modules:true,script:built.outputFiles[0].text,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],durableObjectsPersist:directory,durableObjects:{ROOM:{className:'ScopedCommandRoom',useSQLite:true}}});let mf=create();
 const call=async path=>{const response=await mf.dispatchFetch('http://localhost'+path),body=await response.json();assert.equal(response.status,200,JSON.stringify(body));return body;};
 try{
  for(const [surface,count]of[['small',2],['large',100]])await call(`/seed?surface=${surface}&count=${count}`);
  await mf.dispose();mf=create();const samples=[];
  for(const [surface,count]of[['small',2],['large',100]]){
   const cold=await call(`/post?surface=${surface}&id=cold`),warm=await call(`/post?surface=${surface}&id=warm`),propose=await call(`/propose?surface=${surface}&id=task`),accept=await call(`/accept?surface=${surface}&id=accept&work=task`),retry=await call(`/accept?surface=${surface}&id=accept&work=task`);
   assert.equal(warm.result.event.actorId,'owner');assert.equal(accept.result.event.actorId,'member-001');assert.equal(retry.result.duplicate,true);
   for(const read of[cold,warm,propose,accept,retry]){assert.equal(read.cost.unknown,0);assert.equal(read.cost.rawRuntime.unknown,0);}
   assert.equal(retry.cost.rowsWritten,0);assert.equal(retry.cost.rawRuntime.rowsWritten,2);
   samples.push({surface,count,cold:cold.cost,warm:warm.cost,propose:propose.cost,accept:accept.cost,retry:retry.cost});
  }
  for(const mode of['warm','propose','accept','retry'])assert.ok(samples[1][mode].rowsRead<=samples[0][mode].rowsRead+8,JSON.stringify(samples));
  console.log('SCOPED_COMMAND_WORKER '+JSON.stringify(samples));
 }finally{await mf.dispose();await rm(directory,{recursive:true,force:true});}
});
