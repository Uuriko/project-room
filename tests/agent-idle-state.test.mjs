import test from "node:test";
import assert from "node:assert/strict";
import { classifyMember, deliveryFor, inferKind, nudgeAllowed, DEFAULT_NUDGE_LIMITS } from "../server/agent-idle-state.mjs";

const NOW = Date.parse("2026-11-21T20:00:00Z");
const MIN = 60_000;

test("each agent kind is inferred from the channel that actually works", () => {
  assert.equal(inferKind({ listenerLeaseExpiresAt: NOW + MIN }, NOW), "acp");
  assert.equal(inferKind({ wakeUrl: "https://bot.example/wake" }, NOW), "webhook");
  assert.equal(inferKind({ streamSeenAt: NOW - MIN }, NOW), "stream");
  assert.equal(inferKind({ lastPolledAt: NOW - MIN }, NOW), "poller");
  assert.equal(inferKind({ cloudLauncher: true }, NOW), "cloud");
  assert.equal(inferKind({ memberKind: "human", listenerLeaseExpiresAt: NOW + MIN }, NOW), "human");
  assert.equal(inferKind({}, NOW), "unknown");
  // A live listener wins over a configured webhook: it starts a turn directly.
  assert.equal(inferKind({ listenerLeaseExpiresAt: NOW + MIN, wakeUrl: "https://x.example" }, NOW), "acp");
  // A suspended webhook is not live, but still names the quiet channel.
  assert.equal(inferKind({ wakeUrl: "https://x.example", pushSuspended: true }, NOW), "webhook");
});

test("states: working, idle_reachable, idle_unreachable, sleeping, human", () => {
  const acp = { listenerLeaseExpiresAt: NOW + 5 * MIN, lastClaimActivityAt: NOW - 42 * MIN };
  assert.deepEqual(
    { ...classifyMember(acp, NOW), reasons: undefined, channels: undefined },
    { state: "idle_reachable", kind: "acp", idleMinutes: 42, reasons: undefined, channels: undefined });
  assert.equal(classifyMember({ ...acp, openClaims: [{ leaseExpiresAt: NOW + MIN }] }, NOW).state, "working");
  assert.equal(classifyMember({ ...acp, openRequestsToMember: 1 }, NOW).state, "working");
  assert.equal(classifyMember({ ...acp, unackedWakes: 2 }, NOW).state, "working");
  // An expired claim lease is not in-flight work.
  assert.equal(classifyMember({ ...acp, openClaims: [{ leaseExpiresAt: NOW - MIN }] }, NOW).state, "idle_reachable");
  assert.equal(classifyMember({ ...acp, paused: true }, NOW).state, "sleeping");
  assert.equal(classifyMember({ memberKind: "human" }, NOW).state, "human");
  const expired = classifyMember({ listenerLeaseExpiresAt: NOW - MIN }, NOW);
  assert.equal(expired.state, "idle_unreachable");
  assert.deepEqual(expired.reasons, ["listener_expired"]);
  assert.deepEqual(classifyMember({ wakeUrl: "https://x.example", pushSuspended: true }, NOW).reasons, ["webhook_suspended"]);
  assert.deepEqual(classifyMember({ cloudLauncher: true }, NOW).reasons, ["launch_required"]);
  assert.equal(classifyMember({ lastSeenAt: NOW - 10 * MIN }, NOW).state, "idle_unreachable", "stale heartbeat outside the 180s floor");
  assert.equal(classifyMember({ lastSeenAt: NOW - 10 * MIN, cadenceSeconds: 600 }, NOW).state, "idle_reachable", "cadence widens the window");
  assert.throws(() => classifyMember({}, Number.NaN), TypeError);
});

