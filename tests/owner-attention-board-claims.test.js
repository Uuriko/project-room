// #3754: the owner attention rollup must see board work-claims. A claim that
// sits in `delivered` awaiting the room owner's review (or their verify after
// an approval) is an owner obligation exactly like a legacy work item awaiting
// verification — but attentionReport historically read only workItems, so
// board reviews were invisible. Eligibility mirrors the routes' verify gate:
// the claim's review policy (room default when unset), named reviewers
// (rev-<memberId> tags), and canCloseWork once the owner has approved.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { AccessRequests, accessRequestSchema } from "../server/access-requests.mjs";
import { createRateLimiter } from "../server/identity-ratelimit.mjs";
import { attentionReport } from "../server/owner-attention.mjs";
import { createWork, claimWork, updateWork, recordReview } from "../server/work-claims.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

const NOW = Date.parse("2026-09-21T12:00:00Z");

function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-attention-board-"));
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => NOW });
  store.initialize(initialRoom("commons"));
  store.db.exec(accessRequestSchema);
  const accessRequests = new AccessRequests(store, { rateLimiter: createRateLimiter({ capacity: 1000, refillPerSecond: 1000 }) });
  const ownerKey = store.issueAccessKey("commons", "owner");
  const send = (type, data, id = randomUUID()) => store.command(ownerKey, "commons", { id, type, data });
  send(T.MEMBER_ADDED, { memberId: "member", displayName: "Regular human", kind: "human", permissions: [] });
  send(T.MEMBER_ADDED, { memberId: "agent", displayName: "Test agent", kind: "agent", permissions: ["accept_work", "complete_work"], accountableHumanId: "owner" });
  const report = () => attentionReport({ store, accessRequests }, ownerKey, "commons", null, NOW);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, report };
}

// Drive a claim through the kernel lifecycle into `delivered`.
function delivered(f, { id, reviewPolicy = undefined, tags = [], holder = "agent" }) {
  let item = createWork({ id, title: `Claim ${id}`, reviewPolicy, tags }, { now: NOW, agentId: "owner" });
  item = claimWork(item, holder, { now: NOW });
  item = updateWork(item, holder, { state: "in_progress", now: NOW });
  item = updateWork(item, holder, { state: "delivered", deliveryMode: "result", now: NOW,
    delivery: { result: "shipped",
      artifact: { kind: "report", ref: `https://example.com/results/${id}`, sha256: "a".repeat(64) },
      checks: [{ name: "unit", result: "pass" }] } });
  f.store.workClaims.set("commons", item);
  return item;
}
const boardReviews = report => report.items.filter(item => item.kind === "board_review");

test("a delivered claim awaiting the owner's review surfaces as board_review", t => {
  const f = setup(t);
  delivered(f, { id: "wc_a", reviewPolicy: "distinct_member" });
  const items = boardReviews(f.report());
  assert.equal(items.length, 1);
  const [item] = items;
  assert.equal(item.id, "wc_a");
  assert.equal(item.severity, "action");
  assert.equal(item.title, "Review: Claim wc_a");
  assert.match(item.detail, /review/i);
  assert.deepEqual(item.actions, [{ action: "review", method: "GET", path: "/api/rooms/commons/work-claims/wc_a" }]);
});

test("claims not yet delivered do not surface", t => {
  const f = setup(t);
  let item = createWork({ id: "wc_b", title: "Claim wc_b", reviewPolicy: "distinct_member" }, { now: NOW, agentId: "owner" });
  item = claimWork(item, "agent", { now: NOW });
  item = updateWork(item, "agent", { state: "in_progress", now: NOW });
  f.store.workClaims.set("commons", item);
  assert.deepEqual(boardReviews(f.report()), []);
});

test("under a reviewed policy the owner's own delivered claim is not their review", t => {
  const f = setup(t);
  delivered(f, { id: "wc_c", reviewPolicy: "distinct_member", holder: "owner" });
  assert.deepEqual(boardReviews(f.report()), [], "a reviewed policy never asks the holder to review their own work");
});

test("a self-attested delivered claim owned by the owner awaits their verification", t => {
  const f = setup(t);
  delivered(f, { id: "wc_d", holder: "owner" });
  const items = boardReviews(f.report());
  assert.equal(items.length, 1);
  assert.equal(items[0].id, "wc_d");
  assert.match(items[0].detail, /verif/i);
});

test("a claim naming another reviewer does not surface to the owner; naming the owner does", t => {
  const f = setup(t);
  delivered(f, { id: "wc_e", reviewPolicy: "distinct_member", tags: ["rev-member"] });
  delivered(f, { id: "wc_f", reviewPolicy: "distinct_member", tags: ["rev-owner"] });
  assert.deepEqual(boardReviews(f.report()).map(item => item.id), ["wc_f"]);
});

test("once the owner approves, the same item asks for their verification, then clears at done", t => {
  const f = setup(t);
  const claim = delivered(f, { id: "wc_g", reviewPolicy: "distinct_member" });
  const reviewed = recordReview(claim, "owner", { verdict: "approve", summary: "looks right", now: NOW + 1000 });
  f.store.workClaims.set("commons", reviewed);
  const items = boardReviews(f.report());
  assert.equal(items.length, 1, "the obligation remains — it changed shape, it did not vanish");
  assert.match(items[0].detail, /verif/i, "the pending act is now the verify");
  // The route's verify call: canCloseWork gates it, then the kernel update
  // runs with authority because the verifier is not the claim's owner.
  const done = updateWork(reviewed, "owner", { state: "done", now: NOW + 2000, authority: true });
  f.store.workClaims.set("commons", done);
  assert.deepEqual(boardReviews(f.report()), [], "a verified claim leaves the rollup");
});
