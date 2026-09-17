// Track C slice C12 — Tick-driven growth alert evaluation loop.
//
// A watcher summarizes the C2 collector over a trailing window on every
// tick, compares the fresh summary against the previous tick's summary
// (C8), and evaluates the configured C9 alert rules. The caller drives the
// cadence — there are no timers here; scheduler wiring is a later slice.
//
// Pure and dependency-free apart from the C5/C8/C9 modules. No network, no
// storage, no I/O. Results are frozen; evaluation is deterministic given the
// same events and tick times.
//
// Fan-out note: tick() does NOT publish alert hits to a fan-out hub. The
// C6 hub's notify() validates every envelope against the C1 growth-event
// contract, and alert hits cannot be represented as a C1 envelope without
// inventing a new event type — so publishing would silently no-op. The
// `fanout` option is accepted and shape-checked (held for the future
// delivery design), but tick() returns triggered hits for the caller to
// deliver instead. Alert delivery wiring is a later slice.

import { summarize } from "./growth-summary.js";
import { compareSummaries } from "./growth-compare.js";
import { evaluateAlerts } from "./growth-alerts.js";

export const DEFAULT_WINDOW_MS = 3600000;

const isPlainObject = value =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const checkCollector = collector => {
  if (!isPlainObject(collector)) {
    throw new TypeError("growth-watch: collector must be a collector object");
  }
  if (typeof collector.query !== "function" || typeof collector.stats !== "function") {
    throw new TypeError("growth-watch: collector must expose query() and stats()");
  }
  return collector;
};

const checkRules = rules => {
  if (!Array.isArray(rules)) throw new TypeError("growth-watch: rules must be an array");
  return rules;
};

const checkWindowMs = value => {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new TypeError("growth-watch: windowMs must be a positive finite number");
  }
  return value;
};

const checkFanout = fanout => {
  if (fanout === null || fanout === undefined) return null;
  if (!isPlainObject(fanout) || typeof fanout.notify !== "function") {
    throw new TypeError("growth-watch: fanout must be a fan-out hub exposing notify()");
  }
  // Held for the future delivery design — see the module header. Alert
  // hits are returned to the caller instead of being published.
  return fanout;
};

const checkNow = now => {
  if (now === undefined || now === null) return new Date();
  const date = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError("growth-watch: tick now must be a Date or a parseable timestamp");
  }
  return date;
};

const freezeDeep = value => {
  if (Array.isArray(value)) {
    value.forEach(freezeDeep);
    return Object.freeze(value);
  }
  if (value && typeof value === "object") {
    Object.values(value).forEach(freezeDeep);
    return Object.freeze(value);
  }
  return value;
};

// Create a watcher over a collector. tick() evaluates the rules on every
// call; setRules() swaps the rule set between ticks.
export function createWatcher({ collector, rules, fanout = null, windowMs = DEFAULT_WINDOW_MS } = {}) {
  checkCollector(collector);
  let currentRules = checkRules(rules);
  checkFanout(fanout);
  checkWindowMs(windowMs);

  let previousSummary = null;
  let lastRun = null;

  // Run one evaluation pass over the trailing window [now - windowMs, now].
  // The first tick has no previous summary, so comparison is null and
  // comparison-needing rules report "needs comparison" (C9 semantics).
  // Returns a frozen { summary, comparison, hits, triggered, published,
  // window } result. published is always 0 — see the module header.
  function tick(now) {
    const at = checkNow(now);
    const until = at.toISOString();
    const since = new Date(at.getTime() - windowMs).toISOString();

    const summary = summarize(collector, { since, until });
    const comparison = previousSummary === null ? null : compareSummaries(summary, previousSummary);
    const hits = evaluateAlerts(currentRules, { summary, comparison });
    const triggered = hits.filter(hit => hit.triggered);

    previousSummary = summary;
    lastRun = until;

    return freezeDeep({
      summary,
      comparison,
      hits,
      triggered,
      published: 0,
      window: { since, until }
    });
  }

  // ISO timestamp of the most recent tick, or null before the first tick.
  function getLastRun() {
    return lastRun;
  }

  // The summary produced by the most recent tick, or null before the first tick.
  function getPreviousSummary() {
    return previousSummary;
  }

  // Replace the rule set used by future ticks. The stored previous summary
  // is kept, so comparison-needing rules work across the swap.
  function setRules(nextRules) {
    currentRules = checkRules(nextRules);
  }

  return Object.freeze({ tick, getLastRun, getPreviousSummary, setRules });
}
