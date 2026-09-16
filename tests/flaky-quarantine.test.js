// Q001: flaky-test quarantine system tests.
//
// Pure unit tests over the module's own API: history recording and store
// immutability, flakiness classification boundaries (all-pass = stable,
// all-fail = broken, mixed = flaky, too few runs = insufficient), the
// quarantine / keep / rehabilitate lifecycle, ticket payload contents,
// and invalid-input TypeErrors.

import test from "node:test";
import assert from "node:assert/strict";
import {
  DECISION_KEEP,
  DECISION_QUARANTINE,
  DECISION_REHABILITATE,
  DEFAULT_POLICY,
  STATUS_BROKEN,
  STATUS_FLAKY,
  STATUS_INSUFFICIENT,
  STATUS_STABLE,
  applyDecision,
  buildTicketPayload,
  classifyOutcomes,
  consecutivePasses,
  createPolicy,
  createStore,
  detectStatus,
  evaluateQuarantine,
  getRecord,
  recordOutcome,
  summarizeHistory,
  windowOutcomes
} from "../src/flaky-quarantine.mjs";

const PASS = true;
const FAIL = false;
const T0 = 1_757_000_000_000; // fixed injectable clock (ms)

function storeWith(store, testId, outcomes) {
  let next = store;
  outcomes.forEach((passed, i) => {
    next = recordOutcome(next, testId, passed, T0 + i * 1_000);
  });
  return next;
}

test("recordOutcome appends history and leaves the input store untouched", () => {
  const empty = createStore();
  const s1 = recordOutcome(empty, "a.spec", PASS, T0);
  assert.deepEqual(empty, {});
  assert.equal(getRecord(empty, "a.spec"), null);

  const rec = getRecord(s1, "a.spec");
  assert.equal(rec.testId, "a.spec");
  assert.equal(rec.quarantined, false);
  assert.deepEqual(rec.history, [{ passed: true, atMs: T0 }]);

  const s2 = recordOutcome(s1, "a.spec", FAIL, T0 + 1_000);
  assert.equal(getRecord(s1, "a.spec").history.length, 1); // s1 unchanged
  assert.equal(getRecord(s2, "a.spec").history.length, 2);
  // per-test isolation
  const s3 = recordOutcome(s2, "b.spec", PASS, T0);
  assert.equal(getRecord(s3, "b.spec").history.length, 1);
  assert.equal(getRecord(s3, "a.spec").history.length, 2);
});

test("recordOutcome validates inputs", () => {
  const store = createStore();
  for (const bad of [null, undefined, 42, [], "x"]) {
    assert.throws(() => recordOutcome(bad, "a", PASS, T0), TypeError, `store=${String(bad)}`);
  }
  for (const bad of ["", 42, null, undefined]) {
    assert.throws(() => recordOutcome(store, bad, PASS, T0), TypeError, `testId=${String(bad)}`);
  }
  for (const bad of [1, "true", null, undefined]) {
    assert.throws(() => recordOutcome(store, "a", bad, T0), TypeError, `passed=${String(bad)}`);
  }
  for (const bad of [-1, NaN, Infinity, "t"]) {
    assert.throws(() => recordOutcome(store, "a", PASS, bad), TypeError, `atMs=${String(bad)}`);
  }
  // atMs is optional
  const s = recordOutcome(store, "a", PASS);
  assert.deepEqual(getRecord(s, "a").history, [{ passed: true, atMs: null }]);
});

