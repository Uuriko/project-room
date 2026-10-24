// tests/make-rollback-receipt.test.js — CLI regression tests for the
// rollback compatibility receipt generator (scripts/make-rollback-receipt.mjs).
//
// Covers the FREEZE-PREP-2 completion from PR #3973 review: a flag that is
// present but has no value (a trailing bare --target-entry-id) must be
// rejected, not silently treated as an omitted flag (which used to emit
// targets.entry = null). Also pins the happy path's format-1 shape.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const GENERATOR = path.join(REPO_ROOT, "scripts", "make-rollback-receipt.mjs");

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const UUID_1 = "11111111-2222-3333-4444-555555555555";
const UUID_2 = "22222222-3333-4444-5555-666666666666";
const UUID_3 = "33333333-4444-4555-8666-777777777777";
const UUID_4 = "44444444-5555-4666-8777-888888888888";
const EVIDENCE = `https://github.com/Uuriko/project-room/blob/${SHA_B}/docs/deploy/rollback-compatibility/evidence-x.md`;

function runGenerator(extraArgs) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "rollback-receipt-"));
  const out = path.join(dir, "receipt.json");
  const base = [
    "--current-revision", SHA_A,
    "--current-prod-id", UUID_1,
    "--current-entry-id", UUID_2,
    "--target-revision", SHA_B,
    "--target-prod-id", UUID_3,
    "--evidence", EVIDENCE,
    "--out", "receipt.json", // repo-relative path rules: written under cwd
  ];
  const res = spawnSync(process.execPath, [GENERATOR, ...base, ...extraArgs], { encoding: "utf8", cwd: dir });
  return { res, out };
}

test("generator writes a format-1 receipt; omitted entry flag yields targets.entry null", () => {
  const { res, out } = runGenerator([]);
  assert.equal(res.status, 0, res.stderr);
  const receipt = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(receipt.format, 1);
  assert.deepEqual(receipt.current.prod, { versionId: UUID_1, sourceRevision: SHA_A });
  assert.deepEqual(receipt.targets.prod, { versionId: UUID_3, sourceRevision: SHA_B });
  assert.equal(receipt.targets.entry, null);
  assert.equal(receipt.checks.oldCodeNewData.result, "passed");
  assert.equal(receipt.checks.oldCodeNewData.evidence, EVIDENCE);
});

test("generator records the entry target when --target-entry-id carries a value", () => {
  const { res, out } = runGenerator(["--target-entry-id", UUID_4]);
  assert.equal(res.status, 0, res.stderr);
  const receipt = JSON.parse(readFileSync(out, "utf8"));
  assert.deepEqual(receipt.targets.entry, { versionId: UUID_4, sourceRevision: SHA_B });
});

test("generator rejects a trailing bare --target-entry-id instead of emitting targets.entry null", () => {
  const { res, out } = runGenerator(["--target-entry-id"]);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /--target-entry-id requires a value/);
  assert.equal(existsSync(out), false);
});

test("generator rejects a bare flag followed by another flag", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "rollback-receipt-"));
  const out = path.join(dir, "receipt.json");
  const res = spawnSync(process.execPath, [GENERATOR,
    "--current-revision", SHA_A,
    "--current-prod-id", "--current-entry-id", UUID_2,
    "--target-revision", SHA_B,
    "--target-prod-id", UUID_3,
    "--evidence", EVIDENCE,
    "--out", "receipt.json",
  ], { encoding: "utf8", cwd: dir });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /--current-prod-id requires a value/);
  assert.equal(existsSync(out), false);
});
