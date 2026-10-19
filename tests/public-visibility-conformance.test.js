// Conformance corpus for the one visibility definition
// (server/public-visibility.mjs).
//
// The rule used to live as two hand-kept implementations — SQL fragments
// in the read model and a JS post-filter in receipts-live — whose
// agreement was asserted by a comment and drifted in practice
// (ATLAS-PUBLIC S-7). This corpus enumerates the switch-combination
// space (operator unpublish × owner toggle × receipt shape; unpublish ×
// recorded setting × toggle for lots) and pins three verdicts per cell
// to the same answer: the SQL fragment's, the JS batch form's, and an
// expectation written from the definition itself — not derived from
// either implementation. A future edit that moves one twin must move
// the definition and this corpus with it.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { PUBLIC_READ_MODEL_SCHEMA } from "../server/public-read-model.mjs";
import { publicUnpublishSchema } from "../server/legal-store.mjs";
import { roomDirectorySchema } from "../server/room-directory.mjs";
import { publicWorkClaimsSchema } from "../server/public-work-claims.mjs";
import {
  receiptVisibilitySql,
  receiptVisibilitySqlFor,
  ownerToggleReadable,
  publicWorkTablesReadable,
  hiddenReceiptIds,
  receiptVisible,
  lotReceiptVisible,
  lotVisibleFromFacts,
} from "../server/public-visibility.mjs";

function makeDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(PUBLIC_READ_MODEL_SCHEMA);
  db.exec(publicUnpublishSchema);
  db.exec(roomDirectorySchema);
  db.exec(publicWorkClaimsSchema);
  return db;
}

const hex = (n, ch) => ch.repeat(n).slice(0, n);
let seq = 0;
const nextId = (prefix, ch) => {
  seq += 1;
  const width = prefix === "lot" ? 16 : 32;
  const body = (ch.repeat(width) + seq.toString(16).padStart(2, "0")).slice(-width);
  return `${prefix}_${body}`;
};

