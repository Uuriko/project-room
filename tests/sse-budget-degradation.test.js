// WAVE-500 W14: SSE survival under event-budget pressure.
//
// WHAT THIS COVERS (honest scope):
//   1. server/event-budget.mjs (W8 prototype, real module): the allocator
//      whose refusal semantics DRIVE the degradation design in
//      docs/wave500/SSE-SURVIVAL.md — reserve inviolability, per-namespace
//      isolation, honest refusals that consume nothing.
//   2. server/read-cursor.mjs (real module): the cursor rules the SSE
//      reconnect path depends on — advance-only acks (no rewind),
//      watermark = max, disagreement fold = min (no skip).
//   3. SPEC-CAPTURING tests (no live path): the terminal-frame wire contract
//      and the degradation decision table from docs/wave500/SSE-SURVIVAL.md
//      §2. These pin the exact bytes / decisions the build lane must
//      implement; they do NOT exercise server/http.mjs.
//   4. SPEC of an existing line: the lag-drop predicate mirrors
//      server/http.mjs:867 (`res.writableLength > streamQueueCap`) so a
//      future change to the comparison is a deliberate decision.
//
// WHAT THIS DOES NOT COVER:
//   - the live stream() pump (server/http.mjs:849-910), socket behavior,
//     timing, or the F1 shared pump (refs/heads/wave300-fanout-perf);
//     those need the loopback-server pattern in tests/stream-*.test.js.
//   - the compaction discontinuity-notice event shape (W4 hasn't pinned it).
//   - any timing/throughput claim about reconnect cost.

import test from "node:test";
import assert from "node:assert/strict";
import {
  createBudget,
  tryConsume,
  usage,
  CODE_EXHAUSTED,
  CODE_UNKNOWN,
} from "../server/event-budget.mjs";
import {
  sessionWatermark,
  ackDurableCursor,
  foldHorizonsMin,
} from "../server/read-cursor.mjs";

// ---------------------------------------------------------------------------
// 1. Budget allocator: exhaustion is the degradation trigger
// ---------------------------------------------------------------------------

test("budget: reserve can never be consumed, even by the last namespace", () => {
  // total 1000, 10% reserve -> 900 allocatable to the single namespace.
  let state = createBudget({ total: 1000, namespaces: { a: 1 } });
  assert.equal(state.reserve, 100);
  for (let i = 0; i < 900; i++) {
    const r = tryConsume(state, "a");
    assert.equal(r.ok, true);
    state = r.state;
  }
  const before = state.ns.a.used;
  const refused = tryConsume(state, "a");
  assert.equal(refused.ok, false);
  assert.equal(refused.code, CODE_EXHAUSTED);
  // Honest refusal: nothing was consumed — same state object back.
  assert.equal(refused.state, state);
  assert.equal(state.ns.a.used, before);
  assert.equal(state.ns.a.used, 900);
});

test("budget: one namespace's exhaustion does not touch another's allocation", () => {
  let state = createBudget({ total: 2000, namespaces: { a: 1, b: 1 } });
  // a gets 900 (10% reserve, even split); exhaust it.
  for (let i = 0; i < 900; i++) state = tryConsume(state, "a").state;
  assert.equal(tryConsume(state, "a").ok, false);
  // b is unaffected.
  const r = tryConsume(state, "b", 100);
  assert.equal(r.ok, true);
  assert.equal(r.state.ns.b.used, 100);
  assert.equal(r.state.ns.a.used, 900);
});

test("budget: borrowing draws only from the unallocated pool, never the reserve", () => {
  // reserveRatio 0, three equal weights on 1001 -> 333 each, pool = 2.
  // borrowRatio 1 so the whole pool is borrowable.
  let state = createBudget({
    total: 1001,
    namespaces: { a: 1, b: 1, c: 1 },
    reserveRatio: 0,
    borrowRatio: 1,
  });
  assert.equal(state.unallocatedPool, 2);
  for (let i = 0; i < 333; i++) state = tryConsume(state, "a").state;
  const borrowed = tryConsume(state, "a", 2);
  assert.equal(borrowed.ok, true);
  state = borrowed.state;
  assert.equal(state.ns.a.used, 335);
  assert.equal(state.ns.a.borrowed, 2);
  assert.equal(state.unallocatedPool, 0);
  // Pool empty -> further consumption refuses, even though b and c sit on
  // full allocations. Borrowing NEVER touches another namespace's share.
  const refused = tryConsume(state, "a", 1);
  assert.equal(refused.ok, false);
  assert.equal(refused.code, CODE_EXHAUSTED);
  assert.equal(state.ns.b.used, 0);
  assert.equal(state.ns.c.used, 0);
});

