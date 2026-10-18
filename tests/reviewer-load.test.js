// #3755: per-reviewer pending-review depth (ask 1) and the less-loaded
// reviewer offering at claim submission for review (ask 2). Depth is
// derived at read time from existing claim/review state — the fixtures
// below are hand-computed and the counts must match exactly. The offering
// is presentation only: it never assigns, never wakes, and never changes
// who may review (the eligibility refusals are pinned unchanged).
import test from "node:test";
import assert from "node:assert/strict";
import { RoomStore } from "../server/store.mjs";
import { AgentRooms } from "../server/agent-rooms.mjs";
import { collectNeedsMe } from "../server/needs-me.mjs";
import { createWork, claimWork, updateWork } from "../server/work-claims.mjs";
import { createWorkClaimRegistry, handleWorkClaims } from "../server/work-claim-routes.mjs";
import { pendingReviewersFor, reviewerLoadOf, reviewerOfferFor } from "../server/reviewer-load.mjs";

// --- Hand-computed pure fixture -------------------------------------------
// Members: rev-a / rev-b / rev-c are the room's eligible reviewers.
//   c1 delivered, unnamed            -> rev-a, rev-b, rev-c
//   c2 delivered, named rev-a        -> rev-a
//   c3 in_progress + PR, named a+b   -> rev-a, rev-b
//   c4 in_progress, no PR            -> nobody (not ready to review)
//   c5 done, named rev-a             -> nobody (terminal)
//   c6 delivered, owned by rev-a,
//      named rev-a                   -> nobody (owner never counts)
//   c7 delivered, named rev-b, rev-b
//      already reviewed current basis-> nobody
//   c8 unclaimed                     -> nobody (no owner)
//   c9 delivered, superseded         -> nobody
// Depths: rev-a = 3 (c1,c2,c3), rev-b = 2 (c1,c3), rev-c = 1 (c1).
const MEMBERS = {
  "rev-a": { id: "rev-a", displayName: "Rev A", active: true },
  "rev-b": { id: "rev-b", displayName: "Rev B", active: true },
  "rev-c": { id: "rev-c", displayName: "Rev C", active: true },
  worker1: { id: "worker1", displayName: "Worker", active: true },
};
const ELIGIBLE = ["rev-a", "rev-b", "rev-c"];
const CLAIMED_AT = "2026-10-01T00:00:00.000Z";
const basis = { version: 1, owner: "worker1", claimedAt: CLAIMED_AT, revision: null, headSha: null, deliveryDigest: null, deliveryGeneration: 0 };
const item = (id, extra = {}) => ({
  id, title: id, state: "delivered", owner: "worker1", claimedAt: CLAIMED_AT,
  tags: [], reviews: [], pullRequest: null, pullRequests: [], supersededBy: null, ...extra,
});
const FIXTURE = [
  item("c1"),
  item("c2", { tags: ["rev-rev-a"] }),
  item("c3", { state: "in_progress", tags: ["rev-rev-a", "rev-rev-b"], pullRequest: { url: "https://github.com/x/y/pull/1" } }),
  item("c4", { state: "in_progress" }),
  item("c5", { state: "done", tags: ["rev-rev-a"] }),
  item("c6", { owner: "rev-a", tags: ["rev-rev-a"] }),
  item("c7", { tags: ["rev-rev-b"], reviews: [{ memberId: "rev-b", verdict: "approve", summary: "ok", at: CLAIMED_AT, basis }] }),
  item("c8", { state: "unclaimed", owner: null }),
  item("c9", { supersededBy: "c1" }),
];

test("depth counts match the hand-computed fixture, zeros included", () => {
  const load = reviewerLoadOf(FIXTURE, MEMBERS, ELIGIBLE);
  assert.deepEqual(load, [
    { memberId: "rev-a", pendingReviews: 3, claimIds: ["c1", "c2", "c3"] },
    { memberId: "rev-b", pendingReviews: 2, claimIds: ["c1", "c3"] },
    { memberId: "rev-c", pendingReviews: 1, claimIds: ["c1"] },
  ]);
  // An eligible reviewer with nothing waiting still appears at depth 0:
  // on the named-only claims (c2, c3) rev-c is eligible but unnamed.
  const namedOnly = reviewerLoadOf([FIXTURE[1], FIXTURE[2]], MEMBERS, ELIGIBLE);
  assert.deepEqual(namedOnly.find(row => row.memberId === "rev-c"),
    { memberId: "rev-c", pendingReviews: 0, claimIds: [] });
});

