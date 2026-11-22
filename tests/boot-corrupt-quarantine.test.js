// #4126: one corrupt room must not brick node-server boot.
//
// Before this fix, a single rooms.projection of 'garbage{' threw an
// uncaught SyntaxError out of repairProjectionProvenance (and a garbage
// projection_checkpoints row threw "malformed JSON" out of the boot-path
// help-history audit), so EVERY room in the database was down and the
// in-server repair door was unreachable because the server never started.
// Boot now quarantines the unreadable room — named in the boot log and in
// store.corruptRoomReports() — while healthy rooms boot and serve, and an
// unparseable checkpoint falls back to a full event-history replay.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRuntimePackage } from "../scripts/runtime-package.mjs";
import { v11ReplyBaseline } from "../scripts/frozen-runtime-fixture.mjs";
import { STORE_SCHEMA_VERSION } from "../server/writer-fence.mjs";
import { fileURLToPath, pathToFileURL } from "node:url";

// Two rooms: alpha carries three messages and a valid checkpoint; beta is
// the healthy bystander every case must keep serving.
function buildHealthy(path) {
  const store = new RoomStore(path);
  store.initialize(initialRoom("alpha"));
  store.initialize(initialRoom("beta"));
  const key = store.issueAccessKey("alpha", "owner");
  for (const [id, body] of [["m1", "hello"], ["m2", "second"], ["m3", "third"]]) {
    store.command(key, "alpha", { id: `cmd-${id}`, type: "message.posted", data: { body, messageId: id } });
  }
  const row = store.db.prepare("SELECT sequence, projection FROM rooms WHERE id='alpha'").get();
  store.db.prepare("INSERT INTO projection_checkpoints (room_id, sequence, projection) VALUES ('alpha', ?, ?)")
    .run(row.sequence, row.projection);
  store.close();
  return row.projection;
}

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-boot-quarantine-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const healthyPath = join(directory, "healthy.sqlite");
  const alphaProjection = buildHealthy(healthyPath);
  return { directory, healthyPath, alphaProjection };
}

// Copy the healthy DB, corrupt it through a store's own connection (the
// writer fence refuses foreign connections by design), then reopen.
function reopenCorrupted(t, corrupt) {
  const f = fixture(t);
  const path = join(f.directory, "corrupt.sqlite");
  copyFileSync(f.healthyPath, path);
  const s = new RoomStore(path);
  corrupt(s.db);
  s.close();
  const store = new RoomStore(path);
  t.after(() => store.close());
  return { store, ...f };
}

test("boot with an invalid-JSON room projection quarantines that room only", t => {
  const { store } = reopenCorrupted(t, db => db.prepare("UPDATE rooms SET projection='garbage{' WHERE id='alpha'").run());
  const reports = store.corruptRoomReports();
  assert.equal(reports.length, 1);
  assert.equal(reports[0].roomId, "alpha");
  assert.equal(reports[0].errorClass, "SyntaxError");
  // The healthy room reads and writes after boot.
  assert.equal(store.room("beta").state.room.id, "beta");
  const key = store.issueAccessKey("beta", "owner");
  store.command(key, "beta", { id: "cmd-after-boot", type: "message.posted", data: { body: "still serving", messageId: "after-boot" } });
  assert.equal(store.room("beta").state.messages.length, 1);
  // The corrupt room's own reads keep failing loudly — never hollow state.
  assert.throws(() => store.room("alpha"), SyntaxError);
});

test("boot with a garbage checkpoint falls back to a full-history replay", t => {
  const { store } = reopenCorrupted(t, db => db.prepare("UPDATE projection_checkpoints SET projection='garbage{' WHERE room_id='alpha'").run());
  assert.deepEqual(store.corruptRoomReports(), []);
  assert.equal(store.room("alpha").state.messages.length, 3);
  // The rebuild ignores the unreadable checkpoint and replays every event.
  const rebuilt = store.rebuildProjection("alpha");
  assert.equal(rebuilt.state.messages.length, 3);
  assert.equal(rebuilt.sequence, store.room("alpha").sequence);
});

test("boot with both a garbage projection and a garbage checkpoint", t => {
  const { store } = reopenCorrupted(t, db => {
    db.prepare("UPDATE rooms SET projection='garbage{' WHERE id='alpha'").run();
    db.prepare("UPDATE projection_checkpoints SET projection='garbage{' WHERE room_id='alpha'").run();
  });
  assert.deepEqual(store.corruptRoomReports().map(report => report.roomId), ["alpha"]);
  assert.equal(store.room("beta").state.room.id, "beta");
  assert.throws(() => store.room("alpha"), SyntaxError);
});

