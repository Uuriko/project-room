import test from "node:test";
import assert from "node:assert/strict";
import { planStages, parseArgs, STAGE_ORDER } from "../scripts/release-verify.mjs";

const baseFacts = {
  target: null,
  offline: false,
  requireLive: false,
  explicit: new Set(),
  hasMovedChecks: true,
  hasLegacyPackage: false,
  legacyDepsInstalled: false,
  wranglerInstalled: true,
};

test("release:verify plan keeps the lane order and runs the offline stages", () => {
  const plan = planStages(baseFacts);
  assert.deepEqual(plan.map((s) => s.name), STAGE_ORDER);
  assert.deepEqual(plan.filter((s) => s.run).map((s) => s.name), ["unit", "cloudflare", "build"]);
  const live = plan.filter((s) => !s.run);
  assert.equal(live.length, 2);
  assert.ok(live.every((s) => s.reason.includes("no --target") && !s.blocked));
});

test("release:verify plan runs the live stages when a target is given", () => {
  const plan = planStages({ ...baseFacts, target: "https://staging.example" });
  assert.ok(plan.every((s) => s.run));
});

test("release:verify --require-live blocks when a live stage would skip", () => {
  const plan = planStages({ ...baseFacts, requireLive: true });
  const live = plan.filter((s) => s.name === "cold-start" || s.name === "live-smoke");
  assert.ok(live.every((s) => !s.run && s.blocked));
});

test("release:verify explicit stage selection runs only that stage, as required", () => {
  const plan = planStages({ ...baseFacts, explicit: new Set(["cold-start"]) });
  assert.deepEqual(plan.map((s) => s.name), ["cold-start"]);
  assert.equal(plan[0].run, false);
  assert.equal(plan[0].blocked, true);
});

test("release:verify legacy cloudflare suite skips until its deps are installed", () => {
  const legacy = { ...baseFacts, hasMovedChecks: false, hasLegacyPackage: true };
  const skipped = planStages(legacy).find((s) => s.name === "cloudflare");
  assert.equal(skipped.run, false);
  assert.match(skipped.reason, /deps not installed/);
  const installed = planStages({ ...legacy, legacyDepsInstalled: true }).find((s) => s.name === "cloudflare");
  assert.equal(installed.run, true);
});

test("release:verify parses stage names, target and passthrough", () => {
  const parsed = parseArgs(["cloudflare", "--target", "https://staging.example", "--", "--test-name-pattern=identity"]);
  assert.deepEqual([...parsed.explicit], ["cloudflare"]);
  assert.equal(parsed.target, "https://staging.example");
  assert.deepEqual(parsed.passthrough, ["--test-name-pattern=identity"]);
  assert.throws(() => parseArgs(["nope"]), /unknown argument/);
});
