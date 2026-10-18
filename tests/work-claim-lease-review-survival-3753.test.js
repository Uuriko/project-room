// #3753: delivered work under review must survive lease expiry.
//
// The 24h lease sweep (releaseExpired) auto-releases any active claim
// whose lease has lapsed and wipes the round: delivery, verification,
// CI stamp, reviews, attestations. Two live shapes lost real work:
//
//  (a) finish -> delivered -> reviewer sends it back (changes_requested)
//      -> state in_progress WITH the delivery retained as the record of
//      what was handed over. If the (unchanged) lease then lapses, the
//      sweep destroyed the retained delivery and the review fact.
//  (b) a claim that never went through finish (note-flow) but carries a
//      current-round review: the sweep erased the review with the claim.
//
// Rule pinned here: a lease does not lapse while a review recorded
// against the round's current basis is outstanding. Plain claims (no
// current review) still expire exactly as before — including a
// delivery-carrying claim whose review basis has moved (bug sweep
// 2026-10-16 F1: when the sweep does fire it still clears the round's
// delivery state, so the next claimant never inherits the bundle).
//
// RESIZE (CN-10, 2026-10-18): the CN-10 join over 1,403 simulated claim
// episodes measured 57.5% of delivered episodes lost to lease expiry —
// every one delivered well inside its lease; the separator was reviewer
// arrival, not lease length — and 249 further episodes destroyed while
// in progress (100% had entered in_progress; zero were idle squats).
// The rule is therefore widened from review-outstanding to WORK
// PRODUCT: a lease does not lapse while the claim carries a delivery,
// has started work (in_progress / blocked), or carries a review on the
// round's current basis. A claim that never started — still `claimed`,
// no delivery, no current review, however many bare notes it carries —
// is genuinely idle and still expires exactly as before. The holder
// also gets an expiry warning (leaseExpiryWarning + the route-level
// wake) before/at expiry: the visibility floor the join requires.
import test from "node:test";
import assert from "node:assert/strict";
import { createWork, claimWork, updateWork, recordReview, recordCi, renewWork, isLeaseExpired, releaseExpired,
  leaseExpiryWarning, ClaimError }
  from "../server/work-claims.mjs";
import { createWorkClaimRegistry, handleWorkClaims } from "../server/work-claim-routes.mjs";

const SHA = "a".repeat(64);
const HEAD = "b".repeat(40);
const T0 = Date.parse("2026-10-18T00:00:00.000Z");
const H = 3600 * 1000;
const bundle = () => ({
  artifact: { kind: "text", ref: "room://artifacts/1", sha256: SHA },
  checks: [{ name: "unit", result: "pass" }],
  criteria: [],
});
const start = (id, over = {}) => {
  const item = createWork({ id, reviewPolicy: "distinct_member", ...over }, { agentId: "quill" });
  const claimed = claimWork(item, "quill", { now: T0, leaseHours: 6 });
  return updateWork(claimed, "quill", { state: "in_progress", now: T0 });
};
// finish -> delivered -> changes_requested -> back to in_progress,
// delivery + review fact retained (mirrors work-claim-verified-state).
const sentBack = () => {
  const delivered = updateWork(start("w-sendback"), "quill",
    { state: "delivered", delivery: bundle(), deliveryMode: "result", now: T0 });
  const reviewed = recordReview(delivered, "sage",
    { verdict: "changes_requested", summary: "criterion 2 is not met", now: T0 });
  return updateWork(reviewed, "sage", { state: "in_progress", authority: true, now: T0 });
};

test("#3753 (a): a sent-back claim's lease does not lapse — delivery and review fact survive the sweep", () => {
  const back = sentBack();
  assert.equal(back.state, "in_progress");
  assert.ok(back.delivery, "send-back retains the delivery");
  assert.equal(back.verification.state, "changes_requested");
  assert.equal(isLeaseExpired(back, T0 + 7 * H), false);
  const [after] = releaseExpired([back], T0 + 7 * H);
  assert.equal(after.state, "in_progress");
  assert.equal(after.owner, "quill");
  assert.equal(after.delivery.digest, back.delivery.digest);
  assert.equal(after.verification.state, "changes_requested");
  assert.equal(after.reviews.length, 1);
});

