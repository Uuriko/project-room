// Real HTTP controls and real descendant processes: a stopped host must stop
// execution, not merely suppress its eventual message.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createAcceptanceFixture } from '../scripts/acceptance-fixture.mjs';
import { createRoomServer } from '../server/http.mjs';
import { commandExecutor, createRoomClient, runHostOnce } from '../scripts/room-assistant-scratch.mjs';
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { if (e.code === 'ESRCH') return false; throw e; } };
async function until(fn, message, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await delay(20); }
  assert.fail(message);
}
async function setup(t) {
  const f = createAcceptanceFixture();
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.store.close(); });
  const client = actor => createRoomClient({ origin: `http://127.0.0.1:${server.address().port}`, roomId: 'commons', token: f.keys[actor] });
  const owner = client('owner'), producer = client('producer');
  await owner.act({ action: 'configure', requestId: 'config', name: 'Room', coordinatorMemberId: 'producer', expectedRevision: 0 });
  await owner.post('ask', 'Original instructions');
  await owner.act({ action: 'invoke', requestId: 'invoke', runId: 'run', sourceMessageId: 'ask' });
  return { f, server, owner, producer, current: async () => (await owner.assistant()).runs.find(run => run.id === 'run') };
}
async function slowCommand(t, directory) {
  const marker = join(directory, 'descendant.pid'), script = join(directory, 'executor.mjs');
  await writeFile(script, `import {spawn} from 'node:child_process';
let text=''; process.stdin.on('data',x=>text+=x).on('end',()=>{
 const brief=JSON.parse(text);
 if(brief.inputs.length>1){console.log('Revised answer: '+brief.inputs.at(-1).body);return;}
 const source="const fs=require('node:fs');process.on('SIGTERM',()=>{});fs.writeFileSync("+JSON.stringify(${JSON.stringify(marker)})+",String(process.pid));setTimeout(()=>{console.log('Old answer');process.exit(0)},10000)";
 const child=spawn(process.execPath,['-e',source],{stdio:['ignore','inherit','inherit']});
 child.on('close',()=>process.exit(0));
});`);
  let pid;
  t.after(() => { if (pid && alive(pid)) process.kill(pid, 'SIGKILL'); });
  return { command: `${quote(process.execPath)} ${quote(script)}`, ready: async () => {
    await until(async () => { try { pid = Number(await readFile(marker, 'utf8')); return Boolean(pid); } catch (e) { if (e.code === 'ENOENT') return false; throw e; } }, 'executor descendant started');
    return pid;
  } };
}
for (const action of ['cancel', 'pause', 'contribute', 'replace', 'delete']) test(`in-flight ${action} stops the old executor tree before acknowledging or recomputing`, { skip: process.platform === 'win32' }, async t => {
  const { f, owner, producer, current } = await setup(t);
  const child = await slowCommand(t, f.directory);
  const execute = commandExecutor(child.command, { timeoutMs: 15000 });
  const pass = runHostOnce(producer, { memberId: 'producer', execute, controlPollMs: 25 });
  // Always drain the host on a failed assertion; process cleanup is also bounded.
  t.after(async () => { await pass.catch(() => {}); });
  const pid = await child.ready();
  const before = await current();
  if (action === 'contribute') await owner.post('new-input', 'Use the new instructions');
  if (action === 'replace') await owner.act({ action: 'configure', requestId: 'replace', name: 'Room', coordinatorMemberId: null, expectedRevision: 1 });
  else if (action === 'delete') f.store.command(f.keys.owner, 'commons', { id: 'delete', type: 'message.deleted', data: { messageId: 'ask', expectedMessageRevision: 0 } });
  else await owner.act({ action, requestId: 'control', runId: 'run', expectedRevision: before.revision, ...(action === 'contribute' ? { sourceMessageId: 'new-input' } : {}) });
  await until(() => !alive(pid), 'old executor is still running after the human changed or stopped the request', 3000);
  const { outcomes } = await pass;
  const final = await current();
  assert.equal(final.status, ['cancel', 'delete'].includes(action) ? 'cancelled' : ['pause', 'replace'].includes(action) ? 'paused' : 'done');
  assert.equal(outcomes[0].state, final.status);
  const answers = (await owner.recent()).filter(message => message.authorId === 'producer');
  assert.equal(answers.length, action === 'contribute' ? 1 : 0);
  if (answers.length) assert.match(answers[0].body, /Revised answer: Use the new instructions/);
});

test('executor timeout kills an uncooperative descendant before rejecting', { skip: process.platform === 'win32' }, async t => {
  const { f } = await setup(t);
  const child = await slowCommand(t, f.directory);
  const result = commandExecutor(child.command, { timeoutMs: 1000 })({ inputs: [] });
  const rejection = assert.rejects(result, /timed out/);
  const pid = await child.ready();
  await rejection;
  await until(() => !alive(pid), 'timed-out executor left a descendant alive', 2000);
});


