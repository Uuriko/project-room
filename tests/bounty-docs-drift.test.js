// is-docs bounty-docs-drift: docs-vs-code drift gate for the bounty economy
// tool surface (issue #1574).
//
// Contract: every tool registered in `bountyTools` (the hosted MCP profile's
// credits-only economy surface, client/bounty-tools.mjs) must be named in
// the agent-facing guide docs/SWARM-PLUG-IN.md ("### Bounty tools (hosted
// MCP profile)"), and the docs must not name bounty_* tools that no longer
// exist. A live-but-undocumented tool is undiscoverable to an agent holding
// only the hosted profile.
//
// Authoring-gate answers (.agents/skills/test-audit/SKILL.md):
// 1. Protects the agent-facing discoverability contract: the tool registry
//    and the agent guide are maintained by different lanes at different
//    times, so this is a genuine cross-source contract, not a self-check.
// 2. Credible regression: a lane adds a 13th bounty tool (or renames one)
//    without updating the guide — the gate fails naming the exact tool.
// 3. Existing coverage: mcp-openapi-drift pins input schemas vs OpenAPI,
//    tests/agent-work-search.test.js pins the attention-enabled tool count.
//    Nothing asserts the bounty tool names are all documented in the agent
//    guide. This owns the docs-surface contract.
// 4. No production seam: imports the already-exported bountyTools and reads
//    the guide off disk. No new exports, flags, or wrappers.
//
// Retention bar: source inspection is the cheapest independent guard here —
// the user-facing contract IS "the tool name appears in the guide", so a
// string-presence check is the contract, not an implementation detail. It
// survives identifier-only refactors and fails exactly when the contract
// changes.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { bountyTools } from "../client/bounty-tools.mjs";

const guide = readFileSync(new URL("../docs/SWARM-PLUG-IN.md", import.meta.url), "utf8");
const section = guide.split("### Bounty tools (hosted MCP profile)")[1] ?? "";
assert.ok(section.length > 0, "SWARM-PLUG-IN.md must contain the bounty tools section");

const toolNames = bountyTools.map(t => t.name);
assert.strictEqual(new Set(toolNames).size, toolNames.length, "bounty tool names must be unique");

test("every registered bounty tool is named in the agent guide", () => {
  const missing = toolNames.filter(name => !section.includes(`\`${name}\``));
  assert.deepStrictEqual(missing, [], `undocumented bounty tools: ${missing.join(", ")}`);
});

test("the guide names no phantom bounty tools", () => {
  const documented = new Set(
    [...section.matchAll(/`(\w+)`/g)]
      .map(m => m[1])
      .filter(n => n.startsWith("bounty_"))
  );
  const phantom = [...documented].filter(n => !toolNames.includes(n));
  assert.deepStrictEqual(phantom, [], `phantom bounty tools in docs: ${phantom.join(", ")}`);
});

test("the guide states the credits-only economy and the write rules", () => {
  assert.ok(section.includes("idempotencyKey"), "guide must explain idempotencyKey");
  assert.ok(section.includes("guest_scope_denied"), "guide must name the guest write denial");
  assert.ok(section.includes("valueless ledger units"), "guide must state credits have no cash value");
});