test("#3753 (b): a claim with a current-basis review outstanding does not lapse", () => {
  const active = start("w-noted");
  const reviewed = recordReview(active, "sage", { verdict: "comment", summary: "looking at it", now: T0 });
  assert.equal(reviewed.reviews.length, 1);
  assert.equal(isLeaseExpired(reviewed, T0 + 7 * H), false);
  const [after] = releaseExpired([reviewed], T0 + 7 * H);
  assert.equal(after.state, "in_progress");
  assert.equal(after.owner, "quill");
  assert.equal(after.reviews.length, 1);
});

test("#3753 control: an idle claim — never started, no delivery, no review — still expires and sweeps", () => {
  // RESIZE amendment: the pre-resize control used an in_progress claim
  // as its "plain" shape; under the CN-10 scope an in_progress claim IS
  // started work and is immune (see (d) below). The idle shape the sweep
  // must still reclaim is a claim that never left `claimed`.
  const item = createWork({ id: "w-plain" }, { agentId: "quill" });
  const idle = claimWork(item, "quill", { now: T0, leaseHours: 6 });
  assert.equal(idle.state, "claimed");
  assert.equal(isLeaseExpired(idle, T0 + 7 * H), true);
  const [after] = releaseExpired([idle], T0 + 7 * H);
  assert.equal(after.state, "unclaimed");
  assert.equal(after.owner, null);
  // A bare note is not work product either: a claimed-state claim the
  // holder only annotated still expires.
  const noted = updateWork(idle, "quill", { note: "will start soon", now: T0 });
  assert.equal(isLeaseExpired(noted, T0 + 7 * H), true);
});

test("#3753 control: a review whose basis has moved no longer holds the lease", () => {
  // RESIZE amendment: built on a never-started claim so the review is
  // the only thing that could hold the lease (the pre-resize shape was
  // in_progress, which now holds the lease on its own — see (d)).
  const item = createWork({ id: "w-stale" }, { agentId: "quill" });
  const claimed = claimWork(item, "quill", { now: T0, leaseHours: 6 });
  const reviewed = recordReview(claimed, "sage", { verdict: "comment", summary: "looking at it", now: T0 });
  assert.equal(isLeaseExpired(reviewed, T0 + 7 * H), false, "the current-basis review alone holds the lease");
  // A new CI head moves the review basis (the review attested headSha null).
  const moved = recordCi(reviewed, { state: "success", headSha: HEAD }, T0).item;
  assert.equal(isLeaseExpired(moved, T0 + 7 * H), true);
  const [after] = releaseExpired([moved], T0 + 7 * H);
  assert.equal(after.state, "unclaimed");
});

test("#3753 resize (c): a delivery awaiting its FIRST review survives — no review need be outstanding", () => {
  // The CN-10 main class: the worker delivered and waits; no reviewer
  // has recorded anything yet. Pre-resize this swept (a delivery with
  // no review outstanding did not hold the lease) — 457 of 795 sim
  // episodes were lost in exactly this shape. Shape here: sent back,
  // then paused to `claimed` with the delivery retained and the review
  // record gone with the reviewer's round — delivery alone must hold.
  const back = sentBack();
  const paused = updateWork(back, "quill", { state: "claimed", now: T0 });
  assert.equal(paused.state, "claimed");
  assert.ok(paused.delivery, "pause retains the delivery");
  const unreviewed = { ...paused, reviews: Object.freeze([]) };
  assert.equal(isLeaseExpired(unreviewed, T0 + 7 * H), false);
  const [after] = releaseExpired([unreviewed], T0 + 7 * H);
  assert.equal(after.state, "claimed");
  assert.equal(after.owner, "quill");
  assert.equal(after.delivery.digest, back.delivery.digest);
});

test("#3753 resize (d): in-progress work with no delivery and no review survives the sweep", () => {
  // CN-10's second destroyed class: 249 episodes that had entered
  // in_progress but not yet delivered. Started work is work product.
  const active = start("w-wip");
  assert.equal(active.delivery, null);
  assert.equal(active.reviews.length, 0);
  assert.equal(isLeaseExpired(active, T0 + 7 * H), false);
  const [after] = releaseExpired([active], T0 + 7 * H);
  assert.equal(after.state, "in_progress");
  assert.equal(after.owner, "quill");
  // Blocked is started work parked on an external blocker: also immune.
  const blocked = updateWork(active, "quill", { state: "blocked", now: T0 });
  assert.equal(isLeaseExpired(blocked, T0 + 7 * H), false);
});

