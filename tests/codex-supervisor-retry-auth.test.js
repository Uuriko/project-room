import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { createRoomClient } from "../client/room-assistant-client.mjs";
import { openRequestJournal } from "../client/request-runner.mjs";
import { openCodexStdio, checkCodexProtocol } from "../client/codex-stdio.mjs";
import { superviseCodexRoom, retryDelay } from "../client/codex-supervisor.mjs";
import http from "node:http";

async function fixture(t, mode = "complete") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "room-supervisor-"))), home = join(root, "profile"), cwd = join(root, "workspace");
  mkdirSync(home, { mode: 0o700 }); mkdirSync(cwd);
  const data = join(home, "runtime.json"), command = join(root, "fake-codex");
  writeFileSync(data, JSON.stringify({ threads: {}, starts: 0, interrupted: 0 }));
  writeFileSync(command, `#!${process.execPath}
import readline from 'node:readline'; import {readFileSync,writeFileSync,renameSync,existsSync} from 'node:fs'; import {join} from 'node:path';
const path=join(process.env.CODEX_HOME,'runtime.json'), mode=${JSON.stringify(mode)};
if(!existsSync(path))writeFileSync(path,JSON.stringify({threads:{},starts:0,interrupted:0}));
const load=()=>JSON.parse(readFileSync(path)),save=v=>{const temp=path+'.'+process.pid+'.tmp';writeFileSync(temp,JSON.stringify(v));renameSync(temp,path);},send=v=>process.stdout.write(JSON.stringify(v)+'\\n');
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(!m.id)return;const d=load(),p=m.params||{};let result;
switch(m.method){
case 'initialize':result={};break;
case 'thread/start':{const id='thread-'+Object.keys(d.threads).length;d.threads[id]={id,turns:[]};result={thread:d.threads[id]};break;}
case 'thread/name/set':result={};break;
case 'thread/read':case 'thread/resume':if(!d.threads[p.threadId])throw Error('foreign thread');result={thread:d.threads[p.threadId]};break;
case 'turn/start':{const thread=d.threads[p.threadId];if(!thread)throw Error('foreign start');d.starts++;const turn={id:'turn-'+d.starts,status:'inProgress',items:[]};thread.turns.push(turn);save(d);if(mode==='ambiguous'){process.exit(7);}
result={turn};send({id:m.id,result});if(mode==='complete')setTimeout(()=>{const current=load();const t=current.threads[p.threadId].turns.at(-1);t.status='completed';t.items=[{id:'answer',type:'agentMessage',phase:'final_answer',text:'Finished '+t.id}];save(current);send({method:'turn/completed',params:{threadId:p.threadId,turn:t}});},10);return;}
case 'turn/interrupt':{const turn=d.threads[p.threadId].turns.find(t=>t.id===p.turnId);if(!turn)throw Error('foreign interrupt');turn.status='interrupted';d.interrupted++;save(d);send({method:'turn/completed',params:{threadId:p.threadId,turn}});result={};break;}
default:throw Error('Unexpected RPC '+m.method);}
save(d);send({id:m.id,result});});`);
  chmodSync(command, 0o700);
  const f = createAcceptanceFixture({ dmConsent: true }), server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const connection = { version: 1, origin, roomId: "commons", memberId: "producer", token: f.keys.producer };
  const human = createRoomClient({ ...connection, token: f.keys.owner });
  const owner = { assistant: input => input ? human.act(input) : human.assistant() };
  await owner.assistant({ action: "configure", requestId: randomUUID(), expectedRevision: 0, name: "Room", coordinatorMemberId: "producer" });
  const invoke = async id => {
    f.store.command(f.keys.owner, "commons", { id: randomUUID(), type: "message.posted", data: { messageId: `message-${id}`, body: `Please finish ${id}` } });
    await owner.assistant({ action: "invoke", requestId: randomUUID(), runId: id, sourceMessageId: `message-${id}` });
  };
  const db = openRequestJournal(join(root, "journal.sqlite"));
  const settings = { command, cwd, codexHome: home, policy: { approvalPolicy: "never", sandbox: "read-only" }, requestTimeoutMs: 1000 };
  const directory = join(root, "watch");
  const run = (options = {}) => superviseCodexRoom({ connection, db, directory, cwd, policy: settings.policy, pollMs: 100, retryMaxMs: 400, timeoutMs: 1000,
    connect: async allowedThreadIds => { const rpc = openCodexStdio(settings, { allowedThreadIds }); try { await checkCodexProtocol(rpc, settings, { threadId: allowedThreadIds[0] }); return rpc; } catch (e) { await rpc.close(); throw e; } }, ...options });
  t.after(async () => { db.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, settings, origin, run, invoke, owner, directory, deleteSource: id => f.store.command(f.keys.owner, "commons", { id: randomUUID(), type: "message.deleted", data: { messageId: `message-${id}`, expectedMessageRevision: 0 } }), runtime: () => JSON.parse(readFileSync(data)), db, connection };
}


