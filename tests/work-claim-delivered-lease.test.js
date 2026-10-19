// #3753 + STRANGER S-3: delivered work must survive its claim lease.
//
// The mechanism being pinned shut, end to end:
//  - a delivered claim is not lease-expirable (already true in the machine;
//    pinned here so a table edit can't quietly reopen it);
//  - a send-back (delivered -> in_progress) must restart the lease window —
//    carrying the old, possibly lapsed, lease stamps into an active state
//    hands the round to the next sweep, which clears the delivery record;
//  - a write against an active claim whose lease has lapsed fails loudly
//    with claim_lease_lapsed instead of applying and evaporating;
//  - at the routes, a write that arrives after the lapse (the room sweep
//    runs first) names the lapse (409 claim_lease_lapsed), never a bare
//    "owned by nobody" or a 200 the next read contradicts;
//  - board, single-read, and needs-me present the same post-expiry state
//    for a delivered item, and the claim carries a visible leaseLapsed
//    fact while its delivery waits for review.
import test from "node:test";
import assert from "node:assert/strict";
import { createWork, claimWork, updateWork, recordReview, reassignWork, releaseWork, renewWork,
  releaseExpired, isLeaseExpired, deliveryLeaseLapsed, ClaimError } from "../server/work-claims.mjs";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { handleWorkClaims, buildWorkClaimPage } from "../server/work-claim-routes.mjs";
import { myClaimsOf } from "../server/needs-me.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof ClaimError && error.code === code);
const T0 = Date.parse("2026-10-18T00:00:00.000Z");
const H = 3600 * 1000;
const BUNDLE = {
  artifact: { kind: "pull_request", ref: "https://github.com/Uuriko/project-room/pull/999",
    sha256: "a".repeat(64) },
  checks: [{ name: "unit tests", result: "pass" }],
  criteria: [{ criterion: "criterion A", status: "met" }],
};

// A claim under distinct_member with a 2h lease, delivered one hour in.
const buildDelivered = (id, { leaseHours = 2 } = {}) => {
  let item = createWork({ id, title: id, reviewPolicy: "distinct_member",
    acceptanceCriteria: ["criterion A"] }, { now: T0, agentId: "poster" });
  item = claimWork(item, "alice", { now: T0, leaseHours });
  item = updateWork(item, "alice", { state: "in_progress", now: T0 + H / 2 });
  item = updateWork(item, "alice", { state: "delivered", delivery: BUNDLE, now: T0 + H });
  assert.equal(item.state, "delivered");
  return item;
};

test("immunity: a delivered claim is never swept, however far past its lease", () => {
  const item = buildDelivered("immune");
  const [after] = releaseExpired([item], T0 + 100 * H);
  assert.equal(after.state, "delivered");
  assert.equal(after.owner, "alice");
  assert.ok(after.delivery);
  assert.equal(after.deliveryGeneration, 1);
  assert.equal(isLeaseExpired(item, T0 + 100 * H), false);
  assert.equal(deliveryLeaseLapsed(item, T0 + 100 * H), true);
  assert.equal(deliveryLeaseLapsed(item, T0 + H + 1), false); // lease runs to T0+2H
});

test("send-back after the lapse reopens with a fresh lease of the original duration", () => {
  const item = buildDelivered("send-back-late"); // 2h lease, lapses at T0+2H
  const back = updateWork(item, "alice", { state: "in_progress", now: T0 + 5 * H });
  assert.equal(back.state, "in_progress");
  assert.equal(back.owner, "alice");
  assert.ok(back.delivery, "the delivery stays as the round's record");
  assert.equal(back.leaseStartAt, new Date(T0 + 5 * H).toISOString());
  assert.equal(back.leaseExpiresAt, new Date(T0 + 7 * H).toISOString());
  // The fresh window is real: alive inside it, sweepable after it.
  const [alive] = releaseExpired([back], T0 + 6 * H);
  assert.equal(alive.state, "in_progress");
  const [gone] = releaseExpired([back], T0 + 8 * H);
  assert.equal(gone.state, "unclaimed");
});

