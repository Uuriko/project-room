// WAVE-500 guild-4: fail-first probes for wake batch/page limit handling.
// #2536's claimWakeBatch was held out of main by PR #2560 (2026-10-10), so
// these probes target the live surface: AgentHeartbeats.pendingWakePage,
// the only wake queue read with a caller-controlled limit. Every probe
// below asserts the SAFE behavior: limit=0, negative, non-integer, NaN,
// string, and >MAX_PENDING_WAKES (50) must 422 (invalid_heartbeat) before
// any DB read; valid limits return at most `limit` rows with `more` set.
// Synthetic fixtures only — no network calls, no real credentials.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  AgentHeartbeats, HeartbeatError, agentHeartbeatSchema,
} from "../server/agent-heartbeats.mjs";

const T0 = 1_750_000_000_000;
const AGENT = "ai_testagent";

function unit(t) {
  const db = new DatabaseSync(":memory:");
  db.exec(agentHeartbeatSchema);
  let at = T0;
  const hb = new AgentHeartbeats({ db, now: () => at }, {});
  t.after(() => db.close());
  return { hb, advance: ms => { at += ms; } };
}

function seedSignals(hb, n, advance) {
  for (let i = 0; i < n; i++) {
    hb.enqueueWake({ agentId: AGENT, kind: "mention", messageId: `msg-${i}` });
    advance(1);
  }
}

const is422 = err =>
  err instanceof HeartbeatError && err.status === 422 && err.code === "invalid_heartbeat";

// (a) limit=0 — empty batch or error? Must be a 422, not an empty page.
test("wake page: limit=0 is a 422, not an empty batch", t => {
  const { hb } = unit(t);
  assert.throws(() => hb.pendingWakePage(AGENT, { limit: 0 }), is422);
});

// (b) negative limit — 422, never wraps to a huge unsigned LIMIT.
test("wake page: negative limit is a 422", t => {
  const { hb } = unit(t);
  assert.throws(() => hb.pendingWakePage(AGENT, { limit: -1 }), is422);
  assert.throws(() => hb.pendingWakePage(AGENT, { limit: -Number.MAX_SAFE_INTEGER }), is422);
});

// (d) non-integer / NaN / string limits — 422, not 500.
test("wake page: non-integer, NaN, and string limits are 422s", t => {
  const { hb } = unit(t);
  for (const bad of [1.5, NaN, Infinity, "10", "abc", null, {}, []]) {
    assert.throws(() => hb.pendingWakePage(AGENT, { limit: bad }), is422, `limit=${String(bad)}`);
  }
  // undefined is not an error: destructuring default applies (limit=50).
  const def = hb.pendingWakePage(AGENT, { limit: undefined });
  assert.equal(def.signals.length, 0);
});

// (e) huge limit (1e9) — 422 before any DB read; no whole-table materialization.
test("wake page: huge limit is a 422, capped at MAX_PENDING_WAKES=50", t => {
  const { hb, advance } = unit(t);
  seedSignals(hb, 60, advance);
  assert.throws(() => hb.pendingWakePage(AGENT, { limit: 1e9 }), is422);
  assert.throws(() => hb.pendingWakePage(AGENT, { limit: 51 }), is422);
  // The cap itself is honored: 50 rows + more=true, never the whole table.
  const page = hb.pendingWakePage(AGENT, { limit: 50 });
  assert.equal(page.signals.length, 50);
  assert.equal(page.more, true);
});

// (c) limit larger than the queue — returns everything queued, more=false.
test("wake page: limit larger than the queue returns all signals", t => {
  const { hb, advance } = unit(t);
  seedSignals(hb, 5, advance);
  const page = hb.pendingWakePage(AGENT, { limit: 50 });
  assert.equal(page.signals.length, 5);
  assert.equal(page.more, false);
});

// (f) default limit matches the pendingWakePage cap (MAX_PENDING_WAKES=50).
test("wake page: default limit is capped at 50 with more=true", t => {
  const { hb, advance } = unit(t);
  seedSignals(hb, 60, advance);
  const page = hb.pendingWakePage(AGENT);
  assert.equal(page.signals.length, 50);
  assert.equal(page.more, true);
});

// Boundary sanity: limit=1 returns one row; oldest-first ordering preserved.
test("wake page: limit=1 returns the oldest signal", t => {
  const { hb, advance } = unit(t);
  seedSignals(hb, 3, advance);
  const page = hb.pendingWakePage(AGENT, { limit: 1 });
  assert.equal(page.signals.length, 1);
  assert.equal(page.signals[0].messageId, "msg-0");
  assert.equal(page.more, true);
});
