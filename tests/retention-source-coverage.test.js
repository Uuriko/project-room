// Retention coverage, enumerated from SOURCE DDL.
//
// Before server/retention-registry.mjs existed, exactly two tables had a
// retention behaviour (the disposable web logs) and every other table's
// keep/delete story was an unrecorded default: the analytics and audit
// planners were plan-only in every scheduled path, and the retention
// receipt's "excluded" list named six tables with no decision attached
// (HUNT-SOAK S-4, ATLAS-DATA D-6/D-16). This suite requires every table
// created in server/** source to carry exactly one recorded disposition
// in the registry — drain (with its rule), keep (with the reason), or
// purge-only — and requires the tick's executed drain set to be exactly
// the registry's age-ruled rows, so the registry cannot drift from the
// code that runs.
//
// The enumeration is shared with tests/purge-source-coverage.test.js via
// tests/source-table-enumeration.mjs: both registries disposition the
// same enumerated set, by construction.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  RETENTION_DISPOSITIONS,
  RETENTION_AGE_DRAIN_TABLES,
  retentionDispositionFor
} from "../server/retention-registry.mjs";
import { RETENTION_TABLES } from "../server/retention-run.mjs";
import { enumerateSourceTables } from "./source-table-enumeration.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const { tables: sourceTables, unresolvable } = enumerateSourceTables(repoRoot);
const registryTables = RETENTION_DISPOSITIONS.map(row => row.table);

test("source enumeration is complete enough to trust", () => {
  assert.deepEqual(unresolvable, [], "every dynamically named CREATE TABLE must resolve in-file");
  assert.ok(sourceTables.size >= 200, `expected >= 200 source tables, enumerated ${sourceTables.size} — the walker or the DDL pattern is broken`);
  for (const sentinel of ["rooms", "web_fetch_log", "analytics_events", "operator_actions", "agent_webhook_deliveries"]) {
    assert.ok(sourceTables.has(sentinel), `sentinel table ${sentinel} was not enumerated from source`);
  }
});

test("every table created in server/** source has exactly one retention disposition", () => {
  const seen = new Set();
  for (const table of registryTables) {
    assert.ok(!seen.has(table), `retention registry carries ${table} twice — keep exactly one disposition`);
    seen.add(table);
  }
  const undispositioned = [...sourceTables.keys()].filter(table => !seen.has(table)).sort();
  assert.deepEqual(
    undispositioned, [],
    "tables with no retention disposition. Record one in server/retention-registry.mjs: " +
      "drain (with its rule), keep (with the reason), or purge-only (deleted by room/identity/account purge).",
  );
  const stale = registryTables.filter(table => !sourceTables.has(table)).sort();
  assert.deepEqual(stale, [], "retention registry rows naming tables with no CREATE TABLE in server/** source — remove the stale rows");
});

test("dispositions are well-formed and mechanism citations still exist", () => {
  for (const row of RETENTION_DISPOSITIONS) {
    assert.ok(row.table && typeof row.table === "string", "every disposition names its table");
    if (row.disposition === "drain") {
      assert.ok(row.rule, `${row.table}: a drain disposition needs its rule`);
      if (row.rule.kind === "age") {
        assert.ok(Number.isInteger(row.rule.days) && row.rule.days > 0, `${row.table}: age rule needs a positive day count`);
        assert.ok(typeof row.rule.idColumn === "string" && row.rule.idColumn.length > 0, `${row.table}: age rule needs an id column`);
        assert.ok(typeof row.rule.timestampColumn === "string" && row.rule.timestampColumn.length > 0, `${row.table}: age rule needs a timestamp column`);
      } else if (row.rule.kind === "mechanism") {
        assert.ok(row.rule.name && row.rule.file && row.rule.anchor && row.rule.detail,
          `${row.table}: a mechanism rule needs name, file, anchor, and detail`);
        assert.ok(row.rule.detail.trim().length >= 40, `${row.table}: mechanism detail is too thin to be a declaration`);
        const text = readFileSync(join(repoRoot, row.rule.file), "utf8");
        assert.ok(
          text.includes(row.rule.anchor),
          `${row.table}: mechanism anchor not found in ${row.rule.file}: ${JSON.stringify(row.rule.anchor)} — ` +
            "the mechanism moved or vanished; re-disposition the table instead of weakening the anchor",
        );
      } else {
        assert.fail(`${row.table}: unknown drain rule kind ${JSON.stringify(row.rule.kind)}`);
      }
    } else if (row.disposition === "keep" || row.disposition === "purge-only") {
      assert.equal(typeof row.reason, "string", `${row.table}: a ${row.disposition} disposition needs a reason string`);
      assert.ok(row.reason.trim().length >= 40, `${row.table}: ${row.disposition} reason is too thin to be a declaration: ${JSON.stringify(row.reason)}`);
    } else {
      assert.fail(`${row.table}: unknown disposition ${JSON.stringify(row.disposition)}`);
    }
  }
});

test("the tick's executed drain set is exactly the registry's age-ruled rows", () => {
  assert.deepEqual(
    RETENTION_TABLES.map(spec => ({ table: spec.table, days: spec.days, idColumn: spec.idColumn })),
    RETENTION_AGE_DRAIN_TABLES.map(spec => ({ table: spec.table, days: spec.days, idColumn: spec.idColumn })),
    "retention-run.mjs must execute the registry's age rules, not a second hand-kept list",
  );
  for (const spec of RETENTION_AGE_DRAIN_TABLES) {
    assert.equal(retentionDispositionFor(spec.table)?.disposition, "drain", `${spec.table} drains but is not dispositioned as drain`);
  }
});

test("the load-bearing dispositions say what the evidence established", () => {
  const drain = (table, kind) => {
    const row = retentionDispositionFor(table);
    assert.equal(row?.disposition, "drain", `${table} must be a drain disposition`);
    assert.equal(row.rule.kind, kind, `${table} must drain by ${kind}`);
  };
  drain("web_fetch_log", "age");
  drain("web_research_log", "age");
  drain("agent_webhook_deliveries", "mechanism");
  drain("abuse_rate_buckets", "mechanism");
  assert.equal(retentionDispositionFor("web_fetch_log").rule.days, 30);
  // The audit and analytics planners are deliberately not wired to delete:
  // those decisions are recorded as keeps, not left as defaults.
  assert.equal(retentionDispositionFor("events")?.disposition, "keep");
  assert.equal(retentionDispositionFor("analytics_events")?.disposition, "keep");
  assert.equal(retentionDispositionFor("operator_actions")?.disposition, "keep");
  assert.equal(retentionDispositionFor("rooms")?.disposition, "purge-only");
  assert.equal(retentionDispositionFor("accounts")?.disposition, "purge-only");
});