test("send-back before the lapse also restarts the rework window", () => {
  const item = buildDelivered("send-back-early"); // lease to T0+2H
  const back = updateWork(item, "alice", { state: "in_progress", now: T0 + H + H / 2 });
  assert.equal(back.leaseStartAt, new Date(T0 + H + H / 2).toISOString());
  assert.equal(back.leaseExpiresAt, new Date(T0 + H + H / 2 + 2 * H).toISOString());
});

test("send-back of a leaseless claim invents no lease", () => {
  let item = createWork({ id: "no-lease", title: "no-lease", reviewPolicy: "distinct_member",
    acceptanceCriteria: ["criterion A"] }, { now: T0, agentId: "poster" });
  item = claimWork(item, "alice", { now: T0, leaseHours: null });
  item = updateWork(item, "alice", { state: "in_progress", now: T0 + H / 2 });
  item = updateWork(item, "alice", { state: "delivered", delivery: BUNDLE, now: T0 + H });
  const back = updateWork(item, "alice", { state: "in_progress", now: T0 + 50 * H });
  assert.equal(back.leaseExpiresAt, null);
  const [same] = releaseExpired([back], T0 + 500 * H);
  assert.equal(same.state, "in_progress");
});

test("send-back with a legacy lease (no leaseStartAt) falls back to the room default", () => {
  const item = buildDelivered("legacy-lease");
  const legacy = { ...item, leaseStartAt: null };
  const back = updateWork(legacy, "alice", { state: "in_progress", now: T0 + 5 * H,
    room: { workClaims: { defaultLeaseHours: 10 } } });
  assert.equal(back.leaseExpiresAt, new Date(T0 + 15 * H).toISOString());
});

test("delivered writes after the lapse still work: note and verify are not lease-gated", () => {
  const item = buildDelivered("delivered-writes");
  const noted = updateWork(item, "alice", { note: "still here", now: T0 + 5 * H });
  assert.equal(noted.state, "delivered");
  assert.equal(noted.leaseExpiresAt, item.leaseExpiresAt, "a note does not touch the spent lease");
  const reviewed = recordReview(item, "dave", { verdict: "approve", summary: "verified", now: T0 + 5 * H });
  const done = updateWork(reviewed, "dave", { state: "done", now: T0 + 5 * H, authority: true });
  assert.equal(done.state, "done");
});

test("post-lapse writes on an active claim fail loudly with claim_lease_lapsed", () => {
  let item = createWork({ id: "lapsed-active", title: "lapsed-active" }, { now: T0, agentId: "poster" });
  item = claimWork(item, "alice", { now: T0, leaseHours: 1 });
  item = updateWork(item, "alice", { state: "in_progress", now: T0 });
  const late = T0 + 2 * H;
  throwsCode(() => updateWork(item, "alice", { note: "progress", now: late }), "claim_lease_lapsed");
  throwsCode(() => updateWork(item, "alice", { state: "blocked", now: late }), "claim_lease_lapsed");
  throwsCode(() => updateWork(item, "alice", { state: "delivered", delivery: BUNDLE, now: late }), "claim_lease_lapsed");
  // renewWork's own refusal predates this fix and is pinned as
  // invalid_claim_input (tests/lease-renewal.test.js); the route layer
  // names claim_lease_lapsed for it post-sweep. It is loud either way.
  throwsCode(() => renewWork(item, "alice", { now: late }), "invalid_claim_input");
  // Nothing applied: the item the caller holds is untouched.
  assert.equal(item.state, "in_progress");
  assert.equal(item.history.filter(entry => entry.action === "noted").length, 0);
});

test("release stays possible on a lapsed claim — ending the round is not a write against it", () => {
  let item = createWork({ id: "lapsed-release", title: "lapsed-release" }, { now: T0, agentId: "poster" });
  item = claimWork(item, "alice", { now: T0, leaseHours: 1 });
  item = updateWork(item, "alice", { state: "in_progress", now: T0 });
  const released = releaseWork(item, "alice", {
    expectedClaimedAt: item.claimedAt, expectedHistoryLength: item.history.length, now: T0 + 2 * H });
  assert.equal(released.state, "unclaimed");
  assert.equal(released.owner, null);
});

