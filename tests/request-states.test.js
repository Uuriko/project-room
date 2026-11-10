import test from "node:test";
import assert from "node:assert/strict";
import { deriveRequestState, withRequestState, requestStatesEnabled, ACK_WINDOW_MS, STALE_AFTER_MS } from "../server/request-states.mjs";
const TH = { ackWindowMs: 10_000, staleAfterMs: 30 * 60 * 1000 };

const t0 = Date.parse("2026-11-04T20:00:00.000Z");
const at = ms => new Date(t0 + ms).toISOString();
const open = extra => ({ status: "open", createdAt: at(0), ...extra });

test("states are on by default and only '0' turns them off", () => {
  assert.equal(requestStatesEnabled({}), true);
  assert.equal(requestStatesEnabled(undefined), true);
  assert.equal(requestStatesEnabled({ ROOM_REQUEST_STATES: "1" }), true);
  assert.equal(requestStatesEnabled({ ROOM_REQUEST_STATES: "false" }), true);
  assert.equal(requestStatesEnabled({ ROOM_REQUEST_STATES: "0" }), false);
});

test("withRequestState leaves the compact shape untouched only when switched off", () => {
  const compact = { id: "r1", status: "open" };
  assert.deepEqual(withRequestState(compact, open(), { env: { ROOM_REQUEST_STATES: "0" } }), compact);
  const on = withRequestState(compact, open(), { env: {}, now: t0 + 1000 });
  assert.equal(on.lifecycle.state, "pending");
  assert.equal(on.id, "r1");
});

test("pending within the ack window, unresponsive after it", () => {
  assert.deepEqual(deriveRequestState(open(), { now: t0 + ACK_WINDOW_MS }), { state: "pending", unresponsive: false, since: at(0), thresholds: TH });
  assert.equal(deriveRequestState(open(), { now: t0 + ACK_WINDOW_MS + 1 }).unresponsive, true);
});

test("acknowledged requests are active and never unresponsive", () => {
  const s = deriveRequestState(open({ acknowledgedAt: at(3000) }), { now: t0 + 60_000 });
  assert.equal(s.state, "active");
  assert.equal(s.unresponsive, false);
});

test("needs_input and error: the latest signal wins", () => {
  assert.equal(deriveRequestState(open({ acknowledgedAt: at(1), needsInputAt: at(5) }), { now: t0 + 10 }).state, "needs_input");
  assert.equal(deriveRequestState(open({ acknowledgedAt: at(1), errorAt: at(5) }), { now: t0 + 10 }).state, "error");
  assert.equal(deriveRequestState(open({ errorAt: at(5), needsInputAt: at(9) }), { now: t0 + 10 }).state, "needs_input");
  assert.equal(deriveRequestState(open({ needsInputAt: at(5), errorAt: at(9) }), { now: t0 + 10 }).state, "error");
});

test("terminal statuses are complete with their outcome", () => {
  for (const status of ["answered", "declined", "cancelled"]) {
    const s = deriveRequestState({ status, createdAt: at(0), closedAt: at(50) }, { now: t0 + STALE_AFTER_MS * 2 });
    assert.deepEqual(s, { state: "complete", outcome: status, unresponsive: false, since: at(50), thresholds: TH });
  }
});

test("open requests with no activity for 30 minutes are stale", () => {
  assert.equal(deriveRequestState(open({ acknowledgedAt: at(1) }), { now: t0 + STALE_AFTER_MS + 2 }).state, "stale");
  assert.equal(deriveRequestState(open({ acknowledgedAt: at(1), lastActivityAt: at(STALE_AFTER_MS) }), { now: t0 + STALE_AFTER_MS + 2 }).state, "active");
  assert.equal(deriveRequestState(open({ needsInputAt: at(1) }), { now: t0 + STALE_AFTER_MS * 3 }).state, "needs_input");
});

test("missing or bad createdAt degrades to pending", () => {
  assert.equal(deriveRequestState(null).state, "pending");
  assert.equal(deriveRequestState({ status: "open", createdAt: "nope" }).state, "pending");
});

test("stale threshold is 30 minutes and both thresholds ride every result", () => {
  assert.equal(STALE_AFTER_MS, 30 * 60 * 1000);
  assert.deepEqual(deriveRequestState(open(), { now: t0 }).thresholds, { ackWindowMs: ACK_WINDOW_MS, staleAfterMs: STALE_AFTER_MS });
  assert.equal(deriveRequestState(open({ acknowledgedAt: at(1) }), { now: t0 + 29 * 60 * 1000 }).state, "active");
});
