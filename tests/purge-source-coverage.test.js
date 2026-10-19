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
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PURGE_TABLES } from "../server/purge-registry.mjs";
import { EXECUTOR_DELETIONS, EXEMPTIONS, UNRESOLVED } from "./purge-source-coverage-dispositions.mjs";
import { enumerateSourceTables } from "./source-table-enumeration.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// The enumeration itself (STRICT_DDL / DYNAMIC_DDL + the server/** walker)
// lives in tests/source-table-enumeration.mjs, shared with
// tests/retention-source-coverage.test.js so the purge and retention
// registries are always dispositioned against the same enumerated set.
const { tables: sourceTables, unresolvable } = enumerateSourceTables(repoRoot);
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
