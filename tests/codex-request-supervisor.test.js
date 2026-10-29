import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { RoomAgentClient } from "../client/room-agent.mjs";
import { openRequestJournal, runRequestOnce } from "../client/request-runner.mjs";
import { roomCodexHost } from "../client/codex-runtime.mjs";
import { WatchJournal } from "../client/watch-journal.mjs";
import { superviseCodexRequests } from "../client/codex-request-supervisor.mjs";

const waitUntil = async predicate => {
  const until = Date.now() + 6000;
  while (!await predicate()) { if (Date.now() > until) throw Error("Fixture condition timed out"); await delay(10); }
};
function transport(mode) {
  let starts = 0, interrupts = 0, closed = 0;
  const listeners = new Set(), threads = new Map();
  const event = (method, params) => listeners.forEach(fn => fn({ method, params }));
  return { get starts() { return starts; }, get interrupts() { return interrupts; }, get closed() { return closed; },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }, notify() {}, async close() { closed++; },
    async request(method, params) {
      if (method === "initialize") return {};
      if (method === "thread/start") { const thread = { id: "thread-" + threads.size, turns: [] }; threads.set(thread.id, thread); return { thread }; }
      if (["thread/read", "thread/resume"].includes(method)) return { thread: threads.get(params.threadId) };
      if (method === "turn/start") {
        starts++; const turn = { id: "turn-" + starts, status: "inProgress", items: [] };
        threads.get(params.threadId).turns.push(turn);
        if (mode === "unknown") throw Error("Synthetic lost start acknowledgement");
        if (mode !== "hold") setTimeout(() => {
          turn.status = "completed"; turn.items = [{ id: "answer", type: "agentMessage", text: "Synthetic linked reply" }];
          event("turn/completed", { threadId: params.threadId, turn });
        }, 5);
        return { turn: { ...turn } };
      }
      if (method === "turn/interrupt") {
        interrupts++; const turn = threads.get(params.threadId).turns.find(t => t.id === params.turnId);
        turn.status = "interrupted"; event("turn/completed", { threadId: params.threadId, turn }); return {};
      }
      throw Error("Unexpected fixture method " + method);
    } };
}
async function fixture(t, mode = "complete") {
  const f = createAcceptanceFixture({ dmConsent: true }), server = createRoomServer({ store: f.store });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const connection = { origin: `http://127.0.0.1:${server.address().port}`, roomId: "commons", memberId: "producer", token: f.keys.producer };
  const journal = join(f.directory, "requests.sqlite"), directory = join(f.directory, "watch");
  let db = openRequestJournal(journal), connects = 0;
  const rpc = transport(mode), controls = new Set(), running = new Set();
  const post = (formal = true) => {
    const messageId = randomUUID();
    f.store.command(f.keys.owner, "commons", { id: randomUUID(), type: "message.posted", data: {
      messageId, body: "Synthetic request", ...(formal ? { requestKind: "reply", toMemberId: "producer" } : {}) } });
    return messageId;
  };
  const run = (options = {}) => {
    const controller = options.controller ?? new AbortController(); controls.add(controller);
    const promise = superviseCodexRequests({ connection, db, directory, connect: async () => { connects++; return rpc; },
      cwd: f.directory, policy: { approvalPolicy: "never", sandbox: "read-only" }, allowedRequesterIds: ["owner"],
      pollMs: 1000, timeoutMs: 2000, signal: controller.signal, ...options });
    running.add(promise); promise.finally(() => running.delete(promise)).catch(() => {});
    return { controller, promise };
  };
  t.after(async () => {
    for (const c of controls) c.abort(); await Promise.allSettled([...running]); db.close();
    server.closeStreams(); server.closeAllConnections(); await new Promise(r => server.close(r));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  return { post, run, rpc, directory, connection, cwd: f.directory, client: new RoomAgentClient(connection), get db() { return db; },
    get connects() { return connects; }, reopen() { db.close(); db = openRequestJournal(journal); } };
}

test("directed supervisor publishes one linked reply; restart preserves completed work", async t => {
  const f = await fixture(t), id = f.post(), controller = new AbortController();
  await f.run({ controller, emit: e => { if (e.status === "delivered") controller.abort(); } }).promise;
  const context = await f.client.replyContext(id);
  assert.equal(context.request.status, "answered");
  assert.ok(context.page.items.some(row => row.message.body === "Synthetic linked reply"));
  assert.equal(f.rpc.starts, 1);
  f.reopen(); const restart = f.run(); await delay(150); restart.controller.abort(); await restart.promise;
  assert.equal(f.rpc.starts, 1);
});

test("requester allowlist and ordinary conversation never claim or start a runtime", async t => {
  const f = await fixture(t); f.post(); f.post(false);
  const events = [], run = f.run({ allowedRequesterIds: ["reviewer"], emit: e => events.push(e) });
  await waitUntil(() => events.some(e => e.status === "watching_room")); await delay(150);
  run.controller.abort(); await run.promise;
  assert.equal(f.connects, 0); assert.equal(f.rpc.starts, 0);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM request_runs").get().n, 0);
});

test("unknown start is durable and fences successors after restart", async t => {
  const f = await fixture(t, "unknown"); f.post(); f.post();
  const first = f.run(); await waitUntil(() => f.db.prepare("SELECT count(*) AS n FROM request_runs WHERE response IS NULL").get().n === 1);
  await waitUntil(() => f.rpc.starts === 1); await delay(30); first.controller.abort(); await first.promise;
  f.reopen(); const next = f.run(); await delay(150); next.controller.abort(); await next.promise;
  assert.equal(f.rpc.starts, 1); assert.equal(f.connects, 1);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM request_runs WHERE response IS NULL").get().n, 1);
});

test("durable stop interrupts owned turn and does not start successor", async t => {
  const f = await fixture(t, "hold"); f.post(); f.post();
  const run = f.run(); await waitUntil(() => f.rpc.starts === 1);
  const control = new WatchJournal(f.directory, { acquire: false, create: false }); control.requestStop(); control.close();
  await run.promise;
  assert.equal(f.rpc.starts, 1); assert.equal(f.rpc.interrupts, 1); assert.equal(f.rpc.closed, 1);
});

test("one WatchJournal owner and explicit allowlist are required before runtime connection", async t => {
  const f = await fixture(t);
  for (const ids of [[], ["owner", "owner"], ["bad.id"], ["x".repeat(129)], Array.from({ length: 21 }, (_, i) => "member" + i)])
    await assert.rejects(f.run({ allowedRequesterIds: ids }).promise, /allowlist/);
  const first = f.run(); await delay(30);
  await assert.rejects(f.run().promise, /already_watching/);
  first.controller.abort(); await first.promise;
  assert.equal(f.connects, 0);
});


test("runtime rechecks requester policy after preparation before starting", async t => {
  const f = await fixture(t), id = f.post();
  let allowed = true, checked = 0;
  const host = roomCodexHost({ connection: f.connection, db: f.db, rpc: f.rpc, cwd: f.cwd,
    policy: { approvalPolicy: "never", sandbox: "read-only" }, allowRequest: request => {
      checked++; assert.equal(request.requesterId, "owner"); return allowed;
    } });
  const execute = Object.assign((...args) => host(...args), { prepare: async () => { allowed = false; } });
  await assert.rejects(runRequestOnce({ connection: f.connection, db: f.db, requestMessageId: id, execute,
    allowRequest: () => true }), error => error.code === "requester_not_allowed");
  assert.equal(checked, 1); assert.equal(f.rpc.starts, 0);
});

test("requester revocation prevents steering but permits interrupting the owned turn", async t => {
  const f = await fixture(t, "hold"), id = f.post();
  let allowed = true, binding;
  const host = roomCodexHost({ connection: f.connection, db: f.db, rpc: f.rpc, cwd: f.cwd,
    policy: { approvalPolicy: "never", sandbox: "read-only" }, allowRequest: () => allowed });
  const executing = runRequestOnce({ connection: f.connection, db: f.db, requestMessageId: id,
    execute: (input, options) => { binding = options.binding; return host(input, options); } });
  const rejected = assert.rejects(executing, /interrupted/);
  await waitUntil(() => f.rpc.starts === 1); allowed = false;
  await assert.rejects(host.steer(binding, "new-input", "Do more"), error => error.code === "requester_not_allowed");
  await host.interrupt(binding); await rejected;
  assert.equal(f.rpc.starts, 1); assert.equal(f.rpc.interrupts, 1);
});

test("unresolved shared mode journal fences directed pickup", async t => {
  const f = await fixture(t); f.post();
  f.db.exec("CREATE TABLE codex_shared_runs (id TEXT PRIMARY KEY, attempt_id TEXT, publish TEXT)");
  f.db.prepare("INSERT INTO codex_shared_runs VALUES(?,?,NULL)").run("shared", "prior");
  const events = [], run = f.run({ emit: e => events.push(e) }); await delay(150);
  run.controller.abort(); await run.promise;
  assert.ok(events.some(e => e.status === "recovery_pending"));
  assert.equal(f.connects, 0); assert.equal(f.rpc.starts, 0);
});

for (const priorState of ["inProgress", "interrupted"]) test(`shared runtime ${priorState} is distinguished at mode switch`, async t => {
  const f = await fixture(t); f.post();
  roomCodexHost({ connection: f.connection, db: f.db, rpc: f.rpc, cwd: f.cwd,
    policy: { approvalPolicy: "never", sandbox: "read-only" } });
  f.db.exec("CREATE TABLE codex_shared_runs (id TEXT PRIMARY KEY, attempt_id TEXT, publish TEXT)");
  f.db.prepare("INSERT INTO codex_shared_runs VALUES(?,?,NULL)").run("shared", "prior");
  f.db.prepare("INSERT INTO codex_runtime_attempts(id,binding,state) VALUES(?,?,?)").run("prior", JSON.stringify({
    kind: "shared-assistant", origin: f.connection.origin, roomId: "commons", memberId: "producer", attemptId: "prior"
  }), priorState);
  const controller = new AbortController(), run = f.run({ controller,
    emit: e => { if (e.status === "delivered") controller.abort(); } });
  if (priorState === "inProgress") { await delay(150); controller.abort(); }
  await run.promise;
  assert.equal(f.rpc.starts, priorState === "inProgress" ? 0 : 1);
});
