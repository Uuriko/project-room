// HUNT-RACE (2026-10-18): the claim idempotency ledger (requestOutcomes)
// is scoped to the claim round. A requestId that landed in round 1 must
// not replay as a silent no-op — nor conflict-refuse a fresh write — in
// round 2. First-party clients derive requestIds from the item, the
// delivery generation and the member (src/board-ui.js deliverRequestId /
// verifyRequestId), and claimWork restarts the delivery generation at 0
// for every round, so a round-1 derived id deterministically names
// round 2's first write. Before this fix, the round-2 finish either
// returned 200 without transitioning (identical payload) or refused 409
// work_claim_conflict (any payload drift, e.g. a fresh deliveredAt) —
// a lost delivery in the first case, a deadlocked derived id in the
// second. Within-round retries keep the pinned A4 semantics
// (tests/invariants/work-claim-update-retry.test.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import { createWork, claimWork, updateWork, releaseWork, reassignWork, releaseExpired, claimHistoryLength } from "../server/work-claims.mjs";

const T0 = Date.parse("2026-10-18T10:00:00.000Z");
const H = 3600 * 1000;
const bundle = (by, at) => ({ digest: "a".repeat(64), deliveredBy: by, deliveredAt: new Date(at).toISOString() });

// One full round: claim -> start -> finish with requestId -> release.
const roundTrip = (item, agent, requestId, delivery, at) => {
  let next = claimWork(item, agent, { leaseHours: 8, now: at });
  next = updateWork(next, agent, { state: "in_progress", now: at + H });
  next = updateWork(next, agent, { state: "delivered", delivery, requestId, now: at + 2 * H });
  assert.equal(next.state, "delivered");
  return releaseWork(next, agent, {
    expectedClaimedAt: next.claimedAt, expectedHistoryLength: claimHistoryLength(next), now: at + 3 * H });
};

test("a fresh claim bumps the claim generation; prior-round records stay but are inert", () => {
  let item = createWork({ id: "w1", title: "task" }, { now: T0, agentId: "poster" });
  item = roundTrip(item, "agent-a", "finish-1", bundle("agent-a", T0 + 2 * H), T0);
  assert.equal(item.state, "unclaimed");
  assert.equal(item.claimGeneration, 1, "the first claim opened generation 1");
  assert.equal(item.requestOutcomes["finish-1"].generation, 1,
    "the landed record is tagged with the generation that landed it (the reviewer tombstone reads its existence)");
  const reclaimed = claimWork(item, "agent-a", { leaseHours: 8, now: T0 + 10 * H });
  assert.equal(reclaimed.claimGeneration, 2, "the re-claim opens generation 2");
  assert.equal(reclaimed.requestOutcomes["finish-1"].generation, 1,
    "the record itself is kept — only its verdict scope ends with its round");
});

test("cross-round identical requestId + payload is a fresh write, not a silent replay", () => {
  let item = createWork({ id: "w1", title: "task" }, { now: T0, agentId: "poster" });
  const delivery = bundle("agent-a", T0 + 2 * H);
  item = roundTrip(item, "agent-a", "finish-1", delivery, T0);
  // Round 2: same agent re-claims (e.g. after a lapse + re-claim) and the
  // client re-runs its finish step verbatim (derived requestId, stored
  // bundle) — the MCP layer's own retry doctrine ("retain and retry the
  // exact original input") manufactures exactly this interleaving.
  let round2 = claimWork(item, "agent-a", { leaseHours: 8, now: T0 + 10 * H });
  round2 = updateWork(round2, "agent-a", { state: "in_progress", now: T0 + 11 * H });
  const finished = updateWork(round2, "agent-a", { state: "delivered", delivery, requestId: "finish-1", now: T0 + 12 * H });
  assert.equal(finished.state, "delivered", "the round-2 finish must transition, not replay round 1's outcome");
  assert.ok(finished.delivery && finished.delivery.deliveredBy === "agent-a",
    "the round-2 delivery must be recorded on the item");
});

