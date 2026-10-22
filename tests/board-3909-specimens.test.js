// Issue #3909 (bug sweep 2026-10-16, lane 10 BOARD-UI) — Low bundle F10–F14.
// One regression specimen per finding, each written against the kernel/route
// contract the UI mirrors; controls pin the behaviour that must NOT change.
import test from "node:test";
import assert from "node:assert/strict";
import { myBoardWork, needsMeHtml } from "../src/board-mine.js";
import { boardHtml, canWriteClaims } from "../src/board-ui.js";

const NOW = Date.parse("2026-10-16T12:00:00Z");
const T0 = "2026-10-16T10:00:00.000Z";
const FUTURE = "2026-10-16T18:00:00.000Z";
const PAST = "2026-10-16T08:00:00.000Z";

const members = {
  "agent-1": { id: "agent-1", kind: "agent", active: true, permissions: ["accept_work", "complete_work"] },
  "rev-1": { id: "rev-1", kind: "human", active: true, permissions: ["accept_work", "complete_work"] },
};
const claim = (id, extra = {}) => ({
  id, title: `Title ${id}`, state: "in_progress", owner: "agent-1", kind: "task",
  files: [], dependsOn: [], tags: [], reviews: [], attestations: [], history: [],
  claimedAt: T0, updatedAt: T0, ...extra,
});
const articleOf = (html, id) => {
  const start = html.indexOf(`data-claim-id="${id}"`);
  assert.notEqual(start, -1, `card for ${id} renders`);
  const end = html.indexOf("</article>", start);
  return html.slice(start, end);
};

// --- F10: needs-me must not invent review rows for terminal claims ---
// Kernel REVIEWABLE_CLAIM_STATES = claimed/in_progress/blocked + delivered.
// A done (or closed) claim whose PR is still open is NOT reviewable; the old
// PR clause in myBoardWork counted it anyway and the Review button dead-ended.

test("F10 specimen: a done claim with an open PR produces no review-owed row", () => {
  const item = claim("f10-done", { state: "done", owner: "agent-1", tags: ["rev-rev-1"],
    pullRequest: { url: "https://github.com/o/r/pull/7" } });
  const work = myBoardWork([item], "rev-1", members, NOW);
  assert.equal(work.reviews.length, 0, "done is terminal — no review is owed");
});

test("F10 specimen: a closed claim with an open PR produces no review-owed row", () => {
  const item = claim("f10-closed", { state: "closed", owner: "agent-1", tags: ["rev-rev-1"],
    pullRequest: { url: "https://github.com/o/r/pull/8" } });
  const work = myBoardWork([item], "rev-1", members, NOW);
  assert.equal(work.reviews.length, 0, "closed is terminal — no review is owed");
});

test("F10 control: delivered and active claims with an open PR still owe their review", () => {
  const delivered = claim("f10-delivered", { state: "delivered", owner: "agent-1", tags: ["rev-rev-1"],
    pullRequest: { url: "https://github.com/o/r/pull/9" } });
  const active = claim("f10-active", { state: "claimed", owner: "agent-1", tags: ["rev-rev-1"],
    pullRequest: { url: "https://github.com/o/r/pull/10" } });
  const work = myBoardWork([delivered, active], "rev-1", members, NOW);
  assert.deepEqual(work.reviews.map(({ item }) => item.id).sort(), ["f10-active", "f10-delivered"]);
});

// --- F11: Renew is offered only when a live lease exists to renew ---
// renewWork refuses a leaseless claim ("has no lease — nothing to renew")
// and a lapsed one ("lease already lapsed — claim it again instead").

const workerViewer = { id: "agent-1", manage: false, owner: false, write: true };
const renderAsWorker = (items, opts = {}) => boardHtml(items, null, workerViewer, members, NOW, opts);

test("F11 specimen: a leaseless claim's card offers no Renew button", () => {
  const html = renderAsWorker([claim("f11-nolease", { state: "claimed", leaseExpiresAt: null })]);
  assert.doesNotMatch(articleOf(html, "f11-nolease"), /data-claim-action="renew"/,
    "a claim with no lease has nothing to renew");
});

test("F11 specimen: a lapsed lease's card offers no Renew button", () => {
  const html = renderAsWorker([claim("f11-lapsed", { state: "in_progress", leaseExpiresAt: PAST })]);
  assert.doesNotMatch(articleOf(html, "f11-lapsed"), /data-claim-action="renew"/,
    "a lapsed lease cannot be renewed");
});

test("F11 specimen: needs-me offers no Renew for a lease that already ended", () => {
  const html = needsMeHtml([claim("f11-nm", { state: "claimed", leaseExpiresAt: PAST })], workerViewer, members, NOW);
  assert.match(html, /f11-nm|Title f11-nm/, "the ended-lease row itself still surfaces");
  assert.doesNotMatch(html, /data-claim-action="renew"/, "an ended lease cannot be renewed from needs-me either");
});

