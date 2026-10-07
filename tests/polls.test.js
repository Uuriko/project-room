// tests/polls.test.js — Poll message type + vote aggregation over the
// existing reaction plumbing. A poll is a message with kind "poll" carrying a
// poll payload (question + labeled options, each assigned a vote emoji by the
// server). Votes are ordinary message.reaction_set events on the option emoji;
// the reducer enforces one vote per member on single-choice polls, and
// pollTally aggregates the visible votes. Record-shaped and additive: no new
// event types, no new tables.
import test from "node:test";
import assert from "node:assert/strict";
import { EVENT_TYPES as T, applyEvent, replay } from "../src/events.js";
import { seedEvents } from "../src/seed.js";
import { pollTally, POLL_MAX_OPTIONS, POLL_MIN_OPTIONS } from "../src/polls.js";

const at = "2026-10-06T22:30:00.000Z";
const fixed = (id, type, actorId, data) => ({ id, idempotencyKey: `key-${id}`, roomId: "room-project-room-v0", type, actorId, at, causationId: null, data });

function twoMembers() {
  let state = replay(seedEvents);
  state = applyEvent(state, fixed("add-pva", T.MEMBER_ADDED, "potter", { memberId: "pv-a", displayName: "PV A", kind: "agent", permissions: ["accept_work", "complete_work", "write_external"] }));
  state = applyEvent(state, fixed("add-pvb", T.MEMBER_ADDED, "potter", { memberId: "pv-b", displayName: "PV B", kind: "agent", permissions: ["accept_work", "complete_work", "write_external"] }));
  return state;
}

const postPoll = (state, id, actor, poll, extra = {}) => applyEvent(state, fixed(id, T.MESSAGE_POSTED, actor, {
  messageId: id, body: "poll body", kind: "poll", poll, ...extra
}));
const vote = (state, id, actor, messageId, reaction, active = true) => applyEvent(state, fixed(id, T.MESSAGE_REACTION_SET, actor, { messageId, reaction, active }));
const pollOf = state => state.messages.find(m => m.id === "poll-1");

const POLL = { question: "Which option?", options: ["alpha", "beta", "gamma"] };

test("a poll message records the question and option emojis", () => {
  const state = postPoll(twoMembers(), "poll-1", "pv-a", POLL);
  const message = pollOf(state);
  assert.equal(message.kind, "poll");
  assert.equal(message.poll.question, "Which option?");
  assert.equal(message.poll.options.length, 3);
  assert.deepEqual(message.poll.options.map(o => o.label), ["alpha", "beta", "gamma"]);
  const emojis = message.poll.options.map(o => o.emoji);
  assert.equal(new Set(emojis).size, 3, "each option gets a distinct vote emoji");
  for (const emoji of emojis) assert.ok(typeof emoji === "string" && emoji.length > 0);
});

test("poll validation rejects bad payloads", () => {
  const base = twoMembers();
  const bad = [
    ["no poll payload", undefined, "poll payload"],
    ["missing question", { options: ["a", "b"] }, "question"],
    ["blank question", { question: "  ", options: ["a", "b"] }, "question"],
    ["too few options", { question: "q", options: ["a"] }, "options"],
    ["too many options", { question: "q", options: Array.from({ length: POLL_MAX_OPTIONS + 1 }, (_, i) => `o${i}`) }, "options"],
    ["blank label", { question: "q", options: ["a", "  "] }, "label"],
    ["non-string label", { question: "q", options: ["a", 3] }, "label"],
    ["duplicate labels", { question: "q", options: ["a", "a"] }, "duplicate"],
  ];
  for (const [name, poll, fragment] of bad) {
    assert.throws(() => postPoll(base, `bad-${name.replace(/\s+/g, "-")}`, "pv-a", poll), new RegExp(fragment), name);
  }
  // minimum boundary: exactly POLL_MIN_OPTIONS passes
  const ok = postPoll(base, "poll-1", "pv-a", { question: "q", options: Array.from({ length: POLL_MIN_OPTIONS }, (_, i) => `o${i}`) });
  assert.equal(ok.messages.find(m => m.id === "poll-1").poll.options.length, POLL_MIN_OPTIONS);
});

