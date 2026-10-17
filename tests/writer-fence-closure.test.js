// Writer-fence closure (find:writer-fence-001, first subject of the T-5
// registry-closure census): server/writer-fence.mjs and
// server/purge-registry.mjs are two hand-maintained registries over the
// same tables, plus the DDL each server module actually runs. The unfenced
// list was already closed against module DDL by
// tests/writer-fence-unfenced.test.js; this test pins the remaining three
// legs in agreement — fence <-> purge <-> DDL — so a table added to the
// store DDL without a fence/purge disposition fails here, at the commit
// that introduces it, instead of when auditRecovery meets a database
// carrying the table.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { STORE_SCHEMA_VERSION, applicationTables, fenceDefinitions, lazyAdditiveTables, unfencedAdditiveTables, writerVersions } from "../server/writer-fence.mjs";
import { PURGE_TABLES } from "../server/purge-registry.mjs";

const SERVER_DIR = new URL("../server/", import.meta.url).pathname;
const REGISTERED = new Set([...applicationTables, ...lazyAdditiveTables]);

function fencedTables(version) {
  const prefix = `writer_v${version}_`;
  return [...new Set(fenceDefinitions(version).map(def =>
    def.name.slice(prefix.length).replace(/_(insert|update|delete)$/, "")))];
}

// Same CREATE TABLE scan as tests/writer-fence-unfenced.test.js (plain and
// IF NOT EXISTS forms, plus simple const-interpolated names).
function scanCreatedTables(rootDir) {
  const created = new Set();
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith(".mjs")) continue;
      const src = readFileSync(full, "utf8");
      for (const match of src.matchAll(/CREATE TABLE\s+(?:IF NOT EXISTS\s+)?([a-z_][a-z0-9_]*)\s*\(/gi)) {
        created.add(match[1].toLowerCase());
      }
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

test("every writer-fence lineage (all schema versions) is a registered application/lazy table", () => {
  for (const version of writerVersions) {
    const unregistered = fencedTables(version).filter(table => !REGISTERED.has(table));
    assert.deepEqual(unregistered, [], `v${version} fences unregistered tables: ${unregistered.join(", ")}`);
  }
});

test("the current fence lineage is fenced applicationTables, never lazy-only tables", () => {
  const current = fencedTables(STORE_SCHEMA_VERSION);
  assert.ok(current.length > 0);
  assert.deepEqual(current.filter(table => !applicationTables.includes(table)), []);
  assert.equal(fenceDefinitions(STORE_SCHEMA_VERSION).length, current.length * 3,
    "one INSERT/UPDATE/DELETE trigger per fenced table");
});

test("purge registry only names registered tables, once each, with a complete disposition", () => {
  assert.equal(new Set(PURGE_TABLES.map(row => row.table)).size, PURGE_TABLES.length, "no duplicate purge rows");
  for (const row of PURGE_TABLES) {
    assert.ok(REGISTERED.has(row.table), `purge row for unregistered table: ${row.table}`);
    if (row.action === "retain") assert.ok(row.reason, `retain row needs a reason: ${row.table}`);
    if (row.action === "delete") assert.ok(row.match, `delete row needs a match spec: ${row.table}`);
  }
});

test("applicationTables and lazyAdditiveTables are disjoint", () => {
  assert.deepEqual(applicationTables.filter(table => lazyAdditiveTables.includes(table)), []);
});

// Registered tables with NO purge-registry disposition, recorded explicitly
// at this pin (base 6f828f08). This set is the closure: a registered table
// may join it only by a deliberate edit here, with its group named — the
// same shrink-or-explain discipline as the census baseline.
const NO_PURGE_ROOTS = Object.freeze([ // the purge targets themselves; the executors delete these rows directly
  "accounts", "rooms",
]);
const NO_PURGE_LAZY = Object.freeze([ // lazyAdditiveTables: created on demand by tooling/modules, never by the store constructor, no room/identity/account purge key
  "abuse_rate_buckets", "agent_operator_controls", "agent_wake_listener_leases",
  "agent_wake_room_activity", "agent_wake_signal_claims", "analytics_ctx",
  "analytics_daily", "analytics_events", "analytics_firsts", "analytics_room_cursor",
  "analytics_table_cursor", "claim_bond_shadow", "claim_reputation_signals",
  "oauth_provider_access_tokens", "oauth_provider_clients", "oauth_provider_codes",
  "oauth_provider_refresh_tokens", "request_replays", "seeker_declarations",
  "work_offer_terms",
]);
const NO_PURGE_UNFENCED = Object.freeze([ // unfencedAdditiveTables with no purge disposition at this pin
  "agent_bonds", "board_vtwo_claims", "board_vtwo_events", "board_vtwo_idempotency",
  "board_vtwo_mirror", "integrity_job_cursor", "integrity_snapshot",
  "oauth_pending_states", "operator_actions", "peer_dm_threads",
  "public_abuse_reports", "public_read_model_backfill", "public_unpublish",
  "public_work_claim_writer_permit", "public_work_requests", "room_schema_stamp",
  "web_fetch_cache",
]);

test("every registered table has a purge disposition or a named exception above", () => {
  for (const table of NO_PURGE_LAZY) assert.ok(lazyAdditiveTables.includes(table), `${table} is not a lazy table`);
  for (const table of NO_PURGE_UNFENCED) assert.ok(unfencedAdditiveTables.includes(table), `${table} is not an unfenced additive table`);
  const purged = new Set(PURGE_TABLES.map(row => row.table));
  const withoutDisposition = [...REGISTERED].filter(table => !purged.has(table)).sort();
  const expected = [...NO_PURGE_ROOTS, ...NO_PURGE_LAZY, ...NO_PURGE_UNFENCED].sort();
  assert.deepEqual(withoutDisposition, expected,
    "registered tables without a purge disposition changed — add a PURGE_TABLES row, or record the table in its exception group above");
});

test("every table created by server-module DDL is registered (fence/purge universe)", () => {
  const created = scanCreatedTables(SERVER_DIR);
  for (const plainTable of ["agent_connections", "room_attachments", "membership_invitation_journal"]) {
    assert.ok(created.has(plainTable), `scan missed plain CREATE TABLE table: ${plainTable}`);
  }
  const unregistered = [...created].filter(table => !REGISTERED.has(table));
  assert.deepEqual(unregistered, [],
    `DDL creates unregistered tables — register in writer-fence.mjs (applicationTables or lazyAdditiveTables): ${unregistered.join(", ")}`);
});
