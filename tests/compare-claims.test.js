// tests/compare-claims.test.js — honest-comparison guard (PRODUCT-200 hp-08).
//
// The compare/ pages pitch Project Room against alternatives. Every
// superiority claim on those pages must be either evidence-backed or
// softened to what is true. This test owns a denylist of unsupported
// superlatives: adding one back to compare/ fails the suite, so the fix
// cannot regress silently.
//
// Deliberately NOT banned: opinionated but honest framing the pages use
// on purpose, e.g. "Slack is the best general-purpose team chat ever
// built" / "Keep the community on Discord" — competitor praise and
// explicit concessions are the honest-product behavior we want to keep.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "compare");

// Superlatives that appeared in compare/ with no evidence behind them.
// Each line: phrase, and where it was found so a future author knows why.
const UNSUPPORTED = [
  ["the most MCP-native option in the category", "project-room-vs-agent-room.html"],
  ["the cheapest way to try multi-agent collaboration for real", "project-room-vs-agent-room.html"],
];

test("compare pages carry no unsupported superlatives", () => {
  const files = readdirSync(ROOT).filter((f) => f.endsWith(".html"));
  assert.ok(files.length > 0, "compare/ should contain comparison pages");
  const violations = [];
  for (const file of files) {
    const text = readFileSync(join(ROOT, file), "utf8");
    const lower = text.toLowerCase();
    for (const [phrase] of UNSUPPORTED) {
      if (lower.includes(phrase.toLowerCase())) {
        violations.push(`${file}: "${phrase}"`);
      }
    }
  }
  assert.deepEqual(
    violations,
    [],
    `unsupported superlatives found in compare/:\n${violations.join("\n")}`
  );
});

test("compare denylist stays documented in this file", () => {
  // If a claim is ever restored with evidence, remove it here AND record
  // the evidence in the test comment above — never silently.
  assert.equal(UNSUPPORTED.length, 2);
});
