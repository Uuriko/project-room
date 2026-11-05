import test from'node:test';import assert from'node:assert/strict';import{build}from'esbuild';import{Miniflare}from'miniflare';import{mkdtemp,rm}from'node:fs/promises';import{tmpdir}from'node:os';import{join}from'node:path';import{fileURLToPath}from'node:url';
test('actual Worker addressed auth and selectedwork stay bounded with100 legal members and large unrelated profiles',{timeout:60000},async()=>{
 const built=await build({entryPoints:[fileURLToPath(new URL('./addressed-authority-worker.test-fixture.mjs',import.meta.url))],bundle:true,write:false,format:'esm',platform:'neutral',external:['node:*','cloudflare:*']}),directory=await mkdtemp(join(tmpdir(),'addressed-auth-'));
 const create=()=>new Miniflare({modules:true,script:built.outputFiles[0].text,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],durableObjectsPersist:directory,durableObjects:{ROOM:{className:'AddressedAuthorityRoom',useSQLite:true}}});let mf=create();
 const call=async path=>{const response=await mf.dispatchFetch('http://localhost'+path),body=await response.json();assert.equal(response.status,200,JSON.stringify(body));return body;};
 try{
  for(const [surface,count]of[['small',2],['large',100],['maxmeta',100]])await call(`/seed?surface=${surface}&count=${count}${surface==='maxmeta'?'&maxmeta=1':''}`);
  await mf.dispose();mf=create();const samples=[];
  for(const [surface,count]of[['small',2],['large',100],['maxmeta',100]]){
   const cold=await call(`/auth?surface=${surface}`),warm=await call(`/auth?surface=${surface}`),selected=await call(`/selected?surface=${surface}`);
   assert.equal(warm.result.memberId,'member-001');assert.equal(selected.result.work.definitionOfDone,'Save exact useful result');
   for(const read of[cold,warm,selected]){assert.equal(read.cost.rowsWritten,0);assert.equal(read.cost.rawRuntime.rowsWritten,0);assert.equal(read.cost.unknown,0);}
   samples.push({surface,count,cold:cold.cost,warm:warm.cost,selected:selected.cost});
  }
  for(const mode of['warm','selected'])assert.equal(samples[2][mode].rowsRead,samples[1][mode].rowsRead,JSON.stringify(samples));
  for(const mode of['warm','selected'])assert.ok(samples[1][mode].rowsRead<=samples[0][mode].rowsRead+4,JSON.stringify(samples));
  // The two explicitly admitted member records may straddle at most two extra
  // immutable receipt envelopes, each admitted by two primary-key point reads.
  console.log('ADDRESSED_AUTHORITY_WORKER '+JSON.stringify(samples));
 }finally{await mf.dispose();await rm(directory,{recursive:true,force:true});}
});
