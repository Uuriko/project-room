// B005: inbox.triage decision engine. Pure decider tests; nothing is moved.
import test from "node:test";
import assert from "node:assert/strict";
import { triageMessage, triageBatch, TriageError, ACTIONS } from "../server/inbox-triage.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof TriageError && error.code === code);
const msg = (id = "m-1") => ({ id });

test("spam >= 60 quarantines before anything else", () => {
  const decision = triageMessage(msg(), { spamScore: 85,
    matchedRules: [{ ruleId: "r1", actions: [{ type: "file", folder: "news" }] }] });
  assert.equal(decision.action, "quarantine");
  assert.ok(decision.reasons.some(r => r.includes("85")));
  assert.ok(Object.isFrozen(decision) && Object.isFrozen(decision.reasons));
});
test("rule actions win over the inbox default", () => {
  const file = triageMessage(msg(), { matchedRules: [{ ruleId: "news", actions: [{ type: "file", folder: "newsletters" }] }] });
  assert.equal(file.action, "file");
  assert.equal(file.detail, "newsletters");
  const snooze = triageMessage(msg(), { matchedRules: [{ ruleId: "later", actions: [{ type: "snooze", delay: "2h" }] }] });
  assert.equal(snooze.action, "snooze");
  assert.equal(snooze.detail, "2h");
});
test("uncertain spam goes to a human; clean mail goes to the inbox", () => {
  assert.equal(triageMessage(msg(), { spamScore: 45 }).action, "needs_human");
  assert.equal(triageMessage(msg(), { spamScore: 5 }).action, "inbox");
  assert.equal(triageMessage(msg()).action, "inbox");
});
test("triageBatch groups decisions by action", () => {
  const batch = triageBatch([
    { message: msg("m-1"), spamScore: 90 },
    { message: msg("m-2"), matchedRules: [{ ruleId: "r", actions: [{ type: "flag", label: "vip" }] }] },
    { message: msg("m-3") },
  ]);
  assert.equal(batch.decisions.length, 3);
  assert.deepEqual(batch.byAction.quarantine.map(d => d.messageId), ["m-1"]);
  assert.deepEqual(batch.byAction.flag.map(d => d.messageId), ["m-2"]);
  assert.deepEqual(batch.byAction.inbox.map(d => d.messageId), ["m-3"]);
  assert.deepEqual(batch.byAction.snooze, []);
});
test("malformed inputs are refused", () => {
  throwsCode(() => triageMessage(null), "invalid_triage_input");
  throwsCode(() => triageMessage(msg(), { spamScore: 101 }), "invalid_triage_input");
  throwsCode(() => triageMessage(msg(), { matchedRules: "nope" }), "invalid_triage_input");
  throwsCode(() => triageBatch("nope"), "invalid_triage_input");
  assert.deepEqual(ACTIONS, ["quarantine", "file", "snooze", "flag", "needs_human", "inbox"]);
});
