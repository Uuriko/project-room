import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm}from'node:fs/promises';import{join}from'node:path';import{tmpdir}from'node:os';import{fileURLToPath}from'node:url';import{build}from'esbuild';import{Miniflare}from'miniflare';
test('actual Native NULL-only inline proof adoption rolls back, retries, restarts and preserves privacy',async()=>{
 const built=await build({entryPoints:[fileURLToPath(new URL('./normalization-absent-inline.test-fixture.mjs',import.meta.url))],bundle:true,write:false,format:'esm',platform:'neutral',external:['node:*','cloudflare:*']}),directory=await mkdtemp(join(tmpdir(),'native-copy-'));
 const create=()=>new Miniflare({durableObjectsPersist:directory,modules:true,script:built.outputFiles[0].text,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],durableObjects:{ROOM:{className:'AbsentInlineAdoptionRoom',useSQLite:true}}});let mf=create();
 const call=async(path,input,status=200)=>{const response=await mf.dispatchFetch('http://localhost'+path,input?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)}:{}),body=await response.json();assert.equal(response.status,status,JSON.stringify(body));return body;};
 try{const {plan,parentSequence}=await call('/seed'),input={roomId:'commons',discardLegacyAssignments:true,adoptAbsentInlineProofs:true,planHash:plan.planHash,requestId:'native-copy-adopt',reason:'Disposable Native copy adoption proof'};
  const fault=await call('/fault',input,500);assert.equal(fault.faulted,true);assert.equal(fault.heads,0);assert.equal(fault.messages,4);assert.equal(fault.missingProofs,4);
  const adopted=await call('/execute',input);assert.equal(adopted.result.duplicate,false);assert.equal(adopted.result.accountsAndConnectionsPreserved,true);
  await mf.dispose();mf=create();const retry=await call('/execute',input);assert.equal(retry.result.duplicate,true);
  const read=await call('/read');assert.equal(read.sequence,parentSequence);assert.equal(read.message.body,'Useful public copied result');assert.equal(read.message.toMemberId,null);assert.equal(read.message.replyToId,null);assert.equal(read.privateStatus,404);assert.ok(read.projectionBytes<512);
  const post=await call('/post');assert.equal(post.retry.duplicate,true);
  console.log('NORMALIZATION_ABSENT_INLINE_NATIVE '+JSON.stringify({fault,parentSequence,read,result:retry.result}));
 }finally{await mf.dispose();await rm(directory,{recursive:true,force:true});}
});