function seedReceipt(db, { id, roomId, origin, source }) {
  db.prepare(`INSERT INTO public_receipts
    (id, title, source, origin_room_id, room_id, room_title, agents_json, humans_json,
     pull_request, merged_at, verification_state, hashes_json, at, start_href)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, "Corpus receipt", source, origin, roomId, null, "[]", "[]", null, null, null, "[]",
      "2026-10-01T00:00:00.000Z", "https://room.trydemigod.com/?start=room");
}

function seedWorkRows(db, { receiptId, offerId, taskRoom }) {
  db.prepare(`INSERT INTO public_work_receipts
    (receipt_id, offer_id, namespace_key, generation, identity_id, artifact_text, artifact_sha256, artifact_bytes, receipt_json, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(receiptId, offerId, "ns", 1, "ai_corpus", "note", hex(64, "0"), 4, "{}", 0);
  if (taskRoom) {
    db.prepare(`INSERT INTO public_work_tasks
      (offer_id, namespace_key, room_id, terms_version, repository_url, repository_ref, files_json, generation, created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(offerId, "ns", taskRoom, 1, "https://example.invalid/repo", "main", "[]", 1, 0);
  }
}

function setToggle(db, room, value) {
  if (value === "absent") return;
  db.prepare(`INSERT INTO room_directory_settings (room_id, discoverable, listed_at, updated_at, public_receipts)
    VALUES (?, 0, NULL, 0, ?)`).run(room, value === "off" ? 0 : 1);
}

// Receipt shapes (room attribution differs by source and era):
//   board-listed    room_id = origin = the room
//   board-unlisted  room_id = null, origin = the room
//   pwr-resolved    origin = room_id = task room (current projection)
//   pwr-legacy      origin = room_id = namespace, task room = the room
const SHAPES = {
  "board-listed": cell => ({ roomId: cell.room, origin: cell.room, source: "work-claim" }),
  "board-unlisted": cell => ({ roomId: null, origin: cell.room, source: "work-claim" }),
  "pwr-resolved": cell => ({ roomId: cell.room, origin: cell.room, source: "public-work", work: true }),
  "pwr-legacy": cell => ({ roomId: cell.ns, origin: cell.ns, source: "public-work", work: true }),
};

// Whether a room unpublish on the cell's room reaches this shape: the
// SQL checks room_id and origin_room_id, nothing else.
const unpublishReaches = {
  "board-listed": () => true,
  "board-unlisted": () => true,
  "pwr-resolved": () => true,
  "pwr-legacy": () => false, // both fields name the namespace, not the room
};

// Whether an owner toggle-off on the cell's room reaches this shape:
// the origin room, plus the task's room for public-work receipts.
const toggleReaches = {
  "board-listed": () => true,
  "board-unlisted": () => true,
  "pwr-resolved": () => true,
  "pwr-legacy": () => true, // through the task record
};

test("SQL and JS twins agree with the definition across the receipt switch space", () => {
  const db = makeDb();
  const cells = [];
  let n = 0;
  for (const [shape, build] of Object.entries(SHAPES)) {
    for (const unpublish of ["none", "receipt", "room"]) {
      for (const toggle of ["absent", "on", "off"]) {
        n += 1;
        const room = `cell-room-${n}`;
        const cell = { room, ns: `cell-ns-${n}`, shape, unpublish, toggle };
        const id = nextId("wcr", String(n % 10));
        cell.id = id;
        const fields = build(cell);
        seedReceipt(db, { id, ...fields });
        if (fields.work) seedWorkRows(db, { receiptId: id, offerId: `offer-${n}`, taskRoom: room });
        if (unpublish === "receipt") {
          db.prepare("INSERT INTO public_unpublish (kind, target, at, by_account) VALUES ('receipt', ?, 0, 'op')").run(id);
        }
        if (unpublish === "room") {
          db.prepare("INSERT INTO public_unpublish (kind, target, at, by_account) VALUES ('room', ?, 0, 'op')").run(room);
        }
        setToggle(db, room, toggle);
        const expectedVisible = !(
          unpublish === "receipt"
          || (unpublish === "room" && unpublishReaches[shape]())
          || (toggle === "off" && toggleReaches[shape]())
        );
        cells.push({ ...cell, expectedVisible });
      }
    }
  }

  const sql = receiptVisibilitySql({ ownerToggle: ownerToggleReadable(db) });
  const hidden = hiddenReceiptIds(db, cells.map(cell => cell.id));
  for (const cell of cells) {
    const label = `${cell.shape} / unpublish=${cell.unpublish} / toggle=${cell.toggle}`;
    const sqlVisible = !!db.prepare(`SELECT 1 FROM public_receipts WHERE id=? AND ${sql}`).get(cell.id);
    assert.equal(sqlVisible, cell.expectedVisible, `SQL verdict — ${label}`);
    assert.equal(!hidden.has(cell.id), cell.expectedVisible, `JS batch verdict — ${label}`);
    assert.equal(receiptVisible(db, cell.id), cell.expectedVisible, `JS single verdict — ${label}`);
  }
});

test("edge cells the cross product does not generate", () => {
  const db = makeDb();
  // A legacy pwr row whose task record is gone: nothing resolves a room,
  // so neither a room unpublish nor the room's toggle can reach it.
  const orphan = nextId("wcr", "e");
  seedReceipt(db, { id: orphan, roomId: "gone-ns", origin: "gone-ns", source: "public-work" });
  seedWorkRows(db, { receiptId: orphan, offerId: "offer-gone", taskRoom: null });
  db.prepare("INSERT INTO public_unpublish (kind, target, at, by_account) VALUES ('room', 'gone-room', 0, 'op')").run();
  setToggle(db, "gone-room", "off");
  assert.equal(receiptVisible(db, orphan), true, "an unresolvable receipt is reached by neither room switch");

  // A settings row keyed by the namespace itself hides a legacy pwr row:
  // both twins consult the origin as a settings key, by definition.
  const nsKeyed = nextId("wcr", "f");
  seedReceipt(db, { id: nsKeyed, roomId: "keyed-ns", origin: "keyed-ns", source: "public-work" });
  seedWorkRows(db, { receiptId: nsKeyed, offerId: "offer-keyed", taskRoom: "keyed-room" });
  setToggle(db, "keyed-ns", "off");
  const sql = receiptVisibilitySql({ ownerToggle: true });
  assert.equal(!!db.prepare(`SELECT 1 FROM public_receipts WHERE id=? AND ${sql}`).get(nsKeyed), false, "SQL: origin-keyed toggle hides");
  assert.equal(receiptVisible(db, nsKeyed), false, "JS: origin-keyed toggle hides");

  // An id with no row at all is hidden to the JS form (fail closed).
  assert.equal(receiptVisible(db, nextId("wcr", "0")), false, "unknown id fails closed");
});

test("a settings table without the toggle column disables the owner leg in both twins", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(PUBLIC_READ_MODEL_SCHEMA);
  db.exec(publicUnpublishSchema);
  // The legacy settings schema is today's schema minus the toggle
  // column — derived from the real DDL so the two cannot drift apart.
  const legacyDirectorySchema = roomDirectorySchema.replace(/,\n\s*public_receipts INTEGER[^\n]*/, "");
  assert.equal(legacyDirectorySchema.includes("public_receipts"), false);
  db.exec(legacyDirectorySchema);
  db.exec(publicWorkClaimsSchema);
  assert.equal(ownerToggleReadable(db), false);
  assert.equal(receiptVisibilitySql({ ownerToggle: false }).includes("room_directory_settings"), false,
    "the no-toggle fragment never references the settings table");

  const id = nextId("wcr", "a");
  seedReceipt(db, { id, roomId: "legacy-room", origin: "legacy-room", source: "work-claim" });
  const sql = receiptVisibilitySql({ ownerToggle: ownerToggleReadable(db) });
  assert.equal(!!db.prepare(`SELECT 1 FROM public_receipts WHERE id=? AND ${sql}`).get(id), true, "SQL: visible");
  assert.equal(receiptVisible(db, id), true, "JS: visible — the twins agree the leg does not exist here");
  db.prepare("INSERT INTO public_unpublish (kind, target, at, by_account) VALUES ('receipt', ?, 0, 'op')").run(id);
  assert.equal(!!db.prepare(`SELECT 1 FROM public_receipts WHERE id=? AND ${sql}`).get(id), false, "SQL: unpublish still hides");
  assert.equal(receiptVisible(db, id), false, "JS: unpublish still hides");
});

test("a store predating the public-work tables degrades the task leg in both twins", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(PUBLIC_READ_MODEL_SCHEMA);
  db.exec(publicUnpublishSchema);
  db.exec(roomDirectorySchema);
  // No publicWorkClaimsSchema: no task records can exist here.
  assert.equal(publicWorkTablesReadable(db), false);
  const sql = receiptVisibilitySqlFor(db);
  assert.equal(sql.includes("public_work_receipts"), false, "the composed fragment never references absent tables");

  // A board receipt in a toggled-off room hides; a pwr-shaped row is
  // judged by its origin room alone (there is no task record to consult).
  const board = nextId("wcr", "b");
  seedReceipt(db, { id: board, roomId: "pre-room", origin: "pre-room", source: "work-claim" });
  const pwr = nextId("pwr", "c");
  seedReceipt(db, { id: pwr, roomId: "pre-ns", origin: "pre-ns", source: "public-work" });
  const pwrOpen = nextId("pwr", "d");
  seedReceipt(db, { id: pwrOpen, roomId: "open-ns", origin: "open-ns", source: "public-work" });
  setToggle(db, "pre-room", "off");
  setToggle(db, "pre-ns", "off");
  const hidden = hiddenReceiptIds(db, [board, pwr, pwrOpen]);
  for (const [id, expected] of [[board, false], [pwr, false], [pwrOpen, true]]) {
    assert.equal(!!db.prepare(`SELECT 1 FROM public_receipts WHERE id=? AND ${sql}`).get(id), expected, `SQL verdict for ${id}`);
    assert.equal(!hidden.has(id), expected, `JS verdict for ${id}`);
    assert.equal(receiptVisible(db, id), expected, `JS single verdict for ${id}`);
  }
});

test("the lot rule across unpublish × recorded setting × toggle", () => {
  const db = makeDb();
  let n = 0;
  for (const unpublish of ["none", "receipt", "room"]) {
    for (const setting of ["absent", "off", "on"]) {
      for (const toggle of ["absent", "on", "off"]) {
        n += 1;
        const roomId = `lot-room-${n}`;
        const id = nextId("lot", String(n % 10));
        if (unpublish === "receipt") {
          db.prepare("INSERT INTO public_unpublish (kind, target, at, by_account) VALUES ('receipt', ?, 0, 'op')").run(id);
        }
        if (unpublish === "room") {
          db.prepare("INSERT INTO public_unpublish (kind, target, at, by_account) VALUES ('room', ?, 0, 'op')").run(roomId);
        }
        if (setting !== "absent") {
          db.prepare("INSERT INTO room_public_receipts_setting (room_id, enabled) VALUES (?, ?)")
            .run(roomId, setting === "on" ? 1 : 0);
        }
        setToggle(db, roomId, toggle);
        const expected = unpublish === "none" && setting === "on" && toggle !== "off";
        assert.equal(lotReceiptVisible(db, { id, roomId }), expected,
          `lot / unpublish=${unpublish} / setting=${setting} / toggle=${toggle}`);
      }
    }
  }
});

test("the pure-data lot rule the packager's U5 filter must mirror", () => {
  // The full truth table of lotVisibleFromFacts, written out: a settled
  // lot is public only with a recorded opt-in, no unpublish, and the
  // owner's receipts toggle on. Never-recorded (null) is private (#3594).
  const table = [
    [{ unpublished: true, settingEnabled: 1, receiptsPrivate: false }, false],
    [{ unpublished: false, settingEnabled: 1, receiptsPrivate: false }, true],
    [{ unpublished: false, settingEnabled: 1, receiptsPrivate: true }, false],
    [{ unpublished: false, settingEnabled: 0, receiptsPrivate: false }, false],
    [{ unpublished: false, settingEnabled: null, receiptsPrivate: false }, false],
    [{ unpublished: true, settingEnabled: null, receiptsPrivate: true }, false],
  ];
  for (const [facts, expected] of table) {
    assert.equal(lotVisibleFromFacts(facts), expected, JSON.stringify(facts));
  }
});
