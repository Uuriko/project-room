// W4-38 G2: deterministic fake runner. Simulates start, output, failure,
// timeout and restart against a fixture store - no paid/provider execution
// of any kind. The caller injects the clock and the request-id sequence, so
// repeated runs over fresh stores produce the same attempt ledger and the
// same semantic event stream (transport ids stay random by design).
import { sessionRecord } from "../src/work-item-session.js";

// A wall clock that advances a fixed step per read; jump() skips ahead, which
// is how the scenario crosses a runtime budget without waiting.
export function steppedClock(startIso, stepMs = 60_000) {
  let current = Date.parse(startIso);
  const now = () => { const value = current; current += stepMs; return value; };
  now.jump = ms => { current += ms; };
  return now;
}

export function fixedIds(prefix = "fake-runner") {
  let n = 0;
  return () => `${prefix}-${String(++n).padStart(4, "0")}`;
}

// Drives one work item through the session API exactly as a real worker
// would (mutateWorkSession, the same entry the HTTP route uses), with every
// id and timestamp supplied by the caller's deterministic sources.
export function createFakeRunner({ store, roomId = "commons", key, workItemId,
  environment = "fake-runner-1", ids = fixedIds() }) {
  const revision = () => store.room(roomId).state.workItems[workItemId].revision;
  const act = body => store.mutateWorkSession(key, roomId,
    { requestId: ids(), workItemId, expectedRevision: revision(), ...body });
  return {
    start: ({ budget, environment: env } = {}) => act({ action: "set_status", status: "processing",
      environment: env ?? environment, ...(budget ? { budget } : {}) }),
    report: (status, spendCents) => act({ action: "set_status", status,
      ...(spendCents === undefined ? {} : { spendCents }) }),
    finish: (status, outputs) => act({ action: "set_status", status,
      ...(outputs === undefined ? {} : { outputs }) }),
    requestStop: () => act({ action: "request_stop" }),
    ledger: () => JSON.parse(JSON.stringify(sessionRecord(store.room(roomId).state.workItems[workItemId]).attempts))
  };
}

// The canonical scenario: start, output, failure, timeout (runtime budget
// trip), and a restart after each stop. Returns the final attempt ledger.
export function runScenario({ store, roomId = "commons", key, workItemId, clock }) {
  const runner = createFakeRunner({ store, roomId, key, workItemId });
  // 1. start + output: a clean run that records its result references.
  runner.start();
  runner.report("active");
  runner.finish("done", ["msg:fake-output-1"]);
  // 2. restart after done, then fail with a log reference.
  runner.start();
  runner.finish("failed", ["log:fake-run-2"]);
  // 3. timeout: start under a runtime budget, jump the clock past it, and the
  //    next report trips the wire - the session is force-stopped as failed.
  runner.start({ budget: { maxRuntimeMs: 300_000 } });
  clock.jump(300_001);
  let tripped = null;
  try { runner.report("active"); } catch (error) { tripped = error; }
  if (!tripped || !/budget exceeded/i.test(tripped.message)) {
    throw new Error("Expected the runtime budget to trip on the stale report");
  }
  // 4. restart after the timeout and finish clean.
  runner.start();
  runner.finish("done");
  return runner.ledger();
}
