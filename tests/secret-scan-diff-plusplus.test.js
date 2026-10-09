import test from "node:test";
import assert from "node:assert/strict";
import { parseDiff, scanAddedUnits } from "../scripts/secret-scan-diff.mjs";

test("parseDiff keeps an added line that starts with ++ on the current file", () => {
  const stripe = "sk_live_" + "b".repeat(16);
  const diff = [
    "diff --git a/server/pay.mjs b/server/pay.mjs",
    "--- a/server/pay.mjs",
    "+++ b/server/pay.mjs",
    "@@ -1,1 +1,3 @@",
    " context",
    `+++const billing = "${stripe}"`,
    "+const note = ready",
    "diff --git a/server/next.mjs b/server/next.mjs",
    "--- a/server/next.mjs",
    "+++ b/server/next.mjs",
    "@@ -1 +1 @@",
    "+const ready = true",
  ].join("\n");
  const units = parseDiff(diff);
  assert.deepEqual(units.map(unit => [unit.path, unit.line, unit.text.startsWith("++")]), [
    ["server/pay.mjs", 2, true],
    ["server/pay.mjs", 3, false],
    ["server/next.mjs", 1, false],
  ]);
  const findings = scanAddedUnits(units, []);
  assert.ok(findings.some(finding => finding.startsWith("server/pay.mjs:2 ") && finding.includes("stripe-key")));
  assert.equal(findings.some(finding => finding.includes(stripe)), false);
});
