// B019: agent sandbox. Pure dry-run tests.
import test from "node:test";
import assert from "node:assert/strict";
import { createSandbox, SandboxError } from "../server/agent-sandbox.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof SandboxError && error.code === code);

test("enable/stageWrite/stagedWrites/applyStaged lifecycle", () => {
  const sandbox = createSandbox();
  assert.equal(sandbox.isSandboxed("ada"), false);
  sandbox.enable("ada");
  assert.equal(sandbox.isSandboxed("ada"), true);
  const staged = sandbox.stageWrite("ada", { operation: "create", target: "room:1",
    details: { title: "Test" } });
  assert.ok(staged.stageId.startsWith("stage-"));
  assert.ok(Object.isFrozen(staged));
  assert.equal(sandbox.stagedWrites("ada").length, 1);
  const applied = sandbox.applyStaged("ada");
  assert.equal(applied.length, 1);
  assert.equal(sandbox.stagedWrites("ada").length, 0); // cleared
});
test("disable discards staged writes", () => {
  const sandbox = createSandbox();
  sandbox.enable("bob");
  sandbox.stageWrite("bob", { operation: "delete", target: "room:2" });
  const result = sandbox.disable("bob");
  assert.equal(result.discarded, 1);
  assert.equal(sandbox.isSandboxed("bob"), false);
});
test("writes outside sandbox are refused", () => {
  const sandbox = createSandbox();
  throwsCode(() => sandbox.stageWrite("carol", { operation: "x", target: "y" }), "invalid_sandbox");
  throwsCode(() => sandbox.disable("carol"), "invalid_sandbox");
});
test("malformed inputs are refused", () => {
  const sandbox = createSandbox();
  throwsCode(() => sandbox.enable(""), "invalid_sandbox");
});
