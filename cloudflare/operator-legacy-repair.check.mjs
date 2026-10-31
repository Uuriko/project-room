import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
const origin='https://room.example.test', operator='synthetic-workerd-operator-repair-token';
const bundle=await build({entryPoints:[fileURLToPath(new URL('./operator-legacy-repair.test-fixture.mjs',import.meta.url))],bundle:true,write:false,format:'esm',platform:'neutral',external:['node:*','cloudflare:*']});
async function setup(t) {
  const mf=new Miniflare({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],
    durableObjects:{ROOM:{className:'LegacyRepairProbe',useSQLite:true}},bindings:{ROOM_ORIGIN:origin,ROOM_OPERATOR_TOKEN_SHA256:createHash('sha256').update(operator).digest('hex')}});
  t.after(()=>mf.dispose());
  const call=(path,body,auth='Operator '+operator)=>mf.dispatchFetch(origin+path,{method:body===undefined?'GET':'POST',headers:{'CF-Connecting-IP':'203.0.113.1',Origin:origin,Authorization:auth,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const seed=await (await call('/__fixture/seed',{})).json();
  const input={rooms:[{roomId:'repair-target',expectedHead:seed.head}],reason:'Synthetic Workerd legacy shape qualification'};
  const state=async()=>{const response=await call('/__fixture/state');assert.equal(response.status,200);return response.json();};
  return {call,input,state};
}
const base='/api/operator/messages/legacy-repair/';
test('actual Workerd Operator HTTP repair nests read/write transactions, verifies and clears ledger, duplicate is idempotent',async t=>{
  const f=await setup(t);
  const second=await (await f.call('/__fixture/second',{})).json();
  f.input.rooms.push({roomId:'repair-second',expectedHead:second.head});
  const before=await f.state();
  assert.equal((await f.call(base+'plan',f.input,'Bearer not-an-operator')).status,404);
  const planned=await f.call(base+'plan',f.input);assert.equal(planned.status,200);
  const plan=await planned.json();assert.equal(plan.rooms[0].records,1);
  const afterPlan=await f.state();assert.deepEqual(afterPlan,before,'plan audit cannot change content, certification or failure ledger');
  const input={...f.input,planHash:plan.planHash,requestId:'workerd-repair'};
  assert.equal((await f.call(base+'execute',{...input,planHash:'0'.repeat(64)})).status,409);
  assert.equal((await f.call(base+'execute',{...input,rooms:[{roomId:'repair-target',expectedHead:999}]})).status,409);
  assert.deepEqual(await f.state(),before,'stale/digest refusals do not mutate data or certificates');
  const executed=await f.call(base+'execute',input);assert.equal(executed.status,200);
  assert.equal((await executed.json()).verified,2);
  const after=await f.state();assert.equal(after.repaired,true);assert.equal(after.secondRepaired,true);assert.equal(after.failures.length,0);
  assert.equal(after.certificate,f.input.rooms[0].expectedHead);assert.equal(after.source,before.source);assert.equal(after.other,before.other);assert.equal(after.completions,1);
  const duplicate=await f.call(base+'execute',input);assert.equal(duplicate.status,200);assert.equal((await duplicate.json()).duplicate,true);
  assert.deepEqual(await f.state(),after);
});
for(const failure of ['verify','audit']) test(`actual Workerd ${failure} failure rolls back repair/ledger and preserves unrelated room`,async t=>{
  const f=await setup(t),before=await f.state();
  const planned=await f.call(base+'plan',f.input);assert.equal(planned.status,200);const plan=await planned.json();
  assert.equal((await f.call('/__fixture/fail-'+failure,{})).status,200);
  const executed=await f.call(base+'execute',{...f.input,planHash:plan.planHash,requestId:'workerd-failure'});
  assert.equal(executed.status,failure==='verify'?409:500);
  const after=await f.state();assert.equal(after.target,before.target);assert.equal(after.source,before.source);assert.equal(after.other,before.other);
  assert.deepEqual(after.failures,before.failures);assert.equal(after.certificate,null);assert.equal(after.completions,0);assert.equal(after.repaired,false);
});
