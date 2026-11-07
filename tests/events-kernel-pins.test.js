// tests/events-kernel-pins.test.js — B1-4 PIN tests (event kernel reducers).
//
// Conversion of the methods audit's B1-4 survivor clusters (phase-b/B1,
// B1-4.md §4): the audit's tier-1 run (oracle tests/events.test.js) left
// 463 survivors in 47 clusters, graded UNRESOLVED because the tier-2 /
// triad leg was blocked by the VM write-fault episode. Each test below
// executes the cluster's named proving step against the pristine code and
// was verified to FAIL on a representative mutant of the cluster (see the
// PR body for the re-check table) — that triad is what converts a cluster
// from SUSPECTED to pinned. Clusters not in this file are named as
// remainder in the PR body, in cluster order.
//
// E1 caveat (binding, from PR #4963's landing acceptance): this file makes
// NO claim of event-id-conflict coverage for numeric-field-only changes to
// a reused event id. The stableStringify numeric-field class (tier-1
// mutants 2 and 4) is deliberately not pinned here; E1 coverage below is
// the key-order leg only, killed via mutant 5 (object-branch return
// deleted). Conversion re-check found tier-1 mutant 1 (array-branch
// return deleted) is masked by the object branch — arrays are objects
// whose index keys still sort — so the load-bearing statement for
// key-order insensitivity is the object branch, and that is what E1 pins.
import test from "node:test";
import assert from "node:assert/strict";
import { EVENT_TYPES, applyEvent, replay, CHANNEL_ARCHIVED_CODE } from "../src/events.js";
import { seedEvents } from "../src/seed.js";

const ROOM_ID = "room-project-room-v0";
const baseState = () => replay(seedEvents);
function fixedEvent(id, type, actorId, data) {
  return { id, idempotencyKey: `key-${id}`, roomId: ROOM_ID, type, actorId, at: "2026-09-05T10:00:00.000Z", causationId: null, data };
}
const post = (state, id, data, actor = "potter") => applyEvent(state, fixedEvent(id, EVENT_TYPES.MESSAGE_POSTED, actor, data));
const card = (state, id, extra = {}) => post(state, id, {
  messageId: id, body: "card body", kind: "receipt_card", claimId: `claim-${id}`,
  title: "Card", closedBy: "potter", deliveryMode: "result", evidence: "Shipped.", ...extra,
});
const lastMsg = (state, id) => state.messages.find((m) => m.id === id);

// --- M1a: receipt cost cents validity (L10-16) ---
// Envelope-legal shapes only: validateEnvelope (src/events.js) requires
// cost to be exactly {spentCents, capCents, model} with cents null or
// non-negative safe integers — so the distinguishing boundary reachable
// through applyEvent is 0 (kept by the original, nulled by the >= → >
// mutant). The negative-cents half of the audit's proving step is
// pre-empted by the envelope and is not claimed here.
test("M1a receipt cost: 0 cents is kept as 0, not nulled", () => {
  const s = card(baseState(), "m1a-card", { cost: { spentCents: 0, capCents: 0, model: null } });
  assert.deepEqual(lastMsg(s, "m1a-card").cost, { spentCents: 0, capCents: 0, model: null });
});

// --- M1c: cost.model rules (L13) ---
// Envelope-legal shapes only (see M1a note): the 100-char boundary is the
// reachable distinguishing leg; 101-char and non-string models are refused
// by validateEnvelope before the reducer runs.
test("M1c receipt cost model: exactly 100 chars is kept; null model stays null with cents intact", () => {
  const s1 = card(baseState(), "m1c-100", { cost: { spentCents: 5, capCents: 9, model: "m".repeat(100) } });
  assert.deepEqual(lastMsg(s1, "m1c-100").cost, { spentCents: 5, capCents: 9, model: "m".repeat(100) });
  const s2 = card(baseState(), "m1c-null", { cost: { spentCents: 5, capCents: 9, model: null } });
  assert.deepEqual(lastMsg(s2, "m1c-null").cost, { spentCents: 5, capCents: 9, model: null });
});

// --- M2: isRedactedBody (L18) ---
test("M2 redacted replay: {redacted:true} with no body posts as redacted; with a body it does not", () => {
  const s1 = post(baseState(), "m2-redacted", { messageId: "m2-redacted", redacted: true });
  assert.equal(lastMsg(s1, "m2-redacted").redacted, true);
  const s2 = post(baseState(), "m2-live", { messageId: "m2-live", redacted: true, body: "live text" });
  assert.equal("redacted" in lastMsg(s2, "m2-live"), false);
  assert.equal(lastMsg(s2, "m2-live").body, "live text");
});

// --- M3: body-required guard for non-redacted posts (L30/L34) ---
test("M3 post with no body and no redacted flag throws 'Event data missing body'", () => {
  assert.throws(() => post(baseState(), "m3-nobody", {}), /Event data missing body/);
});

// --- M5: receipt-card requireFields (L40) ---
test("M5 receipt card missing evidence throws", () => {
  assert.throws(() => post(baseState(), "m5-card", {
    messageId: "m5-card", body: "b", kind: "receipt_card", claimId: "c", title: "t",
    closedBy: "potter", deliveryMode: "result",
  }), /Event data missing evidence/);
});

// --- M6: requireWorkItem on post (L43) ---
test("M6 post naming a bogus workItemId throws", () => {
  assert.throws(() => post(baseState(), "m6-post", { body: "b", workItemId: "work-does-not-exist" }), /work item/i);
});

