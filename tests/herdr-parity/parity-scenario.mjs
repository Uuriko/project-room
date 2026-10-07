// The scripted Phase-A scenario, backend-agnostic.
//
// claim → session → heartbeat → blocked → done
//
// runScenario(createDriver) builds a driver, executes the five ops in
// order, and returns the driver's room-observable trace. The SAME scenario
// runs against the legacy backend and the SessionAdapter backend; the
// comparator then asserts the traces are identical.
//
// Driver contract (see legacy-driver.mjs / herdr-driver.mjs):
//   driver.backend: "legacy" | "herdr"
//   await driver.claim(taskId, agentId)
//   await driver.startSession(taskId, agentId)
//   await driver.heartbeat(taskId, agentId)
//   await driver.reportBlocked(taskId, agentId, note)
//   await driver.finish(taskId, agentId, note)
//   await driver.tryOp(fn) -> { ok:true } | { ok:false, code, message }
//   await driver.illegalFinish(taskId, agentId) -> throws ClaimError
//   driver.trace() -> { backend, steps, journal, eventSequence }
//   await driver.close()
export const SCENARIO = Object.freeze({
  taskId: "parity-task-1",
  title: "parity scenario task",
  agentId: "ai_paritylane",
  hostId: "parity-host-1",
  blockedNote: "waiting on review",
  doneNote: "shipped",
});

export async function runScenario(createDriver) {
  const driver = await createDriver();
  try {
    await driver.claim(SCENARIO.taskId, SCENARIO.agentId);
    await driver.startSession(SCENARIO.taskId, SCENARIO.agentId);
    await driver.heartbeat(SCENARIO.taskId, SCENARIO.agentId);
    await driver.reportBlocked(SCENARIO.taskId, SCENARIO.agentId, SCENARIO.blockedNote);
    await driver.finish(SCENARIO.taskId, SCENARIO.agentId, SCENARIO.doneNote);
    return driver.trace();
  } finally {
    await driver.close();
  }
}
