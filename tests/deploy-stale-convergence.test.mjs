import test from 'node:test';
import assert from 'node:assert/strict';
import { convergeDeploymentHealth, deploymentHealth } from '../scripts/prod-deploy-smoke.mjs';
const epoch = Date.now();
function fixture(stale = false) {
  return { health:{status:200,json:{status:stale?'degraded':'ok',liveness:'ok',jobs:{status:stale?'stale':'ok'}}},
    jobs:{status:stale?503:200,json:{schema:'room.job-health/1',status:stale?'stale':'ok',generatedAt:new Date(epoch).toISOString(),jobs:[
      {name:'room-backup',required:true,status:'ok',stale:false,consecutiveFailures:0},
      {name:'integrity',required:false,status:stale?'stale':'ok',stale,consecutiveFailures:0,secondsSinceSuccess:900,staleAfterSeconds:600},
    ]}}, ready:{status:200,json:{status:'ready',emailVerification:'enforced',emailVerificationScope:'durable-object'}} };
}
function harness(select, {remaining = 30, initial = 0, readiness = null} = {}) {
  let clock = initial, healthReads = 0;
  const sleeps = [], deadlines = [];
  const run = () => convergeDeploymentHealth({doors:['canonical','entry'],deadline:epoch+remaining,now:()=>epoch+clock,pollMs:10,
    sleepFn:async ms=>{sleeps.push(ms);clock+=ms;},
    readHealth:async (door, deadline)=>{healthReads++;deadlines.push(deadline);return select(clock,door).health;},
    readJobs:async door=>select(clock,door).jobs,
    readReady:async door=>readiness?.(clock,door)??select(clock,door).ready,
  });
  return {run,reads:()=>healthReads,sleeps,deadlines};
}
test('valid stale jobs converge on both doors without counting stale as passing', async () => {
  const h=harness(clock=>fixture(clock<10));const result=await h.run();
  assert.equal(result.rounds,2);assert.ok(result.observations.every(r=>r.health.pass));
  assert.deepEqual(h.sleeps,[10]);assert.equal(h.reads(),4);
  assert.deepEqual(h.deadlines,[null,null,epoch+30,epoch+30]);
});
test('persistent stale jobs consume only remaining shared deployment budget', async () => {
  const h=harness(()=>fixture(true),{remaining:25,initial:20});const result=await h.run();
  assert.deepEqual(h.sleeps,[5]);assert.equal(result.rounds,1);
  assert.ok(result.observations.every(r=>!r.health.pass&&r.health.reason==='job_stale'));
  assert.equal(h.reads(),2);
});
test('source convergence exhausting the deadline leaves no stale retry budget',async()=>{
  const h=harness(()=>fixture(true),{remaining:30,initial:30});const result=await h.run();
  assert.deepEqual(h.sleeps,[]);assert.equal(result.rounds,1);assert.equal(result.observations[0].health.pass,false);
});
for (const [name,mutate] of Object.entries({
  failing:f=>{f.jobs.json.jobs[1].consecutiveFailures=1;},
  malformed:f=>{f.jobs.json.jobs[1].required='false';},
  missing:f=>{f.jobs.json.jobs=[];},
  'backup missing':f=>{f.jobs.json.jobs.shift();},
  'backup stale':f=>{f.jobs.json.jobs[0].status='stale';f.jobs.json.jobs[0].stale=true;},
  'backup failing':f=>{f.jobs.json.jobs[0].status='failing';},
  'lying stale summary':f=>{f.jobs.json.status='ok';},
  'lying liveness':f=>{f.health.json.liveness='error';},
  'contradictory stale age':f=>{f.jobs.json.jobs[1].secondsSinceSuccess=1;},
  'stale unsupported degradation':f=>{f.jobs.json.jobs[1].degraded='unexpected';},
  'missing stale age':f=>{delete f.jobs.json.jobs[1].secondsSinceSuccess;},
  'unknown degradation beside stale':f=>{f.jobs.json.jobs.push({name:'patrol',required:false,status:'degraded',stale:false,consecutiveFailures:0,degraded:'unexpected'});},
})) test(`does not wait for ${name}`,async()=>{
  const f=fixture(true);mutate(f);const h=harness(()=>f);const result=await h.run();
  assert.equal(result.rounds,1);assert.deepEqual(h.sleeps,[]);assert.ok(result.observations.every(r=>!r.health.pass));
});
test('readiness failure on either door immediately stops stale convergence',async()=>{
  const h=harness(()=>fixture(true),{readiness:(_,door)=>door==='entry'?{status:503,json:{status:'degraded'}}:fixture().ready});
  const result=await h.run();assert.equal(result.rounds,1);assert.deepEqual(h.sleeps,[]);
});
test('a readiness regression during recovery still fails the final observation',async()=>{
  const h=harness(clock=>fixture(clock<10),{readiness:clock=>clock?{status:503,json:{status:'degraded'}}:fixture().ready});
  const result=await h.run();assert.equal(result.rounds,2);assert.equal(result.observations[0].ready.status,503);
});
test('stale diagnostics expose fixed safe names/status/age without errors',()=>{
  const f=fixture(true);f.jobs.json.jobs[1].name='private-name';f.jobs.json.jobs[1].lastError='private endpoint credentials';
  const result=deploymentHealth(f.health,f.jobs,epoch);
  assert.equal(result.pass,false);assert.equal(result.retryableStale,true);
  assert.deepEqual(result.degradedJobs,[{name:'job',status:'stale',reason:'job_stale',ageSeconds:900,staleAfterSeconds:600}]);
  assert.doesNotMatch(JSON.stringify(result),/private-name|private endpoint|credentials/);
});

test('a healthy response finishing after the remaining deadline cannot turn green', async()=>{
  let clock=0;
  const result=await convergeDeploymentHealth({doors:['canonical'],deadline:epoch+15,now:()=>epoch+clock,pollMs:10,
    sleepFn:async ms=>{clock+=ms;},readHealth:async()=>fixture(clock===0).health,
    readJobs:async()=>fixture(clock===0).jobs,readReady:async()=>{if(clock)clock=16;return fixture().ready;}});
  assert.equal(result.rounds,2);assert.equal(result.observations[0].health.pass,false);
  assert.equal(result.observations[0].health.reason,'convergence_deadline');
});