test("budget: usage() reports borrowed consumption honestly (pct may exceed 1)", () => {
  let state = createBudget({
    total: 1001,
    namespaces: { a: 1, b: 1, c: 1 },
    reserveRatio: 0,
    borrowRatio: 1,
  });
  for (let i = 0; i < 333; i++) state = tryConsume(state, "a").state;
  state = tryConsume(state, "a", 2).state;
  const u = usage(state);
  assert.equal(u.a.used, 335);
  assert.equal(u.a.allocated, 333);
  assert.ok(u.a.pct > 1, "borrowed consumption is reported, not clamped");
  assert.equal(u.b.pct, 0);
});

test("budget: unknown namespace refuses with its own code and consumes nothing", () => {
  const state = createBudget({ total: 1000, namespaces: { a: 1 } });
  const r = tryConsume(state, "nope");
  assert.equal(r.ok, false);
  assert.equal(r.code, CODE_UNKNOWN);
  assert.equal(r.state, state);
  assert.match(r.message, /Unknown event namespace/);
});

test("budget: refusal carries a retry hint but no silent queue", () => {
  let state = createBudget({ total: 1000, namespaces: { a: 1 } });
  for (let i = 0; i < 900; i++) state = tryConsume(state, "a").state;
  const r = tryConsume(state, "a");
  assert.equal(typeof r.retryAfterSec, "number");
  assert.ok(r.retryAfterSec > 0);
  assert.match(r.message, /nothing was consumed/);
});

test("budget: invalid construction throws", () => {
  assert.throws(() => createBudget({ total: 0, namespaces: { a: 1 } }), TypeError);
  assert.throws(() => createBudget({ total: 100, namespaces: {} }), TypeError);
  assert.throws(() => createBudget({ total: 100, namespaces: { a: -1 } }), TypeError);
  assert.throws(() => tryConsume(createBudget({ total: 100, namespaces: { a: 1 } }), "a", 0), TypeError);
});

// ---------------------------------------------------------------------------
// 2. Cursor rules the SSE reconnect path depends on
// ---------------------------------------------------------------------------

test("cursor: durable ack is advance-only — a stale Last-Event-ID never rewinds", () => {
  // Consumer reconnects with ?after=90 while the server already holds 100.
  assert.equal(ackDurableCursor(100, 90), 100);
  assert.equal(ackDurableCursor(100, 100), 100);
  assert.equal(ackDurableCursor(100, 120), 120);
  assert.equal(ackDurableCursor(null, 50), 50);
  assert.equal(ackDurableCursor(50, null), 50);
});

test("cursor: session watermark is the max of durable and session positions", () => {
  // Resume from the furthest acknowledged point, never the older one.
  assert.equal(sessionWatermark(100, 90), 100);
  assert.equal(sessionWatermark(90, 100), 100);
  assert.equal(sessionWatermark(null, 40), 40);
  assert.equal(sessionWatermark("120", 100), 120); // string positions normalize
});

test("cursor: horizon fold takes MIN — disagreement re-delivers, never skips", () => {
  assert.equal(foldHorizonsMin([100, 140, 90]), 90);
  assert.equal(foldHorizonsMin([100, null, 140]), 100);
  assert.equal(foldHorizonsMin([]), null);
  assert.equal(foldHorizonsMin([null, undefined]), null);
});

// ---------------------------------------------------------------------------
// 3. SPEC: terminal-frame wire contract (docs/wave500/SSE-SURVIVAL.md §2.2)
//
// The `room_budget_exhausted` frame does not exist in server/http.mjs yet
// (this worker may not touch the live SSE path). These tests pin the exact
// bytes the build lane must emit and the parser rule that keeps
// Last-Event-ID resume safe.
// ---------------------------------------------------------------------------

// Proposed frame shape — mirrors the room_event_budget_low refusal body and
// the no-`id:` rule of every existing terminal frame (http.mjs:874, :903).
function terminalFrame({ successorId = null } = {}) {
  const data = {
    eventsRemaining: 0,
    successor_id: successorId,
    hint: "Event budget exhausted; writes are refused. Reads and export remain available. Reconnect delay 60s.",
    reconnect_delay_ms: 60000,
    next: [{ command: "GET /api/rooms/{roomId}/export" }],
  };
  return `event: room_budget_exhausted\ndata: ${JSON.stringify(data)}\n\n`;
}