// --- M7: thread-root channel walk (L50-55) ---
test("M7 a deep reply pins to its thread root's channel, not the carried channelId", () => {
  let s = baseState();
  s = applyEvent(s, fixedEvent("m7-chan", EVENT_TYPES.CHANNEL_CREATED, "potter", { name: "side-room" }));
  const sideId = Object.values(s.channels).find((c) => c.name === "side-room").id;
  s = post(s, "m7-root", { messageId: "m7-root", body: "root", channelId: sideId });
  s = post(s, "m7-mid", { messageId: "m7-mid", body: "mid", replyToId: "m7-root", channelId: "general" });
  s = post(s, "m7-leaf", { messageId: "m7-leaf", body: "leaf", replyToId: "m7-mid", channelId: "general" });
  assert.equal(lastMsg(s, "m7-mid").channelId, sideId);
  assert.equal(lastMsg(s, "m7-leaf").channelId, sideId);
});

// --- M8: archived-channel error carries its code (L60-61) ---
test("M8 posting to an archived channel throws an error with code channel_archived", () => {
  let s = baseState();
  s = applyEvent(s, fixedEvent("m8-chan", EVENT_TYPES.CHANNEL_CREATED, "potter", { name: "old-room" }));
  const chanId = Object.values(s.channels).find((c) => c.name === "old-room").id;
  s = applyEvent(s, fixedEvent("m8-arch", EVENT_TYPES.CHANNEL_ARCHIVED, "potter", { channelId: chanId }));
  assert.throws(
    () => post(s, "m8-post", { messageId: "m8-post", body: "b", channelId: chanId }),
    (e) => e.code === CHANNEL_ARCHIVED_CODE && e.code === "channel_archived",
  );
});

// --- M9: message-id fallback messageId || id (L65) ---
test("M9 a post without messageId is stored under the event id", () => {
  const s = post(baseState(), "m9-event-id", { body: "no messageId" });
  assert.equal(lastMsg(s, "m9-event-id").body, "no messageId");
});

// --- M10a: workItemId projection (L72) ---
test("M10a a post linked to a work item carries workItemId", () => {
  const s = post(baseState(), "m10a-post", { body: "b", workItemId: "work-vertical-slice" });
  assert.equal(lastMsg(s, "m10a-post").workItemId, "work-vertical-slice");
});

// --- M10b: replyToId projection (L73) ---
test("M10b a reply post carries replyToId", () => {
  let s = post(baseState(), "m10b-root", { messageId: "m10b-root", body: "root" });
  s = post(s, "m10b-reply", { messageId: "m10b-reply", body: "reply", replyToId: "m10b-root" });
  assert.equal(lastMsg(s, "m10b-reply").replyToId, "m10b-root");
});

// --- M10d: receipt-card optional fields (L89-90) ---
test("M10d a receipt card projects pullRequestUrl and cost when carried", () => {
  const s = card(baseState(), "m10d-card", { pullRequestUrl: "https://example.com/pr/9", cost: { spentCents: 3, capCents: 4, model: "m" } });
  const m = lastMsg(s, "m10d-card");
  assert.equal(m.pullRequestUrl, "https://example.com/pr/9");
  assert.deepEqual(m.cost, { spentCents: 3, capCents: 4, model: "m" });
});

// --- M10f: redacted marker on posted message (L70) ---
test("M10f a redacted-replay post carries redacted:true in the projection", () => {
  const s = post(baseState(), "m10f-post", { messageId: "m10f-post", redacted: true });
  assert.equal(lastMsg(s, "m10f-post").redacted, true);
});

// --- M11: also-send-to-channel copy (L100-103) ---
test("M11 a public thread reply with alsoSendToChannel lands exactly one channel copy; a DM reply lands none", () => {
  let s = post(baseState(), "m11-root", { messageId: "m11-root", body: "root" });
  s = post(s, "m11-reply", { messageId: "m11-reply", body: "reply", replyToId: "m11-root", alsoSendToChannel: true });
  const copy = lastMsg(s, "m11-reply:channel");
  assert.ok(copy, "channel copy exists");
  assert.equal(copy.replyToId, null);
  assert.equal(copy.body, "reply");
  let s2 = post(baseState(), "m11-dmroot", { messageId: "m11-dmroot", body: "root", toMemberId: "maya" }, "potter");
  s2 = post(s2, "m11-dmreply", { messageId: "m11-dmreply", body: "dm reply", replyToId: "m11-dmroot", toMemberId: "maya", alsoSendToChannel: true });
  assert.equal(lastMsg(s2, "m11-dmreply:channel"), undefined);
});

// --- E1 (key-order leg only): stableStringify object branch (events.js L1683) ---
test("E1 re-applying an event whose array-carried object keys are reordered is idempotent, not a conflict", () => {
  const first = fixedEvent("e1-event", EVENT_TYPES.MESSAGE_POSTED, "potter", {
    messageId: "e1-msg", body: "b", actions: [{ claimId: "c1", label: "L" }],
  });
  const reordered = fixedEvent("e1-event", EVENT_TYPES.MESSAGE_POSTED, "potter", {
    messageId: "e1-msg", body: "b", actions: [{ label: "L", claimId: "c1" }],
  });
  const s1 = post(baseState(), "e1-event", first.data);
  const s2 = applyEvent(s1, reordered);
  assert.equal(s2.messages.filter((m) => m.id === "e1-msg").length, 1);
});
