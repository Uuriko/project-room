import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
const bundle=await build({entryPoints:[fileURLToPath(new URL('./operator-message-authority.test-fixture.mjs',import.meta.url))],bundle:true,write:false,format:'esm',platform:'neutral',external:['node:*','cloudflare:*']});
const worker=persistence=>new Miniflare({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],durableObjects:{ROOM:{className:'OperatorAuthorityRoom',useSQLite:true}},durableObjectsPersist:persistence});
async function call(mf,path,input){const response=await mf.dispatchFetch('http://localhost'+path,input?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)}:{});return {status:response.status,body:await response.json()};}
const request={roomId:'commons',reason:'Persistent workerd qualification'};
test('actual workerd restarts preserve conversion, later edit, retry receipt and current-state reverse',async()=>{
 const persistence=await mkdtemp(join(tmpdir(),'room-authority-restart-'));let mf=worker(persistence);
 try {
  assert.equal((await call(mf,'/seed')).status,200);
  const before=await call(mf,'/state'),plan=await call(mf,'/plan',request);assert.equal(plan.status,200,JSON.stringify(plan));
  const input={...request,requestId:'persistent-conversion',planHash:plan.body.planHash};
  const done=await call(mf,'/execute',input);assert.equal(done.status,200,JSON.stringify(done));
  await mf.dispose();mf=worker(persistence);
  const cold=await call(mf,'/state');assert.equal(cold.body.canonical,true);assert.equal(cold.body.hasArray,false);assert.equal(cold.body.sequence,before.body.sequence);
  assert.deepEqual(cold.body.bodies,['Body 0','Body 1','Body 2']);assert.equal(cold.body.rollingWindow,null);assert.equal(cold.body.rollingEntities,false);
  assert.equal((await call(mf,'/edit')).status,200);
  await mf.dispose();mf=worker(persistence);
  const retry=await call(mf,'/execute',input);assert.equal(retry.status,200,JSON.stringify(retry));assert.equal(retry.body.duplicate,true);assert.deepEqual(retry.body.result,done.body.result);
  const afterEdit=await call(mf,'/state');assert.equal(afterEdit.body.receipts,1);assert.equal(afterEdit.body.bodies.at(-1),'Saved after restart');
  const reverse=await call(mf,'/plan',{...request,reverse:true});assert.equal(reverse.status,200,JSON.stringify(reverse));
  assert.equal((await call(mf,'/execute',{...request,reverse:true,requestId:'persistent-reverse',planHash:reverse.body.planHash})).status,200);
  await mf.dispose();mf=worker(persistence);
  const final=await call(mf,'/state');assert.equal(final.body.canonical,false);assert.equal(final.body.hasArray,true);assert.equal(final.body.receipts,2);assert.deepEqual(final.body.bodies,afterEdit.body.bodies);assert.equal(final.body.sequence,afterEdit.body.sequence);
  console.log('AUTHORITY_RESTART '+JSON.stringify({before:before.body,canonical:cold.body,afterEdit:afterEdit.body,final:final.body}));
 }finally{await mf.dispose();await rm(persistence,{recursive:true,force:true});}
});
test('persistent canonical corruption refuses a freshly planned reverse',async()=>{
 const persistence=await mkdtemp(join(tmpdir(),'room-authority-corruption-'));let mf=worker(persistence);
 try{
  await call(mf,'/seed');const plan=await call(mf,'/plan',request);
  assert.equal((await call(mf,'/execute',{...request,requestId:'convert',planHash:plan.body.planHash})).status,200);
  await mf.dispose();mf=worker(persistence);await call(mf,'/tamper');
  const reverse=await call(mf,'/plan',{...request,reverse:true});assert.equal(reverse.status,200);
  const refused=await call(mf,'/execute',{...request,reverse:true,requestId:'reverse',planHash:reverse.body.planHash});
  assert.equal(refused.status,409,JSON.stringify(refused));assert.equal(refused.body.error.code,'authority_integrity_failure');
  assert.equal((await call(mf,'/state')).body.canonical,true);
 }finally{await mf.dispose();await rm(persistence,{recursive:true,force:true});}
});
test('workerd qualifies a near-row-cap eligible conversion with bounded source inventory',async()=>{
 const persistence=await mkdtemp(join(tmpdir(),'room-authority-budget-'));const mf=worker(persistence);
 try{
  assert.equal((await call(mf,'/seed?count=1000&padding=100')).status,200);
  const started=performance.now(),plan=await call(mf,'/plan',request);assert.equal(plan.status,200,JSON.stringify(plan));
  const planned=performance.now(),done=await call(mf,'/execute',{...request,requestId:'convert-size',planHash:plan.body.planHash});assert.equal(done.status,200,JSON.stringify(done));
  const completed=performance.now(),state=await call(mf,'/state');assert.equal(state.body.canonical,true);assert.equal(state.body.bodies.length,1000);
  console.log('AUTHORITY_BUDGET '+JSON.stringify({domains:plan.body.domains,projectionBytes:plan.body.projectionBytes,hydratedUpperBound:plan.body.reverseBound,planWallMs:planned-started,executeWallMs:completed-planned,afterBytes:state.body.projectionBytes,limitations:'Local workerd wall time, not production CPU or a bound for oversized rooms'}));
 }finally{await mf.dispose();await rm(persistence,{recursive:true,force:true});}
});
