import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, chmodSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { openEvolution, digest, events } from '../client/evolution/store.mjs';
import { installPackage, activate, activation, evaluate, rollback } from '../client/evolution/registry.mjs';
import { configure, submit, runJob, getJob, admission, cancel, reconcile, feedback } from '../client/evolution/executor.mjs';
import { parseCapabilityTask, prefix } from '../client/evolution/room-bridge.mjs';

const memory = 64 * 1024 ** 2;
const source = `import {readFileSync,writeFileSync} from 'node:fs'; import {join} from 'node:path'; const input=JSON.parse(readFileSync(process.env.ROOM_TASK_INPUT)); writeFileSync(join(process.env.ROOM_TASK_OUTPUT,'result.json'),JSON.stringify(input));`;
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'evolution-')); const store = openEvolution(join(directory, 'state'));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  configure(store, { rooms: ['one', 'two'], capabilities: ['verify'], maxJobs: 1, cpuSlots: 2, memoryBytes: memory * 2, reserveMemoryBytes: 0, paused: false });
  function install(version = 'v1', code = source, timeoutMs = 2000) {
    const path = join(directory, version + '.mjs'); writeFileSync(path, code);
    const manifest = { schema: 1, capability: 'verify', version, runtime: process.version, resources: { cpu: 1, memoryBytes: memory },
      files: [{ path: version + '.mjs', sha256: digest(code) }], steps: [{ id: 'verify', module: version + '.mjs', args: [], timeoutMs }] };
    return { ...installPackage(store, directory, manifest), manifest, path };
  }
  const first = install(); activate(store, { capability: 'verify', hash: first.hash, expectedRevision: 0, bootstrap: true, reason: 'local install' });
  const job = (operation, input = { value: 1 }, extra = {}) => submit(store, { room: 'one', operation, capability: 'verify', input, ...extra });
  const observation = () => ({ at: Date.now(), cpuSlots: 8, memoryBytes: memory * 20 });
  const run = id => runJob(store, id, { observation: observation() });
  return { store, directory, install, first, job, run, observation };
}
test('operation replay preserves immutable pin and rejects changed input', t => {
  const f = fixture(t), job = f.job('same'); const v2 = f.install('v2', source + '\n// v2');
  assert.equal(f.job('same').id, job.id);
  assert.throws(() => f.job('same', { value: 2 }), /payload_changed/);
  assert.throws(() => activate(f.store, { capability: 'verify', hash: v2.hash, expectedRevision: 1, reason: 'unverified' }), /evaluation_required/);
  assert.equal(getJob(f.store, job.id).pin, f.first.hash);
});
test('durable success replay never executes again and event cursors resume', async t => {
  const f = fixture(t), job = f.job('one'); const first = await f.run(job.id);
  assert.equal(first.job.state, 'completed'); assert.equal(first.job.attempt, 1);
  assert.equal((await f.run(job.id)).claimed, false);
  const other = openEvolution(join(f.directory, 'state')); t.after(() => other.close());
  assert.equal(getJob(other, job.id).result.artifactDigest, first.job.result.artifactDigest);
  const page = events(f.store, 0, 2); assert.equal(page.items.length, 2); assert.ok(events(f.store, page.after).items.every(e => e.seq > page.after));
});
test('two rooms and independent broker connections cannot double-admit', async t => {
  const f = fixture(t), slow = f.install('slow', 'await new Promise(r=>setTimeout(r,500));' + source);
  const a = f.job('a', {}, { candidateHash: slow.hash }), b = f.job('b', {}, { room: 'two' });
  const other = openEvolution(join(f.directory, 'state')); t.after(() => other.close());
  const running = f.run(a.id); await delay(30);
  const blocked = await runJob(other, b.id, { observation: f.observation() });
  assert.equal(blocked.claimed, false); assert.equal(blocked.reason, 'resources_reserved');
  assert.equal((await running).job.state, 'completed'); assert.equal((await f.run(b.id)).job.state, 'completed');
});
test('cancellation kills active step and preserves terminal evidence', async t => {
  const f = fixture(t), slow = f.install('slow', 'await new Promise(r=>setTimeout(r,10000));' + source);
  const job = f.job('cancel', {}, { candidateHash: slow.hash }); const running = f.run(job.id);
  await delay(40); assert.equal(cancel(f.store, job.id).state, 'cancelling');
  const result = await running; assert.equal(result.job.state, 'cancelled'); assert.equal(result.job.result.passed, false);
});
test('expired heartbeat does not silently free unknown external execution', t => {
  const f = fixture(t), a = f.job('a'), b = f.job('b');
  f.store.db.prepare("UPDATE jobs SET state='running',owner='old',attempt=1,heartbeat=1 WHERE id=?").run(a.id);
  assert.equal(admission(f.store, b, f.observation()).allowed, false);
  assert.throws(() => reconcile(f.store, a.id, { owner: 'wrong', attempt: 1, processesStopped: true, reason: 'checked' }), /conflict/);
  assert.throws(() => reconcile(f.store, a.id, { owner: 'old', attempt: 1, processesStopped: false, reason: 'guess' }), /evidence/);
  reconcile(f.store, a.id, { owner: 'old', attempt: 1, processesStopped: true, reason: 'local process checked stopped' });
  assert.equal(admission(f.store, b, f.observation()).allowed, true); assert.equal(getJob(f.store, a.id).state, 'needs_attention');
});
test('two distinct replay cases gate canary/promotion and old queued job stays pinned', async t => {
  const f = fixture(t), old = f.job('old'), v2 = f.install('v2', source + '\n// implementation v2'); const pairs = [];
  for (let i = 0; i < 2; i++) {
    const a = f.job('a' + i, { i }), b = f.job('b' + i, { i }, { candidateHash: v2.hash }); await f.run(a.id); await f.run(b.id);
    pairs.push({ baselineJob: a.id, candidateJob: b.id });
  }
  assert.throws(() => evaluate(f.store, { capability: 'verify', baseline: f.first.hash, candidate: v2.hash, pairs: [pairs[0], pairs[0]] }), /distinct/);
  assert.equal(evaluate(f.store, { capability: 'verify', baseline: f.first.hash, candidate: v2.hash, pairs }).passed, true);
  activate(f.store, { capability: 'verify', hash: v2.hash, expectedRevision: 1, percent: 10, reason: 'canary' });
  assert.equal(activation(f.store, 'verify').candidate, v2.hash);
  activate(f.store, { capability: 'verify', hash: v2.hash, expectedRevision: 2, reason: 'promote' });
  assert.equal(f.job('new').pin, v2.hash);
  assert.equal(rollback(f.store, { capability: 'verify', expectedRevision: 3, reason: 'operator rollback' }).current, f.first.hash);
  assert.equal(f.job('after-rollback').pin, f.first.hash); assert.equal(getJob(f.store, old.id).pin, f.first.hash);
  assert.throws(() => activate(f.store, { capability: 'verify', hash: v2.hash, expectedRevision: 2, reason: 'stale' }), /conflict/);
});
test('changed artifacts fail evaluation despite successful script exits', async t => {
  const f = fixture(t), bad = f.install('bad', source.replace('JSON.stringify(input)', 'JSON.stringify({wrong:true})')), pairs = [];
  for (let i = 0; i < 2; i++) { const a = f.job('a' + i, { i }), b = f.job('b' + i, { i }, { candidateHash: bad.hash }); await f.run(a.id); await f.run(b.id); pairs.push({ baselineJob: a.id, candidateJob: b.id }); }
  assert.equal(evaluate(f.store, { capability: 'verify', baseline: f.first.hash, candidate: bad.hash, pairs }).passed, false);
  assert.throws(() => activate(f.store, { capability: 'verify', hash: bad.hash, expectedRevision: 1, reason: 'bad' }), /evaluation_required/);
});
test('installed byte tampering and source symlinks are rejected before execution', async t => {
  const f = fixture(t), job = f.job('tamper'); const installed = join(f.store.directory, 'packages', f.first.hash, 'v1.mjs');
  chmodSync(installed, 0o600); writeFileSync(installed, 'process.exit(0)'); await assert.rejects(f.run(job.id), /installed_package_changed/);
  assert.equal(getJob(f.store, job.id).state, 'queued');
  symlinkSync(f.first.path, join(f.directory, 'link.mjs'));
  assert.throws(() => installPackage(f.store, f.directory, { ...f.first.manifest, files: [{ path: 'link.mjs', sha256: digest(source) }] }), /unsafe_package_file/);
});
test('pause, scope, stale measurements, feedback and command-shaped input boundaries', t => {
  const f = fixture(t), job = f.job('one');
  assert.throws(() => f.job('wrong', {}, { room: 'other' }), /not_authorized/);
  assert.equal(admission(f.store, job, { ...f.observation(), at: 1 }).reason, 'stale_resources');
  const p = JSON.parse(f.store.db.prepare("SELECT value FROM settings WHERE id='policy'").get().value); configure(f.store, { ...p, paused: true });
  assert.equal(admission(f.store, job, f.observation()).reason, 'paused');
  assert.equal(feedback(f.store, job.id, { category: 'slow', note: 'this task' }).preferenceChanged, false);
  assert.throws(() => parseCapabilityTask(prefix + JSON.stringify({ version: 1, capability: 'verify', input: {}, command: 'echo hi' })), /invalid_capability_task/);
  assert.equal(readFileSync(f.first.path, 'utf8'), source);
});

