// Task 24: per-channel SLA clocks. Pure unit tests over assessThreadSla and
// assessSlaBatch: status boundaries, the first-response stop, per-channel
// targets, and the batch sweep rollup.
import test from "node:test";
import assert from "node:assert/strict";
import { assessThreadSla, assessSlaBatch, slaTargets, atRiskRatio, validateSlaTargets, SlaError } from "../server/sla-clocks.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof SlaError && error.code === code);
const HOUR = 3600000;
const at = hours => new Date(Date.UTC(2026, 8, 17, 0, 0, 0) + hours * HOUR).toISOString();
const NOW = Date.parse(at(10));

const inbound = (id, hours) => ({ id, occurredAt: at(hours), direction: "inbound" });
const outbound = (id, hours) => ({ id, occurredAt: at(hours), direction: "outbound" });

test("on_track while the wait is below the at-risk threshold", () => {
  const sla = assessThreadSla({ threadId: "t1", channel: "telegram", messages: [inbound("m1", 9.5)], now: NOW });
  assert.equal(sla.status, "on_track");
  assert.equal(sla.targetMs, 2 * HOUR);
  assert.equal(sla.elapsedMs, 0.5 * HOUR);
  assert.equal(sla.awaitingSince, at(9.5));
  assert.equal(sla.respondedMs, null);
  assert.equal(sla.withinTarget, true);
  assert.ok(typeof sla.deadlineAt === "string", "breach deadline is explicit");
});

test("at_risk at 75% of the target, breached past it", () => {
  const atRisk = assessThreadSla({ threadId: "t2", channel: "telegram",
    messages: [inbound("m1", 10 - atRiskRatio * 2)], now: NOW });
  assert.equal(atRisk.status, "at_risk");
  assert.equal(atRisk.withinTarget, true, "at-risk is not yet breached");
  const breached = assessThreadSla({ threadId: "t3", channel: "telegram",
    messages: [inbound("m1", 7.9)], now: NOW });
  assert.equal(breached.status, "breached");
  assert.equal(breached.withinTarget, false);
});

test("email runs on hours, not minutes: same elapsed, different status", () => {
  const same = [inbound("m1", 5)]; // 5h wait
  assert.equal(assessThreadSla({ threadId: "t4", channel: "telegram", messages: same, now: NOW }).status, "breached");
  assert.equal(assessThreadSla({ threadId: "t5", channel: "email", messages: same, now: NOW }).status, "on_track");
});

test("the first outbound reply stops the clock; a later inbound restarts it", () => {
  const answered = assessThreadSla({ threadId: "t6", channel: "telegram",
    messages: [inbound("m1", 8), outbound("m2", 8.5)], now: NOW });
  assert.equal(answered.status, "responded");
  assert.equal(answered.respondedMs, 0.5 * HOUR);
  assert.equal(answered.withinTarget, true);
  const reopened = assessThreadSla({ threadId: "t7", channel: "telegram",
    messages: [inbound("m1", 8), outbound("m2", 8.5), inbound("m3", 9.9)], now: NOW });
  assert.equal(reopened.status, "on_track", "the clock restarts at the newest inbound");
  assert.equal(reopened.awaitingSince, at(9.9));
  const lateReply = assessThreadSla({ threadId: "t8", channel: "telegram",
    messages: [inbound("m1", 5), outbound("m2", 9)], now: NOW });
  assert.equal(lateReply.status, "responded");
  assert.equal(lateReply.withinTarget, false, "a late reply is still a reply, but flagged");
});

test("no inbound messages means not_applicable, not a breach", () => {
  const sla = assessThreadSla({ threadId: "t9", channel: "email", messages: [outbound("m1", 9)], now: NOW });
  assert.equal(sla.status, "not_applicable");
});

test("an unconfigured channel is unknown_channel rather than a guessed clock", () => {
  const sla = assessThreadSla({ threadId: "t10", channel: "pager", messages: [inbound("m1", 1)], now: NOW,
    targets: { email: { targetMs: HOUR } } });
  assert.equal(sla.status, "unknown_channel");
  assert.equal(sla.targetMs, null);
});

test("targets are validated and injectable", () => {
  assert.deepEqual(validateSlaTargets({ telegram: { targetMs: 60000, label: "1m" } }),
    { telegram: { targetMs: 60000, label: "1m" } });
  throwsCode(() => validateSlaTargets({ telegram: { targetMs: -5 } }), "invalid_sla_input");
  throwsCode(() => validateSlaTargets({}), "invalid_sla_input");
  const custom = assessThreadSla({ threadId: "t11", channel: "telegram", messages: [inbound("m1", 9)], now: NOW,
    targets: { telegram: { targetMs: 30 * 60000, label: "30m" } } });
  assert.equal(custom.status, "breached", "a stricter policy breaches sooner");
});

test("batch sweep rolls up per-channel open counts and breach lists", () => {
  const batch = assessSlaBatch([
    { threadId: "ok-mail", channel: "email", messages: [inbound("m1", 9)] },
    { threadId: "breach-tg", channel: "telegram", messages: [inbound("m2", 5)] },
    { threadId: "risk-tg", channel: "telegram", messages: [inbound("m3", 10 - atRiskRatio * 2)] },
    { threadId: "done", channel: "telegram", messages: [inbound("m4", 8), outbound("m5", 8.5)] },
    { threadId: "empty", channel: "email", messages: [] },
  ], { now: NOW });
  assert.equal(batch.openCount, 3);
  assert.deepEqual(batch.openByChannel, { email: 1, telegram: 2 });
  assert.deepEqual(batch.breached, ["breach-tg"]);
  assert.deepEqual(batch.atRisk, ["risk-tg"]);
  assert.equal(batch.assessed.length, 5);
  assert.ok(Object.isFrozen(batch) && Object.isFrozen(batch.assessed));
});

test("malformed inputs are refused", () => {
  throwsCode(() => assessThreadSla({ threadId: "", channel: "email", messages: [], now: NOW }), "invalid_sla_input");
  throwsCode(() => assessThreadSla({ threadId: "t", channel: "email", messages: [{ id: "m", occurredAt: "nope", direction: "inbound" }], now: NOW }), "invalid_sla_input");
  throwsCode(() => assessThreadSla({ threadId: "t", channel: "email", messages: [{ id: "m", occurredAt: at(9), direction: "sideways" }], now: NOW }), "invalid_sla_input");
  throwsCode(() => assessSlaBatch("nope", { now: NOW }), "invalid_sla_input");
});

test("default targets keep channel-mismatched units honest", () => {
  assert.equal(slaTargets.telegram.targetMs, 2 * HOUR);
  assert.equal(slaTargets.email.targetMs, 24 * HOUR);
  assert.ok(Object.isFrozen(slaTargets));
});
