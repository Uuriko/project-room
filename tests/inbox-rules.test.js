// A012: inbox rules engine. Pure evaluator tests; no storage, no UI.
import test from "node:test";
import assert from "node:assert/strict";
import { evaluateRules, actionsFor, RuleError } from "../server/inbox-rules.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof RuleError && error.code === code);
const msg = (overrides = {}) => ({ id: "m-1", from: "news@example.com", subject: "Weekly deals", body: "Buy now!", channel: "email", connectionId: "graph-1", spamScore: 12, hasAttachment: false, ...overrides });

test("matching rules return their actions in order", () => {
  const results = evaluateRules([
    { id: "r1", conditions: [{ field: "from", op: "contains", value: "example.com" }], actions: [{ type: "file", folder: "newsletters" }] },
    { id: "r2", conditions: [{ field: "subject", op: "equals", value: "Weekly deals" }], actions: [{ type: "mark_read" }] },
    { id: "r3", conditions: [{ field: "subject", op: "equals", value: "other" }], actions: [{ type: "flag", label: "x" }] },
  ], msg());
  assert.deepEqual(results.map(r => r.ruleId), ["r1", "r2"]);
  assert.deepEqual(results[0].actions, [{ type: "file", folder: "newsletters" }]);
  assert.ok(Object.isFrozen(results) && Object.isFrozen(results[0].actions));
});
test("stopOnMatch halts evaluation", () => {
  const results = evaluateRules([
    { id: "r1", stopOnMatch: true, conditions: [{ field: "channel", op: "equals", value: "email" }], actions: [{ type: "mark_read" }] },
    { id: "r2", conditions: [{ field: "channel", op: "equals", value: "email" }], actions: [{ type: "flag", label: "late" }] },
  ], msg());
  assert.deepEqual(results.map(r => r.ruleId), ["r1"]);
});
test("disabled rules are skipped", () => {
  const results = evaluateRules([
    { id: "r1", enabled: false, conditions: [{ field: "channel", op: "equals", value: "email" }], actions: [{ type: "mark_read" }] },
  ], msg());
  assert.deepEqual(results, []);
});
test("numeric and regex conditions work", () => {
  const results = evaluateRules([
    { id: "spam", conditions: [{ field: "spamScore", op: "gte", value: 60 }], actions: [{ type: "file", folder: "quarantine" }] },
    { id: "deal", conditions: [{ field: "subject", op: "matches", value: "^Weekly" }], actions: [{ type: "flag", label: "promo" }] },
  ], msg({ spamScore: 80 }));
  assert.deepEqual(results.map(r => r.ruleId), ["spam", "deal"]);
  assert.deepEqual(actionsFor([], msg()), []);
});
test("malformed rules are refused", () => {
  throwsCode(() => evaluateRules(null, msg()), "invalid_rule");
  throwsCode(() => evaluateRules([{ id: "r1", conditions: [], actions: [{ type: "mark_read" }] }], msg()), "invalid_rule");
  throwsCode(() => evaluateRules([{ id: "r1", conditions: [{ field: "nope", op: "equals", value: "x" }], actions: [{ type: "mark_read" }] }], msg()), "invalid_rule");
  throwsCode(() => evaluateRules([{ id: "r1", conditions: [{ field: "subject", op: "matches", value: "(" }], actions: [{ type: "mark_read" }] }], msg()), "invalid_rule");
  throwsCode(() => evaluateRules([{ id: "r1", conditions: [{ field: "subject", op: "equals", value: "x" }], actions: [{ type: "fly" }] }], msg()), "invalid_rule");
  throwsCode(() => evaluateRules([{ id: "r1", conditions: [{ field: "subject", op: "equals", value: "x" }], actions: [{ type: "file" }] }], msg()), "invalid_rule");
  throwsCode(() => evaluateRules([{ id: "r1", conditions: [{ field: "subject", op: "equals", value: "x" }], actions: [{ type: "snooze", delay: "never" }] }], msg()), "invalid_rule");
  throwsCode(() => evaluateRules([{ id: "r1", conditions: [{ field: "spamScore", op: "gte", value: 1 }], actions: [{ type: "mark_read" }] }], { id: "m" }), "invalid_rule");
});
