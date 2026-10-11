import { initSharedRunJournal, sharedRunScope } from "../client/codex-shared-assistant.mjs";
import { RoomAssistant } from "../server/room-assistant.mjs";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { createRoomClient } from "../client/room-assistant-client.mjs";
import { openRequestJournal } from "../client/request-runner.mjs";
import { WatchJournal } from "../client/watch-journal.mjs";
import { openCodexStdio, checkCodexProtocol } from "../client/codex-stdio.mjs";
import { superviseCodexRoom } from "../client/codex-supervisor.mjs";

async function fixture(t, mode = "complete") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "room-supervisor-"))), home = join(root, "profile"), cwd = join(root, "workspace");
  mkdirSync(home, { mode: 0o700 }); mkdirSync(cwd);
  const data = join(root, "runtime.json"), command = join(root, "fake-codex");
  writeFileSync(data, JSON.stringify({ threads: {}, starts: 0, interrupted: 0 }));
  writeFileSync(command, `#!${process.execPath}
import readline from 'node:readline'; import {readFileSync,writeFileSync,renameSync} from 'node:fs';
const path=${JSON.stringify(data)}, mode=${JSON.stringify(mode)};
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
  const reads = [];
  server.on("request", req => { if (req.method === "GET" && req.url.includes("/assistant")) reads.push(req.url); });
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
  const addBacklog = count => {
    const assistant = new RoomAssistant(f.store);
    let clock = f.store.now(); f.store.now = () => clock;
    for (let n = 0; n < count; n++) {
      clock += 2100;
      const id = `backlog-${String(n).padStart(4, "0")}`;
      f.store.command(f.keys.owner, "commons", { id: randomUUID(), type: "message.posted", data: { messageId: `message-${id}`, body: `Please finish ${id}` } });
      assistant.apply("commons", { action: "invoke", requestId: randomUUID(), runId: id, sourceMessageId: `message-${id}` }, () => f.store.authenticate(f.keys.owner, "commons"));
    }
  };
  const db = openRequestJournal(join(root, "journal.sqlite"));
  const settings = { command, cwd, codexHome: home, policy: { approvalPolicy: "never", sandbox: "read-only" }, requestTimeoutMs: 1000 };
  const directory = join(root, "watch");
  const run = (options = {}) => superviseCodexRoom({ connection, db, directory, cwd, policy: settings.policy, pollMs: 100, retryMaxMs: 400, timeoutMs: 1000,
    connect: async allowedThreadIds => { const rpc = openCodexStdio(settings, { allowedThreadIds }); try { await checkCodexProtocol(rpc, settings, { threadId: allowedThreadIds[0] }); return rpc; } catch (e) { await rpc.close(); throw e; } }, ...options });
  t.after(async () => { db.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.store.close(); rmSync(root, { recursive: true, force: true }); });
  return { run, invoke, addBacklog, owner, directory, reads, store: f.store, deleteSource: id => f.store.command(f.keys.owner, "commons", { id: randomUUID(), type: "message.deleted", data: { messageId: `message-${id}`, expectedMessageRevision: 0 } }), runtime: () => JSON.parse(readFileSync(data)), db, connection };
}
const waitUntil = async predicate => { const until = Date.now() + 8000; while (!await predicate()) { if (Date.now() > until) throw Error("Timed out waiting for fixture"); await delay(20); } };

test("supervisor picks multiple queued public asks and restart never reruns completed work", async t => {
  const f = await fixture(t); await f.invoke("first"); await f.invoke("second");
  const controller = new AbortController(), events = [];
  await f.run({ signal: controller.signal, emit: e => { events.push(e); if (events.filter(x => x.status === "settled").length === 2) controller.abort(); } });
  assert.equal(f.runtime().starts, 2);
  assert.deepEqual((await f.owner.assistant()).runs.map(r => r.status), ["done", "done"]);
  assert.equal(events.find(e => e.status === "protocol_qualified").providerAuthentication, "unverified");
  const restart = new AbortController(); setTimeout(() => restart.abort(), 250);
  await f.run({ signal: restart.signal }); assert.equal(f.runtime().starts, 2);
  await f.invoke("third"); const third = new AbortController();
  await f.run({ signal: third.signal, emit: e => { if (e.status === "settled") third.abort(); } });
  assert.equal(f.runtime().starts, 3);
});

test("watcher ownership excludes a second supervisor and durable stop exits idle without a runtime", async t => {
  const f = await fixture(t); let connections = 0;
  const running = f.run({ connect: async () => { connections++; throw Error("must stay idle"); } });
  await delay(100);
  await assert.rejects(f.run(), /already_watching/);
  const control = new WatchJournal(f.directory, { acquire: false, create: false }); control.requestStop(); control.close();
  await running; assert.equal(connections, 0);
});

test("shutdown interrupts the owned running turn and never starts a queued successor", async t => {
  const f = await fixture(t, "hold"); await f.invoke("first"); await f.invoke("second");
  const controller = new AbortController(), running = f.run({ signal: controller.signal });
  await waitUntil(() => f.runtime().starts === 1); await delay(50); controller.abort(); await running;
  assert.equal(f.runtime().starts, 1); assert.equal(f.runtime().interrupted, 1);
  assert.equal((await f.owner.assistant()).runs.filter(r => r.status === "queued").length, 1);
});

test("ambiguous start reconnects with backoff and never repeats execution or starts another ask", async t => {
  const f = await fixture(t, "ambiguous"); await f.invoke("first"); await f.invoke("second");
  const controller = new AbortController(), events = [], running = f.run({ signal: controller.signal, emit: e => events.push(e) });
  await waitUntil(() => events.filter(e => e.status === "recovery_pending").length >= 2);
  controller.abort(); await running;
  assert.equal(f.runtime().starts, 1);
  const failures = events.filter(e => e.status === "recovery_pending");
  assert.ok(failures[1].retryAt > failures[0].retryAt);
  const restart = new AbortController(); setTimeout(() => restart.abort(), 250); await f.run({ signal: restart.signal });
  assert.equal(f.runtime().starts, 1);
});

test("another host's reserved attempt is never adopted", async t => {
  const f = await fixture(t); await f.invoke("foreign");
  const agent = createRoomClient(f.connection);
  await agent.act({ action: "claim", requestId: randomUUID(), runId: "foreign", attemptId: "other-host", expectedRevision: 0 });
  const controller = new AbortController(); setTimeout(() => controller.abort(), 250);
  let connections = 0;
  await f.run({ signal: controller.signal, connect: async () => { connections++; throw Error("foreign attempt"); } });
  assert.equal(connections, 0); assert.equal(f.runtime().starts, 0);
});

test("failed connection retries at bounded cadence before running the same queued ask", async t => {
  const f = await fixture(t); await f.invoke("queued");
  const controller = new AbortController(), events = [], started = Date.now(); let connects = 0;
  const running = f.run({ signal: controller.signal, connect: async () => { connects++; throw Error("offline"); }, emit: event => events.push(event) });
  await delay(650); controller.abort(); await running;
  assert.ok(connects >= 1 && connects <= 3, `Unexpected reconnect attempts: ${connects}`);
  assert.ok(Date.now() - started >= 650);
  assert.equal(f.runtime().starts, 0);
  assert.equal((await f.owner.assistant()).runs[0].status, "queued");
  assert.ok(events.some(e => e.status === "recovery_pending"));
});


test("damaged stop-control storage aborts and releases ownership after interrupting work", async t => {
  const f = await fixture(t, "hold"); await f.invoke("first");
  const running = f.run();
  const rejection = assert.rejects(running, /control|table/);
  await waitUntil(() => f.runtime().starts === 1); await delay(50);
  const control = new DatabaseSync(join(f.directory, "watch.sqlite")); control.exec("DROP TABLE control"); control.close();
  await rejection;
  assert.equal(f.runtime().interrupted, 1);
  const lock = new DatabaseSync(join(f.directory, "ownership.sqlite"));
  lock.exec("BEGIN IMMEDIATE; ROLLBACK"); lock.close();
});


test("deleted owned source blocks successor work and later Stop reconciles without another model turn", async t => {
  const f = await fixture(t, "hold"); await f.invoke("first"); await f.invoke("second");
  const first = new AbortController(), active = f.run({ signal: first.signal });
  await waitUntil(() => f.runtime().starts === 1); await delay(50); first.abort(); await active;
  f.deleteSource("first");
  const blocked = new AbortController(), events = [];
  await f.run({ signal: blocked.signal, emit: e => { events.push(e); if (e.status === "recovery_pending") blocked.abort(); } });
  assert.equal(f.runtime().starts, 1);
  const before = (await f.owner.assistant()).runs.find(r => r.id === "first");
  await f.owner.assistant({ action: "cancel", requestId: randomUUID(), runId: "first", expectedRevision: before.revision });
  const restart = new AbortController();
  const safety = setTimeout(() => restart.abort(), 4000);
  await f.run({ signal: restart.signal, emit: e => { if (e.status === "settled") restart.abort(); } });
  clearTimeout(safety);
  assert.equal((await f.owner.assistant()).runs.find(r => r.id === "first").status, "cancelled");
  assert.equal(f.runtime().starts, 1);
});


test("supervisor executes the oldest ask beyond the UI history window", async t => {
  const f = await fixture(t); await f.invoke("oldest"); f.addBacklog(105);
  assert.equal((await f.owner.assistant()).runs.some(r => r.id === "oldest"), false);
  const stop = new AbortController(), events = [];
  await f.run({ signal: stop.signal, emit: e => { events.push(e); if (e.status === "settled") stop.abort(); } });
  assert.equal(events.find(e => e.status === "running").runId, "oldest");
  assert.equal(f.runtime().starts, 1);
});

test("owned ambiguous execution outside history still blocks a newer backlog", async t => {
  const f = await fixture(t, "ambiguous"); await f.invoke("owned-oldest");
  const first = new AbortController();
  await f.run({ signal: first.signal, emit: e => { if (e.status === "recovery_pending") first.abort(); } });
  f.addBacklog(105);
  assert.equal((await f.owner.assistant()).runs.some(r => r.id === "owned-oldest"), false);
  const restart = new AbortController(), events = [];
  await f.run({ signal: restart.signal, emit: e => { events.push(e); if (e.status === "recovery_pending") restart.abort(); } });
  assert.equal(events.find(e => e.status === "running").runId, "owned-oldest");
  assert.equal(f.runtime().starts, 1, "uncertain start is never repeated and successors stay queued");
});


test("restart reconciles its journal before reading any queue pages", async t => {
  const f = await fixture(t, "ambiguous"); await f.invoke("first");
  const first = new AbortController();
  await f.run({ signal: first.signal, emit: e => { if (e.status === "recovery_pending") first.abort(); } });
  f.addBacklog(105); f.reads.length = 0;
  const restart = new AbortController();
  await f.run({ signal: restart.signal, emit: e => { if (e.status === "recovery_pending") restart.abort(); } });
  assert.ok(f.reads.some(url => url.includes("runId=first")));
  assert.equal(f.reads.some(url => url.includes("view=work")), false);
  assert.equal(f.runtime().starts, 1);
});

test("revoked publication is unresolved execution and blocks queue discovery", async t => {
  const f = await fixture(t, "ambiguous"); await f.invoke("first");
  const first = new AbortController();
  await f.run({ signal: first.signal, emit: e => { if (e.status === "recovery_pending") first.abort(); } });
  f.addBacklog(105); // advances server clock past the host heartbeat window
  const stored = JSON.parse(f.store.db.prepare("SELECT value FROM room_assistant_runs WHERE run_id='first'").get().value);
  const cancelled = await f.owner.assistant({ action: "cancel", requestId: randomUUID(), runId: "first", expectedRevision: stored.revision });
  assert.equal(cancelled.result.stopOutcome, "attempt_revoked");
  f.reads.length = 0;
  const restart = new AbortController(), events = [];
  await f.run({ signal: restart.signal, emit: e => { events.push(e); if (e.status === "retrying_room") restart.abort(); } });
  assert.equal(events.find(e => e.status === "retrying_room").code, "assistant_recovery_unresolved");
  assert.equal(f.reads.some(url => url.includes("view=work")), false);
  assert.equal(f.runtime().starts, 1);
  assert.equal(f.db.prepare("SELECT settled FROM codex_shared_runs").get().settled, 0);
});

test("legacy journal metadata comes from its original runtime binding and remains scoped", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE codex_shared_runs(id TEXT PRIMARY KEY,attempt_id TEXT,publish TEXT); CREATE TABLE codex_runtime_attempts(binding TEXT)");
    const connection = { origin: "https://room.example", roomId: "one", memberId: "agent" };
    const binding = { ...connection, kind: "shared-assistant", runId: "old", runCreatedAt: "123", attemptId: "original" };
    db.prepare("INSERT INTO codex_shared_runs VALUES(?,?,NULL)").run("journal-key", "original");
    db.prepare("INSERT INTO codex_runtime_attempts VALUES(?)").run(JSON.stringify(binding));
    initSharedRunJournal(db); initSharedRunJournal(db);
    const row = db.prepare("SELECT * FROM codex_shared_runs").get();
    assert.equal(row.scope, sharedRunScope(connection));
    assert.equal(row.run_id, "old"); assert.equal(row.run_created_at, "123");
    assert.equal(row.attempt_id, "original"); assert.equal(row.settled, 0);
    assert.equal(db.prepare("SELECT count(*) AS n FROM codex_shared_runs WHERE scope=?").get(sharedRunScope({ ...connection, roomId: "two" })).n, 0);
  } finally { db.close(); }
});


test("confirmed terminal work is retired from recovery reads", async t => {
  const f = await fixture(t); await f.invoke("finished");
  const first = new AbortController();
  await f.run({ signal: first.signal, emit: e => { if (e.status === "settled") first.abort(); } });
  f.reads.length = 0;
  const restart = new AbortController(), timeout = setTimeout(() => restart.abort(), 450);
  try { await f.run({ signal: restart.signal }); } finally { clearTimeout(timeout); }
  assert.equal(f.reads.filter(url => url.includes("runId=finished")).length, 1);
  assert.equal(f.db.prepare("SELECT settled FROM codex_shared_runs").get().settled, 1);
  assert.equal(f.runtime().starts, 1);
});

test("unreadable owned work does not clear recovery or start queued work", async t => {
  const f = await fixture(t, "ambiguous"); await f.invoke("owned");
  const first = new AbortController();
  await f.run({ signal: first.signal, emit: e => { if (e.status === "recovery_pending") first.abort(); } });
  await f.invoke("successor");
  f.store.issueAccessKey("commons", "producer"); // revokes the host's old key
  f.reads.length = 0;
  const restart = new AbortController();
  await f.run({ signal: restart.signal, emit: e => { if (e.status === "retrying_room") restart.abort(); } });
  assert.equal(f.reads.some(url => url.includes("view=work")), false);
  assert.equal(f.db.prepare("SELECT settled FROM codex_shared_runs").get().settled, 0);
  assert.equal(f.runtime().starts, 1);
});
