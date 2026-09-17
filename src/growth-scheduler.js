// Track C slice C13 — Growth scheduler wiring.
//
// Drives a C12 watcher on a fixed cadence. Each tick calls watcher.tick()
// inside its own try/catch — a throwing tick is logged and counted, never
// propagated. Triggered alert hits are delivered to an onAlert callback;
// the default logs one structured console line per hit (no delivery
// channels, no message bodies — identifier-only privacy, same as the rest
// of Track C).
//
// The timer is unref()'d, so the scheduler never keeps the process alive by
// itself. Pure apart from the C9/C12 family modules, setInterval and
// console. No network, no storage, no I/O of its own.

import { activitySurgeRule, deadWindowRule } from "./growth-alerts.js";

export const DEFAULT_INTERVAL_MS = 300000;

const oneLine = value =>
  String(value ?? "").replace(/[\r\n]+/g, " ").trim();

const isWatcher = watcher =>
  watcher !== null && typeof watcher === "object" && typeof watcher.tick === "function";

// Default alert delivery: one structured console line per triggered hit.
// Hit shape is the C9 evaluateAlerts() hit {ruleId, kind, triggered,
// severity, detail}. Newlines are stripped so the line stays greppable;
// detail carries identifiers and counts only, never message bodies.
export function defaultOnAlert(hit, context) {
  const h = hit !== null && typeof hit === "object" ? hit : {};
  const at = context && typeof context.at === "string" ? ` at=${oneLine(context.at)}` : "";
  console.log(
    `[growth-alert] ${oneLine(h.severity)} ${oneLine(h.kind)} ${oneLine(h.ruleId)}:${at} ${oneLine(h.detail)}`
  );
}

// A small sensible default rule set for server wiring: warn when the chat
// goes quiet for a whole tick window, and note member-join surges of 100%+
// against the previous window.
export function defaultGrowthRules() {
  return Object.freeze([
    deadWindowRule({ eventTypes: ["message.sent"], ruleId: "growth:dead-chat", severity: "warn" }),
    activitySurgeRule({ eventType: "member.joined", pctThreshold: 1.0, ruleId: "growth:join-surge", severity: "warn" })
  ]);
}

// Create a scheduler over a C12 watcher. start() is a no-op when already
// running or when intervalMs <= 0 (disabled). stop() is idempotent.
export function createScheduler({ watcher, intervalMs = DEFAULT_INTERVAL_MS, onAlert = defaultOnAlert } = {}) {
  if (!isWatcher(watcher)) {
    throw new TypeError("growth-scheduler: watcher must be an object exposing tick()");
  }
  if (typeof intervalMs !== "number" || !Number.isFinite(intervalMs)) {
    throw new TypeError("growth-scheduler: intervalMs must be a finite number");
  }
  if (typeof onAlert !== "function") {
    throw new TypeError("growth-scheduler: onAlert must be a function");
  }

  let timer = null;
  let tickCount = 0;
  let errorCount = 0;

  function runTick() {
    let result;
    try {
      result = watcher.tick();
    } catch (error) {
      errorCount += 1;
      console.warn(`[growth] scheduler tick failed (${errorCount} errors): ${oneLine(error?.message ?? error)}`);
      return;
    }
    tickCount += 1;
    const triggered = result !== null && typeof result === "object" && Array.isArray(result.triggered)
      ? result.triggered
      : [];
    const context = {
      tickCount,
      at: new Date().toISOString(),
      window: result !== null && typeof result === "object" ? (result.window ?? null) : null
    };
    for (const hit of triggered) {
      try {
        onAlert(hit, context);
      } catch (error) {
        const ruleId = hit !== null && typeof hit === "object" ? hit.ruleId : undefined;
        console.warn(`[growth] alert delivery failed for ${oneLine(ruleId ?? "?")}: ${oneLine(error?.message ?? error)}`);
      }
    }
  }

  function start() {
    if (timer !== null) return; // already running
    if (intervalMs <= 0) return; // disabled
    timer = setInterval(runTick, intervalMs);
    if (timer !== null && typeof timer.unref === "function") timer.unref();
  }

  function stop() {
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
  }

  function isRunning() {
    return timer !== null;
  }

  function getTickCount() {
    return tickCount;
  }

  function getErrorCount() {
    return errorCount;
  }

  // Exposed for tests (unref assertion) and operators; not part of the
  // delivery contract.
  function getTimer() {
    return timer;
  }

  return Object.freeze({ start, stop, isRunning, getTickCount, getErrorCount, getTimer });
}
