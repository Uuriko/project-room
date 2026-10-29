// Board batch Slice C — #3890 + #3891.
// #3890: Owner Cockpit decision facts fell through for board_review —
// decisionFacts read workItems[item.id], a map board-native claims are
// never in, so every board review carried null age/consequence and
// sorted as brand new; the cockpit's KIND_LABEL lacked the kind too.
// The facts now come from the claim itself (waiting since its
// delivery landed), and the label exists.
// #3891: the cockpit rendered every POST action as an Approve/Deny
// button; the spend item's body-less "adjust" pointer became a Deny
// button POSTing an empty body to the spend-allowance endpoint. A
// POST without a body is not a decide — it falls through to its hint,
// exactly like the in-room needs-attention card.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { AccessRequests, accessRequestSchema } from "../server/access-requests.mjs";
import { createRateLimiter } from "../server/identity-ratelimit.mjs";
import { bountyEscrowSchema } from "../server/bounty-escrow.mjs";
import { ownerOverview } from "../server/owner-overview.mjs";
import { createWork, claimWork, updateWork } from "../server/work-claims.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { cockpitActionsHtml, KIND_LABEL } from "../src/owner-cockpit.js";

const T0 = Date.parse("2026-10-14T12:00:00.000Z");
const NOW = new Date(T0);

function setup(t) {
  const store = new RoomStore(":memory:", { now: () => T0 });
  store.initialize(initialRoom("room-a"));
  store.db.exec(accessRequestSchema);
  store.db.exec(bountyEscrowSchema);
  const accessRequests = new AccessRequests(store, { rateLimiter: createRateLimiter({ capacity: 1000, refillPerSecond: 1000 }) });
  store.createAccount("owner-account");
  store.bindHumanAccount("room-a", "owner", "owner-account");
  const ownerKey = store.issueAccessKey("room-a", "owner");
  const send = (type, data) => store.command(ownerKey, "room-a", { id: randomUUID(), type, data });
  send(T.MEMBER_ADDED, { memberId: "agent", displayName: "Worker", kind: "agent",
    permissions: ["accept_work", "complete_work"], accountableHumanId: "owner" });
  const key = store.issueAccountAccessKey("owner-account");
  const slot = store.createAccountSessionSlot();
  const session = store.loginAccountSession(slot.token, key, 0);
  t.after(() => { store.close(); });
  return { store, accessRequests, token: slot.token, binding: session.sessionBinding };
}

function deliveredClaim(f, id) {
  let item = createWork({ id, title: `Claim ${id}`, reviewPolicy: "distinct_member" }, { now: NOW, agentId: "owner" });
  item = claimWork(item, "agent", { now: NOW });
  item = updateWork(item, "agent", { state: "in_progress", now: NOW });
  item = updateWork(item, "agent", { state: "delivered", deliveryMode: "result", now: NOW,
    delivery: { result: "shipped",
      artifact: { kind: "report", ref: `https://example.com/results/${id}`, sha256: "a".repeat(64) },
      checks: [{ name: "unit", result: "pass" }] } });
  f.store.workClaims.set("room-a", item);
  return item;
}

test("#3890: a board_review decision carries its age and consequence from the claim's delivery", t => {
  const f = setup(t);
  deliveredClaim(f, "wc_facts");
  const doc = ownerOverview({ store: f.store, accessRequests: f.accessRequests, jobHealth: () => [] },
    f.token, f.binding, T0 + 48 * 3600 * 1000, {});
  const review = doc.decisions.items.find(item => item.kind === "board_review" && item.id === "wc_facts");
  assert.ok(review, `board_review present: ${JSON.stringify(doc.decisions.items.map(i => i.kind))}`);
  assert.equal(review.createdAtMs, T0, "waiting since the delivery landed");
  assert.equal(review.ageMs, 48 * 3600 * 1000);
  assert.match(review.consequence, /stays unverified/);
  assert.equal(review.consequenceAtMs, null, "no deadline attaches to a review");
  assert.equal(doc.decisions.oldestAgeMs, 48 * 3600 * 1000, "the header's oldest age sees the board review");
});

test("#3890: the cockpit labels board_review instead of printing the raw kind", () => {
  assert.equal(KIND_LABEL.board_review, "Board review");
});

test("#3891: a body-less POST action renders its hint, never a Deny button", () => {
  const spend = { id: "spend-allowance", roomId: "room-a", actions: [{ action: "adjust", method: "POST",
    path: "/api/rooms/room-a/spend-allowance", hint: "Send { allowanceCents, periodDays? } to raise the allowance" }] };
  const html = cockpitActionsHtml(spend);
  assert.doesNotMatch(html, /data-cockpit-decide/, "no decide button for a pointer action");
  assert.doesNotMatch(html, /Deny/);
  assert.match(html, /attention-hint/, "the hint renders, like the in-room card");
  assert.match(html, /raise the allowance/);
});

test("#3891: POST actions carrying a body still render their decide buttons", () => {
  const decision = { id: "req-1", roomId: "room-a", actions: [
    { action: "approve", method: "POST", path: "/x", body: { decision: "approve" } },
    { action: "deny", method: "POST", path: "/x", body: { decision: "deny" } },
  ] };
  const html = cockpitActionsHtml(decision);
  assert.match(html, /data-cockpit-decide="approve"[^>]*>Approve</);
  assert.match(html, /data-cockpit-decide="deny"[^>]*>Deny</);
  const review = { id: "wc_1", roomId: "room-a", actions: [{ action: "review", method: "GET", path: "/api/rooms/room-a/bounties" }] };
  assert.match(cockpitActionsHtml(review), /Review in room/);
});
