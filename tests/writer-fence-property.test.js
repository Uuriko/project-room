import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STORE_SCHEMA_VERSION, WRITER_FUNCTION, writerVersions, applicationTables, fenceDefinitions, writerFenceDefinitions, registerWriter, installWriterFence, verifyWriterFence } from "../server/writer-fence.mjs";

// Property-style tests over synthetic databases (never user data): random fence
// versions, writer identities and trigger mutations from a fixed-seed generator.
// PROPERTY_TEST_SEED shifts every seed for an extra exploratory run; the default stays fixed.
const seedOffset = Number(process.env.PROPERTY_TEST_SEED ?? 0);
function rng(seed) {
  let s = (seed + seedOffset) >>> 0;
  const next = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const int = (lo, hi) => lo + Math.floor(next() * (hi - lo + 1));
  const pick = list => list[int(0, list.length - 1)];
  const chance = p => next() < p;
  return { next, int, pick, chance };
}
const operations = ["INSERT", "UPDATE", "DELETE"];
const tablesOf = version => [...new Set(fenceDefinitions(version).map(d => d.name.replace(/^writer_v\d+_/, "").replace(/_(insert|update|delete)$/, "")))];
// Every application table with one seeded row, so UPDATE and DELETE triggers actually fire.
function database(filename = ":memory:") {
  const db = new DatabaseSync(filename);
  for (const table of applicationTables) db.exec(`CREATE TABLE ${table}(id INTEGER PRIMARY KEY, v); INSERT INTO ${table}(v) VALUES (0)`);
  return db;
}
const write = (db, table, operation) => ({ INSERT: `INSERT INTO ${table}(v) VALUES (1)`, UPDATE: `UPDATE ${table} SET v=v+1`, DELETE: `DELETE FROM ${table} WHERE id=(SELECT min(id) FROM ${table})` })[operation];
const triggers = db => db.prepare("SELECT name, sql FROM sqlite_master WHERE type='trigger' AND name GLOB 'writer_v*' ORDER BY name").all();

test("fence definitions form one exact trigger per table and operation, and table sets only ever grow across versions", () => {
  assert.equal(writerVersions.at(-1), STORE_SCHEMA_VERSION);
  assert.equal(WRITER_FUNCTION, `project_room_writer_v${STORE_SCHEMA_VERSION}`);
  assert.deepEqual(writerFenceDefinitions, fenceDefinitions(STORE_SCHEMA_VERSION));
  let previous = [];
  for (const version of writerVersions) {
    const definitions = fenceDefinitions(version), tables = tablesOf(version);
    assert.ok(Object.isFrozen(definitions) && definitions.every(Object.isFrozen));
    assert.equal(definitions.length, tables.length * operations.length, `v${version}: three triggers per table`);
    assert.equal(new Set(definitions.map(d => d.name)).size, definitions.length, `v${version}: trigger names are unique`);
    assert.deepEqual(definitions.map(d => d.name), tables.flatMap(table => operations.map(op => `writer_v${version}_${table}_${op.toLowerCase()}`)));
    for (const { name, sql } of definitions) {
      const [, v, table, op] = name.match(/^writer_v(\d+)_([a-z_]+)_(insert|update|delete)$/);
      assert.equal(Number(v), version);
      assert.equal(sql, `CREATE TRIGGER ${name} BEFORE ${op.toUpperCase()} ON ${table} BEGIN SELECT CASE WHEN project_room_writer_v${version}() IS NOT ${version} THEN RAISE(ABORT,'unsupported database writer') END; END`);
    }
    assert.ok(previous.every(table => tables.includes(table)), `v${version} keeps every table fenced at the previous version`);
    assert.ok(tables.every(table => applicationTables.includes(table)), `v${version} fences only application tables`);
    previous = tables;
  }
  assert.equal(new Set(applicationTables).size, applicationTables.length);
  assert.ok(tablesOf(STORE_SCHEMA_VERSION).length < applicationTables.length, "additive tables exist outside the fenced set");
});