test("classifyOutcomes hits the flakiness boundaries", () => {
  const minRuns = 3;
  assert.equal(classifyOutcomes([PASS, PASS, PASS], { minRuns }), STATUS_STABLE);
  assert.equal(classifyOutcomes([FAIL, FAIL, FAIL], { minRuns }), STATUS_BROKEN);
  assert.equal(classifyOutcomes([PASS, FAIL, PASS], { minRuns }), STATUS_FLAKY);
  assert.equal(classifyOutcomes([FAIL, PASS, FAIL, PASS, FAIL], { minRuns }), STATUS_FLAKY);
  // single failure among passes is still flaky, not broken
  assert.equal(classifyOutcomes([PASS, PASS, PASS, FAIL], { minRuns }), STATUS_FLAKY);
  // too few runs: not enough evidence either way
  assert.equal(classifyOutcomes([PASS, PASS], { minRuns }), STATUS_INSUFFICIENT);
  assert.equal(classifyOutcomes([FAIL], { minRuns }), STATUS_INSUFFICIENT);
  assert.equal(classifyOutcomes([], { minRuns }), STATUS_INSUFFICIENT);

  assert.throws(() => classifyOutcomes("nope", { minRuns }), TypeError);
  assert.throws(() => classifyOutcomes([1, 0], { minRuns }), TypeError);
  assert.throws(() => classifyOutcomes([PASS], { minRuns: 0 }), TypeError);
  assert.throws(() => classifyOutcomes([PASS], { minRuns: 2.5 }), TypeError);
  assert.throws(() => classifyOutcomes([PASS], {}), TypeError);
});

test("windowOutcomes and detectStatus honor the sliding window", () => {
  const store = storeWith(createStore(), "a.spec", [FAIL, FAIL, FAIL, PASS, PASS, PASS]);
  const record = getRecord(store, "a.spec");
  // full window: mixed -> flaky
  assert.deepEqual(windowOutcomes(record, 10), [FAIL, FAIL, FAIL, PASS, PASS, PASS]);
  assert.equal(detectStatus(record, { windowSize: 10, minRuns: 3 }), STATUS_FLAKY);
  // last 3 only: all pass -> stable; old failures fall out of the window
  assert.deepEqual(windowOutcomes(record, 3), [PASS, PASS, PASS]);
  assert.equal(detectStatus(record, { windowSize: 3, minRuns: 3 }), STATUS_STABLE);

  assert.throws(() => windowOutcomes(record, 0), TypeError);
  assert.throws(() => windowOutcomes(null, 3), TypeError);
});

test("consecutivePasses counts the trailing streak", () => {
  let store = storeWith(createStore(), "a.spec", [PASS, FAIL, PASS, PASS]);
  const record = getRecord(store, "a.spec");
  assert.equal(consecutivePasses(record, 10), 2);
  assert.equal(consecutivePasses(record, 1), 1);

  store = storeWith(createStore(), "b.spec", [PASS, PASS, FAIL]);
  assert.equal(consecutivePasses(getRecord(store, "b.spec"), 10), 0);

  store = createStore();
  store = recordOutcome(store, "c.spec", PASS, T0);
  assert.equal(consecutivePasses(getRecord(store, "c.spec"), 10), 1);
});

test("evaluateQuarantine quarantines flaky and broken tests", () => {
  const policy = createPolicy({ windowSize: 10, minRuns: 3, rehabilitateAfter: 2 });
  let store = createStore();
  store = storeWith(store, "flaky.spec", [PASS, FAIL, PASS, FAIL]);
  store = storeWith(store, "broken.spec", [FAIL, FAIL, FAIL, FAIL]);
  store = storeWith(store, "stable.spec", [PASS, PASS, PASS, PASS]);
  store = storeWith(store, "new.spec", [PASS]);

  const flaky = evaluateQuarantine(store, "flaky.spec", policy);
  assert.equal(flaky.decision, DECISION_QUARANTINE);
  assert.equal(flaky.status, STATUS_FLAKY);
  assert.equal(flaky.summary.fails, 2);

  const broken = evaluateQuarantine(store, "broken.spec", policy);
  assert.equal(broken.decision, DECISION_QUARANTINE);
  assert.equal(broken.status, STATUS_BROKEN);

  const stable = evaluateQuarantine(store, "stable.spec", policy);
  assert.equal(stable.decision, DECISION_KEEP);
  assert.equal(stable.status, STATUS_STABLE);

  // too few runs -> keep, insufficient
  const fresh = evaluateQuarantine(store, "new.spec", policy);
  assert.equal(fresh.decision, DECISION_KEEP);
  assert.equal(fresh.status, STATUS_INSUFFICIENT);

  // unknown test -> keep, insufficient, null summary
  const unknown = evaluateQuarantine(store, "ghost.spec", policy);
  assert.equal(unknown.decision, DECISION_KEEP);
  assert.equal(unknown.status, STATUS_INSUFFICIENT);
  assert.equal(unknown.summary, null);
});