// Minimal SSE frame parser: enough to extract event / id / data lines.
function parseSseFrame(raw) {
  const frame = { event: undefined, id: undefined, data: [] };
  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) frame.event = line.slice(6).trim();
    else if (line.startsWith("id:")) frame.id = line.slice(3).trim();
    else if (line.startsWith("data:")) frame.data.push(line.slice(5).trim());
  }
  return { event: frame.event, id: frame.id, data: frame.data.join("\n") };
}

test("spec: terminal frame carries no id: line — it must not become a resume cursor", () => {
  const raw = terminalFrame();
  assert.ok(!/^id:/m.test(raw), "no id: line anywhere in the frame");
  const frame = parseSseFrame(raw);
  assert.equal(frame.event, "room_budget_exhausted");
  assert.equal(frame.id, undefined);
  const data = JSON.parse(frame.data);
  assert.equal(data.eventsRemaining, 0);
  assert.equal(typeof data.hint, "string");
  assert.ok(
    Number.isInteger(data.reconnect_delay_ms) && data.reconnect_delay_ms > 0,
    "reconnect_delay_ms is a positive-integer hint, not an HTTP Retry-After",
  );
  assert.ok(Array.isArray(data.next) && data.next.length > 0);
});

test("spec: terminal frame with a rotation successor names it (room_rotated path)", () => {
  const frame = parseSseFrame(terminalFrame({ successorId: "room-2" }));
  assert.equal(JSON.parse(frame.data).successor_id, "room-2");
  assert.equal(frame.id, undefined);
});

test("spec: only id:-bearing frames advance the client's Last-Event-ID", () => {
  // Byte shapes copied from server/http.mjs as written today (:874, :903)
  // and the typing ephemeral (:889-897): none carries an id: line.
  const frames = [
    "id: 41\nevent: room-event\ndata: {\"sequence\":41}\n\n",
    'event: typing\ndata: {"typists":[]}\n\n',
    'event: stream_lagging\ndata: {"message":"Client fell behind; reconnect with Last-Event-ID to resume"}\n\n',
    'event: access-ended\ndata: {"message":"Access ended; sign in again"}\n\n',
    terminalFrame(),
  ];
  let lastId = null;
  for (const raw of frames) {
    const frame = parseSseFrame(raw);
    if (frame.id !== undefined) lastId = frame.id; // the resume rule
  }
  assert.equal(lastId, "41", "terminal/typing/lag frames must not move the cursor");
});

// ---------------------------------------------------------------------------
// 4. SPEC: degradation decision table (docs/wave500/SSE-SURVIVAL.md §2)
//
// Pure function of the room's used-budget ratio. NOT wired into
// server/http.mjs (constraint of this worker); the build lane owns the
// hookup. The test pins the boundary behavior the doc promises.
// ---------------------------------------------------------------------------

function degradationAction(usedRatio) {
  if (typeof usedRatio !== "number" || Number.isNaN(usedRatio) || usedRatio < 0) {
    throw new TypeError("usedRatio must be a non-negative number");
  }
  if (usedRatio >= 1) return "terminal"; // EXHAUSTED: frame + clean close
  if (usedRatio >= 0.9) return "warn"; // WARN: in-band notice, transport unchanged
  return "flow"; // healthy: no transport change
}

test("spec: degradation decision boundaries", () => {
  assert.equal(degradationAction(0), "flow");
  assert.equal(degradationAction(0.899), "flow");
  assert.equal(degradationAction(0.9), "warn");
  assert.equal(degradationAction(0.999), "warn");
  assert.equal(degradationAction(1), "terminal");
  assert.equal(degradationAction(1.5), "terminal");
  assert.throws(() => degradationAction(-0.1), TypeError);
  assert.throws(() => degradationAction(NaN), TypeError);
});

// ---------------------------------------------------------------------------
// 5. SPEC of an existing line: the lag-drop predicate (server/http.mjs:867)
// ---------------------------------------------------------------------------

test("spec: lagging() is a strict greater-than on the send-queue cap", () => {
  // Mirrors `const lagging = () => res.writableLength > streamQueueCap`.
  const lagging = (writableLength, streamQueueCap) => writableLength > streamQueueCap;
  const CAP = 65536; // createRoomServer default, http.mjs:301
  assert.equal(lagging(0, CAP), false);
  assert.equal(lagging(CAP - 1, CAP), false);
  assert.equal(lagging(CAP, CAP), false, "exactly at the cap is not lagging");
  assert.equal(lagging(CAP + 1, CAP), true);
});
