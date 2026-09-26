// tests/pr-overlap.test.js — cross-PR overlap check (scripts/pr-overlap.mjs).
// Contract guarded: open PRs that add the same top-level declaration to one
// file are reported even when git would merge them without a conflict. The
// fixture is the real #1088-#1092 set from 2026-09-26: #1088 adds the helper
// at a different spot than the other four, so it shares no changed lines with
// them and only the declaration check catches it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { analyzeOverlap, parsePatch } from "../scripts/pr-overlap.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const fixture = join(root, "tests", "fixtures", "pr-overlap-2026-09-26.json");
const pulls = JSON.parse(readFileSync(fixture, "utf8"));

test("the Sept 26 tier-gate PRs are flagged for the duplicate helper, including #1088", () => {
  const report = analyzeOverlap(pulls);
  assert.deepEqual(report.duplicateDeclarations, [
    { file: "server/autonomy-tiers.mjs", name: "enforceAutonomyTierForAction", prs: [1088, 1089, 1090, 1091, 1092] },
  ]);
  const lineOverlapPrs = new Set(report.overlappingHunks.flatMap(o => o.prs));
  assert.equal(lineOverlapPrs.has(1088), false, "#1088 shares no changed lines, which is why git merges it silently");
});

test("indented and removed declarations are not top-level additions", () => {
  const patch = [
    "@@ -1,3 +1,4 @@",
    " const kept = 1;",
    "-export function removed() {}",
    "+  function nested() {}",
    "+export async function added() {}",
  ].join("\n");
  assert.deepEqual(parsePatch(patch).declarations.map(d => d.name), ["added"]);
});

test("the CLI exits 2 when a duplicate declaration is found, so CI can fail on it", () => {
  let status = 0;
  try {
    execFileSync(process.execPath, [join(root, "scripts", "pr-overlap.mjs"), "--input", fixture, "--format", "json"], { stdio: "pipe" });
  } catch (error) { status = error.status; }
  assert.equal(status, 2);
});
