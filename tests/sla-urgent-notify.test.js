// SLA-breach urgent-notification producer. Pure unit tests: breach ->
// urgent notification with the record shape, one alert per breach,
// no alert without a breach, per-channel targets stay configurable, and
// the urgent record survives the quiet-hours path in decideNotification.
import test from "node:test";
import assert from "node:assert/strict";
import { createSlaBreachProducer, SLA_BREACH_KIND, SlaNotifyError } from "../server/sla-urgent-notify.mjs";
import { createNotifyPrefs, isQuietAt } from "../server/notify-prefs.mjs";

const throwsNotify = (fn, code) => assert.throws(fn, err => err instanceof SlaNotifyError && err.code === code);
const HOUR = 3600000;
const at = hours => new Date(Date.UTC(2026, 8, 18, 0, 0, 0) + hours * HOUR).toISOString();
const NOW = Date.parse(at(10));
const inbound = (id, hours) => ({ id, occurredAt: at(hours), direction: "inbound" });
const outbound = (id, hours) => ({ id, occurredAt: at(hours), direction: "outbound" });
const thread = (threadId, channel, messages) => ({ threadId, channel, messages });

// --- breach produces one urgent record --------------------------------------
test("a breached thread produces one urgent notification record", () => {
  const producer = createSlaBreachProducer();
  const produced = producer.produce([thread("t1", "telegram", [inbound("m1", 7)])], { now: NOW });
  assert.equal(produced.length, 1);
  const record = produced[0];
  assert.ok(Object.isFrozen(record), "records are frozen");
  assert.equal(record.kind, SLA_BREACH_KIND);
  assert.equal(record.urgent, true);
  assert.equal(record.threadId, "t1");
  assert.equal(record.channel, "telegram");
  assert.equal(record.elapsedMs, 3 * HOUR);
  assert.equal(record.targetMs, 2 * HOUR);
  assert.equal(record.targetLabel, "2h");
  assert.equal(record.awaitingSince, at(7));
  assert.equal(record.deadlineAt, at(9));
  assert.equal(record.producedAt, new Date(NOW).toISOString());
  assert.ok(typeof record.summary === "string" && record.summary.includes("t1") && record.summary.includes("telegram"));
  assert.equal(producer.activeAlerts().length, 1);
});

test("a breached thread never alerts twice while the breach persists", () => {
  const producer = createSlaBreachProducer();
  const first = producer.produce([thread("t2", "telegram", [inbound("m1", 7)])], { now: NOW });
  assert.equal(first.length, 1);
  const again = producer.produce([thread("t2", "telegram", [inbound("m1", 7)])], { now: NOW + HOUR });
  assert.deepEqual(again, [], "the same unanswered breach does not re-page");
});

test("answering clears the alert, so a later re-breach alerts again", () => {
  const producer = createSlaBreachProducer();
  producer.produce([thread("t3", "telegram", [inbound("m1", 7)])], { now: NOW });
  const answered = producer.produce([thread("t3", "telegram", [inbound("m1", 7), outbound("m2", 10.5)])], { now: NOW + HOUR });
  assert.deepEqual(answered, [], "a replied thread is no longer breached");
  const rebreach = producer.produce(
    [thread("t3", "telegram", [inbound("m1", 7), outbound("m2", 10.5), inbound("m3", 11.5)])],
    { now: NOW + 4 * HOUR });
  assert.equal(rebreach.length, 1, "the new unanswered inbound breaches again");
  assert.equal(rebreach[0].threadId, "t3");
  assert.equal(rebreach[0].awaitingSince, at(11.5));
});

test("clearAlert drops one alert so a still-breached thread re-alerts next sweep", () => {
  const producer = createSlaBreachProducer();
  producer.produce([thread("t4", "telegram", [inbound("m1", 7)])], { now: NOW });
  assert.equal(producer.activeAlerts().length, 1);
  assert.equal(producer.clearAlert("t4"), true);
  assert.equal(producer.activeAlerts().length, 0);
  assert.equal(producer.produce([thread("t4", "telegram", [inbound("m1", 7)])], { now: NOW + HOUR }).length, 1);
  assert.equal(producer.clearAlert("nope"), false);
});

