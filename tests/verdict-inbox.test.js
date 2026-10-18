// CD-01 (COMP-DEEP #1, REV §3 reqs 1–5): verdict inbox attention set.
//
// The attention set is a fold over append-only (claim, person, reason,
// since) records; these tests pin the full req-1 transition table at the
// event API, the same semantics derived from real claim records (#3627's
// delivery / review / verification facts), the orphan rule, bot
// exclusion on the human surface, Contract V section assignment, and
// why+when on every row.
import test from "node:test";
import assert from "node:assert/strict";
import {
  applyAttentionEvent, foldAttentionRecords, attentionTuplesForClaim,
  buildVerdictInbox, DEFAULT_ORPHAN_AFTER_MS,
} from "../server/verdict-inbox.mjs";

const HOUR = 3600 * 1000;
const T0 = Date.parse("2026-10-16T00:00:00Z");
const iso = ms => new Date(ms).toISOString();
const NOW = T0 + 72 * HOUR;

const HUMAN = (id, extra = {}) => ({ id, displayName: id, kind: "human", active: true, ...extra });
const members = {
  hana: HUMAN("hana"), // human reviewer
  wren: HUMAN("wren"), // human worker
  oona: HUMAN("oona"), // human room owner
  bot1: { id: "bot1", displayName: "bot1", kind: "agent", active: true },
};
const live = records => foldAttentionRecords(records);
const tuplesOf = records => live(records).map(t => `${t.personId}:${t.reason}`);

// ------------------------------------------------------- transition table

test("transition table: delivery submitted adds named reviewers (verdict-requested)", () => {
  const records = applyAttentionEvent([], {
    type: "delivery-submitted", claimId: "c1", roomId: "r1", at: iso(T0), reviewers: ["hana", "bot1"], workerId: "wren",
  });
  assert.deepEqual(tuplesOf(records), ["hana:verdict-requested", "bot1:verdict-requested"]);
  const tuple = live(records).find(t => t.personId === "hana");
  assert.equal(tuple.claimId, "c1");
  assert.equal(tuple.roomId, "r1");
  assert.equal(tuple.since, iso(T0), "why + when ride the tuple");
});

test("transition table: a recorded verdict removes only that reviewer", () => {
  let records = applyAttentionEvent([], {
    type: "delivery-submitted", claimId: "c1", at: iso(T0), reviewers: ["hana", "bot1"],
  });
  records = applyAttentionEvent(records, { type: "verdict-recorded", claimId: "c1", at: iso(T0 + HOUR), reviewerId: "hana" });
  assert.deepEqual(tuplesOf(records), ["bot1:verdict-requested"]);
});

test("transition table: request-revision removes the reviewer and adds the worker", () => {
  let records = applyAttentionEvent([], {
    type: "delivery-submitted", claimId: "c1", at: iso(T0), reviewers: ["hana"],
  });
  records = applyAttentionEvent(records, {
    type: "verdict-revision-requested", claimId: "c1", at: iso(T0 + HOUR), reviewerId: "hana", workerId: "wren",
  });
  assert.deepEqual(tuplesOf(records), ["wren:revision-requested"]);
  assert.equal(live(records)[0].since, iso(T0 + HOUR));
});

test("transition table: reject removes the reviewer and adds the worker (rejected)", () => {
  let records = applyAttentionEvent([], {
    type: "delivery-submitted", claimId: "c1", at: iso(T0), reviewers: ["hana"],
  });
  records = applyAttentionEvent(records, {
    type: "verdict-rejected", claimId: "c1", at: iso(T0 + HOUR), reviewerId: "hana", workerId: "wren",
  });
  assert.deepEqual(tuplesOf(records), ["wren:rejected"]);
});

test("transition table: accept clears the whole set", () => {
  let records = applyAttentionEvent([], {
    type: "delivery-submitted", claimId: "c1", at: iso(T0), reviewers: ["hana", "bot1"],
  });
  records = applyAttentionEvent(records, {
    type: "verdict-revision-requested", claimId: "c1", at: iso(T0 + HOUR), reviewerId: "hana", workerId: "wren",
  });
  records = applyAttentionEvent(records, { type: "verdict-accepted", claimId: "c1", at: iso(T0 + 2 * HOUR) });
  assert.deepEqual(live(records), []);
});

