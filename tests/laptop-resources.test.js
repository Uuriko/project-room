import test from "node:test";
import assert from "node:assert/strict";
import { laptopBudget } from "../client/laptop-resources.mjs";
const GiB = 1024 ** 3;
const observation = { at: 1000, cpuCount: 10, freeMemoryBytes: 20 * GiB, freeDiskBytes: 100 * GiB, load1: 0, power: "ac", batteryPercent: 100 };
const policy = { mode: "idle-heavy", maxJobs: 8, memoryPerJobBytes: 2 * GiB, reserveMemoryBytes: 4 * GiB, reserveDiskBytes: 10 * GiB, allowBattery: false };
test("idle plugged-in laptops can contribute heavily while retaining owner reserves", () => {
  assert.equal(laptopBudget(observation, policy, 1000).slots, 8);
  assert.equal(laptopBudget(observation, { ...policy, mode: "balanced" }, 1000).slots, 5);
  assert.equal(laptopBudget({ ...observation, load1: 8 }, policy, 1000).slots, 1);
});
test("stale readings, pause, low battery, memory pressure and disk pressure prevent new work", () => {
  assert.equal(laptopBudget(observation, policy, 40000).reason, "stale_observation");
  assert.equal(laptopBudget({ ...observation, at: 2000 }, policy, 1000).available, false);
  assert.equal(laptopBudget(observation, { ...policy, paused: true }, 1000).reason, "paused");
  assert.equal(laptopBudget({ ...observation, power: "unknown" }, policy, 1000).available, false);
  assert.equal(laptopBudget({ ...observation, power: "battery", batteryPercent: 10 }, { ...policy, allowBattery: true }, 1000).available, false);
  assert.equal(laptopBudget({ ...observation, freeMemoryBytes: GiB }, policy, 1000).available, false);
  assert.equal(laptopBudget({ ...observation, freeDiskBytes: GiB }, policy, 1000).available, false);
});