// --- no breach, no urgent ----------------------------------------------------
test("on_track, at_risk and responded threads produce nothing", () => {
  const producer = createSlaBreachProducer();
  const threads = [
    thread("ok", "telegram", [inbound("m1", 9.9)]),                 // on_track
    thread("risk", "telegram", [inbound("m2", 10 - 0.75 * 2)]),     // at_risk, not breached
    thread("done", "telegram", [inbound("m3", 5), outbound("m4", 5.5)]), // responded
    thread("na", "email", [outbound("m5", 9)]),                      // not_applicable
  ];
  assert.deepEqual(producer.produce(threads, { now: NOW }), []);
  assert.equal(producer.activeAlerts().length, 0);
});

test("an empty sweep produces nothing and never throws", () => {
  assert.deepEqual(createSlaBreachProducer().produce([], { now: NOW }), []);
});

// --- per-channel targets ------------------------------------------------------
test("channel-mismatched SLAs: the same wait breaches telegram, not email", () => {
  const producer = createSlaBreachProducer();
  const produced = producer.produce([
    thread("tg", "telegram", [inbound("m1", 5)]),
    thread("em", "email", [inbound("m2", 5)]),
  ], { now: NOW });
  assert.equal(produced.length, 1);
  assert.equal(produced[0].threadId, "tg");
});

test("targets stay injectable: John's policy changes the breach point, not the shape", () => {
  const strict = createSlaBreachProducer({ targets: { telegram: { targetMs: HOUR, label: "1h" } } });
  const produced = strict.produce([thread("t5", "telegram", [inbound("m1", 8.9)])], { now: NOW });
  assert.equal(produced.length, 1);
  assert.equal(produced[0].targetMs, HOUR);
  assert.equal(produced[0].targetLabel, "1h");
  throwsNotify(() => createSlaBreachProducer({ targets: { telegram: { targetMs: -1 } } }), "invalid_sla_notify");
});

// --- quiet-hours bypass --------------------------------------------------------
test("the urgent record bypasses quiet hours in decideNotification", () => {
  const prefs = createNotifyPrefs();
  // Quiet hours cover all of Friday in LA, well around the 10:00 sweep.
  prefs.setQuietHours("u1", { start: "00:00", end: "23:59", tz: "America/Los_Angeles" });
  assert.equal(isQuietAt(prefs.quietHoursFor("u1"), NOW), true);
  const producer = createSlaBreachProducer();
  const [record] = producer.produce([thread("t6", "telegram", [inbound("m1", 6)])], { now: NOW });
  const urgent = prefs.decideNotification("u1", { urgent: record.urgent, at: NOW });
  assert.equal(urgent.decision, "deliver", "urgent SLA breach is delivered inside quiet hours");
  const routine = prefs.decideNotification("u1", { urgent: false, at: NOW });
  assert.equal(routine.decision, "hold", "non-urgent traffic still holds for the digest");
  const muted = createNotifyPrefs();
  muted.setGlobal("u2", { level: "muted" });
  assert.equal(muted.decideNotification("u2", { urgent: true, at: NOW }).decision, "muted",
    "muted-all is a user choice the breach path does not override");
});

// --- malformed inputs -----------------------------------------------------------
test("malformed inputs are coded errors", () => {
  const producer = createSlaBreachProducer();
  throwsNotify(() => producer.produce("nope", { now: NOW }), "invalid_sla_notify");
  throwsNotify(() => producer.produce([], { now: -1 }), "invalid_sla_notify");
  throwsNotify(() => producer.produce([], {}), "invalid_sla_notify");
  throwsNotify(() => producer.clearAlert(""), "invalid_sla_notify");
  throwsNotify(() => createSlaBreachProducer({ store: {} }), "invalid_sla_notify");
  // Caller-owned stores share the alerted ledger across producers.
  const store = new Map();
  const a = createSlaBreachProducer({ store });
  const b = createSlaBreachProducer({ store });
  assert.equal(a.produce([thread("t7", "telegram", [inbound("m1", 6)])], { now: NOW }).length, 1);
  assert.deepEqual(b.produce([thread("t7", "telegram", [inbound("m1", 6)])], { now: NOW }), []);
});
