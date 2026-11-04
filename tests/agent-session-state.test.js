import test from "node:test";
import assert from "node:assert/strict";
import { agentSessionOf, withAgentSessions, AGENT_SESSION_STATES, STALE_AFTER_MS } from "../server/agent-session-state.mjs";

const T0 = Date.parse("2026-11-03T12:00:00.000Z");
const iso = ms => new Date(ms).toISOString();
const claim = (over = {}) => ({ id: "w1", state: "claimed", owner: "a1", claimedAt: iso(T0),
  history: [{ at: iso(T0), agentId: "a1", action: "state", note: "claimed" }], ...over });

test("six Linear states and no session for unowned work", () => {
  assert.deepEqual(AGENT_SESSION_STATES, ["pending", "active", "awaitingInput", "error", "complete", "stale"]);
  assert.equal(agentSessionOf({ id: "w", state: "unclaimed", owner: null }, T0), null);
  assert.equal(agentSessionOf({ id: "w", state: "closed", owner: "a1" }, T0), null);
});

test("pending before first activity, unresponsive after 10s, stale after 30 min", () => {
  assert.deepEqual(agentSessionOf(claim(), T0 + 1000), { state: "pending", reason: "starting" });
  assert.deepEqual(agentSessionOf(claim(), T0 + 11_000), { state: "pending", reason: "unresponsive" });
  assert.deepEqual(agentSessionOf(claim(), T0 + STALE_AFTER_MS + 1), { state: "stale", reason: "no_activity" });
});

test("owner activity makes it active; other agents' stamps do not", () => {
  const busy = claim({ state: "in_progress", history: [...claim().history, { at: iso(T0 + 5000), agentId: "a1", action: "state", note: "in_progress" }] });
  assert.equal(agentSessionOf(busy, T0 + 60_000).state, "active");
  const other = claim({ history: [...claim().history, { at: iso(T0 + 5000), agentId: "a2", action: "note" }] });
  assert.equal(agentSessionOf(other, T0 + 60_000).state, "pending");
  assert.equal(agentSessionOf(busy, T0 + 5000 + STALE_AFTER_MS + 1).state, "stale");
});

test("blocked/delivered await input, CI failure is error, done is complete, lapsed lease is stale", () => {
  assert.deepEqual(agentSessionOf(claim({ state: "blocked" }), T0), { state: "awaitingInput", reason: "blocked" });
  assert.deepEqual(agentSessionOf(claim({ state: "delivered" }), T0), { state: "awaitingInput", reason: "awaiting_review" });
  assert.deepEqual(agentSessionOf(claim({ state: "in_progress", ci: { state: "failure" } }), T0), { state: "error", reason: "ci_failure" });
  assert.deepEqual(agentSessionOf(claim({ state: "done" }), T0), { state: "complete", reason: "verified" });
  assert.deepEqual(agentSessionOf(claim({ state: "in_progress", leaseExpiresAt: iso(T0 - 1) }), T0), { state: "stale", reason: "lease_expired" });
});

test("board decoration is off by default and additive when on", () => {
  const claims = [claim(), { id: "w2", state: "unclaimed", owner: null }];
  assert.equal(withAgentSessions(claims, T0, {}), claims);
  const on = withAgentSessions(claims, T0 + 1000, { ROOM_AGENT_SESSION_STATES: "1" });
  assert.equal(on[0].agentSession, "pending");
  assert.equal("agentSession" in on[1], false);
  assert.equal(on[0].id, "w1");
});
