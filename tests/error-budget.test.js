// F009: error budget policy + paging rules tests.
//
// Pure unit tests over the module's own API with injectable window clocks:
// budget math, burn-rate threshold boundaries (fast burn 14.4x paging,
// slow burn 6x ticketing), action selection, zero-request edges, window
// rollover, and input validation.
import test from "node:test";
import assert from "node:assert/strict";
import {
  ACTION_NONE,
  ACTION_PAGE,
  ACTION_TICKET,
  DEFAULT_POLICY,
  allowedErrorRate,
  burnRate,
  createPolicy,
  evaluateBurn,
  evaluateWindow,
  observe,
  remainingBudget,
  rollover,
  startWindow
} from "../src/error-budget.mjs";

const DAY = 86_400_000;
const START = 1_757_000_000_000; // fixed injectable clock (ms)

test("allowedErrorRate converts SLO targets to allowed error fractions", () => {
  // 1 - 0.999 is not exactly 0.001 in floating point: compare with tolerance.
  const approxRate = (target, expected) =>
    assert.ok(
      Math.abs(allowedErrorRate(target) - expected) < 1e-12,
      `allowedErrorRate(${target}) ≈ ${expected}`
    );
  approxRate(0.999, 0.001);
  approxRate(0.99, 0.01);
  approxRate(0.95, 0.05);
  for (const bad of [0, 1, -0.5, 1.5, NaN, Infinity, "0.99", null, undefined]) {
    assert.throws(() => allowedErrorRate(bad), TypeError, `sloTarget=${String(bad)}`);
  }
});

test("createPolicy merges overrides and validates rules", () => {
  const p = createPolicy();
  assert.deepEqual(p, DEFAULT_POLICY);
  assert.notEqual(p.alerts, DEFAULT_POLICY.alerts); // copied, not aliased

  const custom = createPolicy({
    alerts: [
      { action: ACTION_PAGE, burn: 10, label: "custom fast" },
      { action: ACTION_NONE, burn: 2, label: "custom slow" }
    ]
  });
  assert.equal(custom.alerts[0].burn, 10);
  assert.equal(custom.name, DEFAULT_POLICY.name);

  assert.throws(() => createPolicy(null), TypeError);
  assert.throws(() => createPolicy([]), TypeError);
  assert.throws(() => createPolicy({ alerts: [] }), TypeError);
  assert.throws(() => createPolicy({ alerts: "nope" }), TypeError);
  assert.throws(
    () => createPolicy({ alerts: [{ action: "escalate", burn: 10 }] }),
    TypeError
  );
  assert.throws(
    () => createPolicy({ alerts: [{ action: ACTION_PAGE, burn: 0 }] }),
    TypeError
  );
  assert.throws(
    () => createPolicy({ alerts: [{ action: ACTION_PAGE, burn: -3 }] }),
    TypeError
  );
  assert.throws(
    () => createPolicy({ alerts: [{ action: ACTION_PAGE, burn: NaN }] }),
    TypeError
  );
  // Duplicate thresholds are ambiguous — rejected.
  assert.throws(
    () =>
      createPolicy({
        alerts: [
          { action: ACTION_PAGE, burn: 10 },
          { action: ACTION_TICKET, burn: 10 }
        ]
      }),
    TypeError
  );
  // Rules must be ordered strictly descending so first-match is deterministic.
  assert.throws(
    () =>
      createPolicy({
        alerts: [
          { action: ACTION_TICKET, burn: 6 },
          { action: ACTION_PAGE, burn: 14.4 }
        ]
      }),
    TypeError
  );
});

test("burnRate measures observed error rate against the allowed rate", () => {
  // 1000 requests, 1 error, 99.9% SLO: exactly at budget pace (tolerant of
  // float arithmetic: 1 - 0.999 is not exactly 0.001).
  assert.ok(Math.abs(burnRate({ requests: 1000, errors: 1, sloTarget: 0.999 }) - 1) < 1e-9);
  // 14.4x fast-burn illustration: 14.4% errors against a 1% allowed rate.
  assert.ok(
    Math.abs(burnRate({ requests: 1000, errors: 144, sloTarget: 0.99 }) - 14.4) < 1e-9
  );
  assert.equal(burnRate({ requests: 1000, errors: 0, sloTarget: 0.999 }), 0);
  // Zero requests is zero burn, never a division by zero.
  assert.equal(burnRate({ requests: 0, errors: 0, sloTarget: 0.999 }), 0);
  assert.equal(burnRate({ requests: 0, errors: 0, sloTarget: 0.5 }), 0);

  assert.throws(() => burnRate({ requests: 100, errors: 101, sloTarget: 0.999 }), TypeError);
  assert.throws(() => burnRate({ requests: -1, errors: 0, sloTarget: 0.999 }), TypeError);
  assert.throws(() => burnRate({ requests: 1.5, errors: 0, sloTarget: 0.999 }), TypeError);
  assert.throws(() => burnRate({ requests: 100, errors: 0, sloTarget: 1 }), TypeError);
});

