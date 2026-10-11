// Fail-first repro for the read-horizon "New messages" unread marker.
// Scenario: messages are posted while a member is away; on return the marker
// must land on the first unread message, stay visible, and clear only when read.
//
// The marker logic is pure: horizonAnchorFor() picks the anchor message and
// the client widens the timeline window so the anchor is never windowed out
// of view (windowLimitForHorizonAnchor). These tests fail until the client
// actually uses that placement (see src/app.js renderMessages).
import test from "node:test";
import assert from "node:assert/strict";
import {
  TIMELINE_WINDOW,
  horizonAnchorFor,
  windowLimitForHorizonAnchor,
  windowTimeline,
} from "../src/conversation.js";

const makeMessages = (n) => Array.from({ length: n }, (_, i) => ({ id: `m${i}` }));

test("marker lands on the first message after the persisted horizon", () => {
  const messages = makeMessages(10);
  assert.equal(horizonAnchorFor(messages, "m3"), "m4");
});

test("marker on wrong message: anchor is the message AFTER the horizon, not the horizon itself", () => {
  const messages = makeMessages(10);
  const anchor = horizonAnchorFor(messages, "m3");
  assert.notEqual(anchor, "m3");
  assert.equal(anchor, "m4");
});

test("marker clears after read: horizon at the newest message means no divider", () => {
  const messages = makeMessages(10);
  assert.equal(horizonAnchorFor(messages, "m9"), null);
});

test("no horizon yet: divider rides on the first message", () => {
  const messages = makeMessages(10);
  assert.equal(horizonAnchorFor(messages, null), "m0");
  assert.equal(horizonAnchorFor(messages, undefined), "m0");
});

test("horizon message gone (deleted / not in this view): no anchor, no phantom marker", () => {
  const messages = makeMessages(10);
  assert.equal(horizonAnchorFor(messages, "no-such-message"), null);
});

test("marker lost repro: anchor windowed out of the timeline gets a widened window", () => {
  // 250 messages arrive while the member is away; horizon sits at m5, so the
  // first unread message (the anchor) is m6 — older than the 200-row window.
  const messages = makeMessages(250);
  const anchor = horizonAnchorFor(messages, "m5");
  assert.equal(anchor, "m6");

  // The old behavior: plain windowTimeline(200) drops the anchor, so the
  // "New messages" divider never renders — the marker is lost.
  const oldShown = windowTimeline(messages, TIMELINE_WINDOW).messages;
  assert.ok(!oldShown.some((m) => m.id === anchor), "old path drops the anchor");

  // The fix: widen the window so the anchor renders.
  const limit = windowLimitForHorizonAnchor(messages, anchor, TIMELINE_WINDOW);
  assert.ok(limit > TIMELINE_WINDOW, "window widens to include the anchor");
  const shown = windowTimeline(messages, limit).messages;
  assert.ok(shown.some((m) => m.id === anchor), "anchor is rendered after widening");
});

test("marker not lost when the anchor is already inside the window", () => {
  const messages = makeMessages(250);
  const anchor = horizonAnchorFor(messages, "m240");
  assert.equal(anchor, "m241");
  assert.equal(windowLimitForHorizonAnchor(messages, anchor, TIMELINE_WINDOW), TIMELINE_WINDOW);
  const shown = windowTimeline(messages, TIMELINE_WINDOW).messages;
  assert.ok(shown.some((m) => m.id === anchor));
});

test("unknown anchor id leaves the window alone", () => {
  const messages = makeMessages(250);
  assert.equal(windowLimitForHorizonAnchor(messages, "no-such", TIMELINE_WINDOW), TIMELINE_WINDOW);
  assert.equal(windowLimitForHorizonAnchor(messages, null, TIMELINE_WINDOW), TIMELINE_WINDOW);
});

test("marker survives across sessions: same persisted horizon anchors the same message", () => {
  const messages = makeMessages(250);
  const persisted = "m5"; // what GET /read-horizon returned last session
  const firstSession = horizonAnchorFor(messages, persisted);
  const secondSession = horizonAnchorFor(messages, persisted); // fresh client, same input
  assert.equal(firstSession, "m6");
  assert.equal(secondSession, firstSession);
});