test("F11 control: a live lease's card and needs-me row still offer Renew", () => {
  const soon = "2026-10-16T12:30:00.000Z"; // 30 minutes left: expiring in needs-me, live on the card
  const card = renderAsWorker([claim("f11-live", { state: "claimed", leaseExpiresAt: FUTURE })]);
  assert.match(articleOf(card, "f11-live"), /data-claim-action="renew"/, "a live lease can be renewed");
  const nm = needsMeHtml([claim("f11-live-nm", { state: "claimed", leaseExpiresAt: soon })], workerViewer, members, NOW);
  assert.match(nm, /data-claim-action="renew"/, "a lease about to lapse can still be renewed");
});

// --- F12: the Claim button consults the per-member open-claim cap ---
// The claim route refuses at cap: held = viewer's claims in
// claimed/in_progress/blocked >= config.maxMemberOpenClaims.

test("F12 specimen: a member at the open-claim cap is offered no Claim button", () => {
  const items = [
    claim("f12-held-1", { state: "claimed" }),
    claim("f12-held-2", { state: "blocked" }),
    claim("f12-open", { state: "unclaimed", owner: null }),
  ];
  const html = renderAsWorker(items, { cap: 2 });
  assert.doesNotMatch(articleOf(html, "f12-open"), /data-claim-action="claim"/,
    "at cap, the board must not offer an action the route will refuse");
});

test("F12 control: below the cap the Claim button renders; delivered work does not count toward it", () => {
  const items = [
    claim("f12-held-1", { state: "claimed" }),
    claim("f12-done-delivered", { state: "delivered" }),
    claim("f12-open", { state: "unclaimed", owner: null }),
  ];
  const html = renderAsWorker(items, { cap: 2 });
  assert.match(articleOf(html, "f12-open"), /data-claim-action="claim"/,
    "one active claim plus delivered work is below a cap of 2");
});

// --- F13: canWriteClaims mirrors mayWriteWorkClaims in both corners ---
// Route order: refuse missing/inactive member first, then the owner branch,
// then the permission profiles — regardless of whether the room has an owner.

const stateOf = (ownerId, mems) => ({ room: { ownerId }, members: mems });
const sessionOf = id => ({ member: { id } });

test("F13 specimen: an ownerless room does not grant write to a permissionless member", () => {
  const state = stateOf(null, { m1: { kind: "human", permissions: [] } });
  assert.equal(canWriteClaims(state, sessionOf("m1")), false,
    "the route applies the permission profiles whether or not an owner exists");
});

test("F13 specimen: an ownerless room does not grant write to an inactive member", () => {
  const state = stateOf(null, { m1: { kind: "human", permissions: ["accept_work"], active: false } });
  assert.equal(canWriteClaims(state, sessionOf("m1")), false,
    "the route refuses inactive members first, owner or no owner");
});

test("F13 specimen: an inactive owner is refused, and an owner with no member record is refused", () => {
  const inactive = stateOf("owner1", { owner1: { kind: "human", permissions: [], active: false } });
  assert.equal(canWriteClaims(inactive, sessionOf("owner1")), false,
    "the route refuses an inactive member before its owner branch");
  const missing = stateOf("owner1", {});
  assert.equal(canWriteClaims(missing, sessionOf("owner1")), false,
    "the route's owner branch requires a live member record");
});

test("F13 control: ownerless profiles still apply, and an active owner still writes", () => {
  const ownerless = stateOf(null, { m1: { kind: "human", permissions: ["accept_work"] } });
  assert.equal(canWriteClaims(ownerless, sessionOf("m1")), true,
    "a permitted member writes in an ownerless room, by profile not by default");
  const owned = stateOf("owner1", { owner1: { kind: "human", permissions: [] } });
  assert.equal(canWriteClaims(owned, sessionOf("owner1")), true, "the active owner writes");
});

// --- F14: the record's history renders newest-first ---
// The server's history is chronological (history[0] is the creation stamp);
// the record must show the most recent event first, as its own comment states.

test("F14 specimen: history renders newest event first", () => {
  const item = claim("f14", {
    history: [
      { action: "created", agentId: "agent-1", at: T0, note: "first event note" },
      { action: "state:claimed", agentId: "agent-1", at: "2026-10-16T11:00:00.000Z", note: "middle event note" },
      { action: "state:delivered", agentId: "agent-1", at: "2026-10-16T11:30:00.000Z", note: "latest event note" },
    ],
    historyOmitted: 2,
  });
  const html = renderAsWorker([item]);
  const latest = html.indexOf("latest event note");
  const middle = html.indexOf("middle event note");
  const first = html.indexOf("first event note");
  assert.ok(latest !== -1 && middle !== -1 && first !== -1, "all history notes render");
  assert.ok(latest < middle && middle < first, "newest first, oldest last");
  assert.match(html, /2 earlier/, "the omitted-count disclosure still renders");
});
