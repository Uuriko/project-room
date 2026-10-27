// Purge coverage, enumerated from SOURCE DDL.
//
// The older coverage check (tests/operator-purge.test.js) enumerates tables
// from a SERVED store's sqlite_master and only looks at tables carrying a
// room_id / identity_id / account_id column. That method is blind to exactly
// the class it exists to catch: public_work_requests has none of those
// columns, and the analytics shadow tables do not exist in a fresh store at
// all — both gaps survived for months (HUNT-ORPHANS findings 2 and 3, fixed
// by PR #4150). This test instead enumerates every CREATE TABLE in server/**
// source — including lazily created additive tables and tables whose DDL
// names them through a same-file const — and requires each one to have a
// disposition:
//
//   (a) a purge-registry row (server/purge-registry.mjs), or
//   (b) an executor-deletion entry (deleted by a named non-registry
//       mechanism, anchor-verified below), or
//   (c) an exemption entry with a reason,
//   (d) or sit on the coordinator-owned UNRESOLVED list.
//
// (b)–(d) live in tests/purge-source-coverage-dispositions.mjs. A new table
// with no disposition fails this suite and names itself; a stale disposition
// entry fails as soon as its table gains a registry row or loses its DDL.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { PURGE_TABLES } from "../server/purge-registry.mjs";
import { EXECUTOR_DELETIONS, EXEMPTIONS, UNRESOLVED } from "./purge-source-coverage-dispositions.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const serverDir = join(repoRoot, "server");

// A real DDL statement names the table and opens its column list; requiring
// the "(" keeps comment prose ("the CREATE TABLE above") and regex literals
// from enumerating phantom tables.
const STRICT_DDL = /CREATE\s+(?:VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(["'`\[]?)([A-Za-z_][A-Za-z0-9_]*)\1\s*\(/g;
// DDL that names its table through an interpolated const:
//   CREATE TABLE IF NOT EXISTS ${permit} (
// The const must resolve to a string literal in the same file; an
// unresolvable one is an enumeration failure, never a silent skip.
const DYNAMIC_DDL = /CREATE\s+(?:VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?\$\{\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\}/g;

function serverFiles() {
  const out = [];
  (function walk(dir) {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else out.push(path);
    }
  })(serverDir);
  return out;
}

function enumerateSourceTables() {
  const tables = new Map(); // name -> [repo-relative files]
  const unresolvable = [];
  for (const file of serverFiles()) {
    const text = readFileSync(file, "utf8");
    const rel = relative(repoRoot, file);
    for (const match of text.matchAll(STRICT_DDL)) {
      if (!tables.has(match[2])) tables.set(match[2], []);
      tables.get(match[2]).push(rel);
    }
    for (const match of text.matchAll(DYNAMIC_DDL)) {
      const ident = match[1];
      const constPattern = new RegExp(`(?:export\\s+)?const\\s+${ident}\\s*=\\s*['"\`]([A-Za-z_][A-Za-z0-9_]*)['"\`]`);
      const resolved = constPattern.exec(text);
      if (!resolved) {
        unresolvable.push(`${rel}: CREATE TABLE names its table through \${${ident}}, which does not resolve to a string-literal const in the same file`);
        continue;
      }
      if (!tables.has(resolved[1])) tables.set(resolved[1], []);
      tables.get(resolved[1]).push(`${rel} (dynamic \${${ident}})`);
    }
  }
  return { tables, unresolvable };
}

const { tables: sourceTables, unresolvable } = enumerateSourceTables();
const registryTables = new Set(PURGE_TABLES.map(row => row.table));
const executorTables = new Set(Object.keys(EXECUTOR_DELETIONS));
const exemptTables = new Set(Object.keys(EXEMPTIONS));
const unresolvedTables = new Set(UNRESOLVED);

test("source enumeration is complete enough to trust", () => {
  assert.deepEqual(unresolvable, [], "every dynamically named CREATE TABLE must resolve in-file");
  assert.ok(sourceTables.size >= 200, `expected >= 200 source tables, enumerated ${sourceTables.size} — the walker or the DDL pattern is broken`);
  // Sentinels for the historical blind spots and for the dynamic path:
  // public_work_requests (no room/identity/account key column),
  // analytics_events (absent from a fresh store), work_item_board_backfill
  // (DDL names the table through a const).
  for (const sentinel of ["rooms", "accounts", "public_work_requests", "analytics_events", "work_item_board_backfill"]) {
    assert.ok(sourceTables.has(sentinel), `sentinel table ${sentinel} was not enumerated from source`);
  }
});

test("every table created in server/** source has exactly one purge disposition", () => {
  const undispositioned = [];
  for (const table of sourceTables.keys()) {
    if (registryTables.has(table) || executorTables.has(table) || exemptTables.has(table)) continue;
    undispositioned.push(table);
  }
  assert.deepEqual(
    undispositioned.sort(),
    [...unresolvedTables].sort(),
    "tables with no purge disposition must be exactly the UNRESOLVED list. " +
      "A new table needs a purge-registry row, an executor-deletion entry, or an exemption with a reason " +
      "in tests/purge-source-coverage-dispositions.mjs — or, with coordinator sign-off and a PR-body listing, " +
      "an UNRESOLVED entry. A table listed in UNRESOLVED that gained a disposition must come off the list.",
  );
  for (const table of unresolvedTables) {
    assert.ok(sourceTables.has(table), `UNRESOLVED entry ${table} has no CREATE TABLE in server/** source — remove the stale entry`);
  }
});

test("executor-deletion entries anchor on a mechanism that still exists in source", () => {
  for (const [table, entry] of Object.entries(EXECUTOR_DELETIONS)) {
    assert.ok(sourceTables.has(table), `executor-deletion entry ${table} has no CREATE TABLE in server/** source — remove the stale entry`);
    assert.ok(!registryTables.has(table), `${table} now has a purge-registry row — remove its executor-deletion entry`);
    assert.ok(entry.file && entry.anchor && entry.mechanism, `executor-deletion entry ${table} needs file, anchor, and mechanism`);
    const text = readFileSync(join(repoRoot, entry.file), "utf8");
    assert.ok(
      text.includes(entry.anchor),
      `executor-deletion anchor for ${table} not found in ${entry.file}: ${JSON.stringify(entry.anchor)} — ` +
        "the deletion mechanism moved or vanished; re-disposition the table instead of weakening the anchor",
    );
  }
});

test("exemption entries carry a substantive reason and stay current", () => {
  for (const [table, reason] of Object.entries(EXEMPTIONS)) {
    assert.ok(sourceTables.has(table), `exemption entry ${table} has no CREATE TABLE in server/** source — remove the stale entry`);
    assert.ok(!registryTables.has(table), `${table} now has a purge-registry row — remove its exemption entry`);
    assert.ok(!executorTables.has(table), `${table} has both an executor-deletion and an exemption entry — keep exactly one disposition`);
    assert.equal(typeof reason, "string", `exemption for ${table} must be a reason string`);
    assert.ok(reason.trim().length >= 40, `exemption reason for ${table} is too thin to be a declaration: ${JSON.stringify(reason)}`);
  }
  for (const table of unresolvedTables) {
    assert.ok(!exemptTables.has(table) && !executorTables.has(table), `${table} is both UNRESOLVED and dispositioned — keep exactly one`);
  }
});
