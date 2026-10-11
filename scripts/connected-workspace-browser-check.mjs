import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { createAcceptanceFixture } from './acceptance-fixture.mjs';
import { signInFixture } from './auth-signin.mjs';
import { createRoomServer } from '../server/http.mjs';
import { saveAgentConnection } from '../client/agent-connection.mjs';

// The provider is the only fake boundary. Browser, server, CLI child, runtime
// subprocess, durable journals, Stop and final publication are real.
test('browser asks are picked up automatically, Stop reaches the runtime, restart does not duplicate results', { timeout: 60000 }, async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'room-connected-')));
  const home = join(root, 'profile'), cwd = join(root, 'workspace');
  mkdirSync(home, { mode: 0o700 }); mkdirSync(cwd);
  const audit = join(root, 'provider-state.json'), executable = join(root, 'fixture-provider');
  writeFileSync(audit, JSON.stringify({ threads: {}, starts: 0, interrupts: 0 }));
  writeFileSync(executable, `#!${process.execPath}
import readline from 'node:readline';
import {readFileSync,writeFileSync} from 'node:fs';
const file=${JSON.stringify(audit)}, send=v=>process.stdout.write(JSON.stringify(v)+'\\n');
const load=()=>JSON.parse(readFileSync(file)), save=v=>writeFileSync(file,JSON.stringify(v));
readline.createInterface({input:process.stdin}).on('line',line=>{
  const m=JSON.parse(line); if(m.method==='initialized')return;
  if(m.id==null)throw Error('Unexpected notification');
  const d=load(), p=m.params??{};let result;
  switch(m.method){
    case 'initialize':result={};break;
    case 'account/read':result={account:null,requiresOpenaiAuth:true};break;
    case 'thread/start':{const id='thread-'+Object.keys(d.threads).length;d.threads[id]={id,turns:[]};result={thread:d.threads[id]};break;}
    case 'thread/name/set':result={};break;
    case 'thread/read':case 'thread/resume':if(!d.threads[p.threadId])throw Error('Unknown thread');result={thread:d.threads[p.threadId]};break;
    case 'turn/start':{
      const thread=d.threads[p.threadId];if(!thread)throw Error('Unknown thread');
      d.starts++;const turn={id:'turn-'+d.starts,status:'inProgress',items:[]};thread.turns.push(turn);save(d);
      send({id:m.id,result:{turn}});
      if(d.starts!==2)setTimeout(()=>{const current=load(),last=current.threads[p.threadId].turns.at(-1);last.status='completed';last.items=[{id:'answer-'+last.id,type:'agentMessage',phase:'final_answer',text:'Connected workspace result '+last.id}];save(current);send({method:'turn/completed',params:{threadId:p.threadId,turn:last}});},30);
      return;
    }
    case 'turn/interrupt':{const turn=d.threads[p.threadId]?.turns.find(v=>v.id===p.turnId);if(!turn)throw Error('Unknown turn');turn.status='interrupted';d.interrupts++;save(d);send({method:'turn/completed',params:{threadId:p.threadId,turn}});result={};break;}
    default:throw Error('Unknown method '+m.method);
  }
  save(d);send({id:m.id,result});
});`);
  chmodSync(executable, 0o700);
  const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store, streamInterval: 40 });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`, connection = join(root, 'connection');
  saveAgentConnection(connection, { version: 1, origin, roomId: 'commons', memberId: 'producer', token: f.keys.producer });
  const config = join(root, 'runtime.json'), journal = join(root, 'journal.sqlite');
  writeFileSync(config, JSON.stringify({ command: executable, cwd, codexHome: home, policy: { approvalPolicy: 'never', sandbox: 'read-only' } }));
  const browser = await chromium.launch({ headless: true }), page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  let child, ended, output = '', stderr = '';
  const stop = async () => { if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); if (ended) await ended; child = null; };
  t.after(async () => { await stop(); await browser.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.store.close(); rmSync(root, { recursive: true, force: true }); rmSync(f.directory, { recursive: true, force: true }); });
  const until = async predicate => { const end = Date.now() + 12000; while (!await predicate()) { assert.ok(Date.now() < end, `Timed out; host stderr: ${stderr}`); await delay(25); } };
  const start = async () => {
    output = ''; stderr = '';
    child = spawn(process.execPath, ['scripts/run-codex-room.mjs', '--watch', journal, config], { env: { PATH: process.env.PATH, ROOM_AGENT_CONFIG: connection }, stdio: ['ignore', 'pipe', 'pipe'] });
    ended = once(child, 'exit'); child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    await until(() => output.includes('watching_room'));
  };
  const api = async () => {
    const response = await fetch(`${origin}/api/rooms/commons/assistant`, { headers: { authorization: `Bearer ${f.keys.owner}` } });
    assert.ok(response.ok); return response.json();
  };
  await page.goto(origin); await signInFixture(page, f.keys.owner); await page.locator('#main').waitFor({ state: 'visible' });
  await page.locator('#assistant-setup').click();
  await page.locator('#room-assistant-setup select').selectOption('producer');
  await page.locator('#room-assistant-setup button[type=submit]').click();
  await page.locator('#room-assistant-setup').waitFor({ state: 'hidden' });
  const ask = async text => { await page.locator('#ask-room').click(); await page.locator('#message-input').fill(text); await page.locator('#message-form button[type=submit]').click(); };
  await start();
  await ask('Run the first connected workspace check.');
  await until(async () => (await api()).runs.some(run => run.status === 'done'));
  await page.locator('#assistant-face').getByRole('button', { name: 'Open result', exact: true }).click();
  await page.getByText('Connected workspace result turn-1', { exact: true }).waitFor();
  assert.equal(f.store.room('commons').state.messages.filter(m => m.body === 'Connected workspace result turn-1').length, 1);
  // Return from result focus before creating the next public ask.
  await page.reload(); await page.locator('#main').waitFor({ state: 'visible' });
  await ask('Run a task that I will stop.');
  await until(() => JSON.parse(readFileSync(audit)).starts === 2);
  const working = (await api()).runs.find(run => run.status === 'working');
  assert.ok(working?.attemptId, 'provider start must belong to a claimed Room attempt');
  // Provider startup precedes the browser's next assistant projection. Stop is
  // fenced to the rendered attempt, so first observe that exact running attempt
  // rather than clicking the still-queued card with expectedAttemptId:null.
  await page.waitForFunction(attemptId => document.querySelector('#assistant-face')?.dataset.attemptId === attemptId, working.attemptId);
  const stopResponse = page.waitForResponse(response => {
    if (!response.url().endsWith('/assistant') || response.request().method() !== 'POST') return false;
    const input = response.request().postDataJSON();
    return input.action === 'cancel' && input.runId === working.id;
  });
  await page.locator('#assistant-face').getByRole('button', { name: 'Stop', exact: true }).click();
  const stopped = await stopResponse;
  assert.equal(stopped.request().postDataJSON().expectedAttemptId, working.attemptId);
  assert.equal(stopped.status(), 200, JSON.stringify(await stopped.json()));
  await until(() => JSON.parse(readFileSync(audit)).interrupts === 1);
  await until(async () => (await api()).runs.some(run => run.status === 'cancelled'));
  await stop(); await start();
  await delay(2200);
  assert.equal(JSON.parse(readFileSync(audit)).starts, 2, 'restart must not rerun completed or cancelled tasks');
  await page.reload(); await page.locator('#main').waitFor({ state: 'visible' });
  await ask('Run another check after reconnecting.');
  await until(async () => (await api()).runs.filter(run => run.status === 'done').length === 2);
  assert.equal(JSON.parse(readFileSync(audit)).starts, 3);
  assert.equal(f.store.room('commons').state.messages.filter(m => m.body.startsWith('Connected workspace result')).length, 2);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: '/tmp/project-room-connected-workspace.png' });
  await stop();
});