test("pendingReviewersFor names only the reviewers a claim waits on", () => {
  assert.deepEqual(pendingReviewersFor(FIXTURE[1], MEMBERS, ELIGIBLE), ["rev-a"]);
  assert.deepEqual(pendingReviewersFor(FIXTURE[5], MEMBERS, ELIGIBLE), [], "the owner is never their own pending reviewer");
  assert.deepEqual(pendingReviewersFor(FIXTURE[6], MEMBERS, ELIGIBLE), [], "a current-basis review clears the wait");
});

test("the offering ranks eligible reviewers least-loaded first", () => {
  // A new unnamed claim counts toward every eligible reviewer, so the
  // depths including it are rev-a 4, rev-b 3, rev-c 2: rev-c is offered.
  const fresh = item("c10");
  const offer = reviewerOfferFor(fresh, [...FIXTURE, fresh], MEMBERS, ELIGIBLE);
  assert.equal(offer.suggestedReviewer, "rev-c");
  assert.deepEqual(offer.reviewers, [
    { memberId: "rev-c", pendingReviews: 2 },
    { memberId: "rev-b", pendingReviews: 3 },
    { memberId: "rev-a", pendingReviews: 4 },
  ]);
  // A named claim offers only among its named reviewers.
  const named = item("c11", { tags: ["rev-rev-a", "rev-rev-b"] });
  const namedOffer = reviewerOfferFor(named, [...FIXTURE, named], MEMBERS, ELIGIBLE);
  assert.equal(namedOffer.suggestedReviewer, "rev-b");
  assert.deepEqual(namedOffer.reviewers.map(row => row.memberId), ["rev-b", "rev-a"]);
  // No eligible reviewer (the only named reviewer is the owner): no offer.
  assert.equal(reviewerOfferFor(FIXTURE[5], FIXTURE, MEMBERS, ELIGIBLE), null);
});

// --- Route-level: board surface + delivered offer --------------------------
const ROUTE_MEMBERS = {
  mia: { id: "mia", kind: "human", active: true, permissions: ["manage_claims", "accept_work", "complete_work", "verify", "steer"] },
  worker: { id: "worker", kind: "agent", active: true, permissions: ["accept_work", "complete_work"] },
  ana: { id: "ana", kind: "agent", active: true, permissions: ["verify"] },
  bob: { id: "bob", kind: "human", active: true, permissions: ["verify"] },
  chat: { id: "chat", kind: "agent", active: true, permissions: [] },
};
const helpers = {
  json: (_res, status, value) => ({ status, value }),
  reject: (status, code, message) => { const error = new Error(message); error.status = status; error.code = code; throw error; },
  body: async req => req.body,
};
const call = (registry, memberId, route, id, body) => handleWorkClaims({
  req: { method: route === "list" ? "GET" : "POST", body },
  res: {},
  url: new URL("https://room.example/api/rooms/room1/work-claims"),
  store: { roomAuthority: () => ({ ownerId: "mia", members: ROUTE_MEMBERS }), room: () => ({ state: { messages: [] } }) },
  roomId: "room1",
  auth: { member: { id: memberId, kind: ROUTE_MEMBERS[memberId].kind, permissions: ROUTE_MEMBERS[memberId].permissions } },
  workClaimRoute: route,
  workClaimId: id,
  helpers,
  registry,
});

async function deliver(registry, id, tags) {
  assert.equal((await call(registry, "mia", "create", null, { id, tags })).status, 201);
  assert.equal((await call(registry, "worker", "claim", id, {})).status, 200);
  assert.equal((await call(registry, "worker", "update", id, { state: "in_progress" })).status, 200);
  return call(registry, "worker", "update", id, { state: "delivered" });
}

test("delivering a claim offers the less-loaded eligible reviewer and changes nothing else", async () => {
  const registry = createWorkClaimRegistry();
  // d0 names ana alone, loading her queue to 1 before d1 is submitted.
  const d0 = await deliver(registry, "d0", ["rev-ana"]);
  assert.equal(d0.status, 200);
  assert.equal(d0.value.reviewOffer.suggestedReviewer, "ana", "a named claim offers its named reviewer");
  // d1 is unnamed: depths including d1 are mia 1, bob 1, ana 2 (worker is
  // the owner and excluded). The tie at 1 breaks by memberId: bob.
  const d1 = await deliver(registry, "d1");
  assert.equal(d1.status, 200);
  assert.equal(d1.value.state, "delivered");
  assert.deepEqual(d1.value.reviewOffer, {
    suggestedReviewer: "bob",
    reviewers: [
      { memberId: "bob", pendingReviews: 1 },
      { memberId: "mia", pendingReviews: 1 },
      { memberId: "ana", pendingReviews: 2 },
    ],
  });
  // The offer is response presentation only: the stored claim gained no
  // assignment, and eligibility is exactly as before — ana (named on d0,
  // eligible on d1) may still review d1, and chat (never eligible) is
  // refused with the same refusal as before the offering existed.
  const stored = registry.get("room1", "d1");
  assert.equal(stored.reviewOffer, undefined);
  assert.equal(stored.owner, "worker");
  const refused = await call(registry, "chat", "review", "d1", { verdict: "approve", summary: "looks fine" });
  assert.equal(refused.status, 403);
  assert.equal(refused.value.error.code, "work_claims_not_permitted");
  const reviewed = await call(registry, "ana", "review", "d1", { verdict: "approve", summary: "looks fine" });
  assert.equal(reviewed.status, 200);
});

