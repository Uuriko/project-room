// tests/poll-close.test.js — Polls can be closed: after close, no more votes.
//
// Contract: `message.poll_closed` closes an open poll. Only the poll author or
// a member with the steer permission may close. Closing a non-poll, an
// already-closed poll, or a deleted poll is rejected; votes on a closed poll
// are rejected. The reducer stays deterministic under replay.
import test from "node:test";
import assert from "node:assert/strict";
import { EVENT_TYPES as T, applyEvent, replay } from "../src/events.js";
import { seedEvents } from "../src/seed.js";
import { POLL_OPTION_EMOJIS } from "../src/polls.js";

const at = "2026-10-07T05:00:00.000Z";
const fixed = (id, type, actorId, data) => ({ id, idempotencyKey: `key-${id}`, roomId: "room-project-room-v0", type, actorId, at, causationId: null, data });

function members() {
  let state = replay(seedEvents);
  // potter is the room owner in the seed; add an agent author and a steerer.
  state = applyEvent(state, fixed("add-pva", T.MEMBER_ADDED, "potter", { memberId: "pv-a", displayName: "PV A", kind: "agent", permissions: ["accept_work", "complete_work", "write_external"] }));
  state = applyEvent(state, fixed("add-pvb", T.MEMBER_ADDED, "potter", { memberId: "pv-b", displayName: "PV B", kind: "agent", permissions: ["accept_work", "complete_work", "write_external"] }));
  state = applyEvent(state, fixed("add-steer", T.MEMBER_ADDED, "potter", { memberId: "pv-s", displayName: "PV Steer", kind: "agent", permissions: ["accept_work", "complete_work", "steer"] }));
  return state;
}

const POLL = { question: "Which option?", options: ["alpha", "beta"] };
const postPoll = (state, id, actor, extra = {}) => applyEvent(state, fixed(id, T.MESSAGE_POSTED, actor, {
  messageId: id, body: "poll body", kind: "poll", poll: POLL, ...extra
}));
const close = (state, id, actor, messageId) => applyEvent(state, fixed(id, T.MESSAGE_POLL_CLOSED, actor, { messageId }));
const vote = (state, id, actor, messageId, reaction) => applyEvent(state, fixed(id, T.MESSAGE_REACTION_SET, actor, { messageId, reaction, active: true }));

test("the poll author can close an open poll", () => {
  let state = postPoll(members(), "poll-1", "pv-a");
  state = close(state, "close-1", "pv-a", "poll-1");
  const poll = state.messages.find(m => m.id === "poll-1").poll;
  assert.ok(typeof poll.closedAt === "string" && poll.closedAt.length > 0, "closedAt stamped");
});

test("a member with steer permission can close someone else's poll", () => {
  let state = postPoll(members(), "poll-1", "pv-a");
  state = close(state, "close-1", "pv-s", "poll-1");
  assert.ok(state.messages.find(m => m.id === "poll-1").poll.closedAt, "steer member closed the poll");
});

test("a member without steer cannot close someone else's poll", () => {
  const state = postPoll(members(), "poll-1", "pv-a");
  assert.throws(() => close(state, "close-1", "pv-b", "poll-1"), /lacks|permission|close/i);
});

test("closing a non-poll message is rejected", () => {
  const state = applyEvent(members(), fixed("m1", T.MESSAGE_POSTED, "pv-a", { messageId: "m1", body: "plain" }));
  assert.throws(() => close(state, "close-1", "pv-a", "m1"), /poll/i);
});

test("closing an already-closed poll is rejected", () => {
  let state = postPoll(members(), "poll-1", "pv-a");
  state = close(state, "close-1", "pv-a", "poll-1");
  // A second close command lands at a later time (a new command, not a replay
  // of the recorded close event) and is rejected.
  const later = { ...fixed("close-2", T.MESSAGE_POLL_CLOSED, "pv-a", { messageId: "poll-1" }), at: "2026-10-07T05:01:00.000Z" };
  assert.throws(() => applyEvent(state, later), /already closed/i);
});

test("closing an unknown message is rejected", () => {
  assert.throws(() => close(members(), "close-1", "pv-a", "nope"), /Room/i);
});

test("votes on a closed poll are rejected", () => {
  let state = postPoll(members(), "poll-1", "pv-a");
  state = close(state, "close-1", "pv-a", "poll-1");
  assert.throws(() => vote(state, "v1", "pv-b", "poll-1", POLL_OPTION_EMOJIS[0]), /closed/i);
});

test("votes before close still count after close", () => {
  let state = postPoll(members(), "poll-1", "pv-a");
  state = vote(state, "v1", "pv-b", "poll-1", POLL_OPTION_EMOJIS[0]);
  state = close(state, "close-1", "pv-a", "poll-1");
  const reactions = state.messages.find(m => m.id === "poll-1").reactions;
  assert.deepEqual(reactions[POLL_OPTION_EMOJIS[0]], ["pv-b"]);
});

test("closing is deterministic under replay", () => {
  let state = postPoll(members(), "poll-1", "pv-a");
  state = close(state, "close-1", "pv-a", "poll-1");
  const once = state.messages.find(m => m.id === "poll-1").poll.closedAt;
  // Re-applying the same close event (duplicate delivery) changes nothing.
  const again = applyEvent(state, fixed("close-1", T.MESSAGE_POLL_CLOSED, "pv-a", { messageId: "poll-1" }));
  assert.equal(again.messages.find(m => m.id === "poll-1").poll.closedAt, once);
});
