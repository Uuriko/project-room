// B017: skill/agent registry. Pure registry tests.
import test from "node:test";
import assert from "node:assert/strict";
import { compareVersions, createSkillRegistry, RegistryError } from "../server/skill-registry.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof RegistryError && error.code === code);

test("compareVersions orders semver", () => {
  assert.equal(compareVersions("1.0.0", "2.0.0"), -1);
  assert.equal(compareVersions("2.1.0", "2.0.9"), 1);
  assert.equal(compareVersions("1.2.3", "1.2.3"), 0);
  throwsCode(() => compareVersions("1.0", "1.0.0"), "invalid_registry");
});
test("register/get/byCapability/byLane/deregister", () => {
  const registry = createSkillRegistry();
  registry.register({ skillId: "s1", agentId: "quill", name: "search",
    version: "1.0.0", capabilities: ["web", "search"], lane: "research" });
  registry.register({ skillId: "s2", agentId: "grok", name: "search-pro",
    version: "2.0.0", capabilities: ["web", "search"], lane: "research" });
  registry.register({ skillId: "s3", agentId: "quill", name: "summarize",
    version: "1.0.0", capabilities: ["nlp"], lane: "writing" });
  assert.equal(registry.get("s1").name, "search");
  assert.ok(Object.isFrozen(registry.get("s1")));
  const byCap = registry.byCapability("search");
  assert.deepEqual(byCap.map(s => s.skillId), ["s2", "s1"]); // newest first
  assert.deepEqual(registry.byLane("writing").map(s => s.skillId), ["s3"]);
  registry.deregister("s3");
  assert.equal(registry.size(), 2);
});
test("malformed inputs are refused", () => {
  const registry = createSkillRegistry();
  throwsCode(() => registry.register({ skillId: "s", agentId: "a", name: "n",
    version: "bad", capabilities: ["c"], lane: "l" }), "invalid_registry");
  throwsCode(() => registry.get("ghost"), "invalid_registry");
  throwsCode(() => registry.deregister("ghost"), "invalid_registry");
});