test("the quarantine record clears once the room's bytes are repaired", t => {
  const { store, alphaProjection } = reopenCorrupted(t, db => db.prepare("UPDATE rooms SET projection='garbage{' WHERE id='alpha'").run());
  assert.equal(store.corruptRoomReports().length, 1);
  // Operator repair replaces the torn bytes (here: the original projection,
  // standing in for the repair tool's rebuilt materialisation).
  store.db.prepare("UPDATE rooms SET projection=? WHERE id='alpha'").run(alphaProjection);
  store.repairProjectionProvenance();
  assert.deepEqual(store.corruptRoomReports(), []);
  assert.equal(store.room("alpha").state.messages.length, 3);
});

// The upgrade half of #4126: a database stored by an older schema carries
// the same corruption through the constructor's legacy reconciliation scans
// (reply-request, help-field and outside-credit markers) and the work
// projection migration, all of which run before the quarantine scan. Each
// fixture below is a genuine old database, built by that era's packaged
// runtime (the tests/external-producer.test.js pattern): commons carries
// one message and a checkpoint, beta is the healthy bystander.
const v25Baseline = "33c817a911ebb9fb0310592cac77d8e61380541d"; // schema v25 runtime

async function legacyFixture(t, commit) {
  const directory = mkdtempSync(join(tmpdir(), "room-boot-quarantine-legacy-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const repository = fileURLToPath(new URL("../", import.meta.url));
  const runtime = join(directory, "runtime");
  createRuntimePackage({ repository, commit, destination: runtime });
  const { RoomStore: OldStore } = await import(pathToFileURL(join(runtime, "server/store.mjs")));
  const { initialRoom: legacyInitialRoom } = await import(pathToFileURL(join(runtime, "server/bootstrap.mjs")));
  const filename = join(directory, "room.sqlite");
  const old = new OldStore(filename);
  old.initialize(legacyInitialRoom());
  old.initialize(legacyInitialRoom("beta"));
  const key = old.issueAccessKey("commons", "owner");
  old.command(key, "commons", { id: "cmd-m1", type: "message.posted", data: { body: "hello from the old schema", messageId: "m1" } });
  const row = old.db.prepare("SELECT sequence, projection FROM rooms WHERE id='commons'").get();
  old.db.prepare("INSERT INTO projection_checkpoints (room_id, sequence, projection) VALUES ('commons', ?, ?)")
    .run(row.sequence, row.projection);
  return { filename, old };
}

test("upgrading a v25 database with an invalid-JSON room projection quarantines that room only", async t => {
  const f = await legacyFixture(t, v25Baseline);
  f.old.db.prepare("UPDATE rooms SET projection='garbage{' WHERE id='commons'").run();
  f.old.close();
  const store = new RoomStore(f.filename);
  t.after(() => store.close());
  assert.equal(store.db.prepare("PRAGMA user_version").get().user_version, STORE_SCHEMA_VERSION);
  assert.deepEqual(store.corruptRoomReports().map(report => report.roomId), ["commons"]);
  // The healthy room reads and writes after the upgrade boot.
  assert.equal(store.room("beta").state.room.id, "beta");
  const key = store.issueAccessKey("beta", "owner");
  store.command(key, "beta", { id: "cmd-after-upgrade", type: "message.posted", data: { body: "still serving", messageId: "after-upgrade" } });
  assert.equal(store.room("beta").state.messages.length, 1);
  assert.throws(() => store.room("commons"), SyntaxError);
});

test("upgrading a v25 database with a garbage checkpoint replays the full history", async t => {
  const f = await legacyFixture(t, v25Baseline);
  f.old.db.prepare("UPDATE projection_checkpoints SET projection='garbage{' WHERE room_id='commons'").run();
  f.old.close();
  const store = new RoomStore(f.filename);
  t.after(() => store.close());
  assert.deepEqual(store.corruptRoomReports(), []);
  assert.equal(store.room("commons").state.messages.length, 1);
  assert.equal(store.rebuildProjection("commons").state.messages.length, 1);
  assert.equal(store.room("beta").state.room.id, "beta");
});

test("upgrading a v11 database with an invalid-JSON room projection passes every legacy scan", async t => {
  const f = await legacyFixture(t, v11ReplyBaseline);
  f.old.db.prepare("UPDATE rooms SET projection='garbage{' WHERE id='commons'").run();
  f.old.close();
  const store = new RoomStore(f.filename);
  t.after(() => store.close());
  assert.equal(store.db.prepare("PRAGMA user_version").get().user_version, STORE_SCHEMA_VERSION);
  assert.deepEqual(store.corruptRoomReports().map(report => report.roomId), ["commons"]);
  assert.equal(store.room("beta").state.room.id, "beta");
  assert.throws(() => store.room("commons"), SyntaxError);
});

test("a healthy database boots with an empty quarantine record", t => {
  const f = fixture(t);
  const store = new RoomStore(f.healthyPath);
  t.after(() => store.close());
  assert.deepEqual(store.corruptRoomReports(), []);
  assert.equal(store.room("alpha").state.messages.length, 3);
  assert.equal(store.room("beta").state.room.id, "beta");
});
