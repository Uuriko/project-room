import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRequestJournal, runRequestOnce } from "../client/request-runner.mjs";
import { recordRequestStage, readRequestTimeline } from "../client/request-timeline.mjs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";

test("milestones survive reopen and replay without pretending an interrupted host is running", t => {
  const dir = mkdtempSync(join(tmpdir(), "room-timeline-")), path = join(dir, "journal.sqlite");
  let db = openRequestJournal(path);
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  db.prepare("INSERT INTO request_runs(id) VALUES (?)").run("job");
  recordRequestStage(db, "job", "started", 100);
  db.close(); db = openRequestJournal(path);
  recordRequestStage(db, "job", "started", 200);
  assert.equal(readRequestTimeline(db, "job").milestones.started, 100);
  assert.equal(readRequestTimeline(db, "job").state, "needs_reconciliation");
  assert.equal(readRequestTimeline(db, "job").liveExecutionVerified, false);
});

test("missing or backwards timestamps do not invent latency; server clock stays separate", t => {
  const dir = mkdtempSync(join(tmpdir(), "room-timeline-")), db = openRequestJournal(join(dir, "journal"));
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  for (const [stage, at] of [["requested", 999999], ["noticed", 100], ["accepted", 200], ["started", 300], ["finished", 250]])
    recordRequestStage(db, "job", stage, at);
  const timeline = readRequestTimeline(db, "job");
  assert.deepEqual(timeline.durationsMs, { preparation: 100, admission: 100, execution: null, delivery: null });
  assert.equal(recordRequestStage(db, "job", "started", NaN), false);
  assert.equal(recordRequestStage(db, "job", "prompt", 400), false);
});

async function fixture(t) {
  const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const path = join(f.directory, "request-timing.sqlite");
  const journal = { db: openRequestJournal(path) };
  t.after(async () => {
    journal.db.close(); server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  for (const [a, b] of [["owner", "producer"], ["producer", "owner"]]) {
    f.store.dmConsents.request("commons", a, b, "fixture");
    f.store.dmConsents.decide("commons", b, a, "approve");
  }
  const requestMessageId = "timing-question";
  f.store.command(f.keys.owner, "commons", { id: "open-timing", type: "message.posted", data: {
    messageId: requestMessageId, requestKind: "reply", toMemberId: "producer", body: "Run the fixed test" } });
  const connection = { origin: `http://127.0.0.1:${server.address().port}`, roomId: "commons", memberId: "producer", token: f.keys.producer };
  return { journal, path, connection, requestMessageId, store: f.store, keys: f.keys };
}

test("lost delivery exposes saved result, then restart reconciles without rerunning or rewriting timing", async t => {
  const f = await fixture(t); let executions = 0;
  const execute = async () => { executions++; return { body: "Verified fixture output" }; };
  const connection = { ...f.connection, fetchImpl: async (url, options) => {
    const response = await fetch(url, options);
    if (options.method === "POST" && new URL(url).pathname.endsWith("/commands")) throw new TypeError("lost acknowledgement");
    return response;
  } };
  await assert.rejects(runRequestOnce({ ...f, connection, db: f.journal.db, execute }), /lost acknowledgement/);
  const id = f.journal.db.prepare("SELECT id FROM request_runs").get().id;
  const before = readRequestTimeline(f.journal.db, id);
  assert.equal(before.state, "pending_delivery");
  assert.ok(before.milestones.finished); assert.equal(before.milestones.delivered, null);
  f.journal.db.close(); f.journal.db = openRequestJournal(f.path);
  const result = await runRequestOnce({ ...f, db: f.journal.db, execute });
  assert.equal(result.hostExecuted, false); assert.equal(executions, 1);
  const after = readRequestTimeline(f.journal.db, id);
  assert.equal(after.state, "delivered"); assert.ok(after.milestones.delivered);
  assert.equal(after.milestones.started, before.milestones.started);
  assert.equal(after.milestones.finished, before.milestones.finished);
});

test("unavailable execution dependencies never create an execution milestone", async t => {
  const f = await fixture(t);
  await assert.rejects(runRequestOnce({ ...f, db: f.journal.db,
    preflight: () => { throw new Error("machine paused"); }, execute: () => assert.fail("must not run") }), /machine paused/);
  const id = f.journal.db.prepare("SELECT id FROM request_run_timeline LIMIT 1").get().id;
  const timeline = readRequestTimeline(f.journal.db, id);
  assert.equal(timeline.state, "not_started"); assert.ok(timeline.milestones.noticed);
  assert.equal(timeline.milestones.started, null);
});

test("missing diagnostic table cannot discard a successful result", async t => {
  const f = await fixture(t); f.journal.db.exec("DROP TABLE request_run_timeline");
  const result = await runRequestOnce({ ...f, db: f.journal.db, execute: async () => ({ body: "Result survives" }) });
  const timeline = readRequestTimeline(f.journal.db, result.requestId);
  assert.equal(timeline.state, "delivered");
  assert.ok(Object.values(timeline.milestones).every(value => value === null));
});

test("clarification during execution marks saved stale result as needing reconciliation", async t => {
  const f = await fixture(t);
  await assert.rejects(runRequestOnce({ ...f, db: f.journal.db, execute: async () => {
    f.store.command(f.keys.owner, "commons", { id: "steer", type: "message.posted", data: {
      messageId: "steer-msg", replyToId: f.requestMessageId, body: "The task has changed" } });
    return { body: "Saved result for old context" };
  } }));
  const id = f.journal.db.prepare("SELECT id FROM request_runs").get().id;
  const timeline = readRequestTimeline(f.journal.db, id);
  assert.equal(timeline.state, "needs_reconciliation");
  assert.ok(timeline.milestones.finished); assert.ok(timeline.milestones.delivery_blocked);
});

test("timeline CLI is read-only and does not create a missing journal", t => {
  const dir = mkdtempSync(join(tmpdir(), "room-timeline-")), path = join(dir, "journal.sqlite");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const id = "host-" + "a".repeat(64), command = new URL("../client/request-timeline.mjs", import.meta.url);
  const missing = spawnSync(process.execPath, [command.pathname, path, id], { encoding: "utf8" });
  assert.equal(missing.status, 1); assert.equal(existsSync(path), false);
  const db = openRequestJournal(path);
  db.prepare("INSERT INTO request_runs(id,response) VALUES (?,?)").run(id, JSON.stringify({ body: "PRIVATE RESULT" }));
  db.close();
  const read = spawnSync(process.execPath, [command.pathname, path, id], { encoding: "utf8" });
  assert.equal(read.status, 0); assert.equal(JSON.parse(read.stdout).state, "pending_delivery");
  assert.equal(read.stdout.includes("PRIVATE RESULT"), false);
});
