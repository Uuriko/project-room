// F009: error budget policy + paging rules (pairs with F023 incident runbook).
//
// This module answers "how much failure may we still afford, and who do we
// tell about it". It computes the error budget from an SLO target (e.g. a
// 99.9% target allows a 0.1% error rate), measures budget burn over a
// compliance window from observed request/error counts, and evaluates the
// burn rate against the Google SRE alerting tiers: a fast burn (>= 14.4x)
// pages, a slow burn (>= 6x) files a ticket, anything below stays silent.
// It also reports the remaining budget and resets the window on rollover.
// Pure functions, plain arguments, no I/O — clocks and policies are
// injectable so the F023 runbook can drive the same evaluation.
//
// API:
//   ACTION_PAGE / ACTION_TICKET / ACTION_NONE — the three evaluation
//     outcomes: "page" (wake someone up), "ticket" (file a low-urgency
//     ticket), "none" (stay silent).
//   DEFAULT_POLICY — the stock SRE policy: page at 14.4x burn, ticket at
//     6x burn. Alert rules are evaluated top-down; the first rule whose
//     burn threshold the observed burn meets or exceeds wins.
//   allowedErrorRate(sloTarget) — the fraction of requests that may fail,
//     e.g. 0.999 -> 0.001. Throws TypeError unless 0 < sloTarget < 1.
//   createPolicy(overrides) — merge overrides over DEFAULT_POLICY and
//     validate; throws TypeError on invalid thresholds (non-positive,
//     non-finite, or duplicate burn rates), unknown actions, or rules
//     not ordered strictly descending.
//   burnRate({ requests, errors, sloTarget }) — observed error rate
//     divided by the allowed error rate: 1 means burning exactly at
//     budget pace, 14.4 means burning 14.4x budget. Zero requests is
//     zero burn, not a division by zero.
//   evaluateBurn({ burn, policy }) — pure policy evaluation: returns
//     { action, burn, matched } where matched is the winning rule (or
//     null for ACTION_NONE). The policy defaults to DEFAULT_POLICY.
//   remainingBudget({ requests, errors, sloTarget }) — { allowedErrors,
//     consumedErrors, remainingErrors, remainingFraction, exhausted }.
//     remainingFraction is 1 minus the fraction of the budget consumed,
//     clamped to [0, 1]; exhausted is true once consumed >= allowed.
//   startWindow({ sloTarget, windowMs, startMs }) — open a compliance
//     window. Throws TypeError on invalid inputs.
//   observe(window, { requests = 0, errors = 0 }) — return a new window
//     with the counts accumulated; the input window is not mutated.
//   rollover(window, nowMs) — return { rolledOver, window }: when nowMs
//     has passed window start + windowMs the counts reset to zero and
//     the start moves to nowMs (multi-window drift collapses into one
//     fresh window); otherwise the window is returned unchanged.
//   evaluateWindow(window, policy, nowMs) — convenience wrapper: rolls
//     the window over, then reports { action, burn, remaining,
//     rolledOver, window }.
//
// Window shape: { sloTarget, windowMs, startMs, requests, errors } — all
// plain numbers; startMs is epoch milliseconds. nowMs is injectable
// (a bare ms number) so tests never touch a real clock.

export const ACTION_PAGE = "page";
export const ACTION_TICKET = "ticket";
export const ACTION_NONE = "none";

const ACTIONS = new Set([ACTION_PAGE, ACTION_TICKET, ACTION_NONE]);

// Google SRE "Alerting on SLOs": 14.4x burn over the fast window pages
// (exhausts the 30-day budget in ~2 days), 6x burn over the slow window
// files a ticket (exhausts it in ~5 days).
export const DEFAULT_POLICY = {
  name: "default-error-budget",
  version: 1,
  alerts: [
    { action: ACTION_PAGE, burn: 14.4, label: "fast burn" },
    { action: ACTION_TICKET, burn: 6, label: "slow burn" }
  ]
};

const isFiniteNumber = (v) => typeof v === "number" && Number.isFinite(v);

export function allowedErrorRate(sloTarget) {
  if (!isFiniteNumber(sloTarget) || sloTarget <= 0 || sloTarget >= 1) {
    throw new TypeError(
      `sloTarget must be a number strictly between 0 and 1, got ${String(sloTarget)}`
    );
  }
  return 1 - sloTarget;
}

function assertCounts({ requests, errors }, where) {
  for (const [label, value] of [["requests", requests], ["errors", errors]]) {
    if (!isFiniteNumber(value) || value < 0 || !Number.isInteger(value)) {
      throw new TypeError(`${where}: ${label} must be a non-negative integer, got ${String(value)}`);
    }
  }
  if (errors > requests) {
    throw new TypeError(`${where}: errors (${errors}) cannot exceed requests (${requests})`);
  }
}

