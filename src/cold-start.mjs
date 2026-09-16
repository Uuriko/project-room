// F011: cold-start optimization — analyze and shrink startup time under a budget.
//
// This module answers "why is startup slow, and what do we move off the
// critical path to get under 2 seconds". Startup is modeled as named
// phases (module import, env load, DB connect, cache warm, ...), each with
// an estimated duration in milliseconds and flags describing whether it
// may be deferred (lazy-loaded after first response) and what it depends
// on. The module totals the estimated duration against a budget, ranks
// optimizations by estimated savings (defer deferrable phases off the
// critical path, run independent phases in parallel), and projects the
// what-if total once a set of recommendations is applied.
// Pure functions, plain arguments, no I/O — clocks are injectable so
// tests measure with a stub clock and never touch a real timer.
//
// Phase shape: { name, estimatedMs, deferrable?, dependsOn? } —
//   name is a non-empty string, unique across the phase list;
//   estimatedMs is a positive finite number of milliseconds;
//   deferrable (default false) means the phase may be lazy-loaded after
//     the first response instead of blocking startup;
//   dependsOn (default []) lists phase names that must complete first;
//     a phase with dependents can never be deferred.
// Definition shape for timeStartup: { name, work, deferrable?, dependsOn? }
//   where work is a function run once per phase and timed with the clock.
//
// API:
//   DEFAULT_BUDGET_MS — the stock cold-start budget: 2000 ms.
//   OPTIMIZATION_DEFER / OPTIMIZATION_PARALLELIZE — the two
//     recommendation kinds.
//   defaultClock() — { now } backed by Date.now(); a convenience for
//     real measurements. Everything else takes an injected clock.
//   measurePhase(name, work, clock) — run work once, return
//     { name, estimatedMs } timed with clock.now(). Throws TypeError on
//     bad inputs or a clock that moves backwards.
//   timeStartup(definitions, clock) — measure every definition in order,
//     returning the phase list (name, estimatedMs, deferrable, dependsOn).
//     The input definitions are not mutated.
//   totalEstimate(phases) — sum of estimatedMs.
//   criticalPathMs(phases) — sum of non-deferrable estimatedMs; what
//     startup costs once every deferrable phase is lazy-loaded.
//   evaluateStartup(phases, budgetMs) — { totalMs, budgetMs,
//     withinBudget, overageMs, headroomMs, criticalPathMs,
//     deferrableMs, phases } where phases is the per-phase breakdown
//     { name, estimatedMs, deferrable, onCriticalPath, fraction } and
//     fraction is the phase's share of totalMs (0 when totalMs is 0).
//     budgetMs defaults to DEFAULT_BUDGET_MS.
//   recommendations(phases, budgetMs) — ranked optimization list, highest
//     estimatedSavingsMs first, empty when already within budget. Each
//     entry is { kind, phases, estimatedSavingsMs, description }:
//     "defer" moves one deferrable phase with no dependents off the
//     critical path (savings = its full duration); "parallelize" runs a
//     group of two or more independent non-deferrable phases concurrently
//     (savings = group sum minus the longest member). A phase is
//     independent when it has no dependencies and nothing depends on it.
//   projectedTotal(phases, appliedRecommendations, budgetMs) — what-if
//     evaluation after applying a subset of recommendations(): returns
//     { totalMs, budgetMs, withinBudget, overageMs, headroomMs,
//       appliedCount }. Each applied recommendation must be one that
//     recommendations(phases, budgetMs) currently returns (matched by
//     kind and phase set); unknown or duplicated entries throw TypeError.

export const DEFAULT_BUDGET_MS = 2000;

export const OPTIMIZATION_DEFER = "defer";
export const OPTIMIZATION_PARALLELIZE = "parallelize";

const isFiniteNumber = (v) => typeof v === "number" && Number.isFinite(v);

function assertName(name, where) {
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new TypeError(`${where}: name must be a non-empty string, got ${String(name)}`);
  }
}

function assertClock(clock, where) {
  if (!clock || typeof clock !== "object" || typeof clock.now !== "function") {
    throw new TypeError(`${where}: clock must be an object with a now() function`);
  }
}

