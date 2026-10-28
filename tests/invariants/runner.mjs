// Invariant harness runner.
//
// Boots a fresh disposable database per scenario, runs the scenario's
// declare -> act -> assert phases, and tears the database down. Every
// scenario registered through this module gets the same lifecycle, so
// invariant authors never write fixture plumbing.
//
// This is the PERMANENT CI gate (runs under `node --test`): it pins
// never-break product invariants at the store level. WAVE-300's replay
// harness is a different tool (sim-before-live); do not merge the two.
import test from "node:test";
import { rmSync } from "node:fs";
import { createAcceptanceFixture } from "../../scripts/acceptance-fixture.mjs";

// Boot a fresh disposable database and register teardown on the test
// context. Returns the fixture (f.store, f.keys, f.directory, ...).
export function bootInvariantDB(t) {
  const f = createAcceptanceFixture();
  t.after(() => {
    try { f.store.close(); } finally {
      rmSync(f.directory, { recursive: true, force: true });
    }
  });
  return f;
}

// Run one invariant scenario object:
//   { id, title, arrange(f) -> ctx, act(f, ctx) -> ctx, assert(f, ctx) }
// arrange declares the preconditions (declare), act performs the
// operations under test, assert pins the invariant. act may throw when
// the operation under test is expected to be refused — assert then
// inspects the refusal.
export function runInvariant(scenario) {
  if (!scenario || typeof scenario.id !== "string" || !scenario.id) {
    throw new Error("invariant scenario must have a non-empty string id");
  }
  if (typeof scenario.assert !== "function") {
    throw new Error(`invariant ${scenario.id} must define an assert(f, ctx) phase`);
  }
  test(`invariant ${scenario.id}: ${scenario.title ?? "untitled"}`, async t => {
    const f = bootInvariantDB(t);
    let ctx = {};
    if (scenario.arrange) ctx = (await scenario.arrange(f, ctx)) ?? ctx;
    if (scenario.act) ctx = (await scenario.act(f, ctx)) ?? ctx;
    await scenario.assert(f, ctx);
  });
}

// Register a whole suite of scenarios with one call.
export function invariantSuite(scenarios) {
  for (const scenario of scenarios) runInvariant(scenario);
}
