// Two-trigger notification discipline (herdr redesign, lane B8).
//
// Fail-first contract tests for the wiring. The trigger predicate itself is
// owned by lane B19 (server/notify-classifier.mjs, `shouldNotify(event,
// prefs)`); these tests pin the WIRING: flag-off legacy behavior is
// bit-for-bit, flag-on routes on the injected predicate's verdict, and the
// predicate is consumed with exactly the (event, prefs) signature.
//
// Test-audit gate: (1) each test protects a wiring contract no existing
// suite owns — the flag-gated two-trigger paths; (2) credible regression:
// a dropped flag check silently downgrades every new member to
// interrupt-only, or the push gate fires on ambient items (the per-arrival
// ping bankruptcy this discipline exists to kill); (3) existing suites
// (notification-feed, notify-preferences, attention, mention-lifecycle,
// push-subscriptions) pin legacy behavior only; (4) the `twoTrigger` flag
// and injected `shouldNotify` are production integration points
// (coordinator-directed; B19 builds in parallel), not test-only seams.
import test from "node:test";
import assert from "node:assert/strict";
import { createNotifyPrefs, INTERRUPT_LEVEL } from "../server/notify-prefs.mjs";
import { interruptDelivery, heldUntil } from "../server/attention.mjs";
import { mentionInterruptGate } from "../server/mention-lifecycle.mjs";
import { twoTriggerPushGate, classifyTwoTrigger } from "../server/notifications.mjs";

// ---------------------------------------------------------------------------
// notify-prefs: interrupt level, flag-gated
// ---------------------------------------------------------------------------

test("flag off: interrupt level is rejected and the default stays mentions", () => {
  const prefs = createNotifyPrefs(); // twoTrigger defaults to false
  assert.throws(() => prefs.setGlobal("ada", { level: "interrupt" }), /level must be one of/);
  assert.equal(prefs.resolve("new-member", { roomId: "r1" }), "mentions");
  assert.ok(!prefs.LEVELS.includes("interrupt"));
});

test("flag on: interrupt level is accepted at every scope", () => {
  const prefs = createNotifyPrefs({ twoTrigger: true });
  assert.equal(prefs.setGlobal("ada", { level: "interrupt" }).level, "interrupt");
  assert.equal(prefs.setRoom("ada", { roomId: "r1", level: "interrupt" }).level, "interrupt");
  assert.equal(prefs.setThread("ada", { threadId: "t1", level: "interrupt" }).level, "interrupt");
  assert.ok(prefs.LEVELS.includes("interrupt"));
  assert.equal(INTERRUPT_LEVEL, "interrupt");
});

test("flag on: new members default to interrupt-only; stored prefs are kept", () => {
  const prefs = createNotifyPrefs({ twoTrigger: true });
  assert.equal(prefs.resolve("brand-new", { roomId: "r1" }), "interrupt");
  prefs.setGlobal("existing", { level: "mentions" });
  assert.equal(prefs.resolve("existing", { roomId: "r1" }), "mentions"); // no silent downgrade
  prefs.setRoom("existing", { roomId: "r1", level: "all" });
  assert.equal(prefs.resolve("existing", { roomId: "r1" }), "all");
});

// ---------------------------------------------------------------------------
// attention: interrupt-class delivery arithmetic
// ---------------------------------------------------------------------------

const quietPrefs = { quietStart: 22 * 60, quietEnd: 7 * 60, delivery: "immediate", digestHour: null };
// 2026-10-06T12:00:00Z is 12:00 UTC (outside 22:00-07:00); 23:30 UTC is inside.
const NOON = Date.UTC(2026, 9, 6, 12, 0, 0);
const NIGHT = Date.UTC(2026, 9, 6, 23, 30, 0);

test("interruptDelivery: no prefs means deliver, not silent", () => {
  assert.deepEqual(interruptDelivery(null, NOON), { decision: "deliver", silent: false, heldUntil: null });
});

test("interruptDelivery: outside quiet hours delivers normally", () => {
  assert.deepEqual(interruptDelivery(quietPrefs, NOON), { decision: "deliver", silent: false, heldUntil: null });
});

test("interruptDelivery: inside quiet hours delivers silently, never held", () => {
  assert.deepEqual(interruptDelivery(quietPrefs, NIGHT), { decision: "deliver", silent: true, heldUntil: null });
});

test("interruptDelivery never changes the legacy heldUntil arithmetic", () => {
  assert.equal(heldUntil(null, NIGHT), null);
  assert.equal(heldUntil(quietPrefs, NOON), null);
  assert.ok(heldUntil(quietPrefs, NIGHT) > NIGHT); // legacy path still holds non-interrupt wakes
});