test("#3753 resize (e): the expiry warning names expiring and lapsed-but-preserved claims, never idle ones", () => {
  const item = createWork({ id: "w-warn" }, { agentId: "quill" });
  const claimed = claimWork(item, "quill", { now: T0, leaseHours: 6 });
  assert.equal(leaseExpiryWarning(claimed, T0 + 4 * H), null, "more than the warning window left: no warning");
  const soon = leaseExpiryWarning(claimed, T0 + 5.5 * H);
  assert.equal(soon.kind, "expiring");
  assert.equal(soon.leaseExpiresAt, claimed.leaseExpiresAt);
  // At/after expiry an idle claim is simply expired — it is swept and
  // its holder gets the lease_expired wake, not the warning.
  assert.equal(leaseExpiryWarning(claimed, T0 + 7 * H), null);
  // An immune claim past its lease time is warned as preserved: the
  // holder learns the clock passed and the work was NOT discarded.
  const wip = start("w-warn-wip");
  const preserved = leaseExpiryWarning(wip, T0 + 7 * H);
  assert.equal(preserved.kind, "lapsed_preserved");
  assert.equal(preserved.leaseExpiresAt, wip.leaseExpiresAt);
  // Leaseless and delivered claims have no lease at risk: no warning.
  const nolease = claimWork(createWork({ id: "w-warn-null" }, { agentId: "quill" }), "quill", { now: T0, leaseHours: null });
  assert.equal(leaseExpiryWarning(nolease, T0 + 7 * H), null);
});

test("#3753 resize (f): composition with RQ-12 — the holder of preserved work may renew; a lapsed idle lease still refuses", () => {
  // renewWork's guard must read the same liveness rule as the sweep:
  // an immune claim's lease has not lapsed (PR title: the lease never
  // lapses while the work stands), so its holder can re-arm it. Only
  // the holder — the owner check runs first, so no stranger can renew
  // preserved inventory into their own hands.
  const back = sentBack();
  const renewed = renewWork(back, "quill", { now: T0 + 7 * H });
  assert.ok(Date.parse(renewed.leaseExpiresAt) > T0 + 7 * H, "the renewed lease runs past the renewal moment");
  assert.equal(renewed.owner, "quill");
  assert.throws(() => renewWork(back, "mallory", { now: T0 + 7 * H }),
    error => error instanceof ClaimError && /only the owner can renew/.test(error.message));
  // A genuinely lapsed lease (idle claim, past expiry) still refuses —
  // RQ-12's renew-after-lapse refusal is untouched.
  const idle = claimWork(createWork({ id: "w-renew-idle" }, { agentId: "quill" }), "quill", { now: T0, leaseHours: 1 });
  assert.throws(() => renewWork(idle, "quill", { now: T0 + 2 * H }),
    error => error instanceof ClaimError && /lease already lapsed/.test(error.message));
});

test("#3753 route level: the list sweep does not report or apply a release to a sent-back claim", async () => {
  const helpers = {
    json: (res, status, value) => ({ status, value }),
    reject: (status, code, message) => { const error = new Error(message); error.status = status; error.code = code; throw error; },
    body: async req => req.body,
  };
  const call = (registry, route, id, body) => handleWorkClaims({
    req: { method: route === "list" ? "GET" : "POST", body }, res: {},
    url: new URL("https://room.example/api/rooms/room1/work-claims"),
    store: { roomAuthority: () => ({ members: {
      agent1: { id: "agent1", kind: "agent", active: true, permissions: ["accept_work", "complete_work"] },
    } }) },
    roomId: "room1", auth: { member: { id: "agent1", kind: "agent", permissions: [] } },
    workClaimRoute: route, workClaimId: id, helpers, registry,
  });
  const registry = createWorkClaimRegistry();
  await call(registry, "create", null, { id: "seed" });
  const back = sentBack();
  registry.set("room1", { ...back, id: "under-review", leaseExpiresAt: "2020-01-01T00:00:00.000Z" });
  // RESIZE amendment: the swept control is a never-started (idle) claim;
  // an in_progress claim would now be preserved work, not swept.
  const idleBase = claimWork(createWork({ id: "w-route-plain" }, { agentId: "quill" }), "quill", { now: T0, leaseHours: 6 });
  const plain = { ...idleBase, id: "plain-lapsed", leaseExpiresAt: "2020-01-01T00:00:00.000Z" };
  registry.set("room1", plain);
  const listed = await call(registry, "list");
  assert.deepEqual(listed.value.swept, ["plain-lapsed"]);
  const kept = listed.value.claims.find(c => c.id === "under-review");
  assert.equal(kept.state, "in_progress");
  assert.ok(kept.delivery, "the swept listing still carries the delivery");
});