test("evaluateBurn selects page / ticket / none at the SRE tier boundaries", () => {
  const page = evaluateBurn({ burn: 14.4 });
  assert.equal(page.action, ACTION_PAGE);
  assert.equal(page.matched.burn, 14.4);
  assert.equal(page.burn, 14.4);

  // Just under fast-burn: still a ticket while above the slow tier.
  assert.equal(evaluateBurn({ burn: 14.3999 }).action, ACTION_TICKET);
  assert.equal(evaluateBurn({ burn: 6 }).action, ACTION_TICKET);
  assert.equal(evaluateBurn({ burn: 6.0001 }).action, ACTION_TICKET);
  // Just under slow-burn: silence.
  assert.equal(evaluateBurn({ burn: 5.9999 }).action, ACTION_NONE);
  assert.equal(evaluateBurn({ burn: 0 }).action, ACTION_NONE);
  assert.equal(evaluateBurn({ burn: 0 }).matched, null);
  // Deep into fast burn still pages.
  assert.equal(evaluateBurn({ burn: 1000 }).action, ACTION_PAGE);

  // Custom policies are honored.
  const custom = createPolicy({
    alerts: [
      { action: ACTION_PAGE, burn: 10 },
      { action: ACTION_NONE, burn: 2 }
    ]
  });
  assert.equal(evaluateBurn({ burn: 12, policy: custom }).action, ACTION_PAGE);
  assert.equal(evaluateBurn({ burn: 5, policy: custom }).action, ACTION_NONE);

  assert.throws(() => evaluateBurn({ burn: -1 }), TypeError);
  assert.throws(() => evaluateBurn({ burn: NaN }), TypeError);
  assert.throws(() => evaluateBurn({ burn: 10, policy: { alerts: [] } }), TypeError);
});

test("remainingBudget reports consumption and exhaustion", () => {
  // Floats: 1 - 0.999 is not exactly 0.001, so compare with tolerance.
  const approx = (actual, expected, label) =>
    assert.ok(Math.abs(actual - expected) < 1e-9, `${label}: ${actual} ≈ ${expected}`);

  const full = remainingBudget({ requests: 1000, errors: 0, sloTarget: 0.999 });
  approx(full.allowedErrors, 1, "full.allowedErrors");
  assert.equal(full.consumedErrors, 0);
  approx(full.remainingErrors, 1, "full.remainingErrors");
  assert.equal(full.remainingFraction, 1);
  assert.equal(full.exhausted, false);

  const half = remainingBudget({ requests: 2000, errors: 1, sloTarget: 0.999 });
  approx(half.allowedErrors, 2, "half.allowedErrors");
  approx(half.remainingErrors, 1, "half.remainingErrors");
  approx(half.remainingFraction, 0.5, "half.remainingFraction");
  assert.equal(half.exhausted, false);

  // One error against a ~1-error budget spends it but does not overdraw it
  // (float: 1 - 0.999 is slightly above 0.001, so 1 error < allowedErrors).
  const spent = remainingBudget({ requests: 1000, errors: 1, sloTarget: 0.999 });
  approx(spent.remainingFraction, 0, "spent.remainingFraction");
  approx(spent.remainingErrors, 0, "spent.remainingErrors");
  assert.equal(spent.exhausted, false);

  // Two errors overdraw the budget: exhausted.
  const overdrawn = remainingBudget({ requests: 1000, errors: 2, sloTarget: 0.999 });
  assert.equal(overdrawn.remainingFraction, 0);
  assert.equal(overdrawn.exhausted, true);

  // Over-budget: clamped, never negative.
  const over = remainingBudget({ requests: 1000, errors: 5, sloTarget: 0.999 });
  assert.equal(over.remainingFraction, 0);
  assert.equal(over.remainingErrors, 0);
  approx(over.consumedErrors, 1, "over.consumedErrors");
  assert.equal(over.exhausted, true);

  // No observations yet: budget untouched and not "exhausted".
  const empty = remainingBudget({ requests: 0, errors: 0, sloTarget: 0.999 });
  assert.equal(empty.allowedErrors, 0);
  assert.equal(empty.remainingFraction, 1);
  assert.equal(empty.exhausted, false);
});

