#!/usr/bin/env node
// TST-08: every route-table row needs a parity note (owner rule: anything a
// human can do in the UI, an agent can do through REST and MCP).
//   parity: "mcp:room_read_messages"        MCP tool(s) with the same effect
//   parity: "exempt:browser-only OAuth hop"  why no MCP tool applies (8+ chars)
// Rows that predate the rule are listed in scripts/route-parity-baseline.json.
// The list may only shrink: add a note to a row, then run with --write.
//   node scripts/route-parity-notes.mjs          # report, exit 1 on problems
//   node scripts/route-parity-notes.mjs --write  # rewrite the baseline (removals only)
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("..", import.meta.url);
export const BASELINE_PATH = new URL("scripts/route-parity-baseline.json", root);
const SNAPSHOT_PATH = new URL("tests/fixtures/mcp-catalog.snapshot.json", root);

const readJson = path => JSON.parse(readFileSync(path, "utf8"));

export function loadBaseline() { return readJson(BASELINE_PATH); }

export function mcpToolNames(snapshot = readJson(SNAPSHOT_PATH)) {
  const names = new Set();
  for (const profile of Object.values(snapshot)) for (const name of Object.keys(profile)) names.add(name);
  return names;
}

export function parityProblems(routes, baseline, tools, notePattern) {
  const problems = [];
  const ids = new Set(routes.map(r => r.id));
  const grandfathered = new Set(baseline);
  for (const row of routes) {
    if (row.parity === undefined) {
      if (!grandfathered.has(row.id)) problems.push(`${row.id} (${row.method} ${row.path}): add parity: "mcp:<tool>" or "exempt:<reason>"`);
      continue;
    }
    if (grandfathered.has(row.id)) problems.push(`${row.id}: has a parity note, remove it from route-parity-baseline.json (--write)`);
    const note = String(row.parity);
    if (!notePattern.test(note)) { problems.push(`${row.id}: parity note "${note}" is not mcp:<tool> or exempt:<reason of 8+ chars>`); continue; }
    if (note.startsWith("mcp:")) for (const tool of note.slice(4).split(",")) if (!tools.has(tool)) problems.push(`${row.id}: MCP tool ${tool} is not in the catalog snapshot`);
  }
  for (const id of baseline) if (!ids.has(id)) problems.push(`${id}: in route-parity-baseline.json but not in the route table (--write)`);
  return problems;
}

async function main(argv) {
  const { ROUTES, ROUTE_PARITY_NOTE } = await import("../server/routes/table.mjs");
  const baseline = loadBaseline();
  if (argv.includes("--write")) {
    const ids = new Set(ROUTES.map(r => r.id));
    const next = baseline.filter(id => ids.has(id) && ROUTES.find(r => r.id === id).parity === undefined).sort();
    writeFileSync(BASELINE_PATH, JSON.stringify(next, null, 1) + "\n");
    console.log(`baseline: ${baseline.length} -> ${next.length} rows without a parity note`);
    return 0;
  }
  const problems = parityProblems(ROUTES, baseline, mcpToolNames(), ROUTE_PARITY_NOTE);
  const noted = ROUTES.filter(r => r.parity !== undefined).length;
  console.log(`routes ${ROUTES.length}, with parity note ${noted}, grandfathered ${baseline.length}, problems ${problems.length}`);
  for (const line of problems) console.log(`  ${line}`);
  return problems.length ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).then(code => process.exit(code));
