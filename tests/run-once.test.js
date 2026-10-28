// runOnce / executeOnce — the shared idempotency flow (decision #19b).
// Both ways: a first call executes and journals; a retry replays without
// executing; a fingerprint mismatch conflicts; a throwing execute journals
// nothing. Adopters (buyer-signoff, attention) keep their own journals via
// executeOnce — their behavior is pinned by their own test files.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { runOnce, executeOnce } from "../server/run-once.mjs";

const newDb = () => new DatabaseSync(":memory:");

test("runOnce: first call executes, retry replays the journaled outcome", () => {
  const db = newDb();
  let calls = 0;
  const execute = () => { calls += 1; return { ok: true, n: calls, nested: { list: [1, 2, 3] } }; };
  const first = runOnce(db, "scope-a", "req-1", execute, { fingerprint: "fp-1" });
  assert.equal(first.replayed, false);
  assert.deepEqual(first.result, { ok: true, n: 1, nested: { list: [1, 2, 3] } });
  const retry = runOnce(db, "scope-a", "req-1", execute, { fingerprint: "fp-1" });
  assert.equal(retry.replayed, true);
  assert.deepEqual(retry.result, first.result);
  assert.equal(calls, 1, "execute must not run on a replay");
});

test("runOnce: fingerprint mismatch conflicts 409 idempotency_conflict", () => {
  const db = newDb();
  runOnce(db, "scope-a", "req-1", () => ({ v: 1 }), { fingerprint: "fp-1" });
  assert.throws(
    () => runOnce(db, "scope-a", "req-1", () => ({ v: 2 }), { fingerprint: "fp-2" }),
    err => err.status === 409 && err.code === "idempotency_conflict",
  );
});

test("runOnce: no fingerprint supplied replays without a conflict check", () => {
  const db = newDb();
  runOnce(db, "scope-a", "req-1", () => ({ v: 1 }), { fingerprint: "fp-1" });
  const retry = runOnce(db, "scope-a", "req-1", () => ({ v: 2 }));
  assert.equal(retry.replayed, true);
  assert.deepEqual(retry.result, { v: 1 });
});

test("runOnce: custom conflict code/message are honored (legacy-journal shape)", () => {
  const db = newDb();
  const opts = { fingerprint: "a", conflictCode: "request_id_reused", conflictMessage: "Request ID already used with different input" };
  runOnce(db, "scope-a", "req-1", () => ({ v: 1 }), opts);
  assert.throws(
    () => runOnce(db, "scope-a", "req-1", () => ({ v: 2 }), { ...opts, fingerprint: "b" }),
    err => err.status === 409 && err.code === "request_id_reused" && err.message === "Request ID already used with different input",
  );
});

test("runOnce: a throwing execute journals nothing; the retry executes", () => {
  const db = newDb();
  let calls = 0;
  const flaky = () => { calls += 1; if (calls === 1) throw new Error("boom"); return { v: calls }; };
  assert.throws(() => runOnce(db, "scope-a", "req-1", flaky), /boom/);
  const retry = runOnce(db, "scope-a", "req-1", flaky);
  assert.equal(retry.replayed, false);
  assert.deepEqual(retry.result, { v: 2 });
  assert.equal(calls, 2);
});

test("runOnce: scopes and requestIds partition independently", () => {
  const db = newDb();
  let calls = 0;
  const execute = () => { calls += 1; return { n: calls }; };
  runOnce(db, "scope-a", "req-1", execute);
  runOnce(db, "scope-b", "req-1", execute);
  runOnce(db, "scope-a", "req-2", execute);
  assert.equal(calls, 3);
  assert.equal(runOnce(db, "scope-b", "req-1", execute).replayed, true);
  assert.equal(calls, 3);
});

test("runOnce: invalid scope or requestId is a 422, nothing executes", () => {
  const db = newDb();
  let calls = 0;
  const execute = () => { calls += 1; return {}; };
  assert.throws(() => runOnce(db, "", "req-1", execute), err => err.status === 422 && err.code === "invalid_request_id");
  assert.throws(() => runOnce(db, "scope-a", "not a valid id!", execute), err => err.status === 422 && err.code === "invalid_request_id");
  assert.equal(calls, 0);
});

test("runOnce: execute returning undefined is a programmer error, nothing journaled", () => {
  const db = newDb();
  assert.throws(() => runOnce(db, "scope-a", "req-1", () => undefined), TypeError);
  const retry = runOnce(db, "scope-a", "req-1", () => ({ v: 1 }));
  assert.equal(retry.replayed, false);
});

test("executeOnce: caller-owned journal — replay, conflict, and record flow", () => {
  const journal = new Map();
  let calls = 0;
  const flow = fingerprint => executeOnce({
    fingerprint,
    conflictCode: "request_id_reused",
    conflictMessage: "Request ID already used with different input",
    find: () => journal.get("k") ?? null,
    execute: () => { calls += 1; return { outcome: calls }; },
    record: result => journal.set("k", { fingerprint, result }),
  });
  assert.deepEqual(flow("fp-1"), { result: { outcome: 1 }, replayed: false });
  assert.deepEqual(flow("fp-1"), { result: { outcome: 1 }, replayed: true });
  assert.equal(calls, 1);
  assert.throws(() => flow("fp-2"), err => err.status === 409 && err.code === "request_id_reused");
});