test('losing the control connection stops local execution without claiming server cancellation', { skip: process.platform === 'win32' }, async t => {
  const { f, server, producer } = await setup(t);
  const child = await slowCommand(t, f.directory);
  const pass = runHostOnce(producer, { memberId: 'producer', execute: commandExecutor(child.command), controlPollMs: 25 });
  const rejected = assert.rejects(pass, /fetch failed/);
  const pid = await child.ready();
  server.closeStreams(); server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await until(() => !alive(pid), 'executor kept running without its control connection', 3000);
  await rejected;
  const saved = JSON.parse(f.store.db.prepare("SELECT value FROM room_assistant_runs WHERE room_id='commons' AND run_id='run'").get().value);
  assert.equal(saved.status, 'working', 'local termination is not a fabricated server acknowledgement');
  assert.equal(saved.resultMessageId, undefined);
});

test('a custom executor must settle before the host acknowledges Stop', async t => {
  const { owner, producer, current } = await setup(t);
  let release, signal;
  const execute = (_brief, options) => { signal = options?.signal; return new Promise(resolve => { release = resolve; }); };
  const pass = runHostOnce(producer, { memberId: 'producer', execute, controlPollMs: 25 });
  t.after(async () => { release?.('Late output'); await pass.catch(() => {}); });
  await until(() => Boolean(release), 'custom executor started');
  await owner.act({ action: 'cancel', requestId: 'stop-custom', runId: 'run', expectedRevision: (await current()).revision });
  await until(() => signal?.aborted, 'custom executor did not receive cancellation');
  assert.equal((await current()).status, 'cancel_requested', 'signalling is not confirmation of stopped execution');
  release('Late output');
  assert.equal((await pass).outcomes[0].state, 'cancelled');
  assert.equal((await owner.recent()).filter(message => message.authorId === 'producer').length, 0);
});
for (const shutdown of ['SIGINT', 'SIGTERM']) test(`host ${shutdown} waits for resistant descendant cleanup`, { skip: process.platform === 'win32' }, async t => {
  const { spawn } = await import('node:child_process');
  const { f, server } = await setup(t);
  const child = await slowCommand(t, f.directory);
  await writeFile(join(f.directory, 'connection.json'), JSON.stringify({ origin: `http://127.0.0.1:${server.address().port}`, roomId: 'commons', token: f.keys.producer, memberId: 'producer' }));
  const host = spawn(process.execPath, ['scripts/room-assistant-scratch.mjs', 'host', '--config', f.directory, '--exec', child.command], { stdio: 'ignore' });
  t.after(() => { if (host.exitCode === null) host.kill('SIGKILL'); });
  const exited = new Promise(resolve => host.once('exit', (code, signal) => resolve({ code, signal })));
  const pid = await child.ready(); host.kill(shutdown);
  await exited;
  assert.equal(alive(pid), false, 'host exited before owned descendant stopped');
});
for (const when of ['running', 'brief']) test(`HTTP execution permission removal during ${when} prevents continued effects`, { skip: process.platform === 'win32' }, async t => {
  const { f, producer, current } = await setup(t);
  const child = await slowCommand(t, f.directory); let calls = 0;
  const revoke = () => f.store.command(f.keys.owner, 'commons', { id: `revoke-${when}`, type: 'member.access_changed', data: { memberId: 'producer', expectedMemberRevision: 0, permissions: ['complete_work'], active: true } });
  if (when === 'brief') { const message = producer.message; producer.message = async id => { const result = await message(id); revoke(); return result; }; }
  const execute = commandExecutor(child.command, { timeoutMs: 15000 });
  const pass = runHostOnce(producer, { memberId: 'producer', controlPollMs: 25, execute: (...args) => { calls++; return execute(...args); } });
  const settled = pass.catch(() => {}); t.after(() => settled);
  if (when === 'running') { const pid = await child.ready(); revoke(); await until(() => !alive(pid), 'revoked executor continues', 2500); }
  else { await Promise.race([settled, delay(600)]); assert.equal(calls, 0, 'revoked executor launched during brief'); }
  assert.equal((await current()).resultMessageId ?? null, null);
});

for (const status of [429, 503]) test(`first ${status} control read stops execution without an automatic retry`, async t => {
  const { producer, current } = await setup(t); const read = producer.assistant; let reads = 0, starts = 0, stopped = false;
  producer.assistant = async options => { if (++reads === 3) throw Object.assign(new Error("Control read unavailable"), { status }); return read(options); };
  const execute = (_brief, { signal }) => { starts++; return new Promise((_resolve, reject) => signal.addEventListener('abort', () => { stopped = true; reject(signal.reason); }, { once: true })); };
  const result = await runHostOnce(producer, { memberId: 'producer', execute, controlPollMs: 10 });
  assert.equal(stopped, true); assert.equal(starts, 1); assert.equal(result.outcomes[0].state, 'failed');
  assert.equal((await current()).resultMessageId ?? null, null);
});
