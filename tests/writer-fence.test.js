import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { applicationTables, unfencedAdditiveTables, writerFenceDefinitions, verifyWriterFence, fenceDefinitions, STORE_SCHEMA_VERSION } from "../server/writer-fence.mjs";

// Construct a synthetic pre-upgrade database. Never use this fixture on user data.
test("Node read transactions reject nested and direct writes, retain outer writes and restore mode after failures", t => {
  const directory = mkdtempSync(join(tmpdir(), "room-read-transaction-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new RoomStore(join(directory, "room.sqlite")); t.after(() => store.close());
  store.createAccount("fixture-account");
  const original = store.account("fixture-account");
  store.readTransaction(() => {
    assert.throws(() => store.createAccount("nested"), /read-only/);
    assert.throws(() => store.db.prepare("UPDATE accounts SET revision=revision+1 WHERE id=?").run("fixture-account"), /readonly/);
    assert.deepEqual(store.readTransaction(() => store.account("fixture-account")), original);
  });
  assert.equal(store.db.prepare("PRAGMA query_only").get().query_only, 0);
  assert.throws(() => store.readTransaction(() => { throw new Error("fixture read failure"); }), /fixture read failure/);
  assert.equal(store.db.prepare("PRAGMA query_only").get().query_only, 0);
  store.transaction(() => {
    store.readTransaction(() => assert.deepEqual(store.account("fixture-account"), original));
    store.createAccount("after-read");
  });
  assert.equal(store.account("after-read").active, true);
});

function legacyFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-upgrade-contract-"));
  const filename = join(directory, "fixture.sqlite");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const fresh = new RoomStore(filename);
  fresh.createAccount("fixture-account");
  for (const { name } of writerFenceDefinitions) fresh.db.exec(`DROP TRIGGER ${name}`);
  fresh.db.exec("DROP TABLE private_email_folders; DROP TABLE private_email_commands; DROP TABLE private_email_connections; DROP TABLE private_inbox_drafts; DROP TABLE private_inbox_versions; DROP TABLE private_inbox_sources; DROP TABLE private_inbox_commands; DROP TABLE agent_connection_operations; DROP TABLE agent_connections; DROP TABLE private_reminder_commands; DROP TABLE private_reminders; PRAGMA user_version=5");
  fresh.close();
  return filename;
}

test("schema upgrade preserves existing records and fences a previously opened connection", t => {
  const filename = legacyFixture(t), earlier = new DatabaseSync(filename);
  const before = earlier.prepare("SELECT * FROM accounts").all();
  const legacyStatement = earlier.prepare("UPDATE accounts SET revision=revision WHERE id=?");
  legacyStatement.run("fixture-account");
  const current = new RoomStore(filename);
  try {
    assert.equal(current.db.prepare("PRAGMA user_version").get().user_version, 38);
    assert.deepEqual(current.db.prepare("SELECT * FROM accounts").all(), before);
    assert.doesNotThrow(() => verifyWriterFence(current.db));
    assert.equal(writerFenceDefinitions.length, (applicationTables.length - unfencedAdditiveTables.length) * 3,
      "the current fence covers every application table except intentionally-unfenced additive tables");
    assert.throws(() => legacyStatement.run("fixture-account"), /project_room_writer_v38|unsupported database writer/);
    current.createAccount("new-fixture-account");
    assert.equal(current.account("new-fixture-account").active, true);
  } finally { current.close(); earlier.close(); }
  const audited = new RoomStore(filename, { readOnly: true });
  try { assert.equal(audited.verifyInvitationAudit().consistent, true); }
  finally { audited.close(); }
});

test("all startup migration helpers run under the same write transaction", t => {
  const filename = legacyFixture(t), earlier = new DatabaseSync(filename);
  const repair = RoomStore.prototype.repairProjectionProvenance;
  let checked = false;
  RoomStore.prototype.repairProjectionProvenance = function (...args) {
    assert.equal(this.db.isTransaction, true);
    assert.throws(() => earlier.exec("BEGIN IMMEDIATE"), /locked/);
    checked = true;
    return repair.apply(this, args);
  };
  try {
    const migrated = new RoomStore(filename);
    migrated.close();
    assert.equal(checked, true);
  } finally { RoomStore.prototype.repairProjectionProvenance = repair; earlier.close(); }
});

test("failure after fence installation rolls back its schema marker and all triggers", t => {
  const filename = legacyFixture(t);
  const verify = RoomStore.prototype.verifyInvitationAudit;
  RoomStore.prototype.verifyInvitationAudit = function () { throw new Error("Simulated final validation failure"); };
  try { assert.throws(() => new RoomStore(filename), /final validation failure/); }
  finally { RoomStore.prototype.verifyInvitationAudit = verify; }
  const inspected = new DatabaseSync(filename, { readOnly: true });
  try {
    assert.equal(inspected.prepare("PRAGMA user_version").get().user_version, 5);
    assert.equal(inspected.prepare("SELECT count(*) n FROM sqlite_master WHERE type='trigger' AND name LIKE ?").get(`writer_v${STORE_SCHEMA_VERSION}_%`).n, 0,
      "rollback must remove every trigger installed for the current schema version");
    assert.equal(inspected.prepare("SELECT count(*) n FROM accounts").get().n, 1);
  } finally { inspected.close(); }
  const retry = new RoomStore(filename);
  retry.close();
});

test("read-only audit does not upgrade a pre-fence database", t => {
  const filename = legacyFixture(t);
  assert.throws(() => new RoomStore(filename, { readOnly: true }), /requires schema v38/);
  const inspected = new DatabaseSync(filename, { readOnly: true });
  try { assert.equal(inspected.prepare("PRAGMA user_version").get().user_version, 5); }
  finally { inspected.close(); }
});

test("the v9 migration preserves v6 guards while retiring pre-open v6 writers", t => {
  const filename = legacyFixture(t), earlier = new DatabaseSync(filename);
  earlier.function("project_room_writer_v6", () => 6);
  for (const definition of fenceDefinitions(6)) earlier.exec(definition.sql);
  earlier.exec("PRAGMA user_version=6");
  const oldWrite = earlier.prepare("UPDATE accounts SET revision=revision WHERE id='fixture-account'");
  oldWrite.run();
  const current = new RoomStore(filename);
  try {
    assert.equal(current.db.prepare("PRAGMA user_version").get().user_version, 38);
    assert.throws(() => oldWrite.run(), /project_room_writer_v38|unsupported database writer/);
    current.createAccount("current-writer");
    assert.equal(current.account("current-writer").active, true);
  } finally { current.close(); earlier.close(); }
});

test("verifyWriterFence(28) requires deployed-lineage triggers when their tables are present, but not when absent", () => {
  // The deployed v28 lineage fenced agent_invite_codes + room_attachments.
  // Build those definitions from a literal template, not fenceDefinitions(28),
  // so this test does not silently track whatever that function returns.
  const deployedTables = ["agent_invite_codes", "room_attachments"];
  const deployedDefs = deployedTables.flatMap(table => ["INSERT", "UPDATE", "DELETE"].map(operation => {
    const name = `writer_v28_${table}_${operation.toLowerCase()}`;
    return { name, sql: `CREATE TRIGGER ${name} BEFORE ${operation} ON ${table} BEGIN SELECT CASE WHEN project_room_writer_v28() IS NOT 28 THEN RAISE(ABORT,'unsupported database writer') END; END` };
  }));
  const baseDefs = fenceDefinitions(28).filter(def => !deployedDefs.some(deployed => deployed.name === def.name));
  const baseTables = [...new Set(baseDefs.map(def => def.name.replace(/^writer_v28_/, "").replace(/_(insert|update|delete)$/, "")))];
  const build = ({ withDeployedTables, withDeployedTriggers }) => {
    const db = new DatabaseSync(":memory:");
    for (const table of baseTables) db.exec(`CREATE TABLE ${table}(id INTEGER PRIMARY KEY)`);
    if (withDeployedTables) for (const table of deployedTables) db.exec(`CREATE TABLE ${table}(id INTEGER PRIMARY KEY)`);
    for (const { sql } of baseDefs) db.exec(sql);
    if (withDeployedTriggers) for (const { sql } of deployedDefs) db.exec(sql);
    return db;
  };
  // Deployed tables present with no writer triggers at all: must be rejected.
  const missing = build({ withDeployedTables: true, withDeployedTriggers: false });
  try { assert.throws(() => verifyWriterFence(missing, 28), /operator reconciliation/); }
  finally { missing.close(); }
  // Deployed tables present with only part of their trigger set: also rejected.
  const partial = build({ withDeployedTables: true, withDeployedTriggers: true });
  try {
    partial.exec("DROP TRIGGER writer_v28_room_attachments_delete");
    assert.throws(() => verifyWriterFence(partial, 28), /operator reconciliation/);
  } finally { partial.close(); }
  // Deployed tables present with their exact trigger set: accepted.
  const exact = build({ withDeployedTables: true, withDeployedTriggers: true });
  try { assert.doesNotThrow(() => verifyWriterFence(exact, 28)); }
  finally { exact.close(); }
  // Rebuilt v28 lineage: the deployed tables were never created, so their
  // triggers are not required.
  const rebuilt = build({ withDeployedTables: false, withDeployedTriggers: false });
  try { assert.doesNotThrow(() => verifyWriterFence(rebuilt, 28)); }
  finally { rebuilt.close(); }
});

test("v7 to v9 preserves every existing table row and retires a pre-open v7 connection", t => {
  const filename = legacyFixture(t), old = new DatabaseSync(filename);
  old.function("project_room_writer_v7", () => 7);
  for (const { sql } of fenceDefinitions(7)) old.exec(sql);
  old.exec("PRAGMA user_version=7");
  const tables = old.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(row => row.name);
  const before = Object.fromEntries(tables.map(name => [name, old.prepare(`SELECT * FROM ${name}`).all()]));
  const cached = old.prepare("UPDATE accounts SET revision=revision WHERE id='fixture-account'"); cached.run();
  const current = new RoomStore(filename);
  try {
    assert.deepEqual(Object.fromEntries(tables.map(name => [name, current.db.prepare(`SELECT * FROM ${name}`).all()])), before);
    assert.throws(() => cached.run(), /project_room_writer_v38|unsupported database writer/);
    assert.equal(current.db.prepare("SELECT count(*) n FROM private_reminders").get().n, 0);
  } finally { current.close(); old.close(); }
});
