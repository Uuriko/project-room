// Command admission gate (WAVE-300 item 2 — honest backpressure).
//
// Pure-module unit tests: the gate keeps an in-flight count for POST
// /commands processing and sheds fast once the bound is reached. The module
// is dependency-free with an injectable clock, so these tests need no
// server imports at all.
import test from "node:test";
import assert from "node:assert/strict";
import { createCommandAdmission } from "../server/command-admission.mjs";

test("enter admits below the bound and counts in-flight", () => {
  const gate = createCommandAdmission({ maxInFlight: 3 });
  for (let i = 0; i < 3; i++) {
    const result = gate.enter();
    assert.equal(result.admitted, true);
  }
  assert.equal(gate.state().inFlight, 3);
});

test("enter refuses at the bound with the shed shape", () => {
  const gate = createCommandAdmission({ maxInFlight: 2 });
  assert.equal(gate.enter().admitted, true);
  assert.equal(gate.enter().admitted, true);
  const shed = gate.enter();
  assert.equal(shed.admitted, false);
  assert.equal(shed.retryAfterMs, 1000);
  assert.equal(shed.inFlight, 2);
});

test("a refusal does not consume capacity; a later leave re-admits", () => {
  const gate = createCommandAdmission({ maxInFlight: 1 });
  assert.equal(gate.enter().admitted, true);
  assert.equal(gate.enter().admitted, false);
  assert.equal(gate.state().inFlight, 1, "shed requests must not inflate the gauge");
  gate.leave();
  assert.equal(gate.enter().admitted, true);
});

test("leave decrements but never goes below zero", () => {
  const gate = createCommandAdmission({ maxInFlight: 2 });
  gate.enter();
  gate.leave();
  assert.equal(gate.state().inFlight, 0);
  gate.leave();
  gate.leave();
  assert.equal(gate.state().inFlight, 0);
});

test("outputs are frozen", () => {
  const gate = createCommandAdmission({ maxInFlight: 1 });
  assert.ok(Object.isFrozen(gate.enter()));
  assert.ok(Object.isFrozen(gate.enter()));
  assert.ok(Object.isFrozen(gate.state()));
});

test("default bound is 16 and retryAfterMs defaults to a constant 1000ms", () => {
  const gate = createCommandAdmission();
  for (let i = 0; i < 16; i++) assert.equal(gate.enter().admitted, true);
  const shed = gate.enter();
  assert.equal(shed.admitted, false);
  assert.equal(shed.retryAfterMs, 1000);
  assert.equal(gate.state().maxInFlight, 16);
});

test("clock is injectable and exposed via state()", () => {
  let t = 1234;
  const gate = createCommandAdmission({ maxInFlight: 4, now: () => t });
  assert.equal(gate.state().now, 1234);
  t = 5678;
  assert.equal(gate.state().now, 5678);
});

test("state reports shed refusals (feeds future load-calendar tuning)", () => {
  const gate = createCommandAdmission({ maxInFlight: 1 });
  assert.equal(gate.state().shed, 0);
  gate.enter();
  gate.enter();
  gate.enter();
  assert.equal(gate.state().shed, 2);
});