test("an idempotent replay still replays after the lapse — it is not a new write", () => {
  let item = createWork({ id: "replay", title: "replay" }, { now: T0, agentId: "poster" });
  item = claimWork(item, "alice", { now: T0, leaseHours: 1 });
  item = updateWork(item, "alice", { state: "in_progress", now: T0 });
  const landed = updateWork(item, "alice", { note: "half done", requestId: "req-1", now: T0 + H / 2 });
  const replayed = updateWork(landed, "alice", { note: "half done", requestId: "req-1", now: T0 + 5 * H });
  assert.equal(replayed.state, "in_progress");
  assert.equal(replayed.history.length, landed.history.length);
});

test("reassigning a delivered claim after the lapse reopens it with a fresh lease", () => {
  const item = buildDelivered("reassign-delivered");
  const moved = reassignWork(item, "poster", "bob", { now: T0 + 5 * H, authority: true });
  assert.equal(moved.state, "in_progress");
  assert.equal(moved.owner, "bob");
  assert.ok(moved.delivery, "the delivery follows the round");
  assert.equal(moved.leaseStartAt, new Date(T0 + 5 * H).toISOString());
  assert.equal(moved.leaseExpiresAt, new Date(T0 + 7 * H).toISOString());
  const [alive] = releaseExpired([moved], T0 + 6 * H);
  assert.equal(alive.state, "in_progress");
});

// ---- presentation: the board page tells the same story as needs-me ----
// (Read purity is the F12 contract — the stored rows are NOT derived or
// swept here; for a DELIVERED item the raw row and needs-me's derived row
// already agree, and both must carry the leaseLapsed fact.)

test("board page: a delivered claim past its lease presents delivered + leaseLapsed, delivery intact", () => {
  const delivered = buildDelivered("page-delivered");
  const page = buildWorkClaimPage([delivered], "commons", "dave", new URLSearchParams(), T0 + 5 * H);
  const shown = page.claims.find(claim => claim.id === "page-delivered");
  assert.equal(shown.state, "delivered");
  assert.equal(shown.owner, "alice");
  assert.ok(shown.delivery);
  assert.equal(shown.leaseLapsed, true);
  // Before the lapse there is no fact to stamp.
  const early = buildWorkClaimPage([delivered], "commons", "dave", new URLSearchParams(), T0 + H);
  assert.equal(early.claims.find(claim => claim.id === "page-delivered").leaseLapsed, undefined);
});

// ---- routes: the S-3 replay and the loud post-lapse failures ----

const SHA = "a".repeat(64);
const bundle = { artifact: { kind: "text", ref: "room://artifacts/1", sha256: SHA },
  checks: [{ name: "unit", result: "pass" }], criteria: [] };
const auth = (id, kind, permissions) => ({ member: { id, kind, permissions } });
const OWNER = auth("owner", "human", ["manage_claims"]);
const WORKER = auth("worker", "agent", ["accept_work", "complete_work"]);
const REVIEWER = auth("reviewer", "agent", ["verify"]);

async function room(t) {
  const clock = { now: T0 };
  const store = new RoomStore(":memory:", { now: () => clock.now });
  store.initialize(initialRoom("commons"));
  t.after(() => store.close());
  const ownerKey = store.issueAccessKey("commons", "owner");
  const add = (id, kind, permissions) => store.command(ownerKey, "commons",
    { id: `add-${id}`, type: "member.added", data: { memberId: id, displayName: id, kind, permissions } });
  add("worker", "agent", ["accept_work", "complete_work"]);
  add("reviewer", "agent", ["verify"]);
  const helpers = {
    json: (_res, status, value) => ({ status, value }),
    reject: (status, code, message) => { const error = new Error(message); error.status = status; error.code = code; throw error; },
    body: async req => req.body,
  };
  const call = (route, id, body, extra = {}) => handleWorkClaims({
    req: { method: route === "list" || route === "read" || route === "receipts" ? "GET" : "POST", body },
    res: {}, url: new URL("https://room.example/api/rooms/commons/work-claims"),
    store, roomId: "commons", auth: extra.auth ?? OWNER,
    workClaimRoute: route, workClaimId: id, helpers, registry: store.workClaims,
  });
  const get = id => store.workClaims.get("commons", id);
  return { store, call, get, clock };
}

