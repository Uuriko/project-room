// Wake-accounting production reader + recorder-failure observability
// (audit D3-5 P1 / Pass E, conversion Lane 11).
//
// At the audited SHA the chain was broken at both ends:
// 1. recordWakeEvent returned false on any store failure and none of
//    its 18 production call sites inspected the return — a broken
//    counter store produced zero log lines and a clean exit, and a
//    partial failure advanced the counter while its failure-journal
//    row was never written.
// 2. wakeAccounting had no production reader at all (tests only, via
//    AgentHeartbeats.accounting()); the module header's premise that
//    operator surfaces render it was false.
// Cure: GET /api/operator/wake-accounting renders wakeAccounting on
// the operator counter surface the MCP per-tool counter table (#4984)
// established, and recordWakeEvent's write failures are centrally
// counted + logged in wake-metrics (wakeRecordFailures, rendered on
// the same route) with the counter+journal write made atomic.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { recordWakeEvent, wakeAccounting, wakeRecordFailures, resetWakeRecordFailuresForTests } from "../server/wake-metrics.mjs";
import { createOperatorRoutes } from "../server/operator-routes.mjs";

const TOKEN = "wake-accounting-operator-token-0123456789";
const HASH = createHash("sha256").update(TOKEN).digest("hex");

function captureConsoleError(fn) {
  const lines = [];
  const original = console.error;
  console.error = (...args) => { lines.push(args.join(" ")); };
  try { return { result: fn(), lines }; }
  finally { console.error = original; }
}

function operatorFixture(t, db) {
  process.env.ROOM_OPERATOR_TOKEN_SHA256 = HASH;
  t.after(() => { delete process.env.ROOM_OPERATOR_TOKEN_SHA256; });
  const store = { db, now: () => 5000 };
  const routes = createOperatorRoutes({
    store,
    json: (res, status, body) => { res.status = status; res.body = body; },
    reject: (status, code) => { const error = new Error(code); error.status = status; throw error; },
    body: async () => ({}),
    rate: () => {},
  });
  const call = async (path, { token = TOKEN, method = "GET" } = {}) => {
    const res = { setHeader: () => {} };
    const url = new URL(`http://operator.test${path}`);
    const handled = await routes(
      { method, headers: token ? { authorization: `Operator ${token}` } : {} },
      res, { url, remoteAddress: "127.0.0.1", requestId: "wake-acct-test" });
    return { handled, res };
  };
  return { call };
}

test("operator route renders the wake accounting view in production shape", async t => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  assert.equal(recordWakeEvent(db, { at: 100, roomId: "commons", store: "signals", event: "emitted", kind: "mention" }), true);
  assert.equal(recordWakeEvent(db, { at: 101, roomId: "commons", store: "signals", event: "failed", kind: "mention", reason: "enqueue_error", subjectId: "ai_x" }), true);
  const { call } = operatorFixture(t, db);
  const { handled, res } = await call("/api/operator/wake-accounting");
  assert.equal(handled, true);
  assert.equal(res.status, 200);
  assert.equal(res.body.roomId, null);
  assert.equal(res.body.accounting.byStore.signals.emitted, 1);
  assert.equal(res.body.accounting.byStore.signals.failed, 1);
  assert.equal(res.body.accounting.loss.lostAttempts, 1);
  assert.equal(res.body.accounting.loss.failureRate, 0.5);
  assert.equal(res.body.accounting.failures.byReason.enqueue_error, 1);
  assert.equal(res.body.recordFailures.total, 0, "no recorder failures on the happy path");
  const roomed = await call("/api/operator/wake-accounting?roomId=commons");
  assert.equal(roomed.res.body.roomId, "commons");
  assert.equal(roomed.res.body.accounting.byStore.signals.emitted, 1);
  const other = await call("/api/operator/wake-accounting?roomId=elsewhere");
  assert.equal(other.res.body.accounting.byStore.signals.emitted, 0);
});

test("operator wake-accounting door is token-gated like every operator door", async t => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const { call } = operatorFixture(t, db);
  await assert.rejects(() => call("/api/operator/wake-accounting", { token: "wrong-token" }),
    error => error.status === 404 && error.message === "not_found");
  await assert.rejects(() => call("/api/operator/wake-accounting", { token: null }),
    error => error.status === 404 && error.message === "not_found");
});

test("a broken counter store returns false but is counted and logged centrally", t => {
  resetWakeRecordFailuresForTests();
  t.after(() => resetWakeRecordFailuresForTests());
  const brokenDb = { exec() {}, prepare() { throw new Error("disk I/O error"); } };
  const { result, lines } = captureConsoleError(() =>
    recordWakeEvent(brokenDb, { at: 1, store: "signals", event: "failed", reason: "enqueue_error" }));
  assert.equal(result, false, "the never-throws contract is unchanged");
  assert.equal(wakeRecordFailures().total, 1, "the failure is counted without any caller inspecting the return");
  assert.equal(wakeRecordFailures().last.store, "signals");
  assert.equal(wakeRecordFailures().last.event, "failed");
  assert.equal(lines.length, 1, "the first failure is logged");
  assert.match(lines[0], /wake accounting record failed/);
});

test("a partial failure rolls the counter back: no counter without its journal row", t => {
  resetWakeRecordFailuresForTests();
  t.after(() => resetWakeRecordFailuresForTests());
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  assert.equal(recordWakeEvent(db, { at: 1, store: "signals", event: "emitted" }), true);
  db.exec("DROP TABLE agent_wake_failures");
  const { result, lines } = captureConsoleError(() =>
    recordWakeEvent(db, { at: 2, store: "signals", event: "failed", reason: "enqueue_error" }));
  assert.equal(result, false);
  assert.equal(lines.length, 1);
  const counters = db.prepare("SELECT event, n FROM agent_wake_counters ORDER BY event").all()
    .map(row => ({ event: row.event, n: row.n }));
  assert.deepEqual(counters, [{ event: "emitted", n: 1 }],
    "the failed counter row was rolled back with its unwritable journal row");
  assert.equal(wakeRecordFailures().total, 1);
  const acct = wakeAccounting(db, { now: 10 });
  assert.equal(acct.loss.lostAttempts, 0, "accounting no longer reports a loss its journal cannot show");
});

test("validation refusals stay uncounted contract refusals", t => {
  resetWakeRecordFailuresForTests();
  t.after(() => resetWakeRecordFailuresForTests());
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  assert.equal(recordWakeEvent(db, { at: 1, store: "signals", event: "failed", reason: "raw exception text" }), false);
  assert.equal(recordWakeEvent(db, { at: 1, store: "bogus", event: "emitted" }), false);
  assert.equal(wakeRecordFailures().total, 0);
});
