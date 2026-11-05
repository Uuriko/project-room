import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';
test('Native account-controlled enrollment rolls back, cold retries, survives source archive and restores with full oracle',async()=>{
 const built=await build({entryPoints:[fileURLToPath(new URL('./account-agent-enrollment.test-fixture.mjs',import.meta.url))],bundle:true,write:false,format:'esm',platform:'neutral',external:['node:*','cloudflare:*']}),directory=await mkdtemp(join(tmpdir(),'native-account-enrollment-'));
 const create=()=>new Miniflare({durableObjectsPersist:directory,modules:true,script:built.outputFiles[0].text,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],durableObjects:{ROOM:{className:'AccountEnrollmentRoom',useSQLite:true}}});let mf=create();
 const call=async(path,input,status=200)=>{const response=await mf.dispatchFetch('http://localhost'+path,input?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)}:{}),body=await response.json();assert.equal(response.status,status,JSON.stringify(body));return body;};
 try{
  const seed=await call('/seed');
  assert.deepEqual(await call('/fault',seed.request,500),{faulted:true,targetLinks:0,proofs:0});
  const first=await call('/execute',seed.request);assert.equal(first.duplicate,false);assert.equal(first.mcpToken,undefined);assert.equal(first.identityId,seed.identityId);
  await mf.dispose();mf=create();const duplicate=await call('/execute',seed.request);assert.equal(duplicate.duplicate,true);assert.deepEqual(duplicate.receipt,first.receipt);
  await call('/archive');let facts=await call('/facts');assert.equal(facts.sourceUnchanged,true);assert.equal(facts.targetBinding,true);assert.equal(facts.targetLinks,1);assert.equal(facts.identityCount,1);assert.equal(facts.proofs,1);
  await mf.dispose();mf=create();facts=await call('/facts');assert.equal(facts.targetBinding,true);assert.equal((await call('/execute',seed.request)).duplicate,true);
  const exported=await mf.dispatchFetch('http://localhost/export'),ndjson=await exported.text(),restored=await mf.dispatchFetch('http://localhost/restore?instance=restored',{method:'POST',headers:{'content-type':'application/x-ndjson'},body:ndjson}),result=await restored.json();
  assert.equal(restored.status,200,JSON.stringify(result));assert.equal(result.verified,true);assert.equal(result.proofs,1);
  console.log('ACCOUNT_ENROLLMENT_NATIVE '+JSON.stringify({facts,restore:result,exportBytes:Buffer.byteLength(ndjson)}));
 }finally{await mf.dispose();await rm(directory,{recursive:true,force:true});}
});
