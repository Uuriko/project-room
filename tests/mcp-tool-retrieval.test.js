// G5: MCP retrieval-based tool discovery — TF-IDF retriever over the live
// catalog (names + descriptions), synonym map, low-confidence fallback to
// the pre-build profile listing. Acceptance fixture: the DISCOVERY-50 lane
// G5 frozen 30-task set (tests/fixtures/mcp-discovery-tasks.json, copied
// unchanged from the lane's output/tasks.json).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { listedMcpTools, discoverMcpTools } from "../server/mcp-discovery.mjs";
import { retrieveMcpTools, RETRIEVAL_CONFIDENCE_THRESHOLD, MCP_TOOL_RETRIEVAL_ENABLED } from "../server/mcp-tool-retrieval.mjs";
import { MCP_DISCOVERY_SYNONYMS } from "../server/mcp-discovery-synonyms.mjs";

const TASKS = JSON.parse(readFileSync(new URL("./fixtures/mcp-discovery-tasks.json", import.meta.url), "utf8"));
const FULL = listedMcpTools("full");
// Lane accounting: chars/4 over the serialised entry.
const entryCost = tool => Math.ceil(JSON.stringify({ [tool.name]: tool }).length / 4);

test("frozen fixture is the lane's 30-task set, unchanged", () => {
  assert.equal(TASKS.length, 30);
  for (const { task, tool } of TASKS) {
    assert.equal(typeof task, "string");
    assert.ok(FULL.some(entry => entry.name === tool), `true tool ${tool} still in the full catalog`);
  }
});

test("acceptance: frozen 30-task set scores accuracy@5 >= 0.90 against the built retriever", () => {
  let hits = 0;
  const misses = [];
  for (const { task, tool } of TASKS) {
    const { matches } = retrieveMcpTools(task, { tools: FULL });
    if (matches.slice(0, 5).some(match => match.name === tool)) hits++;
    else misses.push(`${tool} for "${task}"`);
  }
  assert.ok(hits / TASKS.length >= 0.9, `accuracy@5 ${hits}/30, misses: ${misses.join("; ")}`);
});

test("the lane's 3 named misses land in the top-5 with the synonym map applied", () => {
  const named = {
    bounty_post: "create a new bounty offering credits for a task",
    room_list_peer_dms: "list direct message conversations with peers",
    room_handoff: "hand off your work to another agent"
  };
  for (const [tool, task] of Object.entries(named)) {
    const { matches } = retrieveMcpTools(task, { tools: FULL });
    assert.ok(matches.slice(0, 5).some(match => match.name === tool),
      `${tool} not in top-5 for "${task}": ${matches.slice(0, 5).map(m => m.name).join(",")}`);
  }
});

test("synonym map is load-bearing: without it the bounty and handoff tasks miss the top-5", () => {
  for (const [tool, task] of Object.entries({
    bounty_post: "create a new bounty offering credits for a task",
    room_handoff: "hand off your work to another agent"
  })) {
    const { matches } = retrieveMcpTools(task, { tools: FULL, synonyms: [] });
    assert.ok(!matches.slice(0, 5).some(match => match.name === tool),
      `${tool} unexpectedly in top-5 without synonyms`);
  }
});

test("synonym map entries each carry the task evidence that motivated them", () => {
  assert.ok(MCP_DISCOVERY_SYNONYMS.length >= 3);
  for (const entry of MCP_DISCOVERY_SYNONYMS) {
    assert.ok(Array.isArray(entry.phrases) && entry.phrases.length > 0, "entry names its phrases");
    assert.ok(Array.isArray(entry.add) && entry.add.length > 0, "entry names the terms it adds");
    assert.ok(typeof entry.evidence === "string" && entry.evidence.length > 0, "entry carries task evidence");
  }
  const flat = MCP_DISCOVERY_SYNONYMS.flatMap(entry => entry.add);
  assert.ok(flat.includes("dm") && flat.includes("handoff") && flat.includes("post"),
    "the lane's three measured fixes are present");
});

test("low-confidence fallback is byte-identical to today's listing", () => {
  assert.equal(MCP_TOOL_RETRIEVAL_ENABLED, true);
  assert.ok(RETRIEVAL_CONFIDENCE_THRESHOLD > 0);
  const result = discoverMcpTools("zxqw vkjb plugh xyzzy", { profile: "full" });
  assert.equal(result.mode, "fallback");
  assert.equal(result.reason, "low_confidence");
  assert.equal(JSON.stringify(result.tools), JSON.stringify(FULL),
    "fallback tools must be the pre-build discovery answer, byte-for-byte");
});

test("revoking the retriever returns the full listing in one act", () => {
  const result = discoverMcpTools("hand off your work to another agent", { profile: "full", enabled: false });
  assert.equal(result.mode, "fallback");
  assert.equal(result.reason, "disabled");
  assert.equal(JSON.stringify(result.tools), JSON.stringify(FULL));
});

test("confident discovery narrows to a capped top-5 drawn from the listing", () => {
  const result = discoverMcpTools("hand off your work to another agent", { profile: "full" });
  assert.equal(result.mode, "narrowed");
  assert.ok(result.tools.length > 0 && result.tools.length <= 5);
  assert.equal(result.tools[0].name, "room_handoff");
  for (const tool of result.tools) assert.ok(FULL.some(entry => entry.name === tool.name));
  assert.ok(result.confidence >= RETRIEVAL_CONFIDENCE_THRESHOLD);
});

test("top-5 token cost is below 10% of the full-catalog serialisation (lane accounting)", () => {
  const fullCost = FULL.reduce((sum, tool) => sum + entryCost(tool), 0);
  let total = 0;
  for (const { task } of TASKS) {
    const { matches } = retrieveMcpTools(task, { tools: FULL });
    total += matches.slice(0, 5).reduce((sum, match) => sum + entryCost(match), 0);
  }
  const avg = total / TASKS.length;
  assert.ok(avg < fullCost * 0.1, `avg top-5 cost ${avg.toFixed(1)} tokens vs full ${fullCost}`);
});

test("static-profile discovery is unchanged for a caller that does not use retrieval", () => {
  assert.equal(listedMcpTools("core").length, 22);
  assert.equal(FULL.length, 122);
  const lean = listedMcpTools("lean");
  assert.ok(lean.length > 0 && lean.every(tool => tool && typeof tool.name === "string"));
  // Retrieval added no tool and removed none: the catalog contents are inputs.
  assert.ok(!FULL.some(tool => tool.name === "discover_mcp_tools"));
});