test("transition table: re-delivery re-adds the reviewer and removes the worker", () => {
  let records = applyAttentionEvent([], {
    type: "delivery-submitted", claimId: "c1", at: iso(T0), reviewers: ["hana"],
  });
  records = applyAttentionEvent(records, {
    type: "verdict-revision-requested", claimId: "c1", at: iso(T0 + HOUR), reviewerId: "hana", workerId: "wren",
  });
  records = applyAttentionEvent(records, {
    type: "redelivery-submitted", claimId: "c1", at: iso(T0 + 2 * HOUR), reviewers: ["hana"], workerId: "wren",
  });
  assert.deepEqual(tuplesOf(records), ["hana:re-review-required"]);
  assert.equal(live(records)[0].since, iso(T0 + 2 * HOUR));
});

test("transition table: a verdict voided by a new delivery re-adds the original reviewers", () => {
  let records = applyAttentionEvent([], {
    type: "delivery-submitted", claimId: "c1", at: iso(T0), reviewers: ["hana"],
  });
  records = applyAttentionEvent(records, { type: "verdict-recorded", claimId: "c1", at: iso(T0 + HOUR), reviewerId: "hana" });
  records = applyAttentionEvent(records, {
    type: "verdict-voided-new-delivery", claimId: "c1", at: iso(T0 + 2 * HOUR), reviewers: ["hana"], workerId: "wren",
  });
  assert.deepEqual(tuplesOf(records), ["hana:verdict-voided-new-delivery"]);
});

test("transition table: unknown events are refused, inputs never mutated", () => {
  const before = Object.freeze([]);
  assert.throws(() => applyAttentionEvent(before, { type: "poke", claimId: "c1", at: iso(T0) }), /unknown attention event type/);
  const records = applyAttentionEvent([], { type: "delivery-submitted", claimId: "c1", at: iso(T0), reviewers: ["hana"] });
  assert.equal(records.length, 1);
  assert.throws(() => applyAttentionEvent(records, { type: "delivery-submitted", claimId: "c1" }), /at\/since/);
});

// ------------------------------------------------------------- fold rules

test("fold semantics: the latest record per person per claim is the only live one", () => {
  const records = [
    { claimId: "c1", personId: "hana", action: "add", reason: "verdict-requested", since: iso(T0) },
    { claimId: "c1", personId: "hana", action: "add", reason: "re-review-required", since: iso(T0 + HOUR) },
    { claimId: "c1", personId: "bot1", action: "add", reason: "verdict-requested", since: iso(T0) },
    { claimId: "c2", personId: "hana", action: "add", reason: "verdict-requested", since: iso(T0) },
  ];
  const folded = live(records);
  assert.equal(folded.length, 3, "hana's second record supersedes her first; c2 is a separate tuple");
  const hanaC1 = folded.find(t => t.claimId === "c1" && t.personId === "hana");
  assert.equal(hanaC1.reason, "re-review-required");
  assert.equal(hanaC1.since, iso(T0 + HOUR));
  // A remove after the adds retires the tuple; a later add revives it.
  const removed = live([...records, { claimId: "c1", personId: "hana", action: "remove", since: iso(T0 + 2 * HOUR) }]);
  assert.ok(!removed.some(t => t.claimId === "c1" && t.personId === "hana"));
  // Malformed records never fold in.
  assert.deepEqual(live([{ claimId: "c1", personId: "hana", action: "add", reason: "nonsense", since: iso(T0) }]), []);
});

// ---------------------------------------------------- claim-record shapes

const deliveredClaim = (extra = {}) => ({
  id: "c-delivered", title: "Delivered work", state: "delivered", owner: "wren",
  tags: ["rev-hana"], reviews: [], verification: null,
  delivery: { digest: "d1", deliveredBy: "wren", deliveredAt: iso(NOW - 5 * HOUR) },
  deliveryGeneration: 1, updatedAt: iso(NOW - 5 * HOUR), ...extra,
});
const room = (claims, extra = {}) => ({
  roomId: "r1", claims, members, roomOwnerId: "oona", ...extra,
});

test("derivation: a delivered claim puts its named reviewer in Needs your verdict, why + when attached", () => {
  const inbox = buildVerdictInbox({ viewerId: "hana", rooms: [room([deliveredClaim()])], nowMs: NOW });
  assert.equal(inbox.sections.needsYourVerdict.length, 1);
  const row = inbox.sections.needsYourVerdict[0];
  assert.equal(row.claimId, "c-delivered");
  assert.equal(row.roomId, "r1");
  assert.equal(row.title, "Delivered work");
  assert.equal(row.reason, "verdict-requested");
  assert.equal(row.since, iso(NOW - 5 * HOUR));
  assert.equal(row.waitingSeconds, 5 * 3600);
  assert.equal(inbox.totals.needsYourVerdict, 1);
});

