import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const gate = path.join(root, "scripts", "scan-secrets.mjs");

function runDiff(body) {
  const dir = mkdtempSync(path.join(tmpdir(), "scan-secrets-line-"));
  const diffPath = path.join(dir, "change.diff");
  writeFileSync(diffPath, body);
  const result = spawnSync(process.execPath, [gate, "--diff", diffPath], { encoding: "utf8" });
  return { status: result.status, stderr: result.stderr, stdout: result.stdout };
}

function addedDiff(line) {
  return [
    "diff --git a/server/pay.mjs b/server/pay.mjs",
    "--- a/server/pay.mjs",
    "+++ b/server/pay.mjs",
    "@@ -1 +1,2 @@",
    " context",
    `+${line}`,
    "",
  ].join("\n");
}

test("a placeholder word elsewhere on the line does not hide a provider key", () => {
  const stripe = "sk_live_" + "b".repeat(16);
  const result = runDiff(addedDiff(`const billing = "${stripe}"; // see example`));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /\[Stripe live key\]/);
});

test("a documented AWS example key is still not a finding", () => {
  const result = runDiff(addedDiff('const key = "AKIAIOSFODNN7EXAMPLE";'));
  assert.equal(result.status, 0, result.stdout);
});

test("an explicit secrets-allowlist marker recovers a line the gate would otherwise fail", () => {
  const stripe = "sk_live_" + "c".repeat(16);
  const failing = runDiff(addedDiff(`const billing = "${stripe}";`));
  assert.equal(failing.status, 1);
  const recovered = runDiff(addedDiff(`const billing = "${stripe}"; // secrets-allowlist`));
  assert.equal(recovered.status, 0, recovered.stdout);
});

test("a clean added line stays clean", () => {
  const result = runDiff(addedDiff("const billing = ready;"));
  assert.equal(result.status, 0, result.stdout);
});