test("delivery differs by kind and never wakes working, sleeping or human members", () => {
  const plan = facts => deliveryFor(classifyMember(facts, NOW)).channel;
  assert.equal(plan({ listenerLeaseExpiresAt: NOW + MIN }), "ready_work_wake");
  assert.equal(plan({ wakeUrl: "https://bot.example/wake" }), "wake_signal_webhook");
  assert.equal(plan({ streamSeenAt: NOW }), "formal_request");
  assert.equal(plan({ lastPolledAt: NOW }), "wake_signal");
  assert.equal(plan({ wakeUrl: "https://bot.example/wake", openClaims: [{}] }), null);
  assert.equal(plan({ wakeUrl: "https://bot.example/wake", paused: true }), null);
  assert.equal(plan({ memberKind: "human" }), null);
  const unreachable = deliveryFor(classifyMember({ listenerLeaseExpiresAt: NOW - MIN }, NOW));
  assert.deepEqual([unreachable.channel, unreachable.ownerLine], [null, true]);
  const cloud = deliveryFor(classifyMember({ cloudLauncher: true }, NOW));
  assert.deepEqual([cloud.channel, cloud.ownerLine, cloud.reason], [null, true, "launch_is_owner_spend_decision"]);
});

test("nudge guard: window, hourly caps, backoff on ack-without-claim, state", () => {
  const reachable = classifyMember({ listenerLeaseExpiresAt: NOW + MIN }, NOW);
  const ask = (history, extra = {}) => nudgeAllowed({ memberId: "a", itemId: "w1", classification: reachable, history, nowMs: NOW, ...extra });
  assert.equal(ask([]).allowed, true);
  assert.equal(ask([{ memberId: "a", itemId: "w9", at: NOW - 10 * MIN }]).reason, "member_window");
  assert.equal(ask([{ memberId: "b", itemId: "w1", at: NOW - 10 * MIN }]).allowed, true, "another member's nudge does not block");
  const three = [50, 35, 21].map(m => ({ memberId: "a", itemId: "x", at: NOW - m * MIN }));
  assert.equal(ask(three).reason, "member_hourly_cap");
  const room = Array.from({ length: 12 }, (_, i) => ({ memberId: `m${i}`, itemId: "x", at: NOW - (i + 1) * 4 * MIN }));
  assert.equal(ask(room).reason, "room_hourly_cap");
  // One ignored offer of the same item: 2 x window backoff (40 min).
  const ignoredOnce = [{ memberId: "a", itemId: "w1", at: NOW - 30 * MIN, outcome: "acked_unclaimed" }];
  assert.equal(ask(ignoredOnce).reason, "item_backoff");
  assert.equal(ask(ignoredOnce, { itemId: "w2" }).allowed, true, "a different item is fine");
  assert.equal(nudgeAllowed({ memberId: "a", itemId: "w1", classification: reachable, history: ignoredOnce, nowMs: NOW + 11 * MIN }).allowed, true);
  // Backoff caps at 4h even after many ignored offers.
  const many = Array.from({ length: 8 }, (_, i) => ({ memberId: "a", itemId: "w1", at: NOW - (8 - i) * 30 * 60 * MIN, outcome: "acked_unclaimed" }));
  const last = many.at(-1).at;
  assert.equal(nudgeAllowed({ memberId: "a", itemId: "w1", classification: reachable, history: many, nowMs: last + DEFAULT_NUDGE_LIMITS.backoffCapMs + 1 }).allowed, true);
  // State gate and missing target.
  const working = classifyMember({ listenerLeaseExpiresAt: NOW + MIN, openClaims: [{}] }, NOW);
  assert.equal(ask([], { classification: working }).reason, "state_working");
  assert.equal(ask([], { itemId: "" }).reason, "missing_target");
  // A window below the 15-minute floor is raised to the floor.
  assert.equal(ask([{ memberId: "a", itemId: "w9", at: NOW - 10 * MIN }], { limits: { windowMs: MIN } }).reason, "member_window");
  // Future-dated history (clock skew) is ignored rather than blocking forever.
  assert.equal(ask([{ memberId: "a", itemId: "w9", at: NOW + 60 * MIN }]).allowed, true);
});
