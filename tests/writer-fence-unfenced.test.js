// Regression test: every additive module-owned table must be registered in
// writer-fence.mjs, otherwise auditRecovery() throws "Recovery data requires
// operator reconciliation" (main browser gate went red at 317c7b1 when
// server/access-requests.mjs created its table unregistered).
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { applicationTables, unfencedAdditiveTables } from "../server/writer-fence.mjs";

const SERVER_DIR = new URL("../server/", import.meta.url).pathname;

test("all CREATE TABLE tables in server modules are registered application tables", () => {
  const created = new Set();
  for (const file of readdirSync(SERVER_DIR)) {
    if (!file.endsWith(".mjs")) continue;
    const src = readFileSync(join(SERVER_DIR, file), "utf8");
    for (const match of src.matchAll(/CREATE TABLE IF NOT EXISTS\s+([a-z_][a-z0-9_]*)/gi)) {
      created.add(match[1].toLowerCase());
    }
  }
  // writer-fence owns the canonical DDL; only additive module tables are in scope here.
  const unregistered = [...created].filter(t => !applicationTables.includes(t));
  assert.deepEqual(unregistered, [],
    `unregistered tables would fail the recovery audit: ${unregistered.join(", ")}`);
});

test("unfenced additive tables stay outside the v34 writer fence", () => {
  assert.ok(unfencedAdditiveTables.includes("access_requests"));
  assert.ok(unfencedAdditiveTables.includes("private_inbox_reads"));
});

// The packaged runtime verifier (scripts/runtime-package.mjs) requires every
// relative import of every packaged file to resolve inside the package. A new
// server module imported by an allowlisted file (e.g. http.mjs) must itself be
// allowlisted, or the packaged browser fallback tests fail with "Runtime
// package does not match its exact allowlisted contract".
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname } from "node:path";

function repoRoot(start) {
  let dir = dirname(start);
  for (;;) {
    try {
      return execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
    } catch {
      const parent = dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  }
}

test("runtime package create+verify succeeds at HEAD (allowlist covers the import closure)", t => {
  const root = repoRoot(new URL(import.meta.url).pathname);
  if (!root) { t.skip("no git checkout available"); return; }
  const head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const dest = mkdtempSync(join(tmpdir(), "runtime-pkg-test-"));
  rmSync(dest, { recursive: true, force: true }); // createRuntimePackage never reuses a path
  try {
    const out = execFileSync("node", [join(root, "scripts/runtime-package.mjs"), "create", root, head, dest],
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    assert.equal(JSON.parse(out).verified, true);
  } finally { rmSync(dest, { recursive: true, force: true }); }
});