test("derivation: a current approval removes that reviewer but not the others", () => {
  const claim = deliveredClaim({
    tags: ["rev-hana", "rev-bot1"],
    reviews: [{ memberId: "hana", verdict: "approve", at: iso(NOW - HOUR),
      basis: { deliveryGeneration: 1, deliveryDigest: "d1" } }],
  });
  const tuples = attentionTuplesForClaim(claim, { roomId: "r1", members, roomOwnerId: "oona", nowMs: NOW });
  assert.deepEqual(tuples.map(t => t.personId), ["bot1"], "hana verdicted; bot1 still waits");
});

test("derivation: a send-back returns the claim to the worker and parks it in the reviewer's Waiting on worker", () => {
  const claim = deliveredClaim({
    state: "in_progress",
    verification: { state: "changes_requested", by: "hana", at: iso(NOW - 2 * HOUR), basis: { deliveryGeneration: 1, deliveryDigest: "d1" } },
    reviews: [{ memberId: "hana", verdict: "changes_requested", at: iso(NOW - 2 * HOUR),
      basis: { deliveryGeneration: 1, deliveryDigest: "d1" } }],
  });
  const workerInbox = buildVerdictInbox({ viewerId: "wren", rooms: [room([claim])], nowMs: NOW });
  assert.deepEqual(workerInbox.sections.returnedToYou.map(r => [r.claimId, r.reason, r.since]),
    [["c-delivered", "revision-requested", iso(NOW - 2 * HOUR)]]);
  const reviewerInbox = buildVerdictInbox({ viewerId: "hana", rooms: [room([claim])], nowMs: NOW });
  assert.deepEqual(reviewerInbox.sections.waitingOnWorker.map(r => [r.claimId, r.personId, r.reason]),
    [["c-delivered", "wren", "revision-requested"]]);
  assert.equal(reviewerInbox.sections.needsYourVerdict.length, 0, "the reviewer is no longer on the hook");
});

test("derivation: a reject-shaped verdict returns the claim to the worker as rejected", () => {
  const claim = deliveredClaim({
    state: "in_progress", verification: null,
    reviews: [{ memberId: "hana", verdict: "reject", at: iso(NOW - HOUR),
      basis: { deliveryGeneration: 1, deliveryDigest: "d1" } }],
  });
  const inbox = buildVerdictInbox({ viewerId: "wren", rooms: [room([claim])], nowMs: NOW });
  assert.deepEqual(inbox.sections.returnedToYou.map(r => r.reason), ["rejected"]);
});

test("derivation: accept clears the set and the claim lands in Recently decided", () => {
  const claim = deliveredClaim({
    state: "done",
    verification: { state: "verified", by: "hana", at: iso(NOW - HOUR), basis: { deliveryGeneration: 1, deliveryDigest: "d1" } },
    reviewedBy: "hana",
    reviews: [{ memberId: "hana", verdict: "approve", at: iso(NOW - HOUR),
      basis: { deliveryGeneration: 1, deliveryDigest: "d1" } }],
  });
  assert.deepEqual(attentionTuplesForClaim(claim, { roomId: "r1", members, roomOwnerId: "oona", nowMs: NOW }), []);
  const inbox = buildVerdictInbox({ viewerId: "hana", rooms: [room([claim])], nowMs: NOW });
  assert.deepEqual(inbox.sections.recentlyDecided.map(r => [r.claimId, r.reason, r.since]),
    [["c-delivered", "accepted", iso(NOW - HOUR)]]);
  assert.equal(inbox.totals.attentionTuples, 0);
});

test("derivation: re-delivery after a send-back re-adds the reviewer as re-review-required", () => {
  const claim = deliveredClaim({
    delivery: { digest: "d2", deliveredBy: "wren", deliveredAt: iso(NOW - HOUR) },
    deliveryGeneration: 2,
    reviews: [{ memberId: "hana", verdict: "changes_requested", at: iso(NOW - 3 * HOUR),
      basis: { deliveryGeneration: 1, deliveryDigest: "d1" } }],
  });
  const inbox = buildVerdictInbox({ viewerId: "hana", rooms: [room([claim])], nowMs: NOW });
  assert.deepEqual(inbox.sections.needsYourVerdict.map(r => r.reason), ["re-review-required"]);
});

