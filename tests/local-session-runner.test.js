import test from "node:test";
import assert from "node:assert/strict";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";
import { RoomAgentClient } from "../client/room-agent.mjs";
import { runLocalSession } from "../client/local-session-runner.mjs";
import { sessionRecord } from "../src/work-item-session.js";

async function fixture(t) {
  const store = new RoomStore(":memory:"); store.initialize(initialRoom());
  const owner = store.issueAccessKey("commons", "owner");
  store.command(owner, "commons", { id: "member", type: "member.added", data: {
    memberId: "agent", displayName: "Agent", kind: "agent", permissions: ["accept_work", "complete_work"] } });
  store.command(owner, "commons", { id: "work", type: "work.proposed", data: {
    workItemId: "task", title: "Local run", definitionOfDone: "Separate review", accountableMemberId: "agent", mode: "read" } });
  const token = store.issueAccessKey("commons", "agent"), server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const config = { origin: `http://127.0.0.1:${server.address().port}`, roomId: "commons", memberId: "agent", token };
  const client = new RoomAgentClient(config);
  const options = { client, roomId: "commons", memberId: "agent", workItemId: "task", runId: "run-one",
    expectedRevision: 0, command: process.execPath, args: ["-e", "console.log('useful result')"], cwd: process.cwd(), maxRuntimeMs: 3000, pollMs: 20, killGraceMs: 30 };
  const item = () => store.room("commons").state.workItems.task;
  return { store, owner, client, config, options, item };
}

test("local run claims once, executes, and records session exit without completing work", async t => {
  const f = await fixture(t), result = await runLocalSession(f.options);
  assert.equal(result.status, "done"); assert.equal(result.recording, "recorded");
  assert.equal(result.output, "useful result\n");
  assert.equal(f.item().status, "done"); assert.equal(f.item().state, "proposed");
  assert.equal(result.workCompleted, false); assert.equal(result.processSandboxed, false);
  assert.equal((await runLocalSession(f.options)).reason, "session_changed");
});

test("room stop terminates the actual local process and records failure", async t => {
  const f = await fixture(t);
  const interval = setInterval(() => {
    if (f.item().status !== "processing" || f.item().stop_requested_at) return;
    f.store.command(f.owner, "commons", { id: "stop", type: "session.stop_requested", data: {
      workItemId: "task", expectedRevision: f.item().revision } });
  }, 40);
  t.after(() => clearInterval(interval));
  const result = await runLocalSession({ ...f.options, args: ["-e", "setInterval(()=>{},100)"] });
  assert.equal(result.status, "failed"); assert.ok(["room_stop", "session_changed"].includes(result.reason));
  assert.equal(result.recording, "recorded"); assert.equal(f.item().status, "failed");
});

test("runtime and output caps stop processes independently of Room events", async t => {
  for (const mode of ["runtime", "output"]) await t.test(mode, async t => {
    const f = await fixture(t);
    const result = await runLocalSession({ ...f.options, maxRuntimeMs: mode === "runtime" ? 150 : 3000,
      maxOutputBytes: 32, args: ["-e", mode === "runtime" ? "setInterval(()=>{},100)" : "process.stdout.write('x'.repeat(10000));setInterval(()=>{},100)"] });
    assert.equal(result.status, "failed"); assert.equal(result.reason, `${mode}_limit`);
    assert.ok(Buffer.byteLength(result.output) <= 32); assert.equal(result.recording, "recorded");
  });
});

test("access revocation stops execution without claiming a successful remote update", async t => {
  const f = await fixture(t);
  const timer = setTimeout(() => f.store.issueAccessKey("commons", "agent"), 150);
  t.after(() => clearTimeout(timer));
  const result = await runLocalSession({ ...f.options, args: ["-e", "setInterval(()=>{},100)"] });
  assert.equal(result.status, "failed"); assert.equal(result.reason, "access_unavailable");
  assert.equal(result.recording, "unconfirmed");
});

test("unknown claim never launches a process and reentry does not rerun claimed work", async t => {
  const f = await fixture(t), lossy = new RoomAgentClient({ ...f.config, fetchImpl: async (url, options) => {
    const response = await fetch(url, options);
    if (url.endsWith("/commands")) throw new TypeError("Lost claim");
    return response;
  } });
  await assert.rejects(runLocalSession({ ...f.options, client: lossy }), /Lost claim/);
  assert.equal(f.item().status, "processing");
  assert.equal((await runLocalSession(f.options)).status, "not_started");
});

test("pre-cancelled and invalid runs never change the room", async t => {
  const f = await fixture(t), signal = AbortSignal.abort();
  assert.equal((await runLocalSession({ ...f.options, signal })).reason, "cancelled");
  await assert.rejects(runLocalSession({ ...f.options, command: "node" }), /Invalid/);
  await assert.rejects(runLocalSession({ ...f.options, maxRuntimeMs: 300001 }), /Invalid/);
  assert.equal(sessionRecord(f.item()).status, "queued");
});

test("local cancellation escalates when a process ignores SIGTERM", async t => {
  const f = await fixture(t), controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 250);
  t.after(() => clearTimeout(timer));
  const result = await runLocalSession({ ...f.options, signal: controller.signal,
    args: ["-e", "process.on('SIGTERM',()=>{});console.log('ready');setInterval(()=>{},100)"] });
  assert.equal(result.reason, "cancelled"); assert.equal(result.signal, "SIGKILL");
  assert.equal(result.recording, "recorded");
});

test("unknown terminal recording preserves the exact write without executing twice", async t => {
  const f = await fixture(t);
  const client = new RoomAgentClient({ ...f.config, fetchImpl: async (url, options) => {
    const response = await fetch(url, options);
    if (url.endsWith("/commands") && JSON.parse(options.body).type === "session.stopped") throw new TypeError("Lost finish");
    return response;
  } });
  const result = await runLocalSession({ ...f.options, client });
  assert.equal(result.status, "done"); assert.equal(result.recording, "unconfirmed");
  assert.equal(result.terminalCommand.id, "run-one:finish");
  assert.equal((await f.client.command(result.terminalCommand)).duplicate, true);
  assert.equal((await runLocalSession(f.options)).status, "not_started");
});

test("a failed executable is a failed session, never a completed task", async t => {
  const f = await fixture(t);
  const result = await runLocalSession({ ...f.options, command: "/nonexistent-project-room-test-executable" });
  assert.equal(result.reason, "process_start_failed");
  assert.equal(result.status, "failed"); assert.equal(result.recording, "recorded");
  assert.equal(f.item().state, "proposed");
});
