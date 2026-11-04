import test from "node:test";
import assert from "node:assert/strict";
import { deriveRequestState, withRequestState, requestStatesEnabled, ACK_WINDOW_MS, STALE_AFTER_MS } from "../server/request-states.mjs";

const t0 = Date.parse("2026-11-04T20:00:00.000Z");
const at = ms => new Date(t0 + ms).toISOString();
const open = extra => ({ status: "open", createdAt: at(0), ...extra });

test("flag is off by default and only '1' turns it on", () => {
  assert.equal(requestStatesEnabled({}), false);
  assert.equal(requestStatesEnabled({ ROOM_REQUEST_STATES: "true" }), false);
  assert.equal(requestStatesEnabled({ ROOM_REQUEST_STATES: "1" }), true);
});

test("withRequestState leaves the compact shape untouched when the flag is off", () => {
  const compact = { id: "r1", status: "open" };
  assert.deepEqual(withRequestState(compact, open(), { env: {} }), compact);
  const on = withRequestState(compact, open(), { env: { ROOM_REQUEST_STATES: "1" }, now: t0 + 1000 });
  assert.equal(on.lifecycle.state, "pending");
  assert.equal(on.id, "r1");
});

test("pending within the ack window, unresponsive after it", () => {
  assert.deepEqual(deriveRequestState(open(), { now: t0 + ACK_WINDOW_MS }), { state: "pending", unresponsive: false, since: at(0) });
  assert.equal(deriveRequestState(open(), { now: t0 + ACK_WINDOW_MS + 1 }).unresponsive, true);
});

test("acknowledged requests are active and never unresponsive", () => {
  const s = deriveRequestState(open({ acknowledgedAt: at(3000) }), { now: t0 + 60_000 });
  assert.equal(s.state, "active");
  assert.equal(s.unresponsive, false);
});

test("needs_input and error: the latest signal wins", () => {
  assert.equal(deriveRequestState(open({ acknowledgedAt: at(1), needsInputAt: at(5) }), { now: t0 + 10 }).state, "needs_input");
  assert.equal(deriveRequestState(open({ acknowledgedAt: at(1), errorAt: at(5) }), { now: t0 + 10 }).state, "error");
  assert.equal(deriveRequestState(open({ errorAt: at(5), needsInputAt: at(9) }), { now: t0 + 10 }).state, "needs_input");
  assert.equal(deriveRequestState(open({ needsInputAt: at(5), errorAt: at(9) }), { now: t0 + 10 }).state, "error");
});

test("terminal statuses are complete with their outcome", () => {
  for (const status of ["answered", "declined", "cancelled"]) {
    const s = deriveRequestState({ status, createdAt: at(0), closedAt: at(50) }, { now: t0 + STALE_AFTER_MS * 2 });
    assert.deepEqual(s, { state: "complete", outcome: status, unresponsive: false, since: at(50) });
  }
});

test("open requests with no activity for a day are stale", () => {
  assert.equal(deriveRequestState(open({ acknowledgedAt: at(1) }), { now: t0 + STALE_AFTER_MS + 2 }).state, "stale");
  assert.equal(deriveRequestState(open({ acknowledgedAt: at(1), lastActivityAt: at(STALE_AFTER_MS) }), { now: t0 + STALE_AFTER_MS + 2 }).state, "active");
  assert.equal(deriveRequestState(open({ needsInputAt: at(1) }), { now: t0 + STALE_AFTER_MS * 3 }).state, "needs_input");
});

test("missing or bad createdAt degrades to pending", () => {
  assert.equal(deriveRequestState(null).state, "pending");
  assert.equal(deriveRequestState({ status: "open", createdAt: "nope" }).state, "pending");
});

test("the recipient's first post in the conversation records acknowledgedAt once", async () => {
  const { recordReplyPost } = await import("../src/reply-requests.js");
  const state = { messages: [], replyRequests: {}, members: {} };
  recordReplyPost(state, { id: "e1", actorId: "a", at: at(0), data: { messageId: "m1", toMemberId: "b", workItemId: null } }, "open");
  state.messages.push({ id: "m1", replyToId: null, workItemId: null });
  const post = (id, actorId, ms) => {
    state.messages.push({ id, replyToId: "m1", workItemId: null });
    recordReplyPost(state, { id: `e-${id}`, actorId, at: at(ms), data: { messageId: id, replyToId: "m1" } }, null);
  };
  post("m2", "a", 2000);
  assert.equal(state.replyRequests.m1.acknowledgedAt, undefined);
  post("m3", "b", 4000);
  post("m4", "b", 9000);
  assert.equal(state.replyRequests.m1.acknowledgedAt, at(4000));
  const s = deriveRequestState(state.replyRequests.m1, { now: t0 + 60_000 });
  assert.deepEqual([s.state, s.unresponsive], ["active", false]);
});
