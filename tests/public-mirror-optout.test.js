// RES-0001 (wave-7 R08-F1): a stored public_receipts row — above all a
// public-work (pwr_) row, which no delete path can remove — must honour
// the room's AUTHORITATIVE recorded public-receipts setting
// (room.public_receipts_set) at read time. Before the fix, stored-row
// reads consulted only the operator unpublish and the directory
// toggle: an owner who recorded enabled:false kept serving on the
// mirror detail, feed, collect, sitemap, the live JS filter, and the
// dedicated public-work receipt/artifact door, indefinitely.
//
// Semantics pinned here (the lot rule's read-time shape, narrowed to
// the opt-out direction): a recorded enabled:false hides; a recorded
// enabled:true serves; never-recorded keeps the pre-existing default
// (the directory toggle decides — public-work receipts are public
// unless opted out). The check is level-triggered: it consults the
// authoritative record on every read, so a mirror row written before
// the opt-out (or restored from a drifted backup) hides with no sync
// edge, and a later opt-in serves it again with no rewrite.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { PUBLIC_READ_MODEL_SCHEMA, publicReceiptById, queryPublicReceipts, collectPublicReceipts, listPublicReceiptSitemap } from "../server/public-read-model.mjs";
import { publicUnpublishSchema } from "../server/legal-store.mjs";
import { roomDirectorySchema } from "../server/room-directory.mjs";
import { PublicWorkClaims, publicWorkClaimsSchema } from "../server/public-work-claims.mjs";
import { receiptVisible, hiddenReceiptIds, recordedReceiptsOptOut, ownerToggleReadable, lotReceiptVisible } from "../server/public-visibility.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { projectPublicWorkReceipt } from "../server/public-read-model.mjs";

const ROOM = "room-a";
const PWR = `pwr_${"a".repeat(32)}`;
const WCR = `wcr_${"b".repeat(32)}`;

