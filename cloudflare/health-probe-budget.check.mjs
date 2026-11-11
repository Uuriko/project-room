import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { HEALTH_PROBE_TIMEOUT_MS } from './health-probe.mjs';
const origin = 'https://room.example.test';
const TEST_SOURCE = 'a'.repeat(40), TEST_BUILD = '2026-11-01T12:00:00.000Z';
async function fixture(t, config, stamps = { sourceRevision: TEST_SOURCE, buildId: TEST_BUILD }) {
  const bundle = await build({ entryPoints: [fileURLToPath(new URL('./health-probe-budget.test-fixture.mjs', import.meta.url))], bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['node:*', 'cloudflare:*'], plugins: [{ name: 'synthetic-static-release-stamp', setup(build) { build.onLoad({ filter: /[\\/]server[\\/]version\.mjs$/ }, () => ({ contents: `export const SOURCE_REVISION=${JSON.stringify(stamps.sourceRevision)};export const BUILD_ID=${JSON.stringify(stamps.buildId)};export const PACKAGE_VERSION="0.1.0";`, loader: 'js' })); } }] });
  const mf = new Miniflare({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-07-30', compatibilityFlags: ['nodejs_compat'], bindings: { ROOM_ORIGIN: origin }, durableObjects: { ROOM: { className: config.observationPeer === 'legacy' ? 'LegacyBudgetProbe' : 'BudgetProbe', useSQLite: true }, ACTUAL: { className: 'ObservedProjectRoom', useSQLite: true } } });
  t.after(() => mf.dispose());
  const fetch = (path, options) => mf.dispatchFetch(origin + path, options);
  await fetch('/configure', { method: 'POST', body: JSON.stringify(config) });
  return { fetch, count: async () => (await (await fetch('/count')).json()).count };
}
for (const delay of [1200, 1800]) test(`actual Worker accepts a successful ${delay}ms readiness RPC once, without caching`, async t => {
  const f = await fixture(t, { delay });
  const [get, head] = await Promise.all([f.fetch('/api/ready'), f.fetch('/api/ready', { method: 'HEAD' })]);
  assert.equal(get.status, 200); assert.equal((await get.json()).status, 'ready');
  assert.equal(head.status, 200); assert.equal(await head.text(), ''); assert.equal(await f.count(), 1);
  assert.equal((await f.fetch('/api/ready')).status, 200); assert.equal(await f.count(), 2);
});
test('actual Worker stalled RPC remains bounded and shared; static Worker version does not probe', async t => {
  const f = await fixture(t, { stalled: true });
  assert.equal((await f.fetch('/api/version/worker')).status, 200);
  assert.equal(await f.count(), 0);
  const [a, b] = await Promise.all([f.fetch('/api/ready'), f.fetch('/api/ready')]);
  for (const response of [a, b]) {
    assert.equal(response.status, 503); const body = await response.json();
    assert.equal(body.durableObject.ready, false); assert.equal(body.do.status, 'timeout');
    assert.equal(body.do.timeoutMs, 2500); assert.ok(body.do.ms >= 2400 && body.do.ms < 4000);
  }
  assert.equal(await f.count(), 1); await f.fetch('/unblock');
});
for (const config of [{ error: true }, { ok: false }]) test(`actual Worker still refuses ${JSON.stringify(config)} readiness`, async t => {
  const f = await fixture(t, config); const response = await f.fetch('/api/ready');
  assert.equal(response.status, 503); assert.equal((await response.json()).do.status, 'error');
  assert.equal(await f.count(), 1);
});
test('actual Worker joining caller gets its own deadline after leader timeout', async t => {
  assert.equal(HEALTH_PROBE_TIMEOUT_MS, 2500);
  const f = await fixture(t, { delay: 3200 });
  const leader = f.fetch('/api/ready');
  await new Promise(resolve => setTimeout(resolve, 1000));
  const joiner = f.fetch('/api/ready');
  assert.equal((await leader).status, 503);
  assert.equal((await joiner).status, 200); assert.equal(await f.count(), 1);
});
test('actual Worker health summary accepts slow successful job RPC without changing liveness semantics', async t => {
  const f = await fixture(t, { delay: 1200 }); const response = await f.fetch('/api/health');
  assert.equal(response.status, 200); const body = await response.json();
  assert.equal(body.liveness, 'ok'); assert.equal(body.jobs.status, 'ok'); assert.equal(await f.count(), 1);
});

function assertObservation(row) {
  assert.equal(row.event, 'room.readiness_probe');
  assert.ok(Number.isFinite(row.epochMs) && row.epochMs > 0);
  assert.equal(row.clockSemantics, 'io-bound');
  assert.equal(row.cpuMeasured, false);
  for (const key of ['elapsedMs', 'probeWaitMs', 'timeoutMs']) {
    if (key in row) assert.ok(Number.isFinite(row[key]) && row[key] >= 0);
  }
  assert.doesNotMatch(JSON.stringify(row), /PRIVATE_|room.example|api\/|emailVerification/);
}
test('readiness observations distinguish shared callers and late RPC settlement without another probe', async t => {
  const f = await fixture(t, { stalled: true, observationPeer: 'valid' });
  const get = f.fetch('/api/ready');
  await new Promise(resolve => setTimeout(resolve, 20));
  const head = f.fetch('/api/ready', { method: 'HEAD' });
  const denied = await f.fetch('/api/ready', { headers: { Origin: 'https://PRIVATE_ORIGIN.invalid' } });
  assert.equal(denied.status, 403);
  assert.equal((await get).status, 503);
  const headResponse = await head;
  assert.equal(headResponse.status, 503); assert.equal(await headResponse.text(), '');
  let rows = await (await f.fetch('/observations')).json();
  assert.equal(rows.filter(row => row.stage === 'worker_wait_started').length, 2);
  assert.equal(rows.filter(row => row.stage === 'worker_rpc_started').length, 1);
  assert.equal(rows.filter(row => row.stage === 'worker_rpc_settled').length, 0);
  const returned = rows.filter(row => row.stage === 'worker_response');
  assert.deepEqual(returned.map(row => row.probeRole).sort(), ['joiner', 'leader']);
  assert.ok(returned.every(row => row.outcome === 'timeout' && row.timeoutMs === 2500));
  assert.equal(await f.count(), 1);
  await f.fetch('/unblock');
  for (let n = 0; n < 20; n++) {
    rows = await (await f.fetch('/observations')).json();
    if (rows.some(row => row.stage === 'worker_rpc_settled')) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(rows.filter(row => row.stage === 'worker_rpc_settled' && row.outcome === 'ok').length, 1);
  assert.equal(rows.find(row => row.stage === 'worker_rpc_settled').authoritySourceRevision, 'b'.repeat(40));
  assert.equal(rows.find(row => row.stage === 'worker_rpc_settled').authorityDoElapsedMs, 3);
  assert.equal(rows.filter(row => row.stage === 'worker_response').length, 2, 'late settlement is not another response');
  assert.equal(await f.count(), 1);
  rows.forEach(assertObservation);
  await f.fetch('/configure', { method: 'POST', body: JSON.stringify({}) });
  assert.equal((await f.fetch('/api/ready')).status, 200);
  assert.equal(await f.count(), 2, 'settled probe is not cached');
});
test('actual DO readiness observations retain two admission reads plus one probe, pause and original error', async t => {
  const f = await fixture(t, {});
  for (const mode of ['ok', 'paused', 'sql-error', 'emitter-error']) {
    const result = await (await f.fetch('/actual?mode=' + mode)).json();
    assert.equal(result.statements, mode === 'paused' ? 0 : 3);
    if (mode === 'sql-error') assert.equal(result.originalError, true);
    else assert.equal(result.result.ok, mode !== 'paused');
    if (mode === 'emitter-error') { assert.deepEqual(result.observations, []); continue; }
    assert.deepEqual(result.observations.map(row => row.stage), mode === 'paused'
      ? ['do_entered', 'do_completed'] : ['do_entered', 'sql_completed', 'do_completed']);
    assert.equal(result.observations.at(-1).outcome, mode === 'paused' ? 'unready' : mode === 'sql-error' ? 'error' : 'ok');
    result.observations.forEach(assertObservation);
  }
});
test('readiness logging failure preserves Worker success and original RPC error responses', async t => {
  const f = await fixture(t, {});
  await f.fetch('/telemetry-failure', { method: 'POST', body: JSON.stringify({ enabled: true }) });
  assert.equal((await f.fetch('/api/ready')).status, 200);
  await f.fetch('/configure', { method: 'POST', body: JSON.stringify({ error: true }) });
  const response = await f.fetch('/api/ready');
  assert.equal(response.status, 503); assert.equal((await response.json()).do.status, 'error');
  assert.equal(await f.count(), 2);
});


test('readiness provenance uses strict static stamps and refuses arbitrary stamp strings', async t => {
  for (const stamps of [{sourceRevision:TEST_SOURCE,buildId:TEST_BUILD}, {sourceRevision:'PRIVATE_SOURCE',buildId:'PRIVATE_BUILD'}, {sourceRevision:TEST_SOURCE,buildId:'2026-02-31T12:00:00.000Z'}]) {
    const f=await fixture(t,{},stamps);assert.equal((await f.fetch('/api/ready')).status,200);
    const rows=await (await f.fetch('/observations')).json();
    for(const row of rows) {
      assert.equal(row.sourceRevision, stamps.sourceRevision === TEST_SOURCE ? TEST_SOURCE : null);
      assert.equal(row.buildId, stamps.buildId === TEST_BUILD ? TEST_BUILD : null);
      assert.doesNotMatch(JSON.stringify(row),/PRIVATE_/);
    }
  }
});
test('readiness provenance is opt-in on the actual DO and retains legacy shape and errors',async t=>{
  const f=await fixture(t,{});
  const legacy=await (await f.fetch('/actual?mode=ok')).json();
  assert.deepEqual(legacy.result,{ok:true,emailVerification:'relaxed-no-mailer'});assert.equal(legacy.statements,3);
  for(const mode of ['ok','paused','sql-error','emitter-error']) {
    const value=await (await f.fetch('/actual?mode='+mode+'&diagnostics=1')).json();
    assert.equal(value.statements,mode==='paused'?0:3);
    if(mode==='sql-error'){assert.equal(value.originalError,true);continue;}
    const diagnostic=value.result.readinessObservation;
    assert.equal(diagnostic.sourceRevision,TEST_SOURCE);assert.equal(diagnostic.buildId,TEST_BUILD);
    assert.equal(diagnostic.sqlOutcome,mode==='paused'?'not_run':'ok');
    for(const key of ['sqlElapsedMs','doElapsedMs'])assert.ok(Number.isFinite(diagnostic[key])&&diagnostic[key]>=0);
    if(mode==='emitter-error')assert.deepEqual(value.observations,[]);
  }
});
test('readiness provenance validates new peers and preserves old or malicious peer public responses',async t=>{
  for(const peer of ['legacy','valid','malicious']) {
    const f=await fixture(t,{observationPeer:peer});const response=await f.fetch('/api/ready');
    assert.equal(response.status,200);const body=await response.json();
    assert.deepEqual({...body,do:{...body.do,ms:0}},{status:'ready',mode:'cloudflare-staging',emailVerification:'enforced',emailVerificationScope:'durable-object',do:{status:'ok',statusCode:200,ms:0}});
    assert.doesNotMatch(JSON.stringify(body),/Observation|sourceRevision|buildId|PRIVATE_/);
    const settled=(await (await f.fetch('/observations')).json()).find(row=>row.stage==='worker_rpc_settled');
    assert.equal(settled.authorityObservation,peer==='valid'?'present':peer==='legacy'?'absent':'invalid');
    assert.doesNotMatch(JSON.stringify(settled),/PRIVATE_/);
    if(peer==='valid'){assert.equal(settled.authoritySourceRevision,'b'.repeat(40));assert.equal(settled.authoritySqlOutcome,'ok');assert.equal(settled.authorityDoElapsedMs,3);}
  }
});

test('readiness provenance refuses each malformed callee field without altering readiness',async t=>{
  const valid={sourceRevision:'b'.repeat(40),buildId:TEST_BUILD,sqlOutcome:'ok',sqlElapsedMs:1,doElapsedMs:3};
  const f=await fixture(t,{});
  for(const bad of [{sourceRevision:'PRIVATE_SOURCE'},{buildId:'PRIVATE_BUILD'},{sqlOutcome:'PRIVATE_OUTCOME'},{sqlElapsedMs:-1},{doElapsedMs:Number.MAX_VALUE},{extra:'PRIVATE_CONTENT'}]) {
    await f.fetch('/configure',{method:'POST',body:JSON.stringify({observationPeer:'supplied',observationValue:{...valid,...bad}})});
    assert.equal((await f.fetch('/api/ready')).status,200);
    const settled=(await (await f.fetch('/observations')).json()).filter(row=>row.stage==='worker_rpc_settled').at(-1);
    assert.equal(settled.authorityObservation,'invalid');assert.doesNotMatch(JSON.stringify(settled),/PRIVATE_/);
    assert.ok(!Object.keys(settled).some(key=>key.startsWith('authority')&&key!=='authorityObservation'));
  }
});

test('readiness provenance crosses actual Worker-to-ProjectRoom RPC without public diagnostic fields',async t=>{
  const f=await fixture(t,{}),response=await f.fetch('/actual-ready');
  assert.equal(response.status,200);const body=await response.json();assert.doesNotMatch(JSON.stringify(body),/Observation|sourceRevision|buildId/);
  const rows=await (await f.fetch('/observations')).json(),settled=rows.find(row=>row.stage==='worker_rpc_settled');
  assert.equal(settled.authorityObservation,'present');assert.equal(settled.authoritySourceRevision,TEST_SOURCE);assert.equal(settled.authorityBuildId,TEST_BUILD);assert.equal(settled.authoritySqlOutcome,'ok');
  assert.equal(rows.filter(row=>row.stage==='do_entered').length,1);assert.equal(rows.filter(row=>row.stage==='sql_completed').length,1);
});
