// K009: polls inside rooms. Pure poll tests.
import test from "node:test";
import assert from "node:assert/strict";
import { createPolls, PollError } from "../server/polls.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof PollError && error.code === code);

test("create/vote/tally/close lifecycle", () => {
  const polls = createPolls();
  const poll = polls.create({ question: "Ship Friday?", options: ["Yes", "No"], createdBy: "ada" });
  assert.ok(poll.pollId.startsWith("poll-"));
  assert.ok(Object.isFrozen(poll));
  polls.vote(poll.pollId, { voterId: "ada", optionIndex: 0 });
  polls.vote(poll.pollId, { voterId: "bob", optionIndex: 1 });
  polls.vote(poll.pollId, { voterId: "ada", optionIndex: 1 }); // change vote
  const result = polls.tally(poll.pollId);
  assert.deepEqual(result.counts, [0, 2]);
  assert.equal(result.totalVotes, 2);
  const closed = polls.close(poll.pollId);
  assert.equal(closed.closed, true);
  throwsCode(() => polls.vote(poll.pollId, { voterId: "x", optionIndex: 0 }), "invalid_poll");
});
test("malformed inputs are refused", () => {
  const polls = createPolls();
  throwsCode(() => polls.create({ question: "", options: ["a", "b"], createdBy: "x" }), "invalid_poll");
  throwsCode(() => polls.create({ question: "q", options: ["only"], createdBy: "x" }), "invalid_poll");
  throwsCode(() => polls.vote("ghost", { voterId: "x", optionIndex: 0 }), "invalid_poll");
});