test("derivation: an approval voided by a new delivery re-adds the reviewer as verdict-voided-new-delivery", () => {
  const claim = deliveredClaim({
    delivery: { digest: "d2", deliveredBy: "wren", deliveredAt: iso(NOW - HOUR) },
    deliveryGeneration: 2,
    reviews: [{ memberId: "hana", verdict: "approve", at: iso(NOW - 3 * HOUR),
      basis: { deliveryGeneration: 1, deliveryDigest: "d1" } }],
  });
  const inbox = buildVerdictInbox({ viewerId: "hana", rooms: [room([claim])], nowMs: NOW });
  assert.deepEqual(inbox.sections.needsYourVerdict.map(r => r.reason), ["verdict-voided-new-delivery"]);
});

// -------------------------------------------------------------- orphan rule

test("orphan rule: a delivered claim with an empty set past the interval adds the room owner", () => {
  const claim = deliveredClaim({ tags: [], delivery: { digest: "d1", deliveredBy: "wren", deliveredAt: iso(NOW - 25 * HOUR) } });
  const tuples = attentionTuplesForClaim(claim, { roomId: "r1", members, roomOwnerId: "oona", nowMs: NOW });
  assert.equal(DEFAULT_ORPHAN_AFTER_MS, 24 * HOUR);
  assert.deepEqual(tuples.map(t => [t.personId, t.reason, t.since]),
    [["oona", "orphaned-review", iso(NOW - HOUR)]], "responsibility starts when the interval lapses");
  const inbox = buildVerdictInbox({ viewerId: "oona", rooms: [room([claim])], nowMs: NOW });
  assert.deepEqual(inbox.sections.needsYourVerdict.map(r => r.reason), ["orphaned-review"]);
});

test("orphan rule: no orphan before the interval, none when the set is non-empty, interval is room-configured", () => {
  const fresh = deliveredClaim({ tags: [], delivery: { digest: "d1", deliveredBy: "wren", deliveredAt: iso(NOW - 23 * HOUR) } });
  assert.deepEqual(attentionTuplesForClaim(fresh, { roomId: "r1", members, roomOwnerId: "oona", nowMs: NOW }), []);
  const named = deliveredClaim({ delivery: { digest: "d1", deliveredBy: "wren", deliveredAt: iso(NOW - 30 * HOUR) } });
  assert.deepEqual(attentionTuplesForClaim(named, { roomId: "r1", members, roomOwnerId: "oona", nowMs: NOW })
    .map(t => t.personId), ["hana"], "a live reviewer means no orphan, however old");
  const custom = buildVerdictInbox({
    viewerId: "oona", nowMs: NOW,
    rooms: [room([deliveredClaim({ tags: [], delivery: { digest: "d1", deliveredBy: "wren", deliveredAt: iso(NOW - 2 * HOUR) } })],
      { config: { verdictOrphanAfterMs: HOUR } })],
  });
  assert.deepEqual(custom.sections.needsYourVerdict.map(r => r.reason), ["orphaned-review"],
    "the room-configured interval (here 1h) governs, not the 24h default");
});

// ------------------------------------------------------------ bot exclusion

test("bots never enter the human set; agent reviewers get a queue view of the same underlying set", () => {
  const claim = deliveredClaim({ tags: ["rev-bot1"] });
  const underlying = attentionTuplesForClaim(claim, { roomId: "r1", members, roomOwnerId: "oona", nowMs: NOW });
  assert.deepEqual(underlying.map(t => t.personId), ["bot1"], "one underlying set, bot included");
  const human = buildVerdictInbox({ viewerId: "bot1", rooms: [room([claim])], nowMs: NOW, surface: "human" });
  assert.deepEqual(human.sections.needsYourVerdict, [], "the human surface never renders a bot tuple");
  assert.equal(human.totals.attentionTuples, 1, "the underlying tuple still exists and is counted");
  const agent = buildVerdictInbox({ viewerId: "bot1", rooms: [room([claim])], nowMs: NOW, surface: "agent" });
  assert.deepEqual(agent.sections.needsYourVerdict.map(r => [r.claimId, r.reason]),
    [["c-delivered", "verdict-requested"]], "the agent door is a queue view of the same set, not a second set");
});

// ------------------------------------------------------- sections + sorting