test("for any fence version, a write passes exactly when the registered writer answers that integer version", t => {
  const r = rng(0xfe0ce001);
  for (let i = 0; i < 120; i++) {
    const version = r.pick(writerVersions), db = database(); t.after(() => db.close());
    const fenced = tablesOf(version), unfenced = applicationTables.filter(table => !fenced.includes(table));
    for (const { sql } of fenceDefinitions(version)) db.exec(sql);
    const answer = r.pick([version, version, version, version - 1, version + 1, STORE_SCHEMA_VERSION, 6, 0, -version, null, String(version), version + 0.5, 2 ** 40]);
    db.function(`project_room_writer_v${version}`, () => answer);
    const table = r.pick(fenced), operation = r.pick(operations), statement = write(db, table, operation);
    if (answer === version) assert.doesNotThrow(() => db.exec(statement), `v${version} ${operation} ${table}`);
    else assert.throws(() => db.exec(statement), /unsupported database writer/, `v${version} ${operation} ${table} with writer ${String(answer)}`);
    if (unfenced.length) assert.doesNotThrow(() => db.exec(write(db, r.pick(unfenced), operation)), "additive tables outside the fence never consult the writer");
    if (answer !== version) {
      assert.equal(db.prepare(`SELECT count(*) n FROM ${table}`).get().n, 1, "an aborted write leaves the table untouched");
      assert.equal(db.prepare(`SELECT v FROM ${table}`).get().v, 0);
    }
  }
});

test("a connection without any writer function is refused by every fenced write; registerWriter answers every retained version", t => {
  const r = rng(0xfe0ce002);
  const directory = mkdtempSync(join(tmpdir(), "room-fence-property-")); t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (let i = 0; i < 12; i++) {
    const filename = join(directory, `fence-${i}.sqlite`), version = r.pick(writerVersions);
    const current = database(filename), stale = new DatabaseSync(filename);
    try {
      current.exec("PRAGMA synchronous=OFF");
      for (const v of writerVersions.filter(v => v <= version)) for (const { sql } of fenceDefinitions(v)) current.exec(sql);
      registerWriter(current);
      for (const v of writerVersions) assert.equal(current.prepare(`SELECT project_room_writer_v${v}() AS v`).get().v, v);
      const table = r.pick(tablesOf(version)), operation = r.pick(operations);
      assert.doesNotThrow(() => current.exec(write(current, table, operation)), "the migrated connection satisfies every retained fence");
      // Row-level triggers only fire against existing rows, so keep every table populated before the stale writes.
      for (const t of tablesOf(version)) if (!current.prepare(`SELECT count(*) n FROM ${t}`).get().n) current.exec(write(current, t, "INSERT"));
      assert.throws(() => stale.exec(write(stale, table, operation)), /project_room_writer_v|unsupported database writer/, "a pre-migration connection has no writer function");
      const lying = r.pick(writerVersions.filter(v => v <= version)), value = r.pick([lying - 1, null, 0]);
      for (const v of writerVersions.filter(v => v <= version)) stale.function(`project_room_writer_v${v}`, () => v === lying ? value : v);
      assert.throws(() => stale.exec(write(stale, r.pick(tablesOf(lying)), r.pick(operations))), /unsupported database writer/, `one wrong answer at v${lying} fences the write`);
    } finally { current.close(); stale.close(); }
  }
});

