// Board-v2 SQLite persistence tests (RC-2026-09-27).
//
// Contract: the durable registry must store and retrieve board state
// (claims, events, idempotency keys) correctly via SQLite. This is the
// durability boundary — data written must survive and be queryable.
//
// Authoring gate:
// 1. Protects: SQLite schema correctness, JSON serialization round-trips,
//    seq monotonicity, upsert semantics.
// 2. Regression: schema drift (column missing), JSON parse failures on
//    complex payloads, seq gaps, data loss on claim updates.
// 3. Existing coverage: board-v2.test.js covers the in-memory BoardV2 only;
//    no coverage for the SQLite module exists.
// 4. No production seam: uses real node:sqlite DatabaseSync, the production API.

import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { boardV2Schema, createDurableBoardV2 } from "../server/board-v2-sqlite.mjs";

function setup() {
  const db = new DatabaseSync(":memory:");
  db.exec(boardV2Schema);
  const board = createDurableBoardV2(db);
  return { db, board };
}

test("schema verifies cleanly after creation", () => {
  const { board } = setup();
  assert.equal(board.verifySchema(), true);
});

test("seq starts at 0 and increments on event append", () => {
  const { board } = setup();
  assert.equal(board.seq(), 0);
  const e1 = board.appendEvent({ kind: "claim", task_id: "RC-2026-09-27-001", lane: "jill", payload: { files: ["a.md"] } });
  assert.equal(e1.seq, 1);
  assert.equal(board.seq(), 1);
  const e2 = board.appendEvent({ kind: "heartbeat", task_id: "RC-2026-09-27-001", lane: "jill", payload: {} });
  assert.equal(e2.seq, 2);
  assert.equal(board.seq(), 2);
});

test("claim put/get round-trip preserves all fields", () => {
  const { board } = setup();
  const claim = {
    task_id: "RC-2026-09-27-001",
    lane: "jill",
    files: ["docs/a.md", "server/b.mjs"],
    lease: "lease=6h",
    lease_h: 6,
    reason: "test claim",
    state: "submitted",
    claim_seq: 1,
    claim_at_ms: Date.parse("2026-09-27T00:00:00.000Z"),
    heartbeat_at_ms: null,
    last_seq: 1,
    receipts: [],
  };
  board.putClaim(claim);
  const got = board.getClaim("RC-2026-09-27-001");
  assert.equal(got.task_id, claim.task_id);
  assert.equal(got.lane, claim.lane);
  assert.deepEqual(got.files, claim.files);
  assert.equal(got.lease, claim.lease);
  assert.equal(got.lease_h, claim.lease_h);
  assert.equal(got.reason, claim.reason);
  assert.equal(got.state, claim.state);
  assert.equal(got.claim_seq, claim.claim_seq);
  assert.equal(got.claim_at_ms, claim.claim_at_ms);
  assert.equal(got.heartbeat_at_ms, null);
  assert.equal(got.last_seq, claim.last_seq);
  assert.deepEqual(got.receipts, []);
});

test("claim upsert updates existing row", () => {
  const { board } = setup();
  const base = {
    task_id: "RC-2026-09-27-001", lane: "jill", files: ["a.md"],
    lease: "lease=6h", lease_h: 6, reason: "v1", state: "submitted",
    claim_seq: 1, claim_at_ms: Date.parse("2026-09-27T00:00:00.000Z"),
    heartbeat_at_ms: null, last_seq: 1, receipts: [],
  };
  board.putClaim(base);
  const updated = {
    ...base, state: "working", last_seq: 2,
    heartbeat_at_ms: Date.parse("2026-09-27T01:00:00.000Z"),
    receipts: [{ seq: 3, at: "2026-09-27T02:00:00.000Z", sha: "abc1234", pr: 100 }],
  };
  board.putClaim(updated);
  const got = board.getClaim("RC-2026-09-27-001");
  assert.equal(got.state, "working");
  assert.equal(got.last_seq, 2);
  assert.equal(got.heartbeat_at_ms, updated.heartbeat_at_ms);
  assert.deepEqual(got.receipts, updated.receipts);
});

test("event payload JSON round-trips complex objects", () => {
  const { board } = setup();
  const payload = {
    files: ["a.md", "b/c.mjs"],
    nested: { deep: [1, 2, { three: "four" }] },
    unicode: "héllo wörld 🪔",
  };
  const { seq } = board.appendEvent({ kind: "claim", task_id: "RC-2026-09-27-001", lane: "jill", payload });
  const event = board.getEvent(seq);
  assert.deepEqual(event.payload, payload);
});

test("listEvents paginates with has_more", () => {
  const { board } = setup();
  for (let i = 0; i < 5; i++) {
    board.appendEvent({ kind: "note", task_id: null, lane: "jill", payload: { i } });
  }
  const page1 = board.listEvents({ since_seq: 0, limit: 2 });
  assert.equal(page1.events.length, 2);
  assert.equal(page1.has_more, true);
  assert.equal(page1.events[0].seq, 1);
  assert.equal(page1.events[1].seq, 2);

  const page2 = board.listEvents({ since_seq: 2, limit: 10 });
  assert.equal(page2.events.length, 3);
  assert.equal(page2.has_more, false);
});

test("idempotency put/get round-trip", () => {
  const { board } = setup();
  const body = { watermark: 5, seq: 5, claim: { task_id: "RC-2026-09-27-001" } };
  board.putIdempotency("jill", "key-123", { status: 201, body, fingerprint: "fp-abc" });
  const got = board.getIdempotency("jill", "key-123");
  assert.equal(got.status, 201);
  assert.deepEqual(got.body, body);
  assert.equal(got.fingerprint, "fp-abc");
  assert.ok(got.created_at > 0);
});

test("idempotency is per-lane scoped", () => {
  const { board } = setup();
  board.putIdempotency("jill", "key-123", { status: 201, body: {}, fingerprint: "fp" });
  const other = board.getIdempotency("codex", "key-123");
  assert.equal(other, null);
});

test("mirror record/resolve round-trip", () => {
  const { board } = setup();
  const { seq } = board.appendEvent({ kind: "claim", task_id: "RC-2026-09-27-001", lane: "jill", payload: {} });
  board.recordMirror({ seq, issue: 266, comment_id: 5852778660 });
  const resolved = board.resolveMirror({ issue: 266, comment_id: 5852778660 });
  assert.equal(resolved.seq, seq);
  assert.equal(resolved.issue, 266);
  assert.equal(resolved.comment_id, 5852778660);
});
