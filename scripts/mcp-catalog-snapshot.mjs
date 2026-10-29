#!/usr/bin/env node
// mcp-catalog-snapshot.mjs: contract snapshot of the hosted MCP catalog (TST-05).
//
// For every tools/list profile the server serves, it records each tool name,
// a hash of its inputSchema and its annotations. Descriptions are not part of
// the snapshot: copy edits must not fail CI. tests/mcp-catalog-contract.test.js
// compares the live catalog with tests/fixtures/mcp-catalog.snapshot.json.
// A change fails the test until the snapshot is regenerated in the same PR, so
// every add, remove or schema change shows up in the PR diff for review.
//
//   node scripts/mcp-catalog-snapshot.mjs           print the diff, exit 1 on drift
//   node scripts/mcp-catalog-snapshot.mjs --write   regenerate the snapshot
//
// Run it with the default environment: off-by-default feature flags stay off.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { listedMcpTools, livePublicMcpTools, liveEnrolledMcpTools } from "../server/mcp-discovery.mjs";

export const SNAPSHOT_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "tests", "fixtures", "mcp-catalog.snapshot.json");

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

const hash = value => createHash("sha256").update(canonicalJson(value)).digest("hex").slice(0, 16);

export function servedProfiles() {
  return {
    public: livePublicMcpTools(),
    core: listedMcpTools("core"),
    full: listedMcpTools("full"),
    "focus=work": listedMcpTools("core", false, null, "work"),
    "focus=conversation": listedMcpTools("core", false, null, "conversation"),
    "focus=review": listedMcpTools("core", false, null, "review"),
    "focus=automation": listedMcpTools("core", false, null, "automation"),
    "focus=public_work": listedMcpTools("core", false, null, "public_work"),
    enrolled: liveEnrolledMcpTools(),
  };
}

export function buildSnapshot(profiles = servedProfiles()) {
  const out = {};
  for (const [profile, tools] of Object.entries(profiles)) {
    const entries = {};
    for (const tool of tools) {
      entries[tool.name] = { inputSchema: hash(tool.inputSchema ?? {}), annotations: tool.annotations ?? {} };
    }
    out[profile] = Object.fromEntries(Object.keys(entries).sort().map(k => [k, entries[k]]));
  }
  return out;
}

export function diffSnapshots(expected, actual) {
  const changes = [];
  for (const profile of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
    const a = expected[profile] ?? {};
    const b = actual[profile] ?? {};
    if (!(profile in expected)) changes.push(`${profile}: new profile`);
    if (!(profile in actual)) changes.push(`${profile}: profile removed`);
    for (const name of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (!(name in a)) changes.push(`${profile}: + ${name}`);
      else if (!(name in b)) changes.push(`${profile}: - ${name}`);
      else {
        if (a[name].inputSchema !== b[name].inputSchema) changes.push(`${profile}: ~ ${name} inputSchema`);
        if (canonicalJson(a[name].annotations) !== canonicalJson(b[name].annotations)) changes.push(`${profile}: ~ ${name} annotations`);
      }
    }
  }
  return changes.sort();
}

// Human-readable snapshot diff for failure output: diffSnapshots() names the
// changed tools; this adds the REAL committed-vs-served values (inputSchema
// hashes, annotation JSON) behind each change, plus the one-command cure and
// the follow-on acts the regen does NOT do itself (the count pins).
const MAX_SNAPSHOT_DIFF_LINES = 50;
const clip = (text, max = 160) => text.length > max ? `${text.slice(0, max)}…` : text;
export function formatSnapshotDiff(expected, actual) {
  const lines = [];
  for (const profile of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
    const a = expected[profile] ?? {};
    const b = actual[profile] ?? {};
    if (!(profile in expected)) { lines.push(`${profile}: new profile, not in the committed snapshot (${Object.keys(b).length} tools served)`); continue; }
    if (!(profile in actual)) { lines.push(`${profile}: profile removed, still in the committed snapshot (${Object.keys(a).length} tools)`); continue; }
    for (const name of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (!(name in a)) lines.push(`${profile}: + ${name} (served, not in the snapshot)`);
      else if (!(name in b)) lines.push(`${profile}: - ${name} (in the snapshot, no longer served)`);
      else {
        if (a[name].inputSchema !== b[name].inputSchema)
          lines.push(`${profile}: ~ ${name} inputSchema hash committed ${a[name].inputSchema} -> served ${b[name].inputSchema}`);
        if (canonicalJson(a[name].annotations) !== canonicalJson(b[name].annotations))
          lines.push(`${profile}: ~ ${name} annotations committed ${clip(canonicalJson(a[name].annotations))} -> served ${clip(canonicalJson(b[name].annotations))}`);
      }
    }
  }
  if (!lines.length) return "";
  lines.sort();
  const shown = lines.slice(0, MAX_SNAPSHOT_DIFF_LINES);
  if (lines.length > MAX_SNAPSHOT_DIFF_LINES) shown.push(`… and ${lines.length - MAX_SNAPSHOT_DIFF_LINES} more catalog changes`);
  shown.push("Cure (one command, then re-run this check):",
    "  node scripts/mcp-catalog-snapshot.mjs --write",
    "Then review `git diff tests/fixtures/mcp-catalog.snapshot.json` — it is the review surface for catalog changes.",
    "Follow-on the regen does NOT do: if a profile's tool COUNT changed, update the count pins by hand —",
    "the exact core/full length pins in tests/mcp-search-actions.test.js and the full-catalog budget in tests/mcp-untrusted-content.test.js.");
  return shown.join("\n");
}

function main() {
  const actual = buildSnapshot();
  if (process.argv.includes("--write")) {
    writeFileSync(SNAPSHOT_PATH, `${JSON.stringify(actual, null, 2)}\n`);
    console.log(`wrote ${SNAPSHOT_PATH}`);
    return;
  }
  const expected = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8"));
  const changes = diffSnapshots(expected, actual);
  if (changes.length) console.log(formatSnapshotDiff(expected, actual));
  console.log(`${changes.length} catalog change(s)`);
  process.exitCode = changes.length ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
