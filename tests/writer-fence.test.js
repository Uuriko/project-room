import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { writerFenceDefinitions, verifyWriterFence } from "../server/writer-fence.mjs";

// Construct a synthetic pre-upgrade database. Never use this fixture on user data.
function legacyFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-upgrade-contract-"));
  const filename = join(directory, "fixture.sqlite");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const fresh = new RoomStore(filename);
  fresh.createAccount("fixture-account");
  for (const { name } of writerFenceDefinitions) fresh.db.exec(`DROP TRIGGER ${name}`);
  fresh.db.exec("PRAGMA user_version=5");
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
    assert.equal(current.db.prepare("PRAGMA user_version").get().user_version, 7);
    assert.deepEqual(current.db.prepare("SELECT * FROM accounts").all(), before);
    assert.doesNotThrow(() => verifyWriterFence(current.db));
    assert.equal(writerFenceDefinitions.length, 48);
    assert.throws(() => legacyStatement.run("fixture-account"), /project_room_writer_v7|unsupported database writer/);
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
    assert.equal(inspected.prepare("SELECT count(*) n FROM sqlite_master WHERE type='trigger' AND name LIKE 'writer_v7_%'").get().n, 0);
    assert.equal(inspected.prepare("SELECT count(*) n FROM accounts").get().n, 1);
  } finally { inspected.close(); }
  const retry = new RoomStore(filename);
  retry.close();
});

test("read-only audit does not upgrade a pre-fence database", t => {
  const filename = legacyFixture(t);
  assert.throws(() => new RoomStore(filename, { readOnly: true }), /requires schema v7/);
  const inspected = new DatabaseSync(filename, { readOnly: true });
  try { assert.equal(inspected.prepare("PRAGMA user_version").get().user_version, 5); }
  finally { inspected.close(); }
});

test("the v7 link migration preserves v6 guards while retiring pre-open v6 writers", t => {
  const filename = legacyFixture(t), earlier = new DatabaseSync(filename);
  earlier.function("project_room_writer_v6", () => 6);
  for (const definition of writerFenceDefinitions.filter(({ name }) => !name.includes("share_link"))) {
    earlier.exec(definition.sql.replaceAll("writer_v7", "writer_v6").replace("IS NOT 7", "IS NOT 6"));
  }
  earlier.exec("PRAGMA user_version=6");
  const oldWrite = earlier.prepare("UPDATE accounts SET revision=revision WHERE id='fixture-account'");
  oldWrite.run();
  const current = new RoomStore(filename);
  try {
    assert.equal(current.db.prepare("PRAGMA user_version").get().user_version, 7);
    assert.throws(() => oldWrite.run(), /project_room_writer_v7|unsupported database writer/);
    current.createAccount("current-writer");
    assert.equal(current.account("current-writer").active, true);
  } finally { current.close(); earlier.close(); }
});