test("verifyWriterFence accepts exact installs at any version and rejects any single trigger drift", t => {
  const r = rng(0xfe0ce003);
  for (let i = 0; i < 60; i++) {
    const version = r.pick(writerVersions), db = database(); t.after(() => db.close());
    // Retained lower-version guards are optional but must be exact when present.
    const retained = writerVersions.filter(v => v < version && r.chance(0.6));
    for (const v of [...retained, version]) for (const { sql } of fenceDefinitions(v)) db.exec(sql);
    if (r.chance(0.3)) db.exec(`CREATE TRIGGER audit_${i} AFTER INSERT ON rooms BEGIN SELECT 1; END`); // Not a writer trigger: ignored.
    assert.doesNotThrow(() => verifyWriterFence(db, version), `v${version} with retained ${retained.join(",")}`);
    // Only the current version's triggers are mandatory; a retained guard may be absent but never drifted.
    const installed = triggers(db), own = r.pick(installed.filter(row => row.name.startsWith(`writer_v${version}_`))), any = r.pick(installed);
    const drift = sql => sql.replace("RAISE(ABORT,'unsupported database writer')", "RAISE(ABORT,'unsupported writer')");
    const mutation = r.pick(["drop", "rewrite", "rename", "stray", "future", "retained-drift"]);
    switch (mutation) {
      case "drop": db.exec(`DROP TRIGGER ${own.name}`); break;
      case "rewrite": db.exec(`DROP TRIGGER ${any.name}; ${drift(any.sql)}`); break;
      case "rename": db.exec(`DROP TRIGGER ${any.name}; ${any.sql.replace(any.name, any.name + "_x")}`); break;
      case "stray": db.exec(`CREATE TRIGGER writer_v${version}_${r.pick(applicationTables)}_purge BEFORE DELETE ON rooms BEGIN SELECT 1; END`); break;
      case "future": { const later = writerVersions.find(v => v > version); if (later === undefined) { db.exec(`DROP TRIGGER ${own.name}`); break; }
        db.exec(fenceDefinitions(later)[r.int(0, 2)].sql); break; } // An exact trigger from a later version is still unexpected here.
      default: { const lower = writerVersions.filter(v => v < version); if (!lower.length) { db.exec(`DROP TRIGGER ${own.name}`); break; }
        const other = r.pick(lower), definition = fenceDefinitions(other)[r.int(0, 2)];
        if (retained.includes(other)) db.exec(`DROP TRIGGER ${definition.name}`);
        db.exec(drift(definition.sql)); } // A drifted retained guard is caught even though its absence would be tolerated.
    }
    assert.throws(() => verifyWriterFence(db, version), /operator reconciliation/, `${mutation} at v${version} must be detected`);
    if (mutation === "drop") {
      const lowerRetained = retained.length ? fenceDefinitions(r.pick(retained))[0] : null;
      if (lowerRetained) { db.exec(own.sql); db.exec(`DROP TRIGGER ${lowerRetained.name}`); assert.doesNotThrow(() => verifyWriterFence(db, version), "a missing retained guard is tolerated"); }
    }
  }
});

test("installWriterFence is idempotent inside a transaction, refuses drifted triggers and stamps the schema version", t => {
  const r = rng(0xfe0ce004);
  for (let i = 0; i < 60; i++) {
    const db = database(); t.after(() => db.close());
    const preinstalled = writerFenceDefinitions.filter(() => r.chance(0.5));
    for (const { sql } of preinstalled) db.exec(sql);
    if (r.chance(0.4)) for (const v of writerVersions.filter(v => v < STORE_SCHEMA_VERSION && r.chance(0.3))) for (const { sql } of fenceDefinitions(v)) db.exec(sql);
    assert.throws(() => installWriterFence(db), /migration transaction/);
    db.exec("BEGIN");
    installWriterFence(db);
    installWriterFence(db);
    db.exec("COMMIT");
    const current = triggers(db).filter(row => row.name.startsWith(`writer_v${STORE_SCHEMA_VERSION}_`));
    assert.deepEqual(current.map(row => row.name).sort(), writerFenceDefinitions.map(d => d.name).sort());
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, STORE_SCHEMA_VERSION);
    assert.doesNotThrow(() => verifyWriterFence(db));
    const drifted = database(); t.after(() => drifted.close());
    const victim = r.pick(writerFenceDefinitions);
    drifted.exec(victim.sql.replace("IS NOT", "<>"));
    drifted.exec("BEGIN");
    assert.throws(() => installWriterFence(drifted), /operator reconciliation/);
    drifted.exec("ROLLBACK");
    assert.equal(drifted.prepare("PRAGMA user_version").get().user_version, 0, "a refused install stamps nothing");
  }
});