test("cross-round requestId reuse with a different payload is a fresh write, not a conflict", () => {
  let item = createWork({ id: "w1", title: "task" }, { now: T0, agentId: "poster" });
  item = roundTrip(item, "agent-a", "finish-1", bundle("agent-a", T0 + 2 * H), T0);
  // Round 2 is held by a different agent whose derived ids collide by
  // shape (deliver-<id>-0-<member> is per-member, but a shared automation
  // identity or a hand-copied id reuses the literal string).
  let round2 = claimWork(item, "agent-b", { leaseHours: 8, now: T0 + 10 * H });
  round2 = updateWork(round2, "agent-b", { state: "in_progress", now: T0 + 11 * H });
  const finished = updateWork(round2, "agent-b", {
    state: "delivered", delivery: bundle("agent-b", T0 + 12 * H), requestId: "finish-1", now: T0 + 12 * H });
  assert.equal(finished.state, "delivered");
  assert.equal(finished.owner, "agent-b");
});

test("the ledger also restarts after a lease-sweep exit (releaseExpired)", () => {
  let item = createWork({ id: "w1", title: "task" }, { now: T0, agentId: "poster" });
  item = claimWork(item, "agent-a", { leaseHours: 1, now: T0 });
  item = updateWork(item, "agent-a", { state: "in_progress", now: T0 });
  item = updateWork(item, "agent-a", { note: "wip", requestId: "note-1", now: T0 });
  const [swept] = releaseExpired([item], T0 + 2 * H);
  assert.equal(swept.state, "unclaimed");
  const reclaimed = claimWork(swept, "agent-a", { leaseHours: 8, now: T0 + 3 * H });
  assert.equal(reclaimed.claimGeneration, 2);
  assert.equal(reclaimed.requestOutcomes["note-1"].generation, 1,
    "the swept round's record is tagged with its own generation, so it cannot answer for the new round");
  const noted = updateWork(reclaimed, "agent-a", { note: "wip", requestId: "note-1", now: T0 + 4 * H });
  assert.equal(noted.history.at(-1).note, "wip", "the re-sent note must append in the new round");
});

test("within-round retry still replays (A4 semantics unchanged)", () => {
  let item = createWork({ id: "w1", title: "task" }, { now: T0, agentId: "poster" });
  item = claimWork(item, "agent-a", { leaseHours: 8, now: T0 });
  const first = updateWork(item, "agent-a", { note: "progress", requestId: "req-1", now: T0 + H });
  const retry = updateWork(first, "agent-a", { note: "progress", requestId: "req-1", now: T0 + 2 * H });
  assert.equal(retry.history.length, first.history.length, "the identical in-round retry appends nothing");
  assert.deepEqual(retry.requestOutcomes, first.requestOutcomes);
});

test("reassign from unclaimed opens a new claim generation; a live-round reassign keeps the generation", () => {
  let item = createWork({ id: "w1", title: "task" }, { now: T0, agentId: "poster" });
  item = roundTrip(item, "agent-a", "finish-1", bundle("agent-a", T0 + 2 * H), T0);
  const assigned = reassignWork(item, "poster", "agent-b", { now: T0 + 10 * H, authority: true });
  assert.equal(assigned.state, "claimed");
  assert.equal(assigned.claimGeneration, 2,
    "a fresh assignment is a round open: the generation bumps, so round 1's records cannot answer for it");

  let live = createWork({ id: "w2", title: "task" }, { now: T0, agentId: "poster" });
  live = claimWork(live, "agent-a", { leaseHours: 8, now: T0 });
  live = updateWork(live, "agent-a", { note: "progress", requestId: "req-1", now: T0 + H });
  const handed = reassignWork(live, "agent-a", "agent-b", { now: T0 + 2 * H });
  assert.equal(handed.claimGeneration, live.claimGeneration,
    "a live round changing hands is the same round: the generation — and its retry scope — rides along");
  assert.ok(handed.requestOutcomes && Object.hasOwn(handed.requestOutcomes, "req-1"),
    "a live round changing hands is the same round: its retry records ride along");
});