async function deliveredRoute(t, id) {
  const r = await room(t);
  await r.call("create", null, { id, title: `Task ${id}`, reviewPolicy: "distinct_member" });
  await r.call("claim", id, { leaseHours: 1 }, { auth: WORKER });
  await r.call("update", id, { state: "in_progress" }, { auth: WORKER });
  await r.call("update", id, { state: "delivered", delivery: bundle }, { auth: WORKER });
  return r;
}

test("S-3 replay: post-lapse send-back survives, the review lands, every surface agrees", async t => {
  const r = await deliveredRoute(t, "s3");
  r.clock.now = T0 + 2 * H; // the lease lapsed an hour ago; the delivery waits

  // Board and single read: still delivered, still the worker's, fact visible.
  const page = (await r.call("list", null, undefined, { auth: REVIEWER })).value;
  const listed = page.claims.find(claim => claim.id === "s3");
  assert.equal(listed.state, "delivered");
  assert.equal(listed.owner, "worker");
  assert.equal(listed.leaseLapsed, true);
  assert.deepEqual(page.swept, []);
  const read = (await r.call("read", "s3", undefined, { auth: REVIEWER })).value;
  assert.equal(read.state, "delivered");
  assert.equal(read.leaseLapsed, true);
  // needs-me (the owner's inbox): same state, same fact.
  const mine = myClaimsOf(r.store, "commons", "worker");
  const myRow = mine.top.find(row => row.id === "s3");
  assert.equal(myRow.state, "delivered");
  assert.equal(myRow.leaseLapsed, true);

  // The holder's post-lapse update (S-3's exact move) succeeds — and this
  // time the claim it leaves behind is alive, not sweep bait.
  const back = (await r.call("update", "s3", { state: "in_progress" }, { auth: WORKER })).value;
  assert.equal(back.state, "in_progress");
  assert.equal(back.owner, "worker");
  assert.equal(Date.parse(back.leaseExpiresAt), T0 + 3 * H);
  assert.equal(r.get("s3").state, "in_progress");

  // The review that S-3 lost now lands.
  const reviewed = (await r.call("review", "s3", { verdict: "approve", summary: "looks right" }, { auth: REVIEWER })).value;
  assert.equal(reviewed.state, "in_progress");
  assert.equal(r.get("s3").reviews.length, 1);
});

test("routes: a holder write that arrives after the lapse names the lapse, not 'owned by nobody'", async t => {
  const r = await room(t);
  await r.call("create", null, { id: "late-write", title: "Task late-write" });
  await r.call("claim", "late-write", { leaseHours: 1 }, { auth: WORKER });
  await r.call("update", "late-write", { state: "in_progress" }, { auth: WORKER });
  r.clock.now = T0 + 2 * H;
  await assert.rejects(r.call("update", "late-write", { state: "blocked" }, { auth: WORKER }),
    error => error.status === 409 && error.code === "claim_lease_lapsed");
  // The refusal named why; the next read shows the release the sweep
  // recorded (the rejected request's own transaction rolled back, so
  // the sweep lands with the first successful request after it).
  const page = (await r.call("list", null, undefined, { auth: WORKER })).value;
  assert.equal(page.claims.find(claim => claim.id === "late-write").state, "unclaimed");
  assert.deepEqual(page.swept, ["late-write"]);
});

test("routes: a review that arrives after the lapse names the lapse", async t => {
  const r = await room(t);
  await r.call("create", null, { id: "late-review", title: "Task late-review", reviewPolicy: "distinct_member" });
  await r.call("claim", "late-review", { leaseHours: 1 }, { auth: WORKER });
  await r.call("update", "late-review", { state: "in_progress" }, { auth: WORKER });
  r.clock.now = T0 + 2 * H;
  await assert.rejects(r.call("review", "late-review", { verdict: "approve", summary: "done well" }, { auth: REVIEWER }),
    error => error.status === 409 && error.code === "claim_lease_lapsed");
});

test("routes: a delivered claim's verify still lands after the lapse", async t => {
  const r = await deliveredRoute(t, "late-verify");
  r.clock.now = T0 + 2 * H;
  await r.call("review", "late-verify", { verdict: "approve", summary: "bundle verified" }, { auth: REVIEWER });
  const done = (await r.call("update", "late-verify", { state: "done" }, { auth: REVIEWER })).value;
  assert.equal(done.state, "done");
  assert.equal(done.verification.state, "verified");
});
