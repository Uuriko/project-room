import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { writerFenceDefinitions, verifyWriterFence, fenceDefinitions } from "../server/writer-fence.mjs";

// Construct a synthetic pre-upgrade database. Never use this fixture on user data.
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
    assert.equal(current.db.prepare("PRAGMA user_version").get().user_version, 21);
    assert.deepEqual(current.db.prepare("SELECT * FROM accounts").all(), before);
    assert.doesNotThrow(() => verifyWriterFence(current.db));
    assert.equal(writerFenceDefinitions.length, 81);
    assert.throws(() => legacyStatement.run("fixture-account"), /project_room_writer_v21|unsupported database writer/);
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
    assert.equal(inspected.prepare("SELECT count(*) n FROM sqlite_master WHERE type='trigger' AND name LIKE 'writer_v21_%'").get().n, 0);
    assert.equal(inspected.prepare("SELECT count(*) n FROM accounts").get().n, 1);
  } finally { inspected.close(); }
  const retry = new RoomStore(filename);
  retry.close();
});

test("read-only audit does not upgrade a pre-fence database", t => {
  const filename = legacyFixture(t);
  assert.throws(() => new RoomStore(filename, { readOnly: true }), /requires schema v21/);
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
    assert.equal(current.db.prepare("PRAGMA user_version").get().user_version, 21);
    assert.throws(() => oldWrite.run(), /project_room_writer_v21|unsupported database writer/);
    current.createAccount("current-writer");
    assert.equal(current.account("current-writer").active, true);
  } finally { current.close(); earlier.close(); }
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
    assert.throws(() => cached.run(), /project_room_writer_v21|unsupported database writer/);
    assert.equal(current.db.prepare("SELECT count(*) n FROM private_reminders").get().n, 0);
  } finally { current.close(); old.close(); }
});