test("#3753 resize (g): the public-work door's deadline leases opt out — a deadline claim still lapses at its deadline", () => {
  // Composition with #3707: public-offer leases are submission
  // deadlines by the offer's terms. The door passes deadlineLease at
  // its call sites; with it, even started work lapses at the deadline
  // and renew-after-lapse refuses — the board immunity is opt-out
  // there by name, never silently global.
  const wip = start("w-deadline");
  assert.equal(isLeaseExpired(wip, T0 + 7 * H, { deadlineLease: true }), true);
  const [after] = releaseExpired([wip], T0 + 7 * H, { deadlineLease: true });
  assert.equal(after.state, "unclaimed");
  assert.throws(() => renewWork(wip, "quill", { now: T0 + 7 * H, deadlineLease: true }),
    error => error instanceof ClaimError && /lease already lapsed/.test(error.message));
});

test("#3753 resize route level: the holder is woken before expiry, and at expiry when the work is preserved", async () => {
  const helpers = {
    json: (res, status, value) => ({ status, value }),
    reject: (status, code, message) => { const error = new Error(message); error.status = status; error.code = code; throw error; },
    body: async req => req.body,
  };
  const wakes = [];
  const store = {
    now: () => T0 + 5.5 * H,
    roomAuthority: () => ({ members: {
      agent1: { id: "agent1", kind: "agent", active: true, permissions: ["accept_work", "complete_work"] },
    } }),
    db: { prepare: () => ({ get: () => ({ identityId: "ident-agent1" }) }) },
    agentHeartbeats: { enqueueWake: wake => { wakes.push(wake); return { enqueued: true }; } },
  };
  const call = (registry, route, id, body) => handleWorkClaims({
    req: { method: route === "list" ? "GET" : "POST", body }, res: {},
    url: new URL("https://room.example/api/rooms/room1/work-claims"),
    store, roomId: "room1", auth: { member: { id: "agent1", kind: "agent", permissions: [] } },
    workClaimRoute: route, workClaimId: id, helpers, registry,
  });
  const registry = createWorkClaimRegistry();
  await call(registry, "create", null, { id: "seed" });
  // Expiring inside the warning window (lease ends T0+6h, now T0+5.5h).
  const soon = claimWork(createWork({ id: "w-soon" }, { agentId: "quill" }), "agent1", { now: T0, leaseHours: 6 });
  registry.set("room1", soon);
  // Already past its lease time but preserved (in-progress work): the
  // at-expiry warning fires and the claim is NOT swept.
  const preserved = { ...start("w-preserved"), owner: "agent1", leaseExpiresAt: new Date(T0 + 5 * H).toISOString() };
  registry.set("room1", preserved);
  const listed = await call(registry, "list");
  assert.deepEqual(listed.value.swept, []);
  assert.equal(listed.value.claims.find(c => c.id === "w-preserved").state, "in_progress");
  const warned = wakes.filter(w => w.messageId.includes(":lease_expiring:")).map(w => w.messageId).sort();
  assert.deepEqual(warned, [
    `work-claim:w-preserved:lease_expiring:${preserved.leaseExpiresAt}`,
    `work-claim:w-soon:lease_expiring:${soon.leaseExpiresAt}`,
  ]);
  assert.ok(wakes.every(w => w.agentId === "ident-agent1"), "warnings go to the claim holder only");
});