test('real Room request executes once and lost reply acknowledgement reconciles', async t => {
  const { createAcceptanceFixture } = await import('../scripts/acceptance-fixture.mjs');
  const { createRoomServer } = await import('../server/http.mjs');
  const { RoomAgentClient } = await import('../client/room-agent.mjs');
  const { runRoomCapability } = await import('../client/evolution/room-bridge.mjs');
  const f = fixture(t), room = createAcceptanceFixture(), server = createRoomServer({ store: room.store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(r => server.close(r)); room.store.close(); rmSync(room.directory, { recursive: true, force: true }); });
  for (const [from, to] of [['owner', 'producer'], ['producer', 'owner']]) { room.store.dmConsents.request('commons', from, to, 'fixture'); room.store.dmConsents.decide('commons', to, from, 'approve'); }
  const origin = `http://127.0.0.1:${server.address().port}`;
  const connection = { origin, roomId: 'commons', memberId: 'producer', token: room.keys.producer };
  configure(f.store, { rooms: ['commons'], capabilities: ['verify'], maxJobs: 1, cpuSlots: 2, memoryBytes: memory * 2, reserveMemoryBytes: 0, paused: false,
    roomGrants: [{ origin, room: 'commons', member: 'producer', requesters: ['owner'], capabilities: ['verify'] }] });
  room.store.command(room.keys.owner, 'commons', { id: 'evolution-request', type: 'message.posted', data: { messageId: 'evolution-request', toMemberId: 'producer', requestKind: 'reply', body: prefix + JSON.stringify({ version: 1, capability: 'verify', input: { value: 7 } }) } });
  let lost = false;
  const flaky = { ...connection, fetchImpl: async (url, options) => {
    const response = await fetch(url, options);
    if (!lost && options.method === 'POST' && url.endsWith('/commands') && options.body.includes('"responseOutcome"')) { lost = true; throw new TypeError('lost acknowledgement'); }
    return response;
  } };
  await assert.rejects(runRoomCapability(f.store, { connection: flaky, requestMessageId: 'evolution-request', observeResources: f.observation }), /lost acknowledgement/);
  const replay = await runRoomCapability(f.store, { connection, requestMessageId: 'evolution-request', observeResources: f.observation });
  assert.equal(replay.hostExecuted, false); assert.equal(replay.receipt.duplicate, true);
  assert.equal(f.store.db.prepare('SELECT SUM(attempt) AS count FROM jobs').get().count, 1);
  assert.equal((await new RoomAgentClient(connection).replyContext('evolution-request')).request.status, 'answered');
  room.store.command(room.keys.owner, 'commons', { id: 'evolution-crash', type: 'message.posted', data: { messageId: 'evolution-crash', toMemberId: 'producer', requestKind: 'reply', body: prefix + JSON.stringify({ version: 1, capability: 'verify', input: { value: 8 } }) } });
  const interrupted = { ...connection, fetchImpl: async (url, options) => {
    if (options.method === 'POST' && url.endsWith('/request-runs') && JSON.parse(options.body).action === 'result_ready')
      return new Response(JSON.stringify({ error: 'injected interruption' }), { status: 409, headers: { 'content-type': 'application/json' } });
    return fetch(url, options);
  } };
  await assert.rejects(runRoomCapability(f.store, { connection: interrupted, requestMessageId: 'evolution-crash', observeResources: f.observation }));
  const { openRequestJournal } = await import('../client/request-runner.mjs');
  const journal = openRequestJournal(join(f.store.directory, 'room-requests.sqlite'));
  journal.prepare("UPDATE request_runs SET response=NULL WHERE json_extract(response,'$.responseToRequestId')=?").run('evolution-crash'); journal.close();
  const recovered = await runRoomCapability(f.store, { connection, requestMessageId: 'evolution-crash', observeResources: f.observation });
  assert.equal(recovered.hostExecuted, false); assert.equal(recovered.status, 'delivered');
  assert.equal(f.store.db.prepare('SELECT SUM(attempt) AS count FROM jobs').get().count, 2);

});


