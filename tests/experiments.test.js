// EXP-1 shared experiment assignment: default off, qa- rooms only by default.
import assert from "node:assert/strict";
import test from "node:test";
import { experimentArm, experimentInScope, listProductExperiments } from "../server/experiments.mjs";

const on = { ROOM_EXPERIMENTS: "cold_read_latest" };

test("off by default: every unit gets the control arm", () => {
  for (let i = 0; i < 200; i += 1) assert.equal(experimentArm("cold_read_latest", `ai_${i}`, { roomId: "qa-x", env: {} }), "oldest");
});

test("enabled experiments split only qa- rooms unless scope is all", () => {
  assert.equal(experimentInScope("qa-room", on), true);
  assert.equal(experimentInScope("project-room-lobby", on), false);
  assert.equal(experimentInScope("project-room-lobby", { ...on, ROOM_EXPERIMENTS_SCOPE: "all" }), true);
  for (let i = 0; i < 200; i += 1) assert.equal(experimentArm("cold_read_latest", `ai_${i}`, { roomId: "project-room-lobby", env: on }), "oldest");
});

test("assignment is deterministic and splits evenly in scope", () => {
  const counts = { oldest: 0, latest: 0 };
  for (let i = 0; i < 10_000; i += 1) {
    const arm = experimentArm("cold_read_latest", `ai_${i}`, { roomId: "qa-x", env: on });
    assert.equal(experimentArm("cold_read_latest", `ai_${i}`, { roomId: "qa-y", env: on }), arm);
    counts[arm] += 1;
  }
  assert.ok(Math.abs(counts.oldest - 5_000) <= 300, JSON.stringify(counts));
});

test("force pins an arm only where enabled; unknown ids return null", () => {
  assert.equal(experimentArm("cold_read_latest", "ai_1", { roomId: "qa-x", env: { ...on, GROWTH_FORCE_ARMS: "cold_read_latest:latest" } }), "latest");
  assert.equal(experimentArm("cold_read_latest", "ai_1", { roomId: "qa-x", env: { GROWTH_FORCE_ARMS: "cold_read_latest:latest" } }), "oldest");
  assert.equal(experimentArm("nope", "ai_1", { roomId: "qa-x", env: on }), null);
  assert.equal(experimentArm("cold_read_latest", "", { roomId: "qa-x", env: on }), "oldest");
  assert.deepEqual(listProductExperiments().map(e => e.id), ["cold_read_latest"]);
});
