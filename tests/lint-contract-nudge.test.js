// tests/lint-contract-nudge.test.js — FAIL-FIRST guard for FIX-44 (wave300).
// The contract-field lint nudge (scripts/lint-contract-nudge.mjs) must warn,
// not fail: defensive `??` / `?.` on internal claim-contract fields masks
// contract drift (COLLIDE-4 exp 3). It is advisory — exit 0 always — with a
// --strict flag for humans who want failures.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const script = join(root, "scripts", "lint-contract-nudge.mjs");

const OFFENDING = `// fixture: defensive fallbacks on internal contract fields
export function summarize(item) {
  const files = item.files ?? [];
  const blocks = item?.fileBlocks ?? {};
  const state = item?.state ?? "unclaimed";
  return { files, blocks, state };
}
`;

const CLEAN = `// fixture: explicit shape validation at the module boundary
export function summarize(item) {
  if (!item || typeof item !== "object") throw new TypeError("expected claim item");
  if (!Array.isArray(item.files)) throw new TypeError("expected item.files to be an array");
  return { count: item.files.length };
}
`;

function withFixtures() {
  const dir = mkdtempSync(join(tmpdir(), "contract-nudge-"));
  writeFileSync(join(dir, "offending.mjs"), OFFENDING);
  writeFileSync(join(dir, "clean.mjs"), CLEAN);
  return dir;
}

function run(args, cwd = root) {
  const r = spawnSync(process.execPath, [script, ...args], { cwd, encoding: "utf8" });
  return r;
}

test("nudge script exists and is runnable", () => {
  const r = run(["--help"]);
  assert.equal(r.status, 0, `expected exit 0 from --help, got ${r.status}; stderr: ${r.stderr}`);
  assert.match(r.stdout, /lint-contract-nudge/i);
});

test("offending fixture produces warnings naming file:line, exit stays 0", () => {
  const dir = withFixtures();
  try {
    const r = run([join(dir, "offending.mjs")]);
    assert.equal(r.status, 0, `nudge must never fail by default; stderr: ${r.stderr}`);
    assert.match(r.stdout, /WARNING/);
    assert.match(r.stdout, /offending\.mjs:3/);
    assert.match(r.stdout, /offending\.mjs:4/);
    assert.match(r.stdout, /offending\.mjs:5/);
    assert.match(r.stdout, /files/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("clean fixture produces no warnings", () => {
  const dir = withFixtures();
  try {
    const r = run([join(dir, "clean.mjs")]);
    assert.equal(r.status, 0);
    assert.doesNotMatch(r.stdout, /WARNING/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--strict exits 1 on warnings, 0 when clean", () => {
  const dir = withFixtures();
  try {
    const bad = run(["--strict", join(dir, "offending.mjs")]);
    assert.equal(bad.status, 1, `expected exit 1 in --strict with warnings; stderr: ${bad.stderr}`);
    assert.match(bad.stdout, /WARNING/);
    const good = run(["--strict", join(dir, "clean.mjs")]);
    assert.equal(good.status, 0, `expected exit 0 in --strict when clean; stderr: ${good.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("default scan of server/ is advisory: exit 0, never a hard gate", () => {
  const r = run([]);
  assert.equal(r.status, 0, `default server/ scan must exit 0; stderr: ${r.stderr}`);
});