test('worker process death retains reservation until the orphan is explicitly stopped', async t => {
  const f = fixture(t), slow = f.install('crash', "import {writeFileSync} from 'node:fs'; import {join} from 'node:path'; writeFileSync(join(process.env.ROOM_TASK_OUTPUT,'pid'),String(process.pid)); setInterval(()=>{},1000);", 10000);
  const job = f.job('crash', {}, { candidateHash: slow.hash });
  const code = `import {openEvolution} from './client/evolution/store.mjs'; import {runJob} from './client/evolution/executor.mjs'; const store=openEvolution(${JSON.stringify(f.store.directory)}); await runJob(store,${JSON.stringify(job.id)},{observation:{at:Date.now(),cpuSlots:8,memoryBytes:1073741824}});store.close();`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: 'ignore' });
  const closed = new Promise(resolve => child.once('close', resolve));
  let modulePid;
  t.after(() => { try { child.kill('SIGKILL'); } catch {} if(modulePid) { try { process.kill(-modulePid,'SIGKILL'); } catch {} } });
  for(let i=0;i<250;i++) {
    try { modulePid=Number(readFileSync(join(f.store.directory,'runs',job.id,'1','artifacts','pid'),'utf8')); if(modulePid>0) break; await delay(20); } catch { await delay(20); }
  }
  assert.ok(modulePid); child.kill('SIGKILL'); await closed;
  const interrupted=getJob(f.store,job.id); assert.equal(interrupted.state,'running');
  const second=f.job('waiting'); assert.equal(admission(f.store,second,f.observation()).allowed,false);
  assert.equal((await f.run(job.id)).claimed,false);
  process.kill(-modulePid,'SIGKILL');
  reconcile(f.store,job.id,{owner:interrupted.owner,attempt:interrupted.attempt,processesStopped:true,reason:'test killed recorded child process group'});
  assert.equal(admission(f.store,second,f.observation()).allowed,true);
});

test('timeout stops dependent steps and failures return inspectable evidence', async t => {
  const f = fixture(t), bad = f.install('timeout', 'setInterval(()=>{},1000);', 40);
  const job = f.job('timeout', {}, { candidateHash: bad.hash });
  const result = await f.run(job.id);
  assert.equal(result.job.state, 'needs_attention');
  assert.equal(result.job.result.steps[0].reason, 'timeout');
  assert.equal(result.job.result.passed, false);
});
