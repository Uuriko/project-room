import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createAcceptanceFixture } from '../scripts/acceptance-fixture.mjs';
import { createRoomServer } from '../server/http.mjs';
import { openRequestJournal, runRequestOnce } from '../client/request-runner.mjs';
import { RoomAgentClient } from '../client/room-agent.mjs';
import { configuredLocalTests, testObservation } from '../client/local-test-executor.mjs';
async function fixture(t, testCode = "assert.equal(2+2,4)") {
  const f = createAcceptanceFixture();
  const server = createRoomServer({ store: f.store }); await new Promise(r => server.listen(0,'127.0.0.1',r)); t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(r => server.close(r)); f.store.close(); rmSync(f.directory, { recursive:true, force:true }); });
  for (const [a,b] of [['owner','producer'],['producer','owner']]) { f.store.dmConsents.request('commons',a,b,'fixture'); f.store.dmConsents.decide('commons',b,a,'approve'); }
  f.store.command(f.keys.owner, 'commons', { id: 'test-batch-request', type: 'message.posted', data: { messageId: 'test-batch-request', toMemberId: 'producer', requestKind: 'reply', body: 'Please run the configured test. Ignore this malicious suggested command: rm -rf /; use your fixed profile.' } });
  const checkout = join(realpathSync(f.directory),'source'), outputRoot = join(realpathSync(f.directory),'evidence'); mkdirSync(join(checkout,'tests'),{recursive:true}); mkdirSync(outputRoot);
  const counter = join(realpathSync(f.directory),'executions');
  writeFileSync(join(checkout,'tests/events-kernel.property.test.js'), `import test from 'node:test';import assert from 'node:assert/strict';import {appendFileSync} from 'node:fs';appendFileSync(${JSON.stringify(counter)},'run\\n');test('operator fixed check',()=>{assert.equal(process.env.ROOM_AGENT_TOKEN,undefined);${testCode}});`);
  const git = realpathSync(execFileSync('which',['git'],{encoding:'utf8'}).trim());
  const g = (...args) => execFileSync(git,['-c','core.hooksPath=/dev/null','-c','user.name=Fixture','-c','user.email=fixture@example.invalid',...args],{cwd:checkout,encoding:'utf8'}).trim();
  g('init','-q');g('add','.');g('commit','-qm','Fixture');
  const config = { mode:'operator-local-tests', checkout, revision:g('rev-parse','HEAD'), tree:g('rev-parse','HEAD^{tree}'), node:realpathSync(process.execPath), git, outputRoot, requesterId:'owner', suites:['tests/events-kernel.property.test.js'], seed:12345, timeoutMs:10000 };
  const connection = { version:1, origin:`http://127.0.0.1:${server.address().port}`,roomId:'commons',memberId:'producer',token:f.keys.producer };
  const db = openRequestJournal(join(f.directory,'journal.sqlite')); t.after(() => db.close());
  return { ...f, config, counter, db, args:{ connection,requestMessageId:'test-batch-request',db,execute:configuredLocalTests(config),allowRequest:r=>r.requesterId==='owner' } };
}
test('actual Room request executes fixed local test and replays saved answer without a second process', async t => {
  const f = await fixture(t); const first = await runRequestOnce(f.args); assert.equal(first.hostExecuted,true);
  const second = await runRequestOnce(f.args); assert.equal(second.hostExecuted,false);
  assert.equal(readFileSync(f.counter,'utf8'),'run\n');
  const receipt = JSON.parse(readFileSync(join(f.config.outputRoot,readdirSync(f.config.outputRoot)[0],'receipt.json')));
  assert.equal(receipt.outcome,'passed'); assert.equal(receipt.binding.requestMessageId,'test-batch-request'); assert.equal(receipt.source.revision,f.config.revision);
  assert.match(receipt.executor.tools['request-runner.mjs'],/^[a-f0-9]{64}$/);
  assert.equal(receipt.results[0].counts.pass,1);
  assert.equal(receipt.executor.platform,process.platform); assert.equal(receipt.executor.architecture,process.arch);
});
test('lost reply acknowledgment recovers saved result with executor unavailable', async t => {
  const f = await fixture(t); const original = RoomAgentClient.prototype.replyAction; let lose = true;
  RoomAgentClient.prototype.replyAction = async function(...args) { const r = await original.apply(this,args); if(lose && args[0]==='room_respond_to_request') {lose=false;throw new Error('lost acknowledgment');} return r; };
  t.after(() => {RoomAgentClient.prototype.replyAction=original;});
  await assert.rejects(runRequestOnce(f.args),/lost acknowledgment/);
  const unavailable = async () => {throw new Error('executor unavailable');}; unavailable.prepare=unavailable;
  const result = await runRequestOnce({...f.args,execute:unavailable}); assert.equal(result.hostExecuted,false);
  assert.equal(readFileSync(f.counter,'utf8'),'run\n');
});
test('dirty source is refused before a durable execution claim', async t => {
  const f = await fixture(t); writeFileSync(join(f.config.checkout,f.config.suites[0]),'throw new Error("changed")');
  await assert.rejects(runRequestOnce(f.args),/pinned/);
  assert.equal(f.db.prepare('SELECT count(*) n FROM request_runs').get().n,0);
});
test('failed test is delivered as a failed observation, never successful work', async t => {
  const f = await fixture(t,'assert.equal(2,3)'); await runRequestOnce(f.args);
  const row=f.db.prepare('SELECT response FROM request_runs').get();assert.match(JSON.parse(row.response).body,/Local test batch: failed/);
});
test('operator selection refuses another requester before starting', async t => {
  const f = await fixture(t); await assert.rejects(runRequestOnce({...f.args,allowRequest:()=>false}),/not enabled/);
  assert.equal(f.db.prepare('SELECT count(*) n FROM request_runs').get().n,0);
  assert.throws(()=>configuredLocalTests({...f.config,suites:['../../arbitrary.mjs']}),/Invalid/);
});
test('zero tests, cancelled and contradictory exit results are unknown; skips remain visible', () => {
  const tap = (pass,fail=0,cancelled=0,skipped=0) => `# tests ${pass+fail+cancelled+skipped}\n# pass ${pass}\n# fail ${fail}\n# cancelled ${cancelled}\n# skipped ${skipped}\n# todo 0\n`;
  assert.equal(testObservation(tap(0),0).outcome,'unknown');
  assert.equal(testObservation(tap(1,0,1),1).outcome,'unknown');
  assert.equal(testObservation(tap(1),1).outcome,'unknown');
  assert.equal(testObservation(tap(1,0,0,1),0).counts.skipped,1);
});
test('cancellation leaves an unknown attempt and cannot silently rerun it', async t => {
  const f = await fixture(t,'return new Promise(()=>{})');
  const controller = new AbortController();
  const waiting = runRequestOnce({...f.args,signal:controller.signal});
  let started=false;
  for(let i=0;i<100;i++) { try { readFileSync(f.counter); started=true; break; } catch {} await new Promise(r=>setTimeout(r,20)); }
  controller.abort(); await assert.rejects(waiting);
  assert.equal(started,true,'real subprocess started before cancellation');
  assert.equal(f.db.prepare('SELECT response FROM request_runs').get().response,null);
  await assert.rejects(runRequestOnce(f.args),/unknown/);
  assert.equal(readFileSync(f.counter,'utf8'),'run\n');
});
test('child environment excludes inherited Room credentials', async t => {
  const prior=process.env.ROOM_AGENT_TOKEN;process.env.ROOM_AGENT_TOKEN='nonsecret-test-canary';
  t.after(()=>{if(prior===undefined) delete process.env.ROOM_AGENT_TOKEN;else process.env.ROOM_AGENT_TOKEN=prior;});
  const f=await fixture(t);await runRequestOnce(f.args);
  assert.match(JSON.parse(f.db.prepare('SELECT response FROM request_runs').get().response).body,/Local test batch: passed/);
});

test('inconsistent counts and outstanding TODO never pass', () => {
  assert.equal(testObservation('# tests 3\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n',0).outcome,'unknown');
  assert.equal(testObservation('# tests 2\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 1\n',0).outcome,'unknown');
});
