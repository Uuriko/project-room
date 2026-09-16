// K008: decision voting. Pure voting tests. (The store-backed decision
// record flow from backlog F2 lives in tests/decision-register.test.js;
// this file covers the separate voting module.)
import test from "node:test";
import assert from "node:assert/strict";
import { createDecisions, DecisionError } from "../server/decision-voting.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof DecisionError && error.code === code);

test("propose, vote, change vote, close with tally", () => {
  const decisions = createDecisions();
  decisions.propose({ decisionId: "d1", question: "Ship it?", options: ["yes", "no"], proposedBy: "quill" });
  decisions.vote("d1", { agentId: "quill", option: "yes" });
  decisions.vote("d1", { agentId: "grok", option: "no" });
  decisions.vote("d1", { agentId: "quill", option: "no" }); // changed vote
  const closed = decisions.close("d1");
  assert.equal(closed.state, "closed");
  assert.deepEqual(closed.outcome.tally, { yes: 0, no: 2 });
  assert.equal(closed.outcome.winner, "no");
  assert.equal(closed.outcome.votesCast, 2);
  assert.ok(Object.isFrozen(closed) && Object.isFrozen(closed.outcome));
});
test("ties resolve deterministically to the earliest option", () => {
  const decisions = createDecisions();
  decisions.propose({ decisionId: "d2", question: "Pick", options: ["a", "b"], proposedBy: "x" });
  decisions.vote("d2", { agentId: "p", option: "b" });
  decisions.vote("d2", { agentId: "q", option: "a" });
  assert.equal(decisions.close("d2").outcome.winner, "a");
});
test("malformed inputs are refused", () => {
  const decisions = createDecisions();
  throwsCode(() => decisions.propose({ decisionId: "d", question: "q", options: ["only"], proposedBy: "x" }),
    "invalid_decision");
  decisions.propose({ decisionId: "d3", question: "q", options: ["a", "b"], proposedBy: "x" });
  throwsCode(() => decisions.vote("d3", { agentId: "p", option: "c" }), "invalid_decision");
  decisions.close("d3");
  throwsCode(() => decisions.vote("d3", { agentId: "p", option: "a" }), "invalid_decision");
});