// ---------------------------------------------------------------------------
// mention-lifecycle: interrupt suppression / re-arm off lifecycle transitions
// ---------------------------------------------------------------------------

test("mentionInterruptGate: responded never re-fires", () => {
  assert.deepEqual(mentionInterruptGate({ state: "responded" }),
    { fire: false, reason: "mention already responded" });
  assert.deepEqual(mentionInterruptGate({ state: "responded", explicitReRequest: true }),
    { fire: false, reason: "mention already responded" });
});

test("mentionInterruptGate: delivered/acknowledged fire once, then collapse", () => {
  const first = mentionInterruptGate({ state: "delivered", withinDedupeWindow: false });
  assert.equal(first.fire, true);
  assert.deepEqual(mentionInterruptGate({ state: "delivered", withinDedupeWindow: true }),
    { fire: false, reason: "collapsed into the pending interrupt (dedupe window)" });
  assert.equal(mentionInterruptGate({ state: "acknowledged", withinDedupeWindow: false }).fire, true);
});

test("mentionInterruptGate: only a fresh explicit request re-arms after timeout", () => {
  assert.deepEqual(mentionInterruptGate({ state: "timed_out", explicitReRequest: false }),
    { fire: false, reason: "timed out without a fresh explicit request" });
  const rearmed = mentionInterruptGate({ state: "timed_out", explicitReRequest: true });
  assert.equal(rearmed.fire, true);
});

test("mentionInterruptGate: unknown state throws", () => {
  assert.throws(() => mentionInterruptGate({ state: "vaporized" }), /unknown mention state/);
});

// ---------------------------------------------------------------------------
// notifications: the two-trigger push gate (lives here, not in the delivery-half modules)
// ---------------------------------------------------------------------------

test("twoTriggerPushGate: flag off keeps the legacy permissive gate", () => {
  assert.deepEqual(twoTriggerPushGate({ notification: { class: "ambient" } }),
    { push: true, reason: "two-trigger discipline off: legacy push path unchanged" });
});

test("twoTriggerPushGate: flag on pushes interrupt-class only", () => {
  assert.deepEqual(twoTriggerPushGate({ notification: { class: "interrupt" }, twoTrigger: true }),
    { push: true, reason: "interrupt-class notification" });
  assert.deepEqual(twoTriggerPushGate({ notification: { class: "ambient" }, twoTrigger: true }),
    { push: false, reason: "ambient under the two-trigger discipline: no push" });
});

test("twoTriggerPushGate: flag on fail-closes when the class is missing", () => {
  assert.equal(twoTriggerPushGate({ notification: {}, twoTrigger: true }).push, false);
  assert.equal(twoTriggerPushGate({ notification: null, twoTrigger: true }).push, false);
});

// ---------------------------------------------------------------------------
// notifications: consumption seam for B19's shouldNotify(event, prefs)
// ---------------------------------------------------------------------------

const item = Object.freeze({ kind: "mention", messageId: "m1", sequence: 42 });
const event = Object.freeze({ type: "message.posted", data: { messageId: "m1" } });
const prefs = Object.freeze({ memberId: "ada" });

test("classifyTwoTrigger: flag off returns the item untouched (bit-for-bit)", () => {
  const seen = [];
  const classifier = (e, p) => { seen.push([e, p]); return true; };
  const out = classifyTwoTrigger({ item, event, prefs, shouldNotify: classifier });
  assert.equal(out, item); // same reference, no annotation
  assert.equal(seen.length, 0); // the predicate is never consulted when off
});

test("classifyTwoTrigger: flag on stamps the class from the predicate verdict", () => {
  const seen = [];
  const yes = (e, p) => { seen.push([e, p]); return true; };
  const out = classifyTwoTrigger({ item, event, prefs, shouldNotify: yes, twoTrigger: true });
  assert.equal(out.class, "interrupt");
  assert.equal(out.kind, "mention"); // the rest of the item is preserved
  assert.deepEqual(seen, [[event, prefs]]); // consumed with exactly (event, prefs)

  const no = () => false;
  assert.equal(classifyTwoTrigger({ item, event, prefs, shouldNotify: no, twoTrigger: true }).class, "ambient");
});

test("classifyTwoTrigger: flag on without a classifier fail-closes to ambient", () => {
  const out = classifyTwoTrigger({ item, event, prefs, twoTrigger: true });
  assert.equal(out.class, "ambient"); // no interrupt is ever assumed
  assert.ok(Object.isFrozen(out));
});
