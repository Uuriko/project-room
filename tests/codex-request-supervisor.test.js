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

test("selected request executes without claiming other requests from the same enabled requester", async t => {
  const f = await fixture(t), old = f.post(), selected = f.post(), later = f.post();
  const controller = new AbortController();
  await f.run({ allowedRequestIds: [selected], controller,
    emit: event => { if (event.status === "delivered") controller.abort(); } }).promise;
  assert.equal(f.rpc.starts, 1);
  assert.equal((await f.client.replyContext(selected)).request.status, "answered");
  for (const id of [old, later]) assert.equal((await f.client.replyContext(id)).request.status, "open");
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM request_runs").get().n, 1);
});

test("selection withdrawal during runtime preparation creates no intent or execution", async t => {
  const f = await fixture(t), id = f.post(); let selected = true;
  const execute = Object.assign(async () => assert.fail("Unselected request executed"), {
    prepare: async () => { selected = false; }
  });
  await assert.rejects(runRequestOnce({ connection: f.connection, db: f.db, requestMessageId: id,
    execute, selectRequest: () => selected }), { code: "request_not_selected" });
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM request_runs").get().n, 0);
});

test("request selection cannot bypass requester authorization and invalid selections fail before connecting", async t => {
  const f = await fixture(t), id = f.post();
  await assert.rejects(runRequestOnce({ connection: f.connection, db: f.db, requestMessageId: id,
    execute: () => assert.fail("Unauthorized execution"), allowRequest: () => false, selectRequest: () => true }),
  { code: "requester_not_allowed" });
  for (const allowedRequestIds of [[], [id, id], [""], "all"]) {
    await assert.rejects(f.run({ allowedRequestIds }).promise, /distinct valid request IDs/);
  }
  assert.equal(f.connects, 0);
});

test("saved response survives deselection but still obeys requester revocation", async t => {
  const f = await fixture(t), id = f.post(); let starts = 0;
  const execute = async () => { starts++; return { body: "Saved exact result" }; };
  await runRequestOnce({ connection: f.connection, db: f.db, requestMessageId: id, execute, selectRequest: () => true });
  const original = f.db.prepare("SELECT * FROM request_runs").get();
  const replay = await runRequestOnce({ connection: f.connection, db: f.db, requestMessageId: id,
    execute: () => assert.fail("Saved result reexecuted"), selectRequest: () => false });
  assert.equal(replay.hostExecuted, false);
  assert.equal(starts, 1);
  assert.deepEqual(f.db.prepare("SELECT * FROM request_runs").get(), original);
  await assert.rejects(runRequestOnce({ connection: f.connection, db: f.db, requestMessageId: id,
    execute, selectRequest: () => false, allowRequest: () => false }), { code: "requester_not_allowed" });
});

test("supervisor recovers deselected pending delivery without execution and honors requester revocation", async t => {
  const f = await fixture(t), id = f.post(); let starts = 0;
  const original = RoomAgentClient.prototype.replyAction;
  RoomAgentClient.prototype.replyAction = async () => { throw Object.assign(new Error("Synthetic delivery outage"), { status: 503 }); };
  try {
    await assert.rejects(runRequestOnce({ connection: f.connection, db: f.db, requestMessageId: id,
      execute: async () => { starts++; return { body: "Retained answer" }; } }), /Synthetic delivery outage/);
  } finally { RoomAgentClient.prototype.replyAction = original; }
  const saved = f.db.prepare("SELECT * FROM request_runs").get();
  assert.ok(saved.response); assert.equal(saved.delivered, 0);
  const denied = f.run({ allowedRequesterIds: ["reviewer"], allowedRequestIds: ["future-request"] });
  await delay(150); denied.controller.abort(); await denied.promise;
  assert.equal(f.db.prepare("SELECT delivered FROM request_runs").get().delivered, 0);
  assert.equal((await f.client.replyContext(id)).request.status, "open");
  const controller = new AbortController();
  await f.run({ allowedRequestIds: ["future-request"], controller,
    emit: event => { if (event.status === "delivered") controller.abort(); } }).promise;
  assert.equal(starts, 1); assert.equal(f.connects, 0);
  const recovered = f.db.prepare("SELECT * FROM request_runs").get();
  assert.equal(recovered.delivered, 1); assert.equal(recovered.response, saved.response);
  assert.equal(recovered.id, saved.id); assert.equal(recovered.attempt_id, saved.attempt_id);
  assert.equal((await f.client.replyContext(id)).request.status, "answered");
});

test("lost acknowledgment of committed answer reconciles from journal after request leaves open queue", async t => {
  const f = await fixture(t), id = f.post(); let starts = 0;
  // Refused old records must not starve a valid saved answer past the batch boundary.
  for (let n = 0; n < 55; n++) f.db.prepare("INSERT INTO request_runs(id,response,delivered) VALUES(?,?,0)")
    .run(`invalid-saved-${n}`, "invalid JSON");
  const original = RoomAgentClient.prototype.replyAction;
  RoomAgentClient.prototype.replyAction = async function (...args) {
    await original.apply(this, args);
    throw new TypeError("Synthetic lost acknowledgment after commit");
  };
  try {
    await assert.rejects(runRequestOnce({ connection: f.connection, db: f.db, requestMessageId: id,
      execute: async () => { starts++; return { body: "Committed exact answer" }; } }), /lost acknowledgment/);
  } finally { RoomAgentClient.prototype.replyAction = original; }
  assert.equal((await f.client.replyContext(id)).request.status, "answered");
  const saved = f.db.prepare("SELECT * FROM request_runs WHERE id NOT LIKE 'invalid-saved-%'").get();
  assert.equal(saved.delivered, 0);
  assert.equal((await f.client.agentWork()).requests.some(r => r.id === id), false);
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 3000);
  try {
    await f.run({ allowedRequestIds: ["future-request"], controller,
      emit: event => { if (event.status === "delivered") controller.abort(); } }).promise;
  } finally { clearTimeout(deadline); }
  const recovered = f.db.prepare("SELECT * FROM request_runs WHERE id NOT LIKE 'invalid-saved-%'").get();
  assert.equal(recovered.delivered, 1);
  assert.equal(recovered.response, saved.response); assert.equal(recovered.id, saved.id);
  assert.equal(starts, 1); assert.equal(f.connects, 0);
});

test("saved row from another scope cannot suppress a selected current request with the same ID", async t => {
  const f = await fixture(t), id = f.post();
  f.db.prepare("INSERT INTO request_runs(id,response,delivered,attempt_id) VALUES(?,?,0,?)")
    .run("host-another-room", JSON.stringify({ responseToRequestId: id, body: "Other room saved answer" }), "old-attempt");
  const controller = new AbortController(), deadline = setTimeout(() => controller.abort(), 3000);
  try {
    await f.run({ allowedRequestIds: [id], controller,
      emit: event => { if (event.status === "delivered") controller.abort(); } }).promise;
  } finally { clearTimeout(deadline); }
  assert.equal((await f.client.replyContext(id)).request.status, "answered");
  assert.equal(f.rpc.starts, 1);
  assert.equal(f.db.prepare("SELECT delivered FROM request_runs WHERE id=?").get("host-another-room").delivered, 0);
});