test("quarantine -> keep quarantined -> rehabilitate lifecycle", () => {
  const policy = createPolicy({ windowSize: 10, minRuns: 3, rehabilitateAfter: 3 });
  let store = storeWith(createStore(), "w.spec", [PASS, FAIL, PASS, FAIL]);

  // quarantine the flaky test
  let verdict = evaluateQuarantine(store, "w.spec", policy);
  assert.equal(verdict.decision, DECISION_QUARANTINE);
  store = applyDecision(store, "w.spec", verdict.decision, T0);
  assert.equal(getRecord(store, "w.spec").quarantined, true);
  assert.equal(getRecord(store, "w.spec").quarantinedAtMs, T0);

  // still flaky after one more pass: stays quarantined
  store = recordOutcome(store, "w.spec", PASS, T0 + 1_000);
  verdict = evaluateQuarantine(store, "w.spec", policy);
  assert.equal(verdict.decision, DECISION_KEEP);
  assert.equal(verdict.status, STATUS_FLAKY);

  // three consecutive passes -> rehabilitate
  store = recordOutcome(store, "w.spec", PASS, T0 + 2_000);
  store = recordOutcome(store, "w.spec", PASS, T0 + 3_000);
  verdict = evaluateQuarantine(store, "w.spec", policy);
  assert.equal(verdict.decision, DECISION_REHABILITATE);
  store = applyDecision(store, "w.spec", verdict.decision, T0 + 4_000);
  assert.equal(getRecord(store, "w.spec").quarantined, false);
  assert.equal(getRecord(store, "w.spec").quarantinedAtMs, null);

  // rehabilitated test: old failures are still inside the window, so the
  // next evaluation sees a flaky window and re-quarantines — honest
  // semantics for a test that keeps failing intermittently.
  verdict = evaluateQuarantine(store, "w.spec", policy);
  assert.equal(verdict.status, STATUS_FLAKY);
  assert.equal(verdict.decision, DECISION_QUARANTINE);
});

test("applyDecision validates inputs and never mutates the input store", () => {
  const store = storeWith(createStore(), "a.spec", [PASS, FAIL, PASS]);
  const kept = applyDecision(store, "a.spec", DECISION_KEEP, T0);
  assert.equal(getRecord(kept, "a.spec").quarantined, false);
  assert.notEqual(kept, store); // fresh object even for keep

  const quarantined = applyDecision(store, "a.spec", DECISION_QUARANTINE, T0);
  assert.equal(getRecord(store, "a.spec").quarantined, false); // input untouched
  assert.equal(getRecord(quarantined, "a.spec").quarantined, true);

  assert.throws(() => applyDecision(store, "a.spec", "banish", T0), TypeError);
  assert.throws(() => applyDecision(store, "ghost.spec", DECISION_QUARANTINE, T0), TypeError);
  assert.throws(() => applyDecision(store, "", DECISION_KEEP, T0), TypeError);
  assert.throws(() => applyDecision(null, "a.spec", DECISION_KEEP, T0), TypeError);
});

