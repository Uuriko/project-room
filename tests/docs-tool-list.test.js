// Gap G8: doc tool listings vs the live served catalog.
//
// /llms.txt, docs/SWARM-PLUG-IN.md and skills/project-room/references/tools.md
// teach tool names to agents. A name a doc teaches that the server does not
// serve 404s as unknown_tool on tools/call; an enumerated "core set" that
// silently drops served names teaches a wrong catalog (tools.md once listed
// 16 of the 19 core tools, and denied the served room_react tool). This test
// pins the three doc surfaces against the catalog the server actually serves,
// so drift fails CI instead of failing agents at runtime.
//
// It imports the same functions that serve the real responses
// (listedMcpTools, llmsTxt, roomTools, attentionTools), so a rename in code
// or a stale list in docs fails here. Docs are downstream of the code: when
// this fails, fix the docs, not the tool names.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { listedMcpTools } from "../server/mcp-discovery.mjs";
import { roomTools, attentionTools } from "../client/mcp-stdio.mjs";
import { CORE_MCP_TOOLS } from "../src/room-mcp-join.js";
import { llmsTxt } from "../deploy/agent-discovery.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = rel => readFileSync(join(root, rel), "utf8");

// Every name the server can serve: the hosted full profile plus the local
// stdio adapter's room and attention tools.
const served = new Set([
  ...listedMcpTools("full", false, null, undefined).map(t => t.name),
  ...roomTools.map(t => t.name),
  ...attentionTools.map(t => t.name),
]);
const core = new Set(CORE_MCP_TOOLS);

// Tool-name tokens: snake_case names with a known tool prefix. Dotted aliases
// (wake.pause) collapse to their canonical snake_case name, which is what
// tools/list serves.
const TOOL_TOKEN = /\b((?:room|wake|heartbeat|webhook|bond|dm|bounty|public_work|inbox|identity|get_room|add_land|list_land|report_tip)[a-z0-9]*(?:[._][a-z0-9]+)+)\b/g;
function toolTokens(text) {
  const out = new Set();
  for (const m of text.matchAll(TOOL_TOKEN)) out.add(m[1].replace(/\./g, "_"));
  return [...out];
}

function assertSetEqual(actual, expected, label) {
  const a = new Set(actual), e = new Set(expected);
  const missing = [...e].filter(x => !a.has(x));
  const extra = [...a].filter(x => !e.has(x));
  assert.deepEqual({ missing, extra }, { missing: [], extra: [] }, label);
}

test("llms.txt core-set enumerations match the live core profile", () => {
  const text = llmsTxt();
  const lists = [];
  for (const m of text.matchAll(/(?:essential tools|compact core set)[ —:\-]+(.+?)(?: — plus|\.\s)/gs)) {
    lists.push(toolTokens(m[1]));
  }
  assert.ok(lists.length > 0, "llms.txt enumerates the core set at least once");
  for (const list of lists) assertSetEqual(list, core, "llms.txt core set == live CORE_MCP_TOOLS");
});

test("tools.md core-set sentence matches the live core profile", () => {
  const text = read("skills/project-room/references/tools.md");
  const m = text.match(/Default `tools\/list` is the core set[^:]*:([^\n.]+)\./);
  assert.ok(m, "tools.md states the default tools/list core set");
  assertSetEqual(toolTokens(m[1]), core, "tools.md core set == live CORE_MCP_TOOLS");
});

test("tools.md react section names the served room_react tool", () => {
  const text = read("skills/project-room/references/tools.md");
  const m = text.match(/[^\n]*reaction_set[^\n]*/);
  assert.ok(m, "tools.md has a react-tool paragraph");
  assert.ok(!/no MCP react tool/i.test(m[0]), "tools.md must not deny the served react tool");
  assert.ok(toolTokens(m[0]).includes("room_react"), "tools.md react paragraph names room_react");
});

test("SWARM-PLUG-IN read/write tool bullets all resolve in the served catalog", () => {
  const text = read("docs/SWARM-PLUG-IN.md");
  const readSection = text.split("### Read tools")[1].split("### Write tools")[0];
  const writeSection = text.split("### Write tools")[1].split(/^## /m)[0];
  const names = new Set();
  for (const section of [readSection, writeSection]) {
    for (const line of section.split("\n")) {
      if (!line.startsWith("- ")) continue;
      for (const token of toolTokens(line)) names.add(token);
    }
  }
  assert.ok(names.size > 0, "SWARM-PLUG-IN read/write sections list tools");
  const unknown = [...names].filter(n => !served.has(n));
  assert.deepEqual(unknown, [], `SWARM-PLUG-IN names not in the served catalog: ${unknown.join(", ")}`);
});

test("tools.md read/write table tools all resolve in the served catalog", () => {
  const text = read("skills/project-room/references/tools.md");
  const names = new Set();
  for (const line of text.split("\n")) {
    const m = line.match(/^\| `([a-z0-9_]+)` \|/);
    if (m) names.add(m[1]);
  }
  assert.ok(names.size > 0, "tools.md read/write tables list tools");
  const unknown = [...names].filter(n => !served.has(n));
  assert.deepEqual(unknown, [], `tools.md table names not in the served catalog: ${unknown.join(", ")}`);
});
