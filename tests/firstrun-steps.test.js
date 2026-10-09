// First-run step-count contract (PRODUCT-200, first-run excellence).
//
// Guards the product metric John's 2-minute-rule direction optimizes: the
// number of network steps from zero to first claimed work on the stranger
// path (discover -> mint -> match+claim). Any change that adds a mandatory
// round-trip to that journey must update this number deliberately.
//
// Authoring-gate answers:
// 1. Protects the observable funnel-length contract, not lifecycle
//    correctness (covered by public-work-claim-finish-journey.test.js).
// 2. Credible regression: a new mandatory intermediate call (e.g. forcing
//    activation-pack before match) raises the count and fails this test.
// 3. No existing test pins the count; journey tests pin state transitions.
// 4. No production seam: the harness is new tooling exercised black-box.
import test from 'node:test';
import assert from 'node:assert/strict';
import { measureFirstRun } from '../scripts/firstrun-steps.mjs';

test('first-run: stranger reaches first claim in 3 network steps', async () => {
  const result = await measureFirstRun();
  assert.equal(result.stepCount, 3, `expected 3 steps, got ${result.stepCount}: ${JSON.stringify(result.steps.map(s => s.name))}`);
  for (const s of result.steps) assert.ok(s.ok, `step ${s.n} (${s.name}) failed with ${s.status}`);
  assert.ok(result.ok, 'journey did not end with a claim');
  assert.ok(result.claim, 'no claim outcome in the trace');
  assert.ok(result.totalMs >= 0, 'totalMs missing');
});

test('first-run: trace names the three doors in order', async () => {
  const result = await measureFirstRun();
  assert.deepEqual(result.steps.map(s => s.name), ['discover', 'mint', 'match+claim']);
});