test("createPolicy merges and validates", () => {
  const p = createPolicy();
  assert.deepEqual(p, DEFAULT_POLICY);

  const custom = createPolicy({ windowSize: 5, minRuns: 2, rehabilitateAfter: 2 });
  assert.equal(custom.windowSize, 5);
  assert.equal(custom.name, DEFAULT_POLICY.name);

  assert.throws(() => createPolicy(null), TypeError);
  assert.throws(() => createPolicy([]), TypeError);
  assert.throws(() => createPolicy({ windowSize: 0 }), TypeError);
  assert.throws(() => createPolicy({ windowSize: 2.5 }), TypeError);
  assert.throws(() => createPolicy({ minRuns: "3" }), TypeError);
  assert.throws(() => createPolicy({ rehabilitateAfter: -1 }), TypeError);
  // minRuns beyond the window can never be satisfied
  assert.throws(() => createPolicy({ windowSize: 3, minRuns: 5 }), TypeError);
  assert.throws(() => evaluateQuarantine(createStore(), "a.spec", { windowSize: 3 }), TypeError);
});

test("summarizeHistory reports windowed stats", () => {
  const store = storeWith(createStore(), "a.spec", [PASS, FAIL, PASS, PASS, FAIL]);
  const summary = summarizeHistory(getRecord(store, "a.spec"), 10);
  assert.equal(summary.total, 5);
  assert.equal(summary.passes, 3);
  assert.equal(summary.fails, 2);
  assert.ok(Math.abs(summary.passRate - 0.6) < 1e-12);
  assert.equal(summary.lastOutcome, "fail");
  assert.equal(summary.passStreak, 0);
  assert.equal(summary.quarantined, false);

  const empty = summarizeHistory(getRecord(recordOutcome(createStore(), "e.spec", PASS), "e.spec"), 10);
  assert.equal(empty.total, 1);
  assert.equal(empty.passRate, 1);

  assert.throws(() => summarizeHistory(null, 10), TypeError);
  assert.throws(() => summarizeHistory(getRecord(store, "a.spec"), 0), TypeError);
});

test("buildTicketPayload carries test id, status, reason, and history", () => {
  const store = storeWith(createStore(), "w.spec", [PASS, FAIL, PASS, FAIL, FAIL]);
  const summary = summarizeHistory(getRecord(store, "w.spec"), 10);
  const payload = buildTicketPayload("w.spec", {
    status: STATUS_FLAKY,
    summary,
    detector: "quill-s2/q001"
  });

  assert.ok(payload.title.includes("w.spec"), "title names the test");
  assert.ok(payload.title.includes(STATUS_FLAKY), "title carries the status");
  assert.ok(payload.body.includes("w.spec"), "body names the test");
  assert.ok(payload.body.includes("mixed pass/fail"), "body states the default flaky reason");
  assert.ok(payload.body.includes("runs: 5"), "body carries the history summary");
  assert.equal(payload.fields.testId, "w.spec");
  assert.equal(payload.fields.status, STATUS_FLAKY);
  assert.equal(payload.fields.detector, "quill-s2/q001");
  assert.equal(payload.fields.quarantined, false);
  assert.ok(payload.fields.historySummary.includes("failures: 3"));

  // explicit reason overrides the default line
  const custom = buildTicketPayload("b.spec", {
    status: STATUS_BROKEN,
    reason: "fails on every CI runner since the dep bump",
    summary,
    detector: "ci-bot"
  });
  assert.ok(custom.body.includes("fails on every CI runner since the dep bump"));
  assert.equal(custom.fields.quarantineReason, "fails on every CI runner since the dep bump");

  assert.throws(() => buildTicketPayload("", { status: STATUS_FLAKY, summary, detector: "d" }), TypeError);
  assert.throws(() => buildTicketPayload("x", { status: "wobbly", summary, detector: "d" }), TypeError);
  assert.throws(() => buildTicketPayload("x", { status: STATUS_FLAKY, summary: null, detector: "d" }), TypeError);
  assert.throws(() => buildTicketPayload("x", { status: STATUS_FLAKY, summary, detector: "" }), TypeError);
  assert.throws(() => buildTicketPayload("x", { status: STATUS_FLAKY, reason: "", summary, detector: "d" }), TypeError);
});

test("getRecord validates inputs", () => {
  const store = createStore();
  assert.throws(() => getRecord(null, "a.spec"), TypeError);
  assert.throws(() => getRecord(store, ""), TypeError);
  assert.throws(() => getRecord(store, 42), TypeError);
});