test("sections: a claim in each lifecycle position lands in exactly its section, oldest waiting first", () => {
  const claims = [
    deliveredClaim({ id: "c-old", delivery: { digest: "d1", deliveredBy: "wren", deliveredAt: iso(NOW - 10 * HOUR) } }),
    deliveredClaim({ id: "c-new", delivery: { digest: "d1", deliveredBy: "wren", deliveredAt: iso(NOW - HOUR) } }),
    deliveredClaim({ id: "c-back", state: "in_progress",
      verification: { state: "changes_requested", by: "hana", at: iso(NOW - 3 * HOUR), basis: { deliveryGeneration: 1, deliveryDigest: "d1" } } }),
    deliveredClaim({ id: "c-done", state: "done",
      verification: { state: "verified", by: "hana", at: iso(NOW - 30 * 60000), basis: { deliveryGeneration: 1, deliveryDigest: "d1" } },
      reviewedBy: "hana" }),
    deliveredClaim({ id: "c-working", state: "in_progress", delivery: null, deliveryGeneration: 0, verification: null }),
  ];
  const asReviewer = buildVerdictInbox({ viewerId: "hana", rooms: [room(claims)], nowMs: NOW });
  assert.deepEqual(asReviewer.sections.needsYourVerdict.map(r => r.claimId), ["c-old", "c-new"],
    "waiting time is the default sort, oldest first");
  assert.deepEqual(asReviewer.sections.waitingOnWorker.map(r => r.claimId), ["c-back"]);
  assert.deepEqual(asReviewer.sections.recentlyDecided.map(r => r.claimId), ["c-done"]);
  assert.equal(asReviewer.sections.returnedToYou.length, 0);
  const asWorker = buildVerdictInbox({ viewerId: "wren", rooms: [room(claims)], nowMs: NOW });
  assert.deepEqual(asWorker.sections.returnedToYou.map(r => r.claimId), ["c-back"]);
  assert.equal(asWorker.totals.total, 2, "returned + recently decided (as its worker)");
  // Why + when on every row of every section.
  for (const rows of Object.values(asReviewer.sections)) {
    for (const row of rows) {
      assert.ok(row.claimId && row.roomId && row.title, "row names the claim");
      assert.ok(typeof row.reason === "string" && row.reason.length > 0, "row carries why");
      assert.ok(Number.isFinite(Date.parse(row.since)), "row carries when");
      assert.ok(Number.isSafeInteger(row.waitingSeconds) && row.waitingSeconds >= 0, "row carries waiting time");
    }
  }
});

// --------------------------------------------------------- follow (Contract F)

test("follow totals (Contract F) ride beside the sections; absent provider reads as null", () => {
  const withFollow = buildVerdictInbox({
    viewerId: "hana", rooms: [room([deliveredClaim()])], nowMs: NOW,
    follow: { totals: { followedClaims: 3, unreadClaims: 1, unreadEvents: 4, mentions: 2 },
      claims: [{ claimId: "c-delivered", roomId: "r1", policy: "follow", unreadCount: 2, mentionCount: 1 }] },
  });
  assert.deepEqual(withFollow.follow.totals, { followedClaims: 3, unreadClaims: 1, unreadEvents: 4, mentions: 2 });
  assert.deepEqual(withFollow.follow.claims, [{ claimId: "c-delivered", roomId: "r1", policy: "follow", unreadCount: 2, mentionCount: 1 }]);
  assert.equal(withFollow.totals.followedChanges, 4, "totals echo the follow unread-event count");
  assert.equal(withFollow.totals.mentions, 2);
  assert.deepEqual(withFollow.following, [{ claimId: "c-delivered", roomId: "r1", policy: "follow", unreadCount: 2, mentionCount: 1, type: "followed-claim" }]);
  const without = buildVerdictInbox({ viewerId: "hana", rooms: [room([deliveredClaim()])], nowMs: NOW });
  assert.equal(without.follow, null, "no CD-06 provider yet: null, never invented zeroes");
  const perRoom = buildVerdictInbox({
    viewerId: "hana", nowMs: NOW,
    rooms: [room([deliveredClaim()], { follow: { followedClaims: 2, unreadClaims: 1, unreadEvents: 1, mentions: 0 } })],
  });
  assert.deepEqual(perRoom.follow.totals, { followedClaims: 2, unreadClaims: 1, unreadEvents: 1, mentions: 0 },
    "a bare totals object (no totals wrapper) is also accepted");
});
