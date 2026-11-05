import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import test from 'node:test';import assert from 'node:assert/strict';import {build} from 'esbuild';import {Miniflare} from 'miniflare';import {fileURLToPath} from 'node:url';
test('actual SQLite Worker cold different-principal supersession and saved resumed result',async()=>{
 const built=await build({entryPoints:[fileURLToPath(new URL('./current-work-supersession.test-fixture.mjs',import.meta.url))],bundle:true,write:false,format:'esm',platform:'neutral',external:['node:*','cloudflare:*']});
 const dir=await mkdtemp(join(tmpdir(),'supersession-')),create=()=>new Miniflare({durableObjectsPersist:dir,modules:true,script:built.outputFiles[0].text,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],durableObjects:{ROOM:{className:'CurrentSupersessionRoom',useSQLite:true}}});let mf=create();
 const call=async path=>{const r=await mf.dispatchFetch('http://local'+path),body=await r.json();assert.equal(r.status,200,JSON.stringify(body));return body;};
 try{
  await call('/prepare');await mf.dispose();mf=create();
  const denied=await call('/unauthorized');assert.equal(denied.status,422);assert.deepEqual(denied.persistedAfter,denied.persistedBefore);
  const swapped=await call('/supersede');assert.equal(swapped.old.accountableMemberId,'departed');assert.equal(swapped.old.claim.status,'superseded');assert.equal(swapped.old.claim.holderId,'departed');assert.equal(swapped.old.supersededBy,'successor');assert.equal(swapped.replacement.accountableMemberId,'replacement');assert.equal(swapped.replacement.state,'proposed');
  await mf.dispose();mf=create();const retry=await call('/supersede');assert.equal(retry.result.duplicate,true);assert.equal(retry.cost.rowsWritten,0);assert.equal(retry.cost.rawRuntime.rowsWritten,2);
  const resumed=await call('/resume');assert.equal(resumed.privateLeak,false);assert.equal(resumed.replacement.state,'completed');assert.equal(resumed.replacement.receipt.producerId,'replacement');assert.equal(resumed.replacement.verification,null);assert.equal(resumed.replacement.decision,null);assert.equal(resumed.replacement.independentVerificationRequired,true);assert.equal(resumed.replacement.ownerDecisionRequired,true);assert.equal(resumed.old.claim.holderId,'departed');
  console.log('CURRENT_WORK_SUPERSESSION_NATIVE '+JSON.stringify({denied,swapped,retry,resumed}));
 }finally{await mf.dispose();await rm(dir,{recursive:true,force:true});}
});