function assertPolicyShape(policy) {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    throw new TypeError("policy must be an object");
  }
  if (!Array.isArray(policy.alerts) || policy.alerts.length === 0) {
    throw new TypeError("policy.alerts must be a non-empty array");
  }
  const seen = new Set();
  let previous = Infinity;
  for (const [index, rule] of policy.alerts.entries()) {
    if (!rule || typeof rule !== "object") {
      throw new TypeError(`policy.alerts[${index}] must be an object`);
    }
    if (!ACTIONS.has(rule.action)) {
      throw new TypeError(
        `policy.alerts[${index}].action must be one of page|ticket|none, got ${String(rule.action)}`
      );
    }
    if (!isFiniteNumber(rule.burn) || rule.burn <= 0) {
      throw new TypeError(
        `policy.alerts[${index}].burn must be a positive finite number, got ${String(rule.burn)}`
      );
    }
    if (seen.has(rule.burn)) {
      throw new TypeError(`policy.alerts[${index}].burn duplicates threshold ${rule.burn}`);
    }
    seen.add(rule.burn);
    if (rule.burn >= previous) {
      throw new TypeError(
        "policy.alerts must be ordered strictly descending by burn threshold"
      );
    }
    previous = rule.burn;
  }
}

export function createPolicy(overrides = {}) {
  if (overrides === null || typeof overrides !== "object" || Array.isArray(overrides)) {
    throw new TypeError("overrides must be an object");
  }
  const merged = {
    ...DEFAULT_POLICY,
    ...overrides,
    alerts: (overrides.alerts ?? DEFAULT_POLICY.alerts).map((rule) => ({ ...rule }))
  };
  assertPolicyShape(merged);
  return merged;
}

export function burnRate({ requests, errors, sloTarget }) {
  assertCounts({ requests, errors }, "burnRate");
  const allowed = allowedErrorRate(sloTarget);
  if (requests === 0) return 0;
  return (errors / requests) / allowed;
}

export function evaluateBurn({ burn, policy = DEFAULT_POLICY }) {
  if (!isFiniteNumber(burn) || burn < 0) {
    throw new TypeError(`burn must be a non-negative finite number, got ${String(burn)}`);
  }
  assertPolicyShape(policy);
  const matched = policy.alerts.find((rule) => burn >= rule.burn) ?? null;
  return { action: matched ? matched.action : ACTION_NONE, burn, matched };
}

export function remainingBudget({ requests, errors, sloTarget }) {
  assertCounts({ requests, errors }, "remainingBudget");
  const allowed = allowedErrorRate(sloTarget);
  const allowedErrors = requests * allowed;
  const consumedErrors = Math.min(errors, allowedErrors);
  const remainingErrors = Math.max(0, allowedErrors - errors);
  const remainingFraction =
    allowedErrors === 0 ? 1 : Math.min(1, Math.max(0, 1 - errors / allowedErrors));
  return {
    allowedErrors,
    consumedErrors,
    remainingErrors,
    remainingFraction,
    exhausted: errors > 0 && errors >= allowedErrors
  };
}

export function startWindow({ sloTarget, windowMs, startMs }) {
  allowedErrorRate(sloTarget);
  if (!isFiniteNumber(windowMs) || windowMs <= 0) {
    throw new TypeError(`windowMs must be a positive finite number, got ${String(windowMs)}`);
  }
  if (!isFiniteNumber(startMs) || startMs < 0) {
    throw new TypeError(`startMs must be a non-negative finite number, got ${String(startMs)}`);
  }
  return { sloTarget, windowMs, startMs, requests: 0, errors: 0 };
}

export function observe(window, { requests = 0, errors = 0 } = {}) {
  if (!window || typeof window !== "object") {
    throw new TypeError("window must be a window object from startWindow");
  }
  assertCounts({ requests, errors }, "observe");
  return {
    ...window,
    requests: window.requests + requests,
    errors: window.errors + errors
  };
}

export function rollover(window, nowMs) {
  if (!window || typeof window !== "object") {
    throw new TypeError("window must be a window object from startWindow");
  }
  if (!isFiniteNumber(nowMs) || nowMs < 0) {
    throw new TypeError(`nowMs must be a non-negative finite number, got ${String(nowMs)}`);
  }
  if (nowMs < window.startMs + window.windowMs) {
    return { rolledOver: false, window };
  }
  return {
    rolledOver: true,
    window: { ...window, startMs: nowMs, requests: 0, errors: 0 }
  };
}

export function evaluateWindow(window, policy = DEFAULT_POLICY, nowMs) {
  const { rolledOver, window: current } = rollover(window, nowMs);
  const burn = burnRate({
    requests: current.requests,
    errors: current.errors,
    sloTarget: current.sloTarget
  });
  const { action, matched } = evaluateBurn({ burn, policy });
  const remaining = remainingBudget({
    requests: current.requests,
    errors: current.errors,
    sloTarget: current.sloTarget
  });
  return { action, burn, matched, remaining, rolledOver, window: current };
}
