import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { messageProofMatches } from '../server/write-integrity.mjs';
test('actual workerd historical derived repair rolls back audit faults and retains exact receipt across restart and later writes',async()=>{
  const bundle=await build({entryPoints:[fileURLToPath(new URL('./legacy-session-repair.test-fixture.mjs',import.meta.url))],bundle:true,write:false,format:'esm',platform:'neutral',external:['node:*','cloudflare:*']});
  const persistence=await mkdtemp(join(tmpdir(),'room-legacy-session-'));
  const worker=()=>new Miniflare({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],durableObjects:{ROOM:{className:'LegacySessionRepairRoom',useSQLite:true}},durableObjectsPersist:persistence});
  let mf=worker();
  const call=async(path,input,status=200)=>{const response=await mf.dispatchFetch('http://localhost'+path,input?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)}:{});const body=await response.json();assert.equal(response.status,status,JSON.stringify(body));return body;};
  try {
    const {request}=await call('/seed'),before=await call('/state');assert.equal(before.blocks,1);
    const plan=await call('/plan',request),input={...request,planHash:plan.planHash,requestId:'synthetic-restart'};
    await call('/audit-fault');await call('/execute',input,500);
    assert.deepEqual(await call('/state'),before);
    await mf.dispose();mf=worker();
    assert.deepEqual(await call('/state'),before);
    await call('/clear-fault');const completed=await call('/execute',input),after=await call('/state');
    assert.equal(after.blocks,0);assert.equal(after.receipts,1);assert.equal(after.cursor.applied_seq,before.head);assert.equal(after.cursor.parity_at_seq,before.head);
    assert.deepEqual(after.authority,before.authority);
    await mf.dispose();mf=worker();
    assert.deepEqual(await call('/execute',input),{...completed,duplicate:true});
    await call('/lose-replay-checkpoints');
    await mf.dispose();mf=worker();
    const recovered=await call('/recover-saved');assert.equal(recovered.replay.sequence,before.head);assert.equal(recovered.parity.ok,true);
    assert.deepEqual((await call('/state')).authority,after.authority);
    assert.deepEqual(await call('/execute',input),{...completed,duplicate:true});
    await call('/append-only');let appended=await call('/state');assert.equal(appended.head,before.head+1);assert.equal(appended.blocks,0);
    await call('/lose-replay-checkpoints');
    await mf.dispose();mf=worker();
    const suffix=await call('/recover-saved');assert.equal(suffix.replay.sequence,appended.head);assert.equal(suffix.parity.ok,true);
    assert.equal(suffix.result.events,before.head+1);
    assert.deepEqual((await call('/state')).authority,appended.authority);appended=await call('/state');
    await mf.dispose();mf=worker();
    assert.deepEqual(await call('/execute',input),{...completed,duplicate:true});assert.deepEqual(await call('/state'),appended);
  } finally {await mf.dispose();await rm(persistence,{recursive:true,force:true});}
});

test('actual workerd adopts only independently matched absent proofs atomically and retains prefix receipt after restart',async()=>{
  const bundle=await build({entryPoints:[fileURLToPath(new URL('./legacy-session-repair.test-fixture.mjs',import.meta.url))],bundle:true,write:false,format:'esm',platform:'neutral',external:['node:*','cloudflare:*']});
  const persistence=await mkdtemp(join(tmpdir(),'room-legacy-proof-adoption-'));
  const worker=()=>new Miniflare({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],durableObjects:{ROOM:{className:'LegacySessionRepairRoom',useSQLite:true}},durableObjectsPersist:persistence});
  let mf=worker();
  const call=async(path,input,status=200)=>{const response=await mf.dispatchFetch('http://localhost'+path,input?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)}:{});const body=await response.json();assert.equal(response.status,status,JSON.stringify(body));return body;};
  const withoutHashes=authority=>({...authority,messages:authority.messages.map(row=>{const value={...row};delete value.entity_hash;return value;})});
  try{
    const {request}=await call('/seed-adopt'),before=await call('/state');assert.ok(before.authority.messages.every(row=>row.entity_hash===null));
    await call('/utf8-valid');const plan=await call('/plan',request);
    await call('/utf8-invalid');const refused=await call('/plan',request,409);assert.equal(refused.error.code,'repair_not_exact_legacy');assert.deepEqual(await call('/state'),before);
    await call('/utf8-restore');assert.equal((await call('/plan',request)).planHash,plan.planHash);
    const input={...request,planHash:plan.planHash,requestId:'proof-restart'};
    assert.equal(plan.derivedOnly,false);assert.deepEqual(await call('/state'),before);
    await call('/audit-fault');await call('/execute',input,500);assert.deepEqual(await call('/state'),before);
    await mf.dispose();mf=worker();assert.deepEqual(await call('/state'),before);
    await call('/clear-fault');const completed=await call('/execute',input),after=await call('/state');
    assert.equal(completed.messageProofsAdopted,before.authority.messages.length);assert.equal(after.blocks,0);assert.equal(after.receipts,1);
    assert.equal(after.cursor.parity_at_seq,before.head);assert.equal(after.authority.messages.every(messageProofMatches),true);
    assert.deepEqual(withoutHashes(after.authority),withoutHashes(before.authority));
    assert.equal(completed.replayContract.version,1);assert.equal(completed.replayContract.adapterVersion,1);assert.equal(completed.replayContract.throughSequence,before.head);
    await call('/lose-replay-checkpoints');
    await mf.dispose();mf=worker();
    const adoptedRecovery=await call('/recover-saved');assert.equal(adoptedRecovery.parity.ok,true);assert.equal(adoptedRecovery.replay.sequence,before.head);
    assert.deepEqual((await call('/state')).authority,after.authority);
    await mf.dispose();mf=worker();assert.deepEqual(await call('/execute',input),{...completed,duplicate:true});
    await call('/append');const appended=await call('/state');assert.equal(appended.head,before.head+1);
    await mf.dispose();mf=worker();assert.deepEqual(await call('/execute',input),{...completed,duplicate:true});assert.deepEqual(await call('/state'),appended);
  }finally{await mf.dispose();await rm(persistence,{recursive:true,force:true});}
});
