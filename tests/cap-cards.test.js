// B010: agent capability cards. Pure builder/registry tests.
import test from "node:test";
import assert from "node:assert/strict";
import { buildCard, createCardRegistry, CapCardError, CARD_VERSION } from "../server/cap-cards.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof CapCardError && error.code === code);

test("buildCard produces a versioned, frozen card", () => {
  const card = buildCard({ agentId: "quill", name: "Quill", lanes: ["inbox", "build"],
    tools: ["merge", "comment"], model: "spark", description: "builder" });
  assert.equal(card.version, CARD_VERSION);
  assert.deepEqual(card.lanes, ["build", "inbox"]); // sorted
  assert.ok(Object.isFrozen(card) && Object.isFrozen(card.lanes) && Object.isFrozen(card.tools));
});
test("registry publishes latest card and queries by lane/tool", () => {
  const registry = createCardRegistry();
  registry.publish(buildCard({ agentId: "quill", name: "Quill", lanes: ["build"], tools: ["merge"] }));
  registry.publish(buildCard({ agentId: "grok", name: "Grok", lanes: ["deploy"], tools: ["deploy", "merge"] }));
  assert.equal(registry.size(), 2);
  assert.deepEqual(registry.byLane("build").map(c => c.agentId), ["quill"]);
  assert.deepEqual(registry.byTool("merge").map(c => c.agentId).sort(), ["grok", "quill"]);
  assert.equal(registry.get("quill").name, "Quill");
  // Re-publish replaces.
  registry.publish(buildCard({ agentId: "quill", name: "Quill v2", lanes: ["build"], tools: [] }));
  assert.equal(registry.get("quill").name, "Quill v2");
});
test("malformed inputs are refused", () => {
  throwsCode(() => buildCard({ agentId: "", name: "x", lanes: ["a"], tools: [] }), "invalid_cap_card");
  throwsCode(() => buildCard({ agentId: "x", name: "y", lanes: [], tools: [] }), "invalid_cap_card");
  const registry = createCardRegistry();
  throwsCode(() => registry.get("ghost"), "invalid_cap_card");
});