const sup = (x, conn, name, options = {}) => { const db = openRequestJournal(join(x.root, name + ".sqlite")); return superviseCodexRoom({ connection: conn, db, directory: join(x.root, name + ".watch"), cwd: x.settings.cwd, policy: x.settings.policy, pollMs: 100, retryMaxMs: 400, timeoutMs: 2000,
  connect: async ids => { const rpc = openCodexStdio(x.settings, { allowedThreadIds: ids }); try { await checkCodexProtocol(rpc, x.settings, { threadId: ids[0] }); return rpc; } catch (e) { await rpc.close(); throw e; } }, ...options }).finally(() => db.close()); };
async function proxy(t, x, handle) {
  const server = http.createServer((req, res) => {
    if (handle(req, res)) return;
    const u = new URL(x.origin);
    const p = http.request({ host: u.hostname, port: u.port, path: req.url, method: req.method, headers: { ...req.headers, host: u.host, ...(req.headers.origin ? { origin: x.origin } : {}) } }, r => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    req.pipe(p);
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r)); t.after(() => { server.closeAllConnections(); server.close(); });
  return { ...x.connection, origin: `http://127.0.0.1:${server.address().port}` };
}
const refuse = (res, status, code, headers = {}) => { res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(JSON.stringify({ error: { code, message: code } })); return true; };

test("a room 429 waits at least the server's Retry-After before polling again", async t => {
  const x = await fixture(t); await x.invoke("rl");
  let refusals = 0; const requests = [];
  const conn = await proxy(t, x, (req, res) => refusals < 2 && req.method === "GET" && req.url.includes("assistant") ? (requests.push(performance.now()), refusals++, refuse(res, 429, "rate_limited", { "retry-after": "1" })) : false);
  const c = new AbortController(), events = [];
  await sup(x, conn, "h", { signal: c.signal, emit: e => { events.push(e); if (e.status === "settled") c.abort(); } });
  const waits = events.filter(e => e.status === "retrying_room").map(e => e.retryMs);
  assert.equal(waits.length, 2);
  assert.ok(waits.every(ms => ms >= 1000), `retry waits ignored Retry-After: ${waits}`);
  assert.ok(requests[1] - requests[0] >= 1000, `actual requests were only ${requests[1] - requests[0]}ms apart`);
  assert.equal(x.runtime().starts, 1);
});

test("a permanent room refusal stops with reconnect_agent instead of looping or respawning Codex", async t => {
  const x = await fixture(t); await x.invoke("denied");
  let connects = 0;
  const conn = await proxy(t, x, (req, res) => req.method === "POST" ? refuse(res, 403, "origin_denied") : false);
  const events = [], safety = new AbortController(), timer = setTimeout(() => safety.abort(), 3000);
  await assert.rejects(sup(x, conn, "h", { signal: safety.signal, emit: e => events.push(e),
    connect: async ids => { connects++; const rpc = openCodexStdio(x.settings, { allowedThreadIds: ids }); await checkCodexProtocol(rpc, x.settings, { threadId: ids[0] }); return rpc; } }),
    error => error.code === "reconnect_agent" && error.cause.code === "origin_denied");
  clearTimeout(timer);
  assert.ok(!safety.signal.aborted, "supervisor kept looping until the safety timer");
  assert.equal(connects, 1);
  assert.deepEqual(events.filter(e => e.status === "stopped_auth").map(e => e.action), ["reconnect_agent"]);
  assert.equal(events.filter(e => e.status === "recovery_pending").length, 0);
  assert.equal(x.runtime().starts, 0);
});

test("a claim-side rate limit delays the next Room read and reuses the same local attempt", async t => {
  const x = await fixture(t); await x.invoke("claim-limited");
  let refusedAt, firstReadAfter, claims = 0;
  const attempts = [];
  const conn = await proxy(t, x, (req, res) => {
    if (refusedAt && !firstReadAfter) firstReadAfter = performance.now();
    if (req.method !== "POST" || !req.url.includes("assistant")) return false;
    req.on("data", body => { try { const value = JSON.parse(body); if (value.action === "claim") attempts.push(value.attemptId); } catch { /* chunked body is not a fixture claim */ } });
    if (claims++ > 0) return false;
    refusedAt = performance.now();
    return refuse(res, 429, "rate_limited", { "retry-after": "1" });
  });
  const c = new AbortController(), events = [];
  await sup(x, conn, "claim-rate", { signal: c.signal, emit: e => { events.push(e); if (e.status === "settled") c.abort(); } });
  assert.ok(firstReadAfter - refusedAt >= 1000, `Room was polled after ${firstReadAfter - refusedAt}ms`);
  assert.equal(new Set(attempts).size, 1);
  assert.equal(x.runtime().starts, 1);
  assert.equal(events.filter(e => e.status === "protocol_qualified").length, 1);
});

test("a revoked token on the idle poll also stops with reconnect_agent", async t => {
  const x = await fixture(t);
  const conn = await proxy(t, x, (req, res) => refuse(res, 401, "unauthenticated"));
  const events = [], safety = new AbortController(), timer = setTimeout(() => safety.abort(), 3000);
  await assert.rejects(sup(x, conn, "h", { signal: safety.signal, emit: e => events.push(e) }), error => error.code === "reconnect_agent");
  clearTimeout(timer);
  assert.ok(!safety.signal.aborted);
  assert.equal(events.filter(e => e.status === "retrying_room").length, 0);
});

test("two hosts on one member: each ask runs once and the losing host keeps its runtime warm", async t => {
  const x = await fixture(t); for (const id of ["a1", "a2", "a3"]) await x.invoke(id);
  const c = new AbortController(), events = [], connects = { A: 0, B: 0 };
  const opts = who => ({ signal: c.signal, emit: e => { events.push({ who, ...e }); if (events.filter(v => v.status === "settled").length >= 3) c.abort(); },
    connect: async ids => { connects[who]++; const own = profile(who); const rpc = openCodexStdio(own, { allowedThreadIds: ids }); await checkCodexProtocol(rpc, own, { threadId: ids[0] }); return rpc; } });
  // Real separate hosts have separate dedicated Codex profiles.
  function profile(who) { const codexHome = join(x.root, "profile-" + who); mkdirSync(codexHome, { recursive: true, mode: 0o700 }); return { ...x.settings, codexHome }; }
  const timer = setTimeout(() => c.abort(), 7000);
  await Promise.all([sup(x, x.connection, "A", opts("A")), sup(x, x.connection, "B", opts("B"))]);
  clearTimeout(timer);
  // Each real host owns its provider history. Sharing a fake history file can
  // overwrite thread IDs during concurrent protocol qualification.
  assert.equal(["A", "B"].reduce((count, who) => count + JSON.parse(readFileSync(join(x.root, "profile-" + who, "runtime.json"))).starts, 0), 3);
  const runs = (await x.owner.assistant()).runs;
  assert.ok(runs.every(r => r.status === "done"));
  for (const who of ["A", "B"]) {
    const journal = openRequestJournal(join(x.root, who + ".sqlite"));
    try {
      for (const record of journal.prepare("SELECT run_id,attempt_id,settled FROM codex_shared_runs").all()) {
        if (runs.find(run => run.id === record.run_id)?.attemptId !== record.attempt_id)
          assert.equal(record.settled, 1, "a proven lost claim must not block this host's future work");
      }
    } finally { journal.close(); }
  }
  assert.equal(events.filter(e => e.status === "recovery_pending").length, 0, "a lost claim race is not a failure");
  assert.ok(connects.A <= 1 && connects.B <= 1, `runtime respawned: ${JSON.stringify(connects)}`);
});


test("server delays beyond the local backoff cap remain intact and cancellation interrupts them", async t => {
  assert.equal(retryDelay({ retryAfterMs: 600000 }, 300000), 600000);
  assert.equal(retryDelay({ retryAfterMs: 3000000000 }, 300000), 3000000000);
  const x = await fixture(t); let requests = 0;
  const conn = await proxy(t, x, (req, res) => { requests++; return refuse(res, 429, "rate_limited", { "retry-after": "3000000" }); });
  const c = new AbortController(), events = [], started = performance.now();
  await sup(x, conn, "long-wait", { signal: c.signal, emit: e => { events.push(e); if (e.status === "retrying_room") setTimeout(() => c.abort(), 20); } });
  assert.equal(requests, 1);
  assert.equal(events.find(e => e.status === "retrying_room").retryMs, 3000000000);
  assert.ok(performance.now() - started < 2000, "cancellation did not interrupt the server delay");
});
