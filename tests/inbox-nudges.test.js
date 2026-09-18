// LANE B: follow-up nudge detection tests (fixture-driven).
import test from "node:test";
import assert from "node:assert/strict";
import {
  nudgeForThread, scanThreads, createNudgeTracker, NudgeError,
  DEFAULT_FOLLOWUP_THRESHOLD_MS,
} from "../server/inbox-nudges.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof NudgeError && error.code === code);

const NOW = 1_750_000_000_000;
const H = 3600_000;
const thread = (id, messages) => ({ id, messages });
const msg = (direction, hoursAgo, sender = "them") => ({ direction, sentAt: NOW - hoursAgo * H, sender });

test("nudges when my last message went unanswered past the threshold", () => {
  const nudge = nudgeForThread(
    thread("t1", [msg("in", 100), msg("out", 72, "me")]),
    { now: NOW }
  );
  assert.ok(nudge);
  assert.equal(nudge.threadId, "t1");
  assert.equal(nudge.kind, "awaiting_reply");
  assert.equal(nudge.urgency, "normal");
  assert.equal(nudge.vip, false);
  assert.ok(nudge.overdueRatio >= 1);
  assert.ok(Object.isFrozen(nudge));
});

test("no nudge when the last message is inbound (they wait on me)", () => {
  assert.equal(nudgeForThread(thread("t2", [msg("out", 100, "me"), msg("in", 72)]), { now: NOW }), null);
});

test("no nudge when my last message is still fresh", () => {
  assert.equal(nudgeForThread(thread("t3", [msg("in", 50), msg("out", 24, "me")]), { now: NOW }), null);
});

test("high urgency when overdue by 2x the threshold", () => {
  const threshold = DEFAULT_FOLLOWUP_THRESHOLD_MS;
  const nudge = nudgeForThread(
    thread("t4", [msg("out", (threshold * 2.5) / H, "me")]),
    { now: NOW }
  );
  assert.equal(nudge.urgency, "high");
});

test("VIP senders get the shorter VIP threshold", () => {
  const vip = new Set(["boss"]);
  // 30h is under the 48h default threshold but over the 24h VIP threshold.
  const nudge = nudgeForThread(
    thread("t5", [msg("out", 30, "boss")]),
    { now: NOW, vipSenders: vip }
  );
  assert.ok(nudge);
  assert.equal(nudge.vip, true);
  assert.equal(nudge.thresholdMs, 24 * H);
  // Same thread, non-VIP: no nudge.
  assert.equal(nudgeForThread(thread("t5", [msg("out", 30, "boss")]), { now: NOW }), null);
});

test("custom threshold and plain-list vipSenders", () => {
  const nudge = nudgeForThread(
    thread("t6", [msg("out", 10, "me")]),
    { now: NOW, followUpThresholdMs: 5 * H, vipSenders: ["me"] }
  );
  assert.ok(nudge);
  assert.equal(nudge.thresholdMs, 5 * H);
});

test("scanThreads sorts most-overdue first", () => {
  const threads = [
    thread("fresh", [msg("out", 60, "me")]),
    thread("stale", [msg("out", 200, "me")]),
    thread("inbound", [msg("in", 200)]),
  ];
  const nudges = scanThreads(threads, { now: NOW });
  assert.deepEqual(nudges.map(n => n.threadId), ["stale", "fresh"]);
  assert.ok(Object.isFrozen(nudges));
});

test("scanThreads validation", () => {
  throwsCode(() => scanThreads("nope", { now: NOW }), "NUDGE_INVALID_INPUT");
  throwsCode(() => nudgeForThread(thread("t", []), { now: NOW }), "NUDGE_INVALID_INPUT");
  throwsCode(() => nudgeForThread(thread("t", [{ direction: "sideways", sentAt: NOW }]), { now: NOW }), "NUDGE_INVALID_INPUT");
  throwsCode(() => nudgeForThread(thread("t", [msg("out", 100, "me")]), {}), "NUDGE_INVALID_INPUT");
});

test("tracker: dismiss quiets a thread until new activity", () => {
  const tracker = createNudgeTracker({ clock: () => NOW });
  const threads = [thread("t7", [msg("in", 200), msg("out", 100, "me")])];
  assert.equal(tracker.scan(threads).length, 1);
  const nudge = tracker.scan(threads)[0];
  tracker.dismiss(nudge.threadId, nudge.lastMessageAt);
  assert.deepEqual(tracker.dismissedIds(), ["t7"]);
  assert.equal(tracker.scan(threads).length, 0);
  // Newer message on the thread re-arms the nudge.
  const updated = [thread("t7", [msg("in", 200), msg("out", 100, "me"), { direction: "in", sentAt: NOW - 90 * H, sender: "them" }, { direction: "out", sentAt: NOW - 80 * H, sender: "me" }])];
  assert.equal(tracker.scan(updated).length, 1);
  // undismiss re-arms even without new activity.
  assert.equal(tracker.undismiss("t7"), true);
  assert.equal(tracker.scan(threads).length, 1);
  assert.equal(tracker.undismiss("t7"), false);
});

test("tracker dismiss validation", () => {
  const tracker = createNudgeTracker({ clock: () => NOW });
  throwsCode(() => tracker.dismiss("", NOW), "NUDGE_INVALID_INPUT");
  throwsCode(() => tracker.dismiss("t", "soon"), "NUDGE_INVALID_INPUT");
});