function makeDb(enabled) {
  const db = new DatabaseSync(":memory:");
  db.exec(PUBLIC_READ_MODEL_SCHEMA);
  db.exec(publicUnpublishSchema);
  db.exec(roomDirectorySchema);
  db.exec(publicWorkClaimsSchema);
  // No rooms table at all: public reads consult the recorded setting's
  // read-model copy (room_public_receipts_setting, part of the read
  // model schema), never rooms.projection.
  setRecorded(db, enabled);
  for (const [id, source] of [[PWR, "public-work"], [WCR, "work-claim"]]) {
    db.prepare(`INSERT INTO public_receipts
      (id, title, source, origin_room_id, room_id, room_title, agents_json, humans_json,
       pull_request, merged_at, verification_state, hashes_json, at, start_href)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, "Settled work", source, ROOM, ROOM, "Room A", "[]", "[]", null, null, null, "[]",
        "2026-10-01T00:00:00.000Z", "https://room.trydemigod.com/?start=room");
  }
  db.prepare(`INSERT INTO public_work_receipts
    (receipt_id, offer_id, namespace_key, generation, identity_id, artifact_text, artifact_sha256, artifact_bytes, receipt_json, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(PWR, "offer-1", "ns", 1, "ai_x", "note", "0".repeat(64), 4, "{}", 0);
  db.prepare(`INSERT INTO public_work_tasks
    (offer_id, namespace_key, room_id, terms_version, repository_url, repository_ref, files_json, generation, created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run("offer-1", "ns", ROOM, 1, "https://example.invalid/repo", "main", "[]", 1, 0);
  // No room_directory_settings row: the directory toggle is at its
  // public default, so only the authoritative setting can hide these.
  return db;
}

// The recorded setting's read-model copy, in the exact shape
// syncRoomPublication writes it in the same transaction as a
// room.public_receipts_set act (enabled 1/0; no row = never recorded).
function setRecorded(db, enabled) {
  if (enabled === null) { db.prepare("DELETE FROM room_public_receipts_setting WHERE room_id=?").run(ROOM); return; }
  db.prepare("INSERT INTO room_public_receipts_setting (room_id, enabled) VALUES (?,?) ON CONFLICT(room_id) DO UPDATE SET enabled=excluded.enabled")
    .run(ROOM, enabled ? 1 : 0);
}

function surfaces(db, id) {
  const store = { db };
  return {
    byId: publicReceiptById(store, id) !== null,
    query: queryPublicReceipts(store, { limit: 10 }).receipts.some(r => r.id === id),
    collect: collectPublicReceipts(store).some(r => r.id === id),
    sitemap: listPublicReceiptSitemap(store).some(r => r.path === `/receipts/${id}`),
    jsVisible: receiptVisible(db, id),
  };
}
const ALL_HIDDEN = { byId: false, query: false, collect: false, sitemap: false, jsVisible: false };
const ALL_SERVED = { byId: true, query: true, collect: true, sitemap: true, jsVisible: true };

test("recorded opt-out hides a pwr_ row on every mirror surface", () => {
  assert.deepEqual(surfaces(makeDb(false), PWR), ALL_HIDDEN);
});

test("recorded opt-out hides a drifted wcr_ row too (missed delete edge)", () => {
  assert.deepEqual(surfaces(makeDb(false), WCR), ALL_HIDDEN);
});

test("recorded opt-in serves the pwr_ row on every mirror surface", () => {
  assert.deepEqual(surfaces(makeDb(true), PWR), ALL_SERVED);
});

test("never-recorded keeps the directory default (serves)", () => {
  assert.deepEqual(surfaces(makeDb(null), PWR), ALL_SERVED);
  assert.equal(recordedReceiptsOptOut(makeDb(null), ROOM), false);
});

test("level-triggered: opt-out recorded after the row exists hides it with no sync; opt-in restores it", () => {
  const db = makeDb(true);
  assert.deepEqual(surfaces(db, PWR), ALL_SERVED);
  setRecorded(db, false); // the recorded opt-out lands; no receipt-row sync runs
  assert.deepEqual(surfaces(db, PWR), ALL_HIDDEN);
  setRecorded(db, true);
  assert.deepEqual(surfaces(db, PWR), ALL_SERVED);
});

// --- Adversarial pass (programme instruction, seq 25078): the cure for
// the seq 25069 fail-open must itself survive the read-error case, the
// unknown-value case, and the one-bad-row case, executed here. ---

// A store whose receipts-setting read fails the way production fails
// it: the statement prepare raises a SQLITE_IOERR-shaped error (the
// function under test is NOT mocked — the error is injected at the
// store's read, exactly where an I/O failure surfaces).
function ioErr() {
  const error = new Error("disk I/O error");
  error.code = "ERR_SQLITE_ERROR";
  error.errcode = 10; // SQLITE_IOERR
  return error;
}
function settingReadFails(db) {
  return {
    prepare(sql, ...rest) {
      if (String(sql).includes("room_public_receipts_setting")) throw ioErr();
      return db.prepare(sql, ...rest);
    },
  };
}

test("adversarial read-error: a failing setting read never exposes a recorded opt-out (JS filter + SQL surfaces)", () => {
  const db = makeDb(false); // recorded opt-out in place
  const failing = settingReadFails(db);
  // JS filter path fails CLOSED: everything asked about is hidden.
  assert.equal(receiptVisible(failing, PWR), false);
  assert.deepEqual([...hiddenReceiptIds(failing, [PWR, WCR])].sort(), [PWR, WCR].sort());
  assert.equal(recordedReceiptsOptOut(failing, ROOM), true);
  // SQL surfaces throw rather than serve (the pre-existing SQL
  // behaviour the JS path now matches in effect: no content served).
  assert.throws(() => queryPublicReceipts({ db: failing }, { limit: 10 }), /disk I\/O error/);
  assert.throws(() => publicReceiptById({ db: failing }, PWR), /disk I\/O error/);
  // The same failure with NO recorded row still fails closed.
  const db2 = makeDb(null);
  const failing2 = settingReadFails(db2);
  assert.equal(receiptVisible(failing2, PWR), false);
  assert.equal(recordedReceiptsOptOut(failing2, ROOM), true);
});

test("adversarial unknown-value: a recorded setting that is neither true/false/0/1 does not fail open", () => {
  for (const bad of [2, "garbage"]) {
    const db = makeDb(null);
    db.prepare("INSERT INTO room_public_receipts_setting (room_id, enabled) VALUES (?,?)").run(ROOM, bad);
    assert.deepEqual(surfaces(db, PWR), ALL_HIDDEN, `enabled=${JSON.stringify(bad)}`);
    assert.equal(recordedReceiptsOptOut(db, ROOM), true, `enabled=${JSON.stringify(bad)}`);
  }
});

test("adversarial one-bad-row: one malformed setting row widens nothing and other rooms' settings still govern", () => {
  const db = makeDb(false); // ROOM opted out (valid row)
  const mk = (id, room) => db.prepare(`INSERT INTO public_receipts
    (id, title, source, origin_room_id, room_id, room_title, agents_json, humans_json,
     pull_request, merged_at, verification_state, hashes_json, at, start_href)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, "Settled work", "work-claim", room, room, "Room", "[]", "[]", null, null, null, "[]",
      "2026-10-01T00:00:00.000Z", "https://room.trydemigod.com/?start=room");
  const good = `wcr_${"c".repeat(32)}`;
  const badRowRoom = `wcr_${"d".repeat(32)}`;
  mk(good, "room-good");
  mk(badRowRoom, "room-bad");
  db.prepare("INSERT INTO room_public_receipts_setting (room_id, enabled) VALUES (?,?)").run("room-good", 1);
  db.prepare("INSERT INTO room_public_receipts_setting (room_id, enabled) VALUES (?,?)").run("room-bad", "garbage");
  // The valid opt-out still hides; the valid opt-in still serves; the
  // malformed row's room is hidden (not widened) and poisons no one.
  assert.equal(receiptVisible(db, PWR), false);
  assert.equal(receiptVisible(db, good), true);
  assert.equal(receiptVisible(db, badRowRoom), false);
  assert.equal(queryPublicReceipts({ db }, { limit: 10 }).receipts.some(r => r.id === good), true);
  assert.equal(queryPublicReceipts({ db }, { limit: 10 }).receipts.some(r => r.id === badRowRoom), false);
});

test("attribution: a taskless pwr_ row is namespace-public — the namespace room's recorded setting does not govern it", () => {
  // The receipts-route contract (tests/receipts-route.test.js): a
  // public-work receipt with no task record stays public when the
  // room it is stored under records an opt-out; the opt-out governs
  // the room's own receipts and task-owned public work (above).
  const db = new DatabaseSync(":memory:");
  db.exec(PUBLIC_READ_MODEL_SCHEMA);
  db.exec(publicUnpublishSchema);
  db.exec(roomDirectorySchema);
  db.exec(publicWorkClaimsSchema);
  setRecorded(db, false);
  db.prepare(`INSERT INTO public_receipts
    (id, title, source, origin_room_id, room_id, room_title, agents_json, humans_json,
     pull_request, merged_at, verification_state, hashes_json, at, start_href)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(PWR, "Settled work", "public-work", ROOM, ROOM, "Room A", "[]", "[]", null, null, null, "[]",
      "2026-10-01T00:00:00.000Z", "https://room.trydemigod.com/?start=room");
  db.prepare(`INSERT INTO public_work_receipts
    (receipt_id, offer_id, namespace_key, generation, identity_id, artifact_text, artifact_sha256, artifact_bytes, receipt_json, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(PWR, "offer-1", "ns", 1, "ai_x", "note", "0".repeat(64), 4, "{}", 0);
  // No public_work_tasks row: no task room, no deciding room.
  assert.deepEqual(surfaces(db, PWR), ALL_SERVED);
});

test("dedicated door: recorded opt-out refuses anonymous receipt and artifact reads, opt-in serves", () => {
  const db = makeDb(false);
  const claims = new PublicWorkClaims({ db, roomDirectory: { publicReceiptsVisible: () => true } });
  assert.throws(() => claims._requireReceiptVisible(ROOM, undefined), (error) => error?.code === "receipts_private");
  setRecorded(db, true);
  claims._requireReceiptVisible(ROOM, undefined); // must not throw
  setRecorded(db, null);
  claims._requireReceiptVisible(ROOM, undefined); // never recorded: directory default governs
});

// --- Round-2 adversarial pass (Codex review, seq 25107/25108): two
// further fail-open paths at the round-1 cured head. (1) The mirror
// table EXISTS but its enabled column cannot be read: round 1 mapped
// a missing-column error to the same null as a missing table
// ("absent"), so a store whose recorded settings live behind an
// unreadable column read as never-recorded and served. Only a missing
// TABLE is the legacy case — no recorded setting can exist there. A
// present table with an unreadable column resolves PRIVATE on every
// surface. (2) hiddenReceiptIds degraded on ANY task-join error, so a
// SQLITE_IOERR on the join silently re-attributed a public-work
// receipt to its stored namespace/origin room — the deciding room the
// round-1 attribution rule removed. The degrade is legitimate only
// for the predating-schema case (the join's tables absent); an I/O
// error fails closed like every other leg. ---

function makeDbColumnBroken() {
  const db = makeDb(null); // full fixture; no recorded row written yet
  db.exec("DROP TABLE room_public_receipts_setting");
  db.exec("CREATE TABLE room_public_receipts_setting (room_id TEXT PRIMARY KEY)");
  db.prepare("INSERT INTO room_public_receipts_setting (room_id) VALUES (?)").run(ROOM);
  return db;
}

test("round-2 read-error, column: a present mirror table with an unreadable enabled column resolves private", () => {
  const db = makeDbColumnBroken();
  // JS surfaces: hidden, and the door's opt-out fact answers private.
  assert.equal(receiptVisible(db, PWR), false);
  assert.equal(receiptVisible(db, WCR), false);
  assert.deepEqual([...hiddenReceiptIds(db, [PWR, WCR])].sort(), [PWR, WCR].sort());
  assert.equal(recordedReceiptsOptOut(db, ROOM), true);
  // SQL surfaces: the probe propagates, so the composed reads throw
  // rather than serve a list/detail with the opt-out leg omitted.
  assert.throws(() => queryPublicReceipts({ db }, { limit: 10 }), /no such column/);
  assert.throws(() => publicReceiptById({ db }, PWR), /no such column/);
  assert.throws(() => collectPublicReceipts({ db }), /no such column/);
  assert.throws(() => listPublicReceiptSitemap({ db }), /no such column/);
});

// The task room (ROOM) recorded the opt-out; the receipt is STORED
// under a namespace room that recorded nothing. With a working join
// the task room decides and the receipt hides; the stored room must
// never decide a public-work receipt.
function makeDbNamespaced() {
  const db = new DatabaseSync(":memory:");
  db.exec(PUBLIC_READ_MODEL_SCHEMA);
  db.exec(publicUnpublishSchema);
  db.exec(roomDirectorySchema);
  db.exec(publicWorkClaimsSchema);
  setRecorded(db, false); // ROOM (the task room) opted out
  db.prepare(`INSERT INTO public_receipts
    (id, title, source, origin_room_id, room_id, room_title, agents_json, humans_json,
     pull_request, merged_at, verification_state, hashes_json, at, start_href)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(PWR, "Settled work", "public-work", "ns-room", "ns-room", "Namespace", "[]", "[]", null, null, null, "[]",
      "2026-10-01T00:00:00.000Z", "https://room.trydemigod.com/?start=room");
  db.prepare(`INSERT INTO public_work_receipts
    (receipt_id, offer_id, namespace_key, generation, identity_id, artifact_text, artifact_sha256, artifact_bytes, receipt_json, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(PWR, "offer-1", "ns", 1, "ai_x", "note", "0".repeat(64), 4, "{}", 0);
  db.prepare(`INSERT INTO public_work_tasks
    (offer_id, namespace_key, room_id, terms_version, repository_url, repository_ref, files_json, generation, created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run("offer-1", "ns", ROOM, 1, "https://example.invalid/repo", "main", "[]", 1, 0);
  return db;
}

function joinReadFails(db, makeError) {
  return {
    prepare(sql, ...rest) {
      if (String(sql).includes("LEFT JOIN public_work_tasks")) throw makeError();
      return db.prepare(sql, ...rest);
    },
  };
}

test("round-2 read-error, task-join: a SQLITE_IOERR on the join never re-attributes a pwr_ receipt to its namespace room", () => {
  const db = makeDbNamespaced();
  assert.equal(receiptVisible(db, PWR), false); // working join: the task room's opt-out decides
  const failing = joinReadFails(db, ioErr);
  assert.equal(receiptVisible(failing, PWR), false); // failed join: fail closed, never namespace-served
  assert.deepEqual([...hiddenReceiptIds(failing, [PWR])], [PWR]);
});

test("round-2 degrade preserved: a genuinely table-less store still degrades to room attribution", () => {
  // No publicWorkClaimsSchema: the public-work tables do not exist at
  // all — the only legitimate degrade. (Round 2 simulated absence by
  // injecting a "no such table" ERROR while the tables existed; the
  // round-3 structural rule keys on the store itself, so that
  // simulation is no longer a degrade — it is the defect's shape.)
  const legacy = new DatabaseSync(":memory:");
  legacy.exec(PUBLIC_READ_MODEL_SCHEMA);
  legacy.exec(publicUnpublishSchema);
  legacy.exec(roomDirectorySchema);
  setRecorded(legacy, false); // ROOM opted out
  const ins = (id, source, room) => legacy.prepare(`INSERT INTO public_receipts
    (id, title, source, origin_room_id, room_id, room_title, agents_json, humans_json,
     pull_request, merged_at, verification_state, hashes_json, at, start_href)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, "Settled work", source, room, room, "Room", "[]", "[]", null, null, null, "[]",
      "2026-10-01T00:00:00.000Z", "https://room.trydemigod.com/?start=room");
  ins(WCR, "work-claim", ROOM);
  ins(PWR, "public-work", "ns-room");
  // The opted-out room's own receipt hides through room attribution;
  // the namespace-stored receipt serves (no task record can exist,
  // so nothing attributes it to ROOM) — degrade is not hide-all.
  assert.equal(receiptVisible(legacy, WCR), false);
  assert.equal(receiptVisible(legacy, PWR), true);
});

// Round 3 (Codex review, seq 25136): the round-2 join degrade keyed
// on error TEXT, so a populated public_work_tasks table with its
// room_id column renamed still produced a "no such column" error and
// degraded — the receipt fell back to namespace attribution and
// served. A present-but-unreadable attribution source is not
// absence: the degrade now keys on the table's existence in the
// schema (sqlite_master), and the renamed column resolves PRIVATE
// on the JS surfaces and throws on the SQL surfaces.
test("round-3 read-error, renamed column: a populated task table with room_id renamed resolves private", () => {
  const db = makeDbNamespaced(); // task room ROOM opted out; receipt stored under ns-room
  db.exec("ALTER TABLE public_work_tasks RENAME COLUMN room_id TO room_id_legacy");
  assert.equal(receiptVisible(db, PWR), false);
  assert.deepEqual([...hiddenReceiptIds(db, [PWR])], [PWR]);
  assert.throws(() => queryPublicReceipts({ db }, { limit: 10 }), /no such column/);
  assert.throws(() => publicReceiptById({ db }, PWR), /no such column/);
});

// --- Round 4 (Codex review, seq 25157): named-relation detection.
// The round-3 schema gate asked sqlite_master for type='table' only,
// so a relation presented as a VIEW read as genuinely absent and
// every degrade behind the gate fired: an unreadable
// public_work_tasks view degraded the task attribution to the
// namespace room, an unreadable room_public_receipts_setting view
// dropped a recorded opt-out as "never recorded" — and even a
// READABLE view silently disqualified both SQL probes, so the
// composed SQL served what the JS twin hid. The same class lived in
// the two remaining error-text gates: ownerToggleReadable matched
// /no such (column|table)/i (a broken settings view's
// "no such table: <base>" matches, dropping the owner leg), and
// recordedReceiptsSetting matched /no such table/i (a broken rooms
// view re-armed the lot rule's mirror fallback). Round 4 decides
// every degrade from the named relation's schema entry — kind
// (table/view/absent) from sqlite_master, column presence from
// pragma_table_info — and treats a present relation of either kind
// that cannot be read as present-but-unreadable: the read error
// propagates and the surfaces fail closed.

// The namespaced fixture (task room ROOM opted out, receipt stored
// under ns-room) with public_work_tasks presented as a view whose
// base table is then dropped: the relation EXISTS, the read fails.
function makeDbTaskViewBroken() {
  const db = makeDbNamespaced();
  db.exec("DROP TABLE public_work_tasks");
  db.exec(`CREATE TABLE public_work_tasks_base
    (offer_id TEXT, namespace_key TEXT, room_id TEXT, terms_version INTEGER,
     repository_url TEXT, repository_ref TEXT, files_json TEXT, generation INTEGER, created_at INTEGER)`);
  db.prepare(`INSERT INTO public_work_tasks_base
    (offer_id, namespace_key, room_id, terms_version, repository_url, repository_ref, files_json, generation, created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run("offer-1", "ns", ROOM, 1, "https://example.invalid/repo", "main", "[]", 1, 0);
  db.exec(`CREATE VIEW public_work_tasks AS
    SELECT offer_id, namespace_key, room_id, terms_version, repository_url, repository_ref, files_json, generation, created_at
    FROM public_work_tasks_base`);
  db.exec("DROP TABLE public_work_tasks_base");
  return db;
}

test("round-4 view, task: an unreadable public_work_tasks VIEW is present, not absent — no namespace re-attribution", () => {
  const db = makeDbTaskViewBroken();
  // JS surfaces fail closed rather than re-attribute to ns-room.
  assert.equal(receiptVisible(db, PWR), false);
  assert.deepEqual([...hiddenReceiptIds(db, [PWR])], [PWR]);
  // SQL surfaces throw (the probe propagates) rather than compose
  // the origin fragments and serve under the namespace room.
  assert.throws(() => queryPublicReceipts({ db }, { limit: 10 }));
  assert.throws(() => publicReceiptById({ db }, PWR));
});

// The recorded opt-out (enabled=0) lives behind a
// room_public_receipts_setting VIEW whose base table is dropped.
function makeDbSettingViewBroken() {
  const db = makeDb(null);
  db.exec("DROP TABLE room_public_receipts_setting");
  db.exec("CREATE TABLE setting_base (room_id TEXT PRIMARY KEY, enabled INTEGER)");
  db.prepare("INSERT INTO setting_base (room_id, enabled) VALUES (?,?)").run(ROOM, 0);
  db.exec("CREATE VIEW room_public_receipts_setting AS SELECT room_id, enabled FROM setting_base");
  db.exec("DROP TABLE setting_base");
  return db;
}

test("round-4 view, setting: an unreadable room_public_receipts_setting VIEW never drops a recorded opt-out", () => {
  const db = makeDbSettingViewBroken();
  assert.equal(receiptVisible(db, PWR), false);
  assert.equal(receiptVisible(db, WCR), false);
  assert.deepEqual([...hiddenReceiptIds(db, [PWR, WCR])].sort(), [PWR, WCR].sort());
  assert.equal(recordedReceiptsOptOut(db, ROOM), true);
  assert.throws(() => queryPublicReceipts({ db }, { limit: 10 }));
  assert.throws(() => publicReceiptById({ db }, PWR));
});

// ROOM's owner toggle is 0 behind a room_directory_settings VIEW
// whose base is dropped; the recorded setting is a clean opt-in, so
// only the owner leg can hide these receipts.
function makeDbOwnerViewBroken() {
  const db = makeDb(true);
  db.exec("DROP TABLE room_directory_settings");
  db.exec(`CREATE TABLE directory_settings_base
    (room_id TEXT PRIMARY KEY, discoverable INTEGER NOT NULL DEFAULT 0, listed_at INTEGER,
     updated_at INTEGER NOT NULL, opportunities_enabled INTEGER NOT NULL DEFAULT 1,
     public_receipts INTEGER NOT NULL DEFAULT 1)`);
  db.prepare("INSERT INTO directory_settings_base (room_id, updated_at, public_receipts) VALUES (?,?,?)").run(ROOM, 0, 0);
  db.exec(`CREATE VIEW room_directory_settings AS
    SELECT room_id, discoverable, listed_at, updated_at, opportunities_enabled, public_receipts
    FROM directory_settings_base`);
  db.exec("DROP TABLE directory_settings_base");
  return db;
}

test("round-4 view, owner: a broken room_directory_settings VIEW fails the probe closed instead of dropping the owner leg", () => {
  const db = makeDbOwnerViewBroken();
  // Round 3 pattern-matched the broken view's "no such table: <base>"
  // error and omitted the owner leg entirely. Round 4: the probe
  // read propagates, so nothing composes a verdict without the leg.
  assert.throws(() => ownerToggleReadable(db));
  assert.throws(() => queryPublicReceipts({ db }, { limit: 10 }));
  assert.throws(() => publicReceiptById({ db }, PWR));
});

test("round-4 view, rooms: a broken rooms VIEW is present-but-unreadable (private), never the mirror fallback", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(PUBLIC_READ_MODEL_SCHEMA);
  db.exec(publicUnpublishSchema);
  db.exec(roomDirectorySchema);
  // The mirror (the only record a rooms-less store may consult) says
  // ON, and it is stale: the authoritative record says OFF.
  db.prepare("INSERT INTO room_public_receipts_setting (room_id, enabled) VALUES (?,?)").run(ROOM, 1);
  db.exec("CREATE TABLE rooms_base (id TEXT PRIMARY KEY, projection TEXT)");
  db.prepare("INSERT INTO rooms_base (id, projection) VALUES (?,?)")
    .run(ROOM, JSON.stringify({ room: { publicReceipts: { enabled: 0 } } }));
  db.exec("CREATE VIEW rooms AS SELECT id, projection FROM rooms_base");
  db.exec("DROP TABLE rooms_base");
  // The authoritative record EXISTS (as a view) but cannot be read:
  // the lot is private. Falling back to the stale mirror here is
  // the drift class the lot rule exists to close (B7-2).
  assert.equal(lotReceiptVisible(db, { id: `lot_${"e".repeat(32)}`, roomId: ROOM }), false);
});

test("round-4 view, readable controls: relations presented as readable VIEWs behave exactly as tables", () => {
  // Task view, readable: the task room's recorded opt-out decides
  // on every surface, exactly as with a table.
  const db = makeDbNamespaced();
  db.exec("DROP TABLE public_work_tasks");
  db.exec(`CREATE TABLE public_work_tasks_base
    (offer_id TEXT, namespace_key TEXT, room_id TEXT, terms_version INTEGER,
     repository_url TEXT, repository_ref TEXT, files_json TEXT, generation INTEGER, created_at INTEGER)`);
  db.prepare(`INSERT INTO public_work_tasks_base
    (offer_id, namespace_key, room_id, terms_version, repository_url, repository_ref, files_json, generation, created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run("offer-1", "ns", ROOM, 1, "https://example.invalid/repo", "main", "[]", 1, 0);
  db.exec(`CREATE VIEW public_work_tasks AS
    SELECT offer_id, namespace_key, room_id, terms_version, repository_url, repository_ref, files_json, generation, created_at
    FROM public_work_tasks_base`);
  assert.deepEqual(surfaces(db, PWR), ALL_HIDDEN);
  // Setting view, readable, enabled=0: the opt-out applies on every
  // surface, exactly as with a table (round 3 omitted the SQL leg
  // for any view, readable or not).
  const db2 = makeDb(null);
  db2.exec("DROP TABLE room_public_receipts_setting");
  db2.exec("CREATE TABLE setting_base (room_id TEXT PRIMARY KEY, enabled INTEGER)");
  db2.prepare("INSERT INTO setting_base (room_id, enabled) VALUES (?,?)").run(ROOM, 0);
  db2.exec("CREATE VIEW room_public_receipts_setting AS SELECT room_id, enabled FROM setting_base");
  assert.deepEqual(surfaces(db2, PWR), ALL_HIDDEN);
  assert.equal(recordedReceiptsOptOut(db2, ROOM), true);
});

test("round-4 degrade preserved: a predating settings TABLE without the toggle column still omits the owner leg", () => {
  const db = makeDb(true); // recorded opt-in; only the owner leg could hide
  db.exec("DROP TABLE room_directory_settings");
  db.exec("CREATE TABLE room_directory_settings (room_id TEXT PRIMARY KEY)");
  // The predating shape is a property of a table: no private rooms
  // by definition, the leg is inapplicable, everything else serves.
  assert.equal(ownerToggleReadable(db), false);
  assert.deepEqual(surfaces(db, PWR), ALL_SERVED);
});

test("adversarial read-error over HTTP: the anonymous door stays shut when the setting read fails", async t => {
  const HPWR = `pwr_${"cd".repeat(32)}`;
  const NAMESPACE = `public_${"ef".repeat(16)}`;
  const directory = mkdtempSync(join(tmpdir(), "project-room-mirror-readerror-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  store.command(ownerKey, "commons", { id: "add-ada", type: "member.added", data: { memberId: "ada", displayName: "Ada", kind: "agent", permissions: ["accept_work"] } });
  const adaKey = store.issueAccessKey("commons", "ada");
  const now = Date.now();
  store.db.prepare(`INSERT INTO public_work_tasks
      (offer_id, namespace_key, room_id, terms_version, repository_url, repository_ref, files_json, generation, created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`)
    .run("offer-1", NAMESPACE, "commons", 1, "https://github.com/Uuriko/project-room", "main", "[]", 1, now);
  const body = { schema: "public-work-receipt/1", receiptId: HPWR, namespaceId: NAMESPACE, identityId: "ai_public",
    title: "Public task", createdAt: "2026-10-01T00:00:00.000Z", artifact: { sha256: "cd".repeat(32) } };
  store.db.prepare("INSERT INTO public_work_receipts VALUES (?,?,?,?,?,?,?,?,?,?)").run(
    HPWR, "offer-1", NAMESPACE, 1, "ai_public", "note", "cd".repeat(32), 4, JSON.stringify(body), now);
  projectPublicWorkReceipt(store, body, "cd".repeat(32));
  // Record the opt-out through the real owner event (mirror row = 0).
  const off = store.command(ownerKey, "commons", { id: "optout", type: "room.public_receipts_set", data: { enabled: false } });
  assert.ok(off);
  assert.equal(store.db.prepare("SELECT enabled FROM room_public_receipts_setting WHERE room_id='commons'").get().enabled, 0);
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const raw = async (path, headers = {}) => {
    const res = await fetch(`${origin}${path}`, { headers: { Origin: origin, ...headers } });
    return { status: res.status, text: await res.text() };
  };
  // Baseline with a working read: anonymous is refused under the opt-out.
  assert.equal((await raw(`/api/public-work/receipts/${HPWR}`)).status, 403);
  // Inject the production-shaped failure at the store's read: every
  // receipts-setting statement prepare raises SQLITE_IOERR.
  const realPrepare = store.db.prepare.bind(store.db);
  store.db.prepare = (sql, ...rest) => {
    if (String(sql).includes("room_public_receipts_setting")) throw ioErr();
    return realPrepare(sql, ...rest);
  };
  try {
    const anon = await raw(`/api/public-work/receipts/${HPWR}`);
    assert.equal(anon.status, 403); // fail CLOSED: never 200 under a failed privacy read
    assert.equal(JSON.parse(anon.text).error.code, "receipts_private");
    assert.equal((await raw(`/api/public-work/receipts/${HPWR}/artifact`)).status, 403);
    const member = await raw(`/api/public-work/receipts/${HPWR}`, { authorization: `Bearer ${adaKey}` });
    assert.equal(member.status, 200); // members keep their access under the failure
  } finally {
    store.db.prepare = realPrepare;
  }
});
