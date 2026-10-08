// tests/request-dedupe.test.js — crash-recovery guild, B1 dedupe store.
// Fail-first tests for server/request-dedupe.mjs:
//   the requestId→result dedupe store behind idempotent work-claim mutations.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { ensureDedupeTable, readRequestId, createDedupeStore } from "../server/request-dedupe.mjs";

function freshStore(ttlMs) {
  const db = new DatabaseSync(":memory:");
  ensureDedupeTable(db);
  return { db, store: createDedupeStore(db, ttlMs === undefined ? {} : { ttlMs }) };
}

function rowCount(db) {
  return db.prepare("SELECT COUNT(*) AS n FROM request_dedupe").get().n;
}

test("record then check -> duplicate:true with identical result", () => {
  const { store } = freshStore();
  const result = { ok: true, claimId: "abc-123", seq: 42, tags: ["x", "y"] };
  store.record("req-1", result);
  const hit = store.check("req-1");
  assert.equal(hit.duplicate, true);
  assert.deepEqual(hit.result, result);
});

test("check unknown id -> duplicate:false", () => {
  const { store } = freshStore();
  assert.deepEqual(store.check("never-seen"), { duplicate: false });
  assert.deepEqual(store.check(null), { duplicate: false });
  assert.deepEqual(store.check(undefined), { duplicate: false });
  assert.deepEqual(store.check(123), { duplicate: false });
  assert.deepEqual(store.check(""), { duplicate: false });
});

test("record twice (retry) -> exactly one row, check duplicate:true", () => {
  const { db, store } = freshStore();
  store.record("req-retry", { attempt: 1 });
  store.record("req-retry", { attempt: 1 });
  assert.equal(rowCount(db), 1);
  const hit = store.check("req-retry");
  assert.equal(hit.duplicate, true);
  assert.deepEqual(hit.result, { attempt: 1 });
});

test("expired entry -> duplicate:false; prune removes it and returns count", () => {
  const ttlMs = 60_000;
  const { db, store } = freshStore(ttlMs);
  const old = Date.now() - ttlMs - 1;
  store.record("req-old", { v: 1 });
  db.prepare("UPDATE request_dedupe SET created_at = ? WHERE request_id = ?").run(old, "req-old");
  store.record("req-fresh", { v: 2 });
  assert.deepEqual(store.check("req-old"), { duplicate: false });
  const fresh = store.check("req-fresh");
  assert.equal(fresh.duplicate, true);
  assert.deepEqual(fresh.result, { v: 2 });
  const deleted = store.prune();
  assert.equal(deleted, 1);
  assert.equal(rowCount(db), 1);
  // prune is idempotent on a clean table
  assert.equal(store.prune(), 0);
});

test("readRequestId: valid -> id; bad shapes -> null; never throws", () => {
  assert.equal(readRequestId({ requestId: "abc-123" }), "abc-123");
  assert.equal(readRequestId({ requestId: "x".repeat(128) }), "x".repeat(128));
  assert.equal(readRequestId({}), null);
  assert.equal(readRequestId({ requestId: "x".repeat(129) }), null);
  assert.equal(readRequestId({ requestId: "" }), null);
  assert.equal(readRequestId({ requestId: 42 }), null);
  assert.equal(readRequestId({ requestId: null }), null);
  assert.equal(readRequestId({ requestId: ["a"] }), null);
  assert.equal(readRequestId(null), null);
  assert.equal(readRequestId(undefined), null);
  assert.equal(readRequestId("requestId=abc"), null);
  assert.equal(readRequestId(42), null);
});

test("record with unserializable result throws BEFORE any write", () => {
  const { db, store } = freshStore();
  const circular = { a: 1 };
  circular.self = circular;
  assert.throws(() => store.record("req-bad", circular), /JSON-serializable/);
  assert.equal(rowCount(db), 0, "no row may be stored when serialization fails");
  assert.deepEqual(store.check("req-bad"), { duplicate: false });
  // JSON.stringify(undefined) returns undefined, not a string: also rejected
  assert.throws(() => store.record("req-undef", undefined), /JSON-serializable/);
  assert.equal(rowCount(db), 0);
});

test("record with invalid requestId is a silent no-op", () => {
  const { db, store } = freshStore();
  for (const bad of [null, undefined, "", 42, "x".repeat(129), {}]) {
    store.record(bad, { v: 1 }); // must not throw
  }
  assert.equal(rowCount(db), 0);
});

test("ensureDedupeTable is idempotent", () => {
  const db = new DatabaseSync(":memory:");
  ensureDedupeTable(db);
  ensureDedupeTable(db);
  const cols = db
    .prepare("PRAGMA table_info(request_dedupe)")
    .all()
    .map((c) => c.name);
  assert.deepEqual(cols, ["request_id", "result_json", "created_at"]);
});