test("unknown message kinds are still rejected", () => {
  const base = twoMembers();
  assert.throws(() => applyEvent(base, fixed("poll-x", T.MESSAGE_POSTED, "pv-a", { messageId: "poll-x", body: "x", kind: "quiz" })), /kind/);
});

test("votes aggregate by option", () => {
  let state = postPoll(twoMembers(), "poll-1", "pv-a", POLL);
  const [e1, e2] = pollOf(state).poll.options.map(o => o.emoji);
  state = vote(state, "v1", "pv-a", "poll-1", e1);
  state = vote(state, "v2", "pv-b", "poll-1", e1);
  state = vote(state, "v3", "potter", "poll-1", e2);
  const tally = pollTally(pollOf(state));
  assert.deepEqual(tally.results.map(r => ({ label: r.label, votes: r.votes })), [
    { label: "alpha", votes: 2 },
    { label: "beta", votes: 1 },
    { label: "gamma", votes: 0 },
  ]);
  assert.equal(tally.total, 3);
  assert.deepEqual(tally.results[0].voters, ["pv-a", "pv-b"]);
});

test("single-choice polls move the vote, not stack it", () => {
  let state = postPoll(twoMembers(), "poll-1", "pv-a", POLL);
  const [e1, e2] = pollOf(state).poll.options.map(o => o.emoji);
  state = vote(state, "v1", "pv-a", "poll-1", e1);
  state = vote(state, "v2", "pv-a", "poll-1", e2);
  const tally = pollTally(pollOf(state));
  assert.equal(tally.results[0].votes, 0);
  assert.equal(tally.results[1].votes, 1);
  assert.equal(tally.total, 1);
});

test("allowMultiple polls keep every vote", () => {
  let state = postPoll(twoMembers(), "poll-1", "pv-a", { ...POLL, allowMultiple: true });
  const [e1, e2] = pollOf(state).poll.options.map(o => o.emoji);
  state = vote(state, "v1", "pv-a", "poll-1", e1);
  state = vote(state, "v2", "pv-a", "poll-1", e2);
  const tally = pollTally(pollOf(state));
  assert.equal(tally.results[0].votes, 1);
  assert.equal(tally.results[1].votes, 1);
  assert.equal(tally.total, 2);
});

test("unvoting clears a vote", () => {
  let state = postPoll(twoMembers(), "poll-1", "pv-a", POLL);
  const [e1] = pollOf(state).poll.options.map(o => o.emoji);
  state = vote(state, "v1", "pv-a", "poll-1", e1);
  state = vote(state, "v2", "pv-a", "poll-1", e1, false);
  const tally = pollTally(pollOf(state));
  assert.equal(tally.results[0].votes, 0);
  assert.equal(tally.total, 0);
});

test("non-option reactions do not touch the tally", () => {
  let state = postPoll(twoMembers(), "poll-1", "pv-a", POLL);
  const [e1] = pollOf(state).poll.options.map(o => o.emoji);
  state = vote(state, "v1", "pv-a", "poll-1", e1);
  state = vote(state, "v2", "pv-b", "poll-1", "👍");
  const tally = pollTally(pollOf(state));
  assert.equal(tally.results[0].votes, 1);
  assert.equal(tally.total, 1);
  // the thumbs-up still lands on the message as an ordinary reaction
  assert.deepEqual(pollOf(state).reactions["👍"], ["pv-b"]);
});

test("pollTally is null for non-poll messages", () => {
  let state = replay(seedEvents);
  state = applyEvent(state, fixed("m1", T.MESSAGE_POSTED, "potter", { messageId: "m1", body: "hello" }));
  assert.equal(pollTally(state.messages.find(m => m.id === "m1")), null);
  assert.equal(pollTally(undefined), null);
});

test("polls replay deterministically", () => {
  const run = () => {
    let state = postPoll(twoMembers(), "poll-1", "pv-a", POLL);
    const [e1, e2] = pollOf(state).poll.options.map(o => o.emoji);
    state = vote(state, "v1", "pv-a", "poll-1", e1);
    state = vote(state, "v2", "pv-b", "poll-1", e2);
    return pollTally(pollOf(state));
  };
  assert.deepEqual(run(), run());
});