function assertPhases(phases) {
  if (!Array.isArray(phases)) {
    throw new TypeError(`phases must be an array, got ${String(phases)}`);
  }
  const seen = new Set();
  for (const [index, phase] of phases.entries()) {
    const where = `phases[${index}]`;
    if (!phase || typeof phase !== "object" || Array.isArray(phase)) {
      throw new TypeError(`${where} must be an object`);
    }
    assertName(phase.name, where);
    if (seen.has(phase.name)) {
      throw new TypeError(`${where}: duplicate phase name ${JSON.stringify(phase.name)}`);
    }
    seen.add(phase.name);
    if (!isFiniteNumber(phase.estimatedMs) || phase.estimatedMs <= 0) {
      throw new TypeError(
        `${where}: estimatedMs must be a positive finite number, got ${String(phase.estimatedMs)}`
      );
    }
    if (phase.deferrable !== undefined && typeof phase.deferrable !== "boolean") {
      throw new TypeError(`${where}: deferrable must be a boolean, got ${String(phase.deferrable)}`);
    }
    if (phase.dependsOn !== undefined && !Array.isArray(phase.dependsOn)) {
      throw new TypeError(`${where}: dependsOn must be an array of phase names`);
    }
    for (const dep of phase.dependsOn ?? []) {
      if (typeof dep !== "string") {
        throw new TypeError(`${where}: dependsOn entries must be strings, got ${String(dep)}`);
      }
    }
  }
  const names = new Set(phases.map((p) => p.name));
  for (const phase of phases) {
    for (const dep of phase.dependsOn ?? []) {
      if (dep === phase.name) {
        throw new TypeError(`phase ${JSON.stringify(phase.name)} cannot depend on itself`);
      }
      if (!names.has(dep)) {
        throw new TypeError(
          `phase ${JSON.stringify(phase.name)} depends on unknown phase ${JSON.stringify(dep)}`
        );
      }
    }
  }
  return phases;
}

function assertBudgetMs(budgetMs) {
  if (!isFiniteNumber(budgetMs) || budgetMs <= 0) {
    throw new TypeError(`budgetMs must be a positive finite number, got ${String(budgetMs)}`);
  }
}

export function defaultClock() {
  return { now: () => Date.now() };
}

export function measurePhase(name, work, clock = defaultClock()) {
  assertName(name, "measurePhase");
  if (typeof work !== "function") {
    throw new TypeError(`measurePhase: work must be a function, got ${String(work)}`);
  }
  assertClock(clock, "measurePhase");
  const startMs = clock.now();
  work();
  const endMs = clock.now();
  if (!isFiniteNumber(startMs) || !isFiniteNumber(endMs)) {
    throw new TypeError("measurePhase: clock.now() must return finite numbers");
  }
  if (endMs < startMs) {
    throw new TypeError(
      `measurePhase: clock moved backwards (${startMs} -> ${endMs})`
    );
  }
  return { name, estimatedMs: endMs - startMs };
}

export function timeStartup(definitions, clock = defaultClock()) {
  if (!Array.isArray(definitions)) {
    throw new TypeError(`definitions must be an array, got ${String(definitions)}`);
  }
  assertClock(clock, "timeStartup");
  return definitions.map((def, index) => {
    const where = `definitions[${index}]`;
    if (!def || typeof def !== "object" || Array.isArray(def)) {
      throw new TypeError(`${where} must be an object`);
    }
    if (def.deferrable !== undefined && typeof def.deferrable !== "boolean") {
      throw new TypeError(`${where}: deferrable must be a boolean, got ${String(def.deferrable)}`);
    }
    if (def.dependsOn !== undefined && !Array.isArray(def.dependsOn)) {
      throw new TypeError(`${where}: dependsOn must be an array of phase names`);
    }
    const measured = measurePhase(def.name, def.work, clock);
    return {
      name: measured.name,
      estimatedMs: measured.estimatedMs,
      deferrable: def.deferrable ?? false,
      dependsOn: [...(def.dependsOn ?? [])]
    };
  });
}

export function totalEstimate(phases) {
  assertPhases(phases);
  return phases.reduce((sum, phase) => sum + phase.estimatedMs, 0);
}

export function criticalPathMs(phases) {
  assertPhases(phases);
  return phases
    .filter((phase) => !(phase.deferrable ?? false))
    .reduce((sum, phase) => sum + phase.estimatedMs, 0);
}

export function evaluateStartup(phases, budgetMs = DEFAULT_BUDGET_MS) {
  assertPhases(phases);
  assertBudgetMs(budgetMs);
  const totalMs = totalEstimate(phases);
  const critical = criticalPathMs(phases);
  const breakdown = phases.map((phase) => ({
    name: phase.name,
    estimatedMs: phase.estimatedMs,
    deferrable: phase.deferrable ?? false,
    onCriticalPath: !(phase.deferrable ?? false),
    fraction: totalMs === 0 ? 0 : phase.estimatedMs / totalMs
  }));
  return {
    totalMs,
    budgetMs,
    withinBudget: totalMs <= budgetMs,
    overageMs: Math.max(0, totalMs - budgetMs),
    headroomMs: Math.max(0, budgetMs - totalMs),
    criticalPathMs: critical,
    deferrableMs: totalMs - critical,
    phases: breakdown
  };
}

