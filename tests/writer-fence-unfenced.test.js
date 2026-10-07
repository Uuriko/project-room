// Regression test: every additive module-owned table must be registered in
// writer-fence.mjs, otherwise auditRecovery() throws "Recovery data requires
// operator reconciliation" (main browser gate went red at 317c7b1 when
// server/access-requests.mjs created its table unregistered).
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { applicationTables, lazyAdditiveTables, unfencedAdditiveTables } from "../server/writer-fence.mjs";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

const SERVER_DIR = new URL("../server/", import.meta.url).pathname;

test("all CREATE TABLE tables in server modules are registered application tables", () => {
  // Recursive: server/analytics/claim-bond-shadow.mjs created claim_bond_shadow
  // unregistered (PR #1466) and the top-level-only scan missed it. The match
  // requires the opening paren so comment lines like "CREATE TABLE IF NOT
  // EXISTS only." do not register phantom tables.
  const created = new Set();
  // Recursive: nested modules (e.g. server/analytics/schema.mjs) own tables
  // too, and the flat scan missed them (F-2).
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith(".mjs")) continue;
      const src = readFileSync(full, "utf8");
      for (const match of src.matchAll(/CREATE TABLE IF NOT EXISTS\s+([a-z_][a-z0-9_]*)\s*\(/gi)) {
        created.add(match[1].toLowerCase());
      }
      // Interpolated table names (e.g. server/public-work-claim-fence.mjs
      // builds its DDL from `const permit = 'public_work_claim_writer_permit'`):
      // resolve the simple const binding so the guardrail sees the table too.
      const bindings = new Map();
      for (const binding of src.matchAll(/^[ \t]*const[ \t]+([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*'([a-z_][a-z0-9_]*)'[ \t]*;/gim)) {
        bindings.set(binding[1], binding[2].toLowerCase());
      }
      for (const match of src.matchAll(/CREATE TABLE IF NOT EXISTS\s+\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
        const table = bindings.get(match[1]);
        if (table) created.add(table);
      }
    }
  };
  walk(SERVER_DIR);
  // writer-fence owns the canonical DDL; only additive module tables are in scope here.
  const registered = new Set([...applicationTables, ...lazyAdditiveTables]);
  const unregistered = [...created].filter(t => !registered.has(t));
  assert.deepEqual(unregistered, [],
    `unregistered tables would fail the recovery audit: ${unregistered.join(", ")}`);
});

test("unfenced additive tables stay outside the v34 writer fence", () => {
  assert.ok(unfencedAdditiveTables.includes("access_requests"));
  assert.ok(unfencedAdditiveTables.includes("private_inbox_reads"));
  assert.ok(unfencedAdditiveTables.includes("share_link_codes"));
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

// H5: every table in applicationTables is REQUIRED by auditRecovery
// (server/recovery.mjs: every required table must exist in the database).
// A table whose DDL only runs lazily on first write must therefore live in
// lazyAdditiveTables (allowed, never required) — registering it as required
// broke recovery for every database that never recorded a funnel event:
// plugin_funnel_events sat in unfencedAdditiveTables (⊂ applicationTables)
// while ensurePluginFunnelSchema only ran inside recordPluginFunnelStage,
// so auditRecovery threw "Recovery data requires operator reconciliation"
// on fresh and pre-funnel databases alike.
test("required application tables all exist in a freshly initialized store", () => {
  const store = new RoomStore(":memory:");
  try {
    store.initialize(initialRoom("commons"));
    const tables = new Set(
      store.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name)
    );
    const missing = applicationTables.filter(table => !tables.has(table));
    assert.deepEqual(missing, [],
      `auditRecovery would demand operator reconciliation for: ${missing.join(", ")}`);
  } finally {
    store.close();
  }
});

test("plugin_funnel_events is allowed-but-optional (created on first funnel write)", () => {
  assert.ok(lazyAdditiveTables.includes("plugin_funnel_events"),
    "the lazily-created funnel table must be allowed, never required");
  assert.ok(!applicationTables.includes("plugin_funnel_events"),
    "the lazily-created funnel table must not be in the required set");
});