test("startWindow validates and opens a zeroed window", () => {
  const w = startWindow({ sloTarget: 0.999, windowMs: 30 * DAY, startMs: START });
  assert.deepEqual(w, {
    sloTarget: 0.999,
    windowMs: 30 * DAY,
    startMs: START,
    requests: 0,
    errors: 0
  });
  assert.throws(() => startWindow({ sloTarget: 1, windowMs: DAY, startMs: START }), TypeError);
  assert.throws(() => startWindow({ sloTarget: 0.999, windowMs: 0, startMs: START }), TypeError);
  assert.throws(() => startWindow({ sloTarget: 0.999, windowMs: -5, startMs: START }), TypeError);
  assert.throws(() => startWindow({ sloTarget: 0.999, windowMs: DAY, startMs: -1 }), TypeError);
});

test("observe accumulates counts without mutating the input window", () => {
  const w = startWindow({ sloTarget: 0.999, windowMs: 30 * DAY, startMs: START });
  const w2 = observe(w, { requests: 100, errors: 2 });
  assert.equal(w2.requests, 100);
  assert.equal(w2.errors, 2);
  assert.equal(w.requests, 0); // original untouched
  assert.equal(w.errors, 0);
  const w3 = observe(w2, { requests: 50, errors: 1 });
  assert.equal(w3.requests, 150);
  assert.equal(w3.errors, 3);
  const w4 = observe(w3); // defaults add nothing
  assert.equal(w4.requests, 150);
  assert.throws(() => observe(w, { requests: 5, errors: 6 }), TypeError);
  assert.throws(() => observe(w, { requests: -1 }), TypeError);
  assert.throws(() => observe(null, { requests: 1 }), TypeError);
});

test("rollover resets the window when the compliance window elapses", () => {
  const w = observe(startWindow({ sloTarget: 0.999, windowMs: DAY, startMs: START }), {
    requests: 1000,
    errors: 1
  });
  // Mid-window: no rollover, same window object back.
  const mid = rollover(w, START + DAY / 2);
  assert.equal(mid.rolledOver, false);
  assert.equal(mid.window, w);
  // Exactly at the boundary counts as elapsed.
  const edge = rollover(w, START + DAY);
  assert.equal(edge.rolledOver, true);
  assert.equal(edge.window.requests, 0);
  assert.equal(edge.window.errors, 0);
  assert.equal(edge.window.startMs, START + DAY);
  assert.equal(edge.window.sloTarget, 0.999);
  // Multi-window drift collapses into a single fresh window at nowMs.
  const drifted = rollover(w, START + 5 * DAY);
  assert.equal(drifted.rolledOver, true);
  assert.equal(drifted.window.startMs, START + 5 * DAY);
  assert.throws(() => rollover(w, -1), TypeError);
  assert.throws(() => rollover(null, START), TypeError);
});

test("evaluateWindow combines rollover, burn, policy, and remaining budget", () => {
  let w = startWindow({ sloTarget: 0.999, windowMs: 30 * DAY, startMs: START });
  // Quiet traffic: no alert, budget intact.
  w = observe(w, { requests: 1000, errors: 0 });
  const quiet = evaluateWindow(w, DEFAULT_POLICY, START + DAY);
  assert.equal(quiet.action, ACTION_NONE);
  assert.equal(quiet.burn, 0);
  assert.equal(quiet.rolledOver, false);
  assert.equal(quiet.remaining.remainingFraction, 1);
  assert.equal(quiet.window.requests, 1000);

  // Fast burn: pages.
  const fast = evaluateWindow(
    observe(startWindow({ sloTarget: 0.999, windowMs: 30 * DAY, startMs: START }), {
      requests: 1000,
      errors: 15 // 1.5% error rate vs 0.1% allowed => 15x burn
    }),
    DEFAULT_POLICY,
    START + DAY
  );
  assert.equal(fast.action, ACTION_PAGE);
  assert.ok(Math.abs(fast.burn - 15) < 1e-9);
  assert.equal(fast.remaining.exhausted, true);

  // Slow burn: tickets.
  const slow = evaluateWindow(
    observe(startWindow({ sloTarget: 0.999, windowMs: 30 * DAY, startMs: START }), {
      requests: 1000,
      errors: 7 // 7x burn
    }),
    DEFAULT_POLICY,
    START + DAY
  );
  assert.equal(slow.action, ACTION_TICKET);

  // Window rollover inside evaluateWindow resets counts before evaluating.
  const rolled = evaluateWindow(w, DEFAULT_POLICY, START + 31 * DAY);
  assert.equal(rolled.rolledOver, true);
  assert.equal(rolled.window.requests, 0);
  assert.equal(rolled.action, ACTION_NONE);
});