// A phase may be deferred only when nothing else depends on it: deferring
// a dependency would strand its dependents on the critical path.
function deferEligible(phases) {
  const dependedUpon = new Set();
  for (const phase of phases) {
    for (const dep of phase.dependsOn ?? []) {
      dependedUpon.add(dep);
    }
  }
  return phases.filter(
    (phase) => (phase.deferrable ?? false) && !dependedUpon.has(phase.name)
  );
}

// Independent phases touch nothing else: no dependencies of their own and
// nothing depends on them, so they may run concurrently with the rest of
// startup. Deferrable phases are excluded here — deferring them dominates
// parallelizing them, and recommendations() lists the defer instead.
function independentGroups(phases) {
  const dependedUpon = new Set();
  for (const phase of phases) {
    for (const dep of phase.dependsOn ?? []) {
      dependedUpon.add(dep);
    }
  }
  const independent = phases.filter(
    (phase) =>
      !(phase.deferrable ?? false) &&
      (phase.dependsOn ?? []).length === 0 &&
      !dependedUpon.has(phase.name)
  );
  // One group per recommendation keeps the savings attribution exact; a
  // single group over all independent phases maximizes the win.
  return independent.length >= 2 ? [independent] : [];
}

export function recommendations(phases, budgetMs = DEFAULT_BUDGET_MS) {
  assertPhases(phases);
  assertBudgetMs(budgetMs);
  const { withinBudget } = evaluateStartup(phases, budgetMs);
  if (withinBudget) return [];

  const recs = [];

  for (const phase of deferEligible(phases)) {
    recs.push({
      kind: OPTIMIZATION_DEFER,
      phases: [phase.name],
      estimatedSavingsMs: phase.estimatedMs,
      description:
        `Defer "${phase.name}" (lazy-load after first response): ` +
        `removes ${phase.estimatedMs}ms from the critical path.`
    });
  }

  for (const group of independentGroups(phases)) {
    const sum = group.reduce((total, phase) => total + phase.estimatedMs, 0);
    const longest = Math.max(...group.map((phase) => phase.estimatedMs));
    const names = group.map((phase) => phase.name).join('", "');
    recs.push({
      kind: OPTIMIZATION_PARALLELIZE,
      phases: group.map((phase) => phase.name),
      estimatedSavingsMs: sum - longest,
      description:
        `Parallelize independent phases "${names}": ` +
        `run concurrently so the group costs ${longest}ms instead of ${sum}ms.`
    });
  }

  // Rank by estimated savings, highest first; ties break alphabetically
  // by phase list so the order is deterministic.
  recs.sort(
    (a, b) =>
      b.estimatedSavingsMs - a.estimatedSavingsMs ||
      a.phases.join(",").localeCompare(b.phases.join(","))
  );
  return recs;
}

function matchRecommendation(available, applied) {
  if (!applied || typeof applied !== "object" || Array.isArray(applied)) {
    throw new TypeError("applied recommendations must be recommendation objects");
  }
  const key = (rec) => `${rec.kind}:${[...rec.phases].sort().join(",")}`;
  const wanted = key(applied);
  const found = available.find((rec) => key(rec) === wanted);
  if (!found) {
    throw new TypeError(
      `unknown recommendation (not offered for these phases): ${JSON.stringify(applied)}`
    );
  }
  return found;
}

export function projectedTotal(phases, appliedRecommendations, budgetMs = DEFAULT_BUDGET_MS) {
  assertPhases(phases);
  assertBudgetMs(budgetMs);
  if (!Array.isArray(appliedRecommendations)) {
    throw new TypeError(
      `appliedRecommendations must be an array, got ${String(appliedRecommendations)}`
    );
  }
  const available = recommendations(phases, budgetMs);
  const seen = new Set();
  let totalMs = totalEstimate(phases);

  for (const applied of appliedRecommendations) {
    const rec = matchRecommendation(available, applied);
    const id = `${rec.kind}:${[...rec.phases].sort().join(",")}`;
    if (seen.has(id)) {
      throw new TypeError(`duplicate recommendation applied: ${JSON.stringify(applied)}`);
    }
    seen.add(id);
    // Both kinds are precomputed as exact critical-path savings by
    // recommendations(): defer removes the phase outright, parallelize
    // collapses the independent group from sum to longest.
    totalMs -= rec.estimatedSavingsMs;
  }

  return {
    totalMs,
    budgetMs,
    withinBudget: totalMs <= budgetMs,
    overageMs: Math.max(0, totalMs - budgetMs),
    headroomMs: Math.max(0, budgetMs - totalMs),
    appliedCount: appliedRecommendations.length
  };
}