test("the board list carries per-reviewer depth for the whole room", async () => {
  const registry = createWorkClaimRegistry();
  await deliver(registry, "d0", ["rev-ana"]);
  await deliver(registry, "d1");
  const list = await call(registry, "mia", "list", null, undefined);
  assert.equal(list.status, 200);
  assert.deepEqual(list.value.reviewerLoad, [
    { memberId: "ana", pendingReviews: 2, claimIds: ["d0", "d1"] },
    { memberId: "bob", pendingReviews: 1, claimIds: ["d1"] },
    { memberId: "mia", pendingReviews: 1, claimIds: ["d1"] },
    { memberId: "worker", pendingReviews: 0, claimIds: [] },
  ]);
});

// --- needs-me standing section ---------------------------------------------
test("needs-me carries the room's reviewerLoad section with the same depths", t => {
  const store = new RoomStore(":memory:", { now: () => Date.parse("2026-10-01T00:00:00Z") });
  t.after(() => store.close());
  const rooms = new AgentRooms(store);
  const WRITER = ["steer", "accept_work", "complete_work", "verify"];
  const owner = store.identities.create("Owen");
  const ada = store.identities.create("Ada");
  const wren = store.identities.create("Wren");
  rooms.create(owner.secret, { roomId: "board", title: "board", purpose: "Reviewer load", kind: "personal" });
  store.identities.link(owner.secret, "board", { identityId: ada.identityId, displayName: "Ada", permissions: WRITER });
  store.identities.link(owner.secret, "board", { identityId: wren.identityId, displayName: "Wren", permissions: WRITER });
  const t0 = Date.parse("2026-10-01T00:00:00Z");
  const put = (id, ownerId, { tags = [], delivered = true } = {}) => {
    let claim = createWork({ id, title: `Task ${id}`, tags, reviewPolicy: "self_attested" }, { now: t0, agentId: owner.identityId });
    claim = claimWork(claim, ownerId, { now: t0 + 60000 });
    claim = updateWork(claim, ownerId, { state: "in_progress", now: t0 + 120000 });
    if (delivered) claim = updateWork(claim, ownerId, { state: "delivered", now: t0 + 180000 });
    store.workClaims.set("board", claim);
    return claim;
  };
  // Hand-computed: eligible reviewers are Owen (owner), Ada and Wren.
  //   d1 Wren, delivered, unnamed        -> Owen, Ada
  //   d2 Wren, delivered, named Ada     -> Ada
  //   d3 Ada, in_progress + PR, unnamed -> Owen, Wren
  //   d4 Wren, delivered, named Owen    -> Owen
  // Depths: Owen 3 (d1,d3,d4), Ada 2 (d1,d2), Wren 1 (d3).
  put("d1", wren.identityId);
  put("d2", wren.identityId, { tags: [`rev-${ada.identityId}`] });
  const d3 = put("d3", ada.identityId, { delivered: false });
  store.workClaims.set("board", { ...d3, pullRequest: { url: "https://github.com/x/y/pull/3" }, pullRequests: [{ url: "https://github.com/x/y/pull/3" }] });
  put("d4", wren.identityId, { tags: [`rev-${owner.identityId}`] });
  const page = collectNeedsMe(store, ada.secret, {});
  assert.equal(page.reviewerLoad?.length, 1);
  const section = page.reviewerLoad[0];
  assert.equal(section.roomId, "board");
  assert.equal(section.totalPendingReviews, 6);
  assert.deepEqual(section.reviewers, [
    { memberId: owner.identityId, pendingReviews: 3, claimIds: ["d1", "d3", "d4"] },
    { memberId: ada.identityId, pendingReviews: 2, claimIds: ["d1", "d2"] },
    { memberId: wren.identityId, pendingReviews: 1, claimIds: ["d3"] },
  ]);
});
