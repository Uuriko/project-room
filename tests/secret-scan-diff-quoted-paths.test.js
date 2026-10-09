// tests/secret-scan-diff-quoted-paths.test.js — regression tests for the
// quoted-diff-path bypass found by WAVE-2000 worker-10 (2026-10-09).
//
// What this protects: git C-style-quotes diff paths when core.quotePath is
// on (the default) and the name holds `"`, `\`, a control char, or a
// non-ASCII byte — e.g. `+++ "b/scripts/caf\303\251.mjs"` for
// scripts/café.mjs. parseDiff used to keep the raw quoted name, so
// isInScope() never matched and secrets added to such files bypassed the
// diff gate entirely. unquoteDiffPath() restores the real name.
//
// NOTE: like the other secret-scan tests, example secrets are generated at
// runtime so this file never contains a literal secret-shaped string.

import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { parseDiff, scanAddedUnits, unquoteDiffPath } from "../scripts/secret-scan-diff.mjs";

// `git diff --unified=0` header lines for scripts/café.mjs, exactly as git
// emits them with core.quotePath=true (the default).
const quotedDiff = (addedLine) =>
  [
    'diff --git "a/scripts/caf\\303\\251.mjs" "b/scripts/caf\\303\\251.mjs"',
    "new file mode 100644",
    "index 0000000..ad1d380",
    "--- /dev/null",
    '+++ "b/scripts/caf\\303\\251.mjs"',
    "@@ -0,0 +1 @@",
    `+${addedLine}`,
  ].join("\n");

test("unquoteDiffPath leaves plain paths untouched", () => {
  assert.equal(unquoteDiffPath("b/scripts/keys.mjs"), "b/scripts/keys.mjs");
  assert.equal(unquoteDiffPath("/dev/null"), "/dev/null");
});

test("unquoteDiffPath decodes git C-style quoting", () => {
  // Octal UTF-8 bytes for é, plus the b/ prefix the parser strips later.
  assert.equal(unquoteDiffPath('"b/scripts/caf\\303\\251.mjs"'), "b/scripts/café.mjs");
  // Escaped quote and backslash inside a quoted name.
  assert.equal(unquoteDiffPath('"b/a\\"b\\\\c.mjs"'), 'b/a"b\\c.mjs');
  // A lone trailing backslash cannot escape anything: kept literally.
  assert.equal(unquoteDiffPath('"b/odd\\\\"'), "b/odd\\");
  // Not actually quoted (no closing quote): untouched.
  assert.equal(unquoteDiffPath('"b/nope.mjs'), '"b/nope.mjs');
});

test("parseDiff maps a quoted-path file to its real name and line", () => {
  const units = parseDiff(quotedDiff("export const x = 1;"));
  assert.deepEqual(units.map((u) => [u.path, u.line, u.text]), [["scripts/café.mjs", 1, "export const x = 1;"]]);
});

test("scanAddedUnits flags a secret added under a quoted diff path", () => {
  // Must fail on the pre-fix code: the raw quoted name never matched the
  // scan scope, so the gate reported zero findings for this diff.
  const apiKey = randomBytes(16).toString("hex");
  const units = parseDiff(quotedDiff(`const api_key = "${apiKey}";`));
  const findings = scanAddedUnits(units, []);
  assert.equal(findings.length, 1, "the secret line is flagged, not bypassed");
  assert.ok(findings[0].startsWith("scripts/café.mjs:1 "), `finding names the real path: ${findings[0]}`);
  assert.ok(findings[0].includes("api-key"), `finding names the rule: ${findings[0]}`);
  assert.equal(findings[0].includes(apiKey), false, "findings never echo the secret value");
});
