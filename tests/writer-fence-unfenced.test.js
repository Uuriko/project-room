// Regression test: every additive module-owned table must be registered in
// writer-fence.mjs, otherwise auditRecovery() throws "Recovery data requires
// operator reconciliation" (main browser gate went red at 317c7b1 when
// server/access-requests.mjs created its table unregistered).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applicationTables, lazyAdditiveTables, unfencedAdditiveTables } from "../server/writer-fence.mjs";

const SERVER_DIR = new URL("../server/", import.meta.url).pathname;

// Collect every table created by DDL under a directory tree of .mjs modules.
// Recursive: server/analytics/claim-bond-shadow.mjs created claim_bond_shadow
// unregistered (PR #1466) and the top-level-only scan missed it, and nested
// modules (e.g. server/analytics/schema.mjs) own tables too (F-2). The match
// requires the opening paren so comment lines like "CREATE TABLE IF NOT
// EXISTS only." do not register phantom tables.
function scanCreatedTables(rootDir) {
  const created = new Set();
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith(".mjs")) continue;
      const src = readFileSync(full, "utf8");
      // "IF NOT EXISTS" is optional (#2911): plain CREATE TABLE is the
      // established style in agent-connections.mjs, email-import.mjs,
      // inbox.mjs, reminders.mjs and attachment-schema.mjs, and a scan that
      // only matched the IF NOT EXISTS form let a new module written in
      // that style escape this guardrail entirely.
      for (const match of src.matchAll(/CREATE TABLE\s+(?:IF NOT EXISTS\s+)?([a-z_][a-z0-9_]*)\s*\(/gi)) {
        created.add(match[1].toLowerCase());
      }
      // Interpolated table names (e.g. server/public-work-claim-fence.mjs
      // builds its DDL from `const permit = 'public_work_claim_writer_permit'`):
      // resolve the simple const binding so the guardrail sees the table too.
      const bindings = new Map();
      for (const binding of src.matchAll(/^[ \t]*const[ \t]+([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*'([a-z_][a-z0-9_]*)'[ \t]*;/gim)) {
        bindings.set(binding[1], binding[2].toLowerCase());
      }
      for (const match of src.matchAll(/CREATE TABLE\s+(?:IF NOT EXISTS\s+)?\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
        const table = bindings.get(match[1]);
        if (table) created.add(table);
      }
    }
  };
  walk(rootDir);
  return created;
}

test("all CREATE TABLE tables in server modules are registered application tables", () => {
  const created = scanCreatedTables(SERVER_DIR);
  // Known plain-form tables (no IF NOT EXISTS) must actually be seen by the
  // scan; on the pre-#2911 patterns none of them were, so this pins the fix
  // to the real tree, not just the synthetic fixture below.
  for (const plainTable of ["agent_connections", "agent_connection_operations",
    "private_email_connections", "private_inbox_sources", "private_reminders",
    "room_attachments", "membership_invitation_journal"]) {
    assert.ok(created.has(plainTable),
      `scan missed plain CREATE TABLE table: ${plainTable}`);
  }
  // writer-fence owns the canonical DDL; only additive module tables are in scope here.
  const registered = new Set([...applicationTables, ...lazyAdditiveTables]);
  const unregistered = [...created].filter(t => !registered.has(t));
  assert.deepEqual(unregistered, [],
    `unregistered tables would fail the recovery audit: ${unregistered.join(", ")}`);
});

test("table scan detects the plain CREATE TABLE form, literal and interpolated (#2911)", () => {
  const dir = mkdtempSync(join(tmpdir(), "writer-fence-scan-"));
  try {
    writeFileSync(join(dir, "plain.mjs"), [
      "export const schema = `",
      "  CREATE TABLE plain_literal_guardrail_probe (id TEXT PRIMARY KEY);",
      "  CREATE TABLE IF NOT EXISTS if_not_exists_guardrail_probe (id TEXT PRIMARY KEY);",
      "`;",
      "const permit = 'plain_interp_guardrail_probe';",
      "export const permitSql = `CREATE TABLE ${permit} (id TEXT);`;",
      "const inefPermit = 'inef_interp_guardrail_probe';",
      "export const inefSql = `CREATE TABLE IF NOT EXISTS ${inefPermit} (id TEXT);`;",
      "// CREATE TABLE IF NOT EXISTS only.",
      "const nameRe = /^CREATE TABLE (\\w+)/;",
      "void nameRe;",
      "",
    ].join("\n"));
    mkdirSync(join(dir, "nested"));
    writeFileSync(join(dir, "nested", "plain.mjs"),
      "export const nested = `CREATE TABLE nested_plain_guardrail_probe (id TEXT);`;\n");
    // Exactly the five real tables: the comment line and the regex literal
    // above must not register phantom tables.
    assert.deepEqual([...scanCreatedTables(dir)].sort(), [
      "if_not_exists_guardrail_probe",
      "inef_interp_guardrail_probe",
      "nested_plain_guardrail_probe",
      "plain_interp_guardrail_probe",
      "plain_literal_guardrail_probe",
    ]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
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
