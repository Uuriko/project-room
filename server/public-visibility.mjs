// The one definition of "publicly visible" for receipts (ATLAS-PUBLIC
// R-1, ATLAS-DATA P-5). Every public surface — receipt list, detail,
// collect, sitemap, proof page, room page, directory counts, lot pages,
// and the dataset packager's U5 filter — answers the visibility question
// from this module and nowhere else. Before it, the rule lived as two
// hand-kept twins (SQL fragments in the read model, a JS post-filter in
// receipts-live) with different inputs, and each surface applied its own
// subset: directory counts applied neither half, the sitemap applied the
// JS half after its LIMIT, and the twins' drift was asserted away by a
// comment. The conformance corpus (tests/public-visibility-conformance
// .test.js) pins the SQL and JS forms below to the same verdicts across
// the full switch-combination space.
//
// THE RULE, for a row of public_receipts:
//
//   visible ⟺ NOT operator-unpublished
//             AND NOT owner-hidden
//             AND NOT authoritatively opted out
//
// Authoritatively opted out: the receipt's deciding room has a RECORDED
// public-receipts setting of enabled=false (room.public_receipts_set —
// the in-room "public receipts" toggle sends exactly this event).
// Public reads never touch rooms.projection (the read model's
// founding invariant, pinned by tests/public-read-model.test.js), so
// this leg reads the setting's read-model copy,
// room_public_receipts_setting, which syncRoomPublication rewrites in
// the same transaction as every recorded setting change (and the
// backfill re-mirrors for every room, previous:null included). Before
// this leg, stored rows consulted only the operator unpublish and the
// directory toggle, so a public-work (pwr_) row — which no delete
// path can remove — kept serving on every surface after the owner
// opted out, and a drifted wcr_/wir_ row whose opt-out edge was
// missed served forever (R08-F1/F3). Read-time and level-triggered:
// the row's presence in public_receipts no longer decides anything,
// so a stale row cannot outlive the recorded setting, and a later
// recorded opt-in serves the row again with no rewrite. A room that
// never recorded a setting keeps the directory toggle's default
// (public-work receipts are public unless opted out); only a
// recorded false hides. The deciding room of a public-work receipt
// is the room that owns its public-work task, and ONLY that room: a
// public-work receipt names a namespace, not a room (its stored
// room_id is the namespace resolution), so a pwr_ row with no task
// record has no deciding room and no room's recorded setting governs
// it — the dedicated door has always applied exactly this attribution
// ("rows without a task link stay public", public-work-claims.mjs).
// The first cut of this leg fell back to the stored room_id for a
// taskless pwr_ row, which hid namespace-public work whenever the
// namespace's room recorded any setting change ending in opt-out —
// over-hiding in the opposite direction (tests/receipts-route.test.js).
// For every other receipt the deciding room is its room_id, else its
// origin room.
//
// Operator-unpublished: a public_unpublish row of kind 'receipt' naming
// the receipt, or kind 'room' naming either of the receipt's rooms
// (room_id or origin_room_id).
//
// Owner-hidden: any room the receipt belongs to has
// room_directory_settings.public_receipts = 0 (the owner's public-
// receipts toggle, default 1 = public). A receipt's rooms are its origin
// room plus, for a public-work receipt, the room that owns its task
// (resolved through public_work_receipts → public_work_tasks, because a
// pwr_ row's origin can be a namespace rather than a room id).
//
// THE RULE, for a lot receipt (lot_ ids name no public_receipts row; the
// journal is the record):
//
//   visible ⟺ NOT operator-unpublished (receipt or room)
//             AND the room's recorded public-receipts setting is ON,
//                 consulted AT READ TIME from the authoritative record
//                 (rooms.projection $.room.publicReceipts.enabled — a
//                 settled lot is public only with the owner's recorded
//                 opt-in, #3594: never-recorded, recorded-off, and
//                 unreadable are all private)
//             AND NOT owner-hidden (the directory toggle above)
//
// The recorded-setting leg used to read the write-time mirror
// (room_public_receipts_setting), and a desynced mirror changed public
// exposure in both directions, indefinitely: a stale enabled=1 served a
// lot after the owner opted out (or after a restore/import dropped the
// recorded setting), and a missing mirror hid a lot the owner had opted
// in (B7-2-F1/F2/F4, B2-4-F1 — the settled-lot drift class). The mirror
// is consulted now only where the store carries no rooms relation at
// all (a predating/partial store, where the mirror is the only record
// that can exist); wherever the authoritative record can be read, it
// alone decides, so mirror drift cannot move a lot's public state.
//
// Legacy stores: a settings table predating the public_receipts column
// has no private rooms by definition (the column's default is public),
// so the owner leg applies only where the column can be read. The read
// path probes and never writes; the column is added by the directory's
// own migration when directory code runs.
//
// Fail-closed: a check that cannot be performed hides the content
// (isUnpublished's contract), and an id with no public_receipts row is
// hidden to the JS batch form — an unknown id must never become visible
// by falling out of a lookup.
//
// SQL contract: the fragments reference the table by name
// (public_receipts.<column>) and are valid in a query whose FROM is
// public_receipts with no alias — the shape every consumer already uses.
import { isUnpublished } from "./legal-store.mjs";

// Operator unpublish (kind 'receipt' on the id, kind 'room' on either
// room the receipt belongs to).
export const OPERATOR_HIDDEN_RECEIPT_SQL = `NOT EXISTS (
  SELECT 1 FROM public_unpublish u
  WHERE (u.kind='receipt' AND u.target=public_receipts.id)
     OR (u.kind='room' AND u.target=public_receipts.room_id)
     OR (u.kind='room' AND u.target=public_receipts.origin_room_id))`;

// Owner toggle: the origin room, plus the owning room of a public-work
// receipt through its task record.
export const OWNER_HIDDEN_RECEIPT_SQL = `NOT EXISTS (
  SELECT 1 FROM room_directory_settings s
  WHERE s.public_receipts = 0
    AND (s.room_id = public_receipts.origin_room_id
         OR s.room_id IN (
           SELECT pwt.room_id FROM public_work_receipts pwr
           JOIN public_work_tasks pwt ON pwt.offer_id = pwr.offer_id
           WHERE pwr.receipt_id = public_receipts.id)))`;

// The owner leg without the task-record resolution, for stores that
// predate the public-work tables: no task records can exist there, so
// the task leg is empty and the origin room alone decides. (Read paths
// across this codebase degrade on predating schemas rather than throw;
// a fragment referencing absent tables would do neither.)
export const OWNER_HIDDEN_ORIGIN_RECEIPT_SQL = `NOT EXISTS (
  SELECT 1 FROM room_directory_settings s
  WHERE s.public_receipts = 0
    AND s.room_id = public_receipts.origin_room_id)`;

export function ownerHiddenReceiptSql({ taskRoomLeg = true } = {}) {
  return taskRoomLeg ? OWNER_HIDDEN_RECEIPT_SQL : OWNER_HIDDEN_ORIGIN_RECEIPT_SQL;
}

// Authoritative opt-out: the deciding room's recorded public-receipts
// setting is enabled=false in the setting's read-model copy
// (room_public_receipts_setting — syncRoomPublication maintains it in
// the same transaction as the recorded change; public reads never
// touch rooms.projection). A recorded row whose value is anything
// other than a clean 1 (0, or a corrupt value no writer produces)
// counts as an opt-out: a recorded setting that cannot be read as ON
// must never widen visibility. Attribution per the header: a
// public-work receipt is decided by its task room alone (no task
// record, no deciding room); any other receipt by room_id, else
// origin room.
export const RECORDED_OPTOUT_RECEIPT_SQL = `NOT EXISTS (
  SELECT 1 FROM room_public_receipts_setting s
  WHERE s.enabled IS NOT 1
    AND (
      s.room_id IN (
        SELECT pwt.room_id FROM public_work_receipts pwr
        JOIN public_work_tasks pwt ON pwt.offer_id = pwr.offer_id
        WHERE pwr.receipt_id = public_receipts.id)
      OR (s.room_id = COALESCE(public_receipts.room_id, public_receipts.origin_room_id)
          AND NOT EXISTS (
            SELECT 1 FROM public_work_receipts pwr
            WHERE pwr.receipt_id = public_receipts.id))
    ))`;

// The opt-out leg without the task-record resolution, for stores that
// predate the public-work tables (same degrade as the owner leg).
export const RECORDED_OPTOUT_ORIGIN_RECEIPT_SQL = `NOT EXISTS (
  SELECT 1 FROM room_public_receipts_setting s
  WHERE s.enabled IS NOT 1
    AND s.room_id = COALESCE(public_receipts.room_id, public_receipts.origin_room_id))`;

export function recordedOptOutReceiptSql({ taskRoomLeg = true } = {}) {
  return taskRoomLeg ? RECORDED_OPTOUT_RECEIPT_SQL : RECORDED_OPTOUT_ORIGIN_RECEIPT_SQL;
}

// The composed SQL predicate over a public_receipts row.
export function receiptVisibilitySql({ ownerToggle = true, taskRoomLeg = true, recordedOptOut = false } = {}) {
  const legs = [OPERATOR_HIDDEN_RECEIPT_SQL];
  if (ownerToggle) legs.push(ownerHiddenReceiptSql({ taskRoomLeg }));
  if (recordedOptOut) legs.push(recordedOptOutReceiptSql({ taskRoomLeg }));
  return legs.join(" AND ");
}

// The kind of a named relation in this store — "table", "view",
// or null when no relation carries the name — read structurally
// from the schema. The degrade decisions below key on genuine
// ABSENCE OF THE NAMED RELATION, never on error text and never on
// the relation being a table specifically: a present table with a
// renamed or unreadable column is not absent (round 3, seq 25136),
// and neither is a VIEW — a store may present any of these
// relations as a view (a restore/import representation, a compat
// shape), and a view is the relation's presence, not its absence.
// The round-3 gate asked sqlite_master for type='table' only, so
// a view-backed relation read as absent and every degrade behind
// it fired: an unreadable public_work_tasks view degraded the
// task attribution, an unreadable setting view dropped a recorded
// opt-out, and even a READABLE view silently disqualified both
// SQL probes below, so the composed SQL served what the JS twin
// hid (Codex review, seq 25157). A present relation of either
// kind that cannot be read is present-but-unreadable: the probes
// let its read error propagate, and the composed reads fail
// closed.
function relationType(db, name) {
  const row = db.prepare("SELECT type FROM sqlite_master WHERE name=? AND type IN ('table','view')").get(name);
  return row ? row.type : null;
}

function relationExists(db, name) {
  return relationType(db, name) !== null;
}

// Whether a relation carries a column, read structurally (the
// table-valued pragma function takes the name as a bound value).
function relationHasColumn(db, name, column) {
  return Boolean(db.prepare("SELECT 1 FROM pragma_table_info(?) WHERE name=?").get(name, column));
}

// Whether the public-work relations the task leg reads can be read
// here.
export function publicWorkTablesReadable(db) {
  if (!relationExists(db, "public_work_receipts") || !relationExists(db, "public_work_tasks")) return false;
  // Both relations exist: a further read failure (a renamed column
  // on a populated table, a view whose base is gone) is
  // present-but-unreadable, not absence — let it propagate, so the
  // composed reads fail closed instead of degrading the task-room
  // attribution to the origin room.
  db.prepare("SELECT receipt_id, offer_id FROM public_work_receipts LIMIT 0").all();
  db.prepare("SELECT offer_id, room_id FROM public_work_tasks LIMIT 0").all();
  return true;
}

// Whether the recorded setting's read-model copy can be read here
// at all: a store predating room_public_receipts_setting carries
// no recorded setting the public read may consult, so the opt-out
// leg cannot apply there. Only a genuinely absent RELATION is
// that legacy case (checked structurally, per relationExists): a
// store whose relation exists but whose enabled column cannot be
// read may hold recorded opt-outs behind the column, so the error
// propagates and the composed reads throw rather than serve with
// the leg silently omitted (the JS twin's rule in
// mirroredReceiptsSetting; Codex review, seq 25107/25108).
export function recordedSettingReadable(db) {
  if (!relationExists(db, "room_public_receipts_setting")) return false;
  db.prepare("SELECT room_id, enabled FROM room_public_receipts_setting LIMIT 0").all();
  return true;
}

// The composed predicate for a concrete store, with both schema probes
// applied — the form consumers use.
export function receiptVisibilitySqlFor(db) {
  return receiptVisibilitySql({
    ownerToggle: ownerToggleReadable(db),
    taskRoomLeg: publicWorkTablesReadable(db),
    recordedOptOut: recordedSettingReadable(db),
  });
}

// A legacy store whose settings TABLE predates the toggle column
// has no private rooms by definition, so the owner leg applies
// only where the column can be read. The predating shape is a
// property of a table, decided structurally (round 4): relation
// kind from sqlite_master, column presence from pragma_table_info
// — no error-text matching anywhere in the decision. A settings
// VIEW is a current-schema object, never a predating store, so it
// gets no column degrade: a view without the column, or one whose
// base is gone, fails the probe read and the error propagates
// (the composed reads fail closed) instead of silently omitting
// the owner leg. The round-3 form pattern-matched the probe's
// error text, and a broken view's "no such table: <base>" matched
// it (Codex review, seq 25157).
export function ownerToggleReadable(db) {
  const kind = relationType(db, "room_directory_settings");
  if (!kind) return false; // no settings relation at all: no owner leg can apply
  if (kind === "table" && !relationHasColumn(db, "room_directory_settings", "public_receipts")) return false;
  db.prepare("SELECT public_receipts FROM room_directory_settings LIMIT 0").all();
  return true;
}

// Pure-data forms of the two rules, for consumers that work from plain
// row values rather than a live db (the dataset packager's U5 filter
// reads snapshot tables). lotReceiptVisible/receiptVisible below are
// these functions over facts read from the db; a snapshot consumer that
// derives the same facts must reach the same verdicts — that parity is
// the U5 obligation, pinned by the conformance corpus. For the lot rule
// the settingEnabled fact is the AUTHORITATIVE recorded setting (the
// room projection's publicReceipts leg), never a mirror of it.
export function receiptVisibleFromFacts({ unpublished = false, receiptsPrivate = false, recordedOptOut = false } = {}) {
  return !unpublished && !receiptsPrivate && !recordedOptOut;
}

export function lotVisibleFromFacts({ unpublished = false, settingEnabled = null, receiptsPrivate = false } = {}) {
  if (unpublished) return false;
  if (settingEnabled !== 1) return false; // recorded opt-in only (#3594)
  if (receiptsPrivate) return false;
  return true;
}

// Whether one room's owner turned public receipts off. Assumes the
// toggle column is readable (ownerToggleReadable); the composed entry
// points below make that check first. Fails closed on a read error.
export function roomReceiptsPrivate(db, roomId) {
  try {
    const row = db.prepare("SELECT public_receipts FROM room_directory_settings WHERE room_id=?").get(roomId);
    return row ? row.public_receipts === 0 : false;
  } catch { return true; }
}

// The JS twin of receiptVisibilitySql, batched: the subset of receiptIds
// that is NOT publicly visible. Applies the whole rule — a receipt the
// operator unpublished is hidden here too, not only owner-hidden ones —
// and fails closed on ids with no public_receipts row.
export function hiddenReceiptIds(db, receiptIds) {
  const hidden = new Set();
  if (!receiptIds.length) return hidden;
  const idList = JSON.stringify(receiptIds);
  let rowsById;
  let taskLegAvailable = true;
  const unpublishedReceipts = new Set();
  const unpublishedRooms = new Set();
  try {
    rowsById = new Map();
    // The task-room resolution joins the public-work tables; a store
    // predating them has no task records, so the join's absence degrades
    // to the origin room alone rather than failing the whole check.
    let rows;
    try {
      rows = db.prepare(`SELECT pr.id AS id, pr.room_id AS roomId, pr.origin_room_id AS origin, pwt.room_id AS taskRoom, pwr.receipt_id AS pwrId
        FROM public_receipts pr
        LEFT JOIN public_work_receipts pwr ON pwr.receipt_id = pr.id
        LEFT JOIN public_work_tasks pwt ON pwt.offer_id = pwr.offer_id
        WHERE pr.id IN (SELECT value FROM json_each(?))`).all(idList);
    } catch (error) {
      // Only genuine ABSENCE degrades (the predating store above,
      // whose missing relations mean no task record can exist),
      // and absence is checked structurally in the schema — never
      // from the error text: a present table with a renamed column
      // produces the same "no such column" as a predating schema,
      // an I/O error reading live tables is not absence either,
      // and a relation presented as a VIEW is present, readable or
      // not (round 4, seq 25157). Anything else rethrows, and the
      // outer catch hides everything asked about rather than
      // re-attributing a public-work receipt to its stored
      // namespace/origin room, the deciding room the opt-out leg's
      // attribution rule removed (Codex review, seq 25107/25108
      // and seq 25136).
      if (relationExists(db, "public_work_receipts") && relationExists(db, "public_work_tasks")) throw error;
      taskLegAvailable = false;
      rows = db.prepare(`SELECT id, room_id AS roomId, origin_room_id AS origin, NULL AS taskRoom, NULL AS pwrId
        FROM public_receipts WHERE id IN (SELECT value FROM json_each(?))`).all(idList);
    }
    for (const row of rows) rowsById.set(row.id, row);
    for (const row of db.prepare(`SELECT target FROM public_unpublish
        WHERE kind='receipt' AND target IN (SELECT value FROM json_each(?))`).all(idList)) {
      unpublishedReceipts.add(row.target);
    }
    const roomTargets = new Set();
    for (const row of rowsById.values()) {
      if (row.roomId) roomTargets.add(row.roomId);
      if (row.origin) roomTargets.add(row.origin);
    }
    if (roomTargets.size) {
      for (const row of db.prepare(`SELECT target FROM public_unpublish
          WHERE kind='room' AND target IN (SELECT value FROM json_each(?))`).all(JSON.stringify([...roomTargets]))) {
        unpublishedRooms.add(row.target);
      }
    }
  } catch {
    // A visibility check that cannot be performed hides the content.
    return new Set(receiptIds);
  }
  // The owner leg, only where the toggle column can be read; a private
  // room is one with a recorded public_receipts = 0.
  const privateRooms = new Set();
  if (ownerToggleReadable(db)) {
    const candidates = new Set();
    for (const row of rowsById.values()) {
      if (row.taskRoom) candidates.add(row.taskRoom);
      if (row.origin) candidates.add(row.origin);
    }
    if (candidates.size) {
      try {
        for (const row of db.prepare(`SELECT room_id FROM room_directory_settings
            WHERE public_receipts = 0 AND room_id IN (SELECT value FROM json_each(?))`).all(JSON.stringify([...candidates]))) {
          privateRooms.add(row.room_id);
        }
      } catch { return new Set(receiptIds); } // readable a moment ago, unreadable now: fail closed
    }
  }
  // The authoritative opt-out leg: a deciding room whose recorded
  // setting is enabled=false hides the receipt, whatever the
  // public_receipts row or the directory toggle says (R08-F1). The
  // deciding room follows the SQL twin's attribution: a public-work
  // receipt is decided by its task room alone (no task record, no
  // deciding room — a namespace is not a room that can opt it out);
  // any other receipt by room_id, else origin. Where the public-work
  // tables cannot be read at all, no task record can exist and every
  // row degrades to room_id/origin, as the SQL origin twin does. The
  // fact is read from the setting's read-model copy
  // (mirroredReceiptsSetting); a read error here fails CLOSED (every
  // candidate hidden), never open — the first cut swallowed the
  // error as "no opt-out" and served a recorded opt-out's receipts
  // (Codex review, seq 25069).
  const optOutDecidingRoom = (row) => {
    if (taskLegAvailable && row.pwrId) return row.taskRoom ?? null;
    return row.roomId ?? row.origin ?? null;
  };
  const optedOutRooms = new Set();
  {
    const candidates = new Set();
    for (const row of rowsById.values()) {
      const deciding = optOutDecidingRoom(row);
      if (deciding) candidates.add(deciding);
    }
    try {
      for (const roomId of candidates) {
        if (mirroredSettingOptsOut(mirroredReceiptsSetting(db, roomId))) optedOutRooms.add(roomId);
      }
    } catch { return new Set(receiptIds); } // the privacy read failed: hide everything asked about
  }
  for (const id of receiptIds) {
    const row = rowsById.get(id);
    if (!row || unpublishedReceipts.has(id)) { hidden.add(id); continue; }
    if ((row.roomId && unpublishedRooms.has(row.roomId)) || (row.origin && unpublishedRooms.has(row.origin))) {
      hidden.add(id);
      continue;
    }
    const decidingRoom = optOutDecidingRoom(row);
    if (decidingRoom && optedOutRooms.has(decidingRoom)) { hidden.add(id); continue; }
    const toggleRooms = [];
    if (row.taskRoom) toggleRooms.push(row.taskRoom);
    if (row.origin && row.origin !== row.taskRoom) toggleRooms.push(row.origin);
    if (toggleRooms.some(roomId => privateRooms.has(roomId))) hidden.add(id);
  }
  return hidden;
}

// The JS twin for one receipt, by id. The stored row is the truth (the
// SQL twin reads the same row), so this is the batch form over one id.
export function receiptVisible(db, id) {
  if (typeof id !== "string" || !id) return false;
  return !hiddenReceiptIds(db, [id]).has(id);
}

// The room's recorded public-receipts setting, read from the
// authoritative record at read time: the room projection's
// $.room.publicReceipts.enabled leg, extracted in SQL so the read never
// hydrates the projection. Returns one of:
//   { status: "recorded", enabled: 1 | 0 | null } — the rooms row exists;
//     enabled is null when no setting was ever recorded (#3594: absent
//     is private), 1/0 for a recorded on/off.
//   { status: "absent", enabled: null } — the authoritative store is
//     there but holds no row for the room (or cannot be read): no
//     recorded opt-in exists, so the verdict is private.
//   { status: "unavailable", enabled: null } — the store carries no
//     rooms relation at all (a predating/partial store): the
//     authoritative record cannot exist here, and the caller falls
//     back to the write-time mirror, the only record such a store
//     can hold.
export function recordedReceiptsSetting(db, roomId) {
  let row;
  try {
    row = db.prepare(`SELECT json_extract(projection, '$.room.publicReceipts.enabled') AS enabled
      FROM rooms WHERE id=?`).get(roomId);
  } catch {
    // "unavailable" is a statement about the STORE, decided
    // structurally (round 4): only a store with no rooms relation
    // at all has no authoritative record. A rooms VIEW is the
    // record's presence — a read failure through it (its base
    // renamed away; the error text still says "no such table",
    // which the round-3 form pattern-matched into the mirror
    // fallback) is present-but-unreadable: "absent", private, and
    // the mirror is never consulted (Codex review, seq 25157).
    if (!relationExists(db, "rooms")) return { status: "unavailable", enabled: null };
    return { status: "absent", enabled: null }; // a store that cannot answer recorded no opt-in
  }
  if (!row) return { status: "absent", enabled: null };
  return { status: "recorded", enabled: row.enabled === 1 ? 1 : row.enabled === 0 ? 0 : null };
}

// The same recorded setting, read from its read-model copy
// (room_public_receipts_setting) instead of the authoritative record:
// the form a public HTTP route may use, because public reads never
// touch rooms.projection (the read model's founding invariant, pinned
// by tests/public-read-model.test.js). Returns the same contract as
// recordedReceiptsSetting:
//   { status: "recorded", enabled: 1 | 0 } — a recorded on/off. The
//     copy is rewritten in the same transaction as every recorded
//     setting change (syncRoomPublication) and reconciled
//     level-triggered on every later room write (#5623), so a desync
//     of the public_rooms listing column — the DETAIL 8 shape: that
//     column stale, or a receipt row re-seeded after an opt-out —
//     cannot move this read: the copy, not the listing row, decides.
//   { status: "recorded", enabled: null } — a recorded row whose value
//     is uninterpretable: not an opt-in, the verdict is private.
//   { status: "absent", enabled: null } — the copy is readable and
//     holds no row for the room: no setting was ever recorded (#3594:
//     absent is private). A copy that exists but cannot be read is
//     also "absent", never a fallback to a weaker mirror.
//   { status: "unavailable", enabled: null } — the store carries no
//     rooms relation at all, or predates the copy's table: no recorded
//     setting can be consulted here, and the caller falls back to the
//     listing column, the only record such a store can hold (the same
//     legacy fallback recordedReceiptsSetting's callers keep).
// Named residual: a desync of this copy itself (a projection-only
// rewrite with no subsequent room write or backfill) is the same
// residual the stored-row opt-out leg already carries on every public
// surface; #5623's level trigger is its cure. Only the lot path, which
// is not a public HTTP route in the invariant test's set, reads the
// authoritative record directly (recordedReceiptsSetting).
export function readModelReceiptsSetting(db, roomId) {
  let mirrored;
  try {
    mirrored = mirroredReceiptsSetting(db, roomId);
  } catch {
    return { status: "absent", enabled: null }; // present-but-unreadable copy: no recorded opt-in can be shown
  }
  if (mirrored === 1 || mirrored === 0) return { status: "recorded", enabled: mirrored };
  if (mirrored === "unknown") return { status: "recorded", enabled: null };
  // mirrored === null: no recorded row, or the copy's table is absent.
  // Both legacy shapes — no rooms relation at all, or a store predating
  // the copy — are "unavailable", decided structurally, never from
  // error text.
  if (!relationExists(db, "rooms")) return { status: "unavailable", enabled: null };
  if (!relationExists(db, "room_public_receipts_setting")) return { status: "unavailable", enabled: null };
  return { status: "absent", enabled: null };
}

// The write-time mirror of the recorded setting: the fallback record
// for stores with no rooms table (see recordedReceiptsSetting), and
// the fact the stored-row opt-out leg reads — public reads consult
// this copy, never rooms.projection. Returns:
//   1 | 0  — a recorded setting with a clean boolean value
//            (1/true = on, 0/false = off);
//   null   — no recorded row, or the store predates the mirror table
//            entirely (the legacy case: no recorded setting can exist
//            there, so no opt-out can be lost by answering null);
//   "unknown" — a recorded row exists but its value is neither
//            true/false/0/1: uninterpretable, and every caller must
//            treat it as private, never as permission to serve.
// Any OTHER read error (I/O, corruption, a locked store) PROPAGATES:
// the first cut of this function caught every error as null, so a
// SQLITE_IOERR on the setting read silently dropped a recorded
// enabled=0 and the JS surfaces failed OPEN while the SQL surfaces
// threw (Codex review, seq 25069). Callers that compose a verdict
// catch the propagation and fail closed; no caller may receive a
// value that reads as "no opt-out" when the read did not happen.
function mirroredReceiptsSetting(db, roomId) {
  let row;
  try {
    row = db.prepare("SELECT enabled FROM room_public_receipts_setting WHERE room_id=?").get(roomId);
  } catch (error) {
    // Only a genuinely absent RELATION is the legacy null above:
    // no recorded setting can exist in a store that predates the
    // mirror. Absence is checked structurally (relationExists),
    // not by error text — a missing or unreadable COLUMN on a
    // present table is not absence (recorded rows may sit behind
    // that column), and neither is a mirror presented as a VIEW:
    // the view is the mirror's presence, readable or not (round
    // 4, seq 25157). Both propagate like any other read error, so
    // the verdict composers fail closed (Codex review,
    // seq 25107/25108).
    if (!relationExists(db, "room_public_receipts_setting")) return null;
    throw error;
  }
  if (!row) return null;
  if (row.enabled === 1 || row.enabled === true) return 1;
  if (row.enabled === 0 || row.enabled === false) return 0;
  return "unknown";
}

// Whether a mirrored setting value records an opt-out for visibility
// purposes: a clean 0, or an uninterpretable recorded value (which
// must not fail open). Mirrors the SQL twin's `enabled IS NOT 1`
// restricted to rooms that HAVE a recorded row.
function mirroredSettingOptsOut(value) {
  return value === 0 || value === "unknown";
}

// The lot rule over a live db: operator unpublish, the recorded opt-in
// consulted at read time from the authoritative record, and the
// owner's directory toggle, composed in one place so the read model
// and any other lot consumer cannot apply different subsets. Mirror
// drift — a stale, missing, or wrongly-polarity
// room_public_receipts_setting row — cannot change the verdict
// wherever the authoritative record can be read (B7-2-F1/F2, B2-4-F1).
// Whether one room's owner recorded the authoritative public-receipts
// opt-out (room.public_receipts_set with enabled:false), read from the
// setting's read-model copy — the same fact the mirror surfaces'
// opt-out leg applies, so the dedicated public-work receipt door and
// the mirror can never disagree about an opt-out. A recorded
// false counts, and so does an uninterpretable recorded value or an
// unreadable setting read (fail closed, seq 25069); never-recorded
// and a genuinely absent mirror table are not an opt-out. The door
// composed the directory toggle alone before (R08-F1).
export function recordedReceiptsOptOut(db, roomId) {
  if (typeof roomId !== "string" || !roomId) return false;
  try {
    return mirroredSettingOptsOut(mirroredReceiptsSetting(db, roomId));
  } catch { return true; } // an unreadable privacy state is private: fail closed
}

export function lotReceiptVisible(db, { id, roomId } = {}) {
  if (typeof id !== "string" || !id || typeof roomId !== "string" || !roomId) return false;
  const unpublished = isUnpublished(db, "receipt", id) || isUnpublished(db, "room", roomId);
  const recorded = recordedReceiptsSetting(db, roomId);
  let settingEnabled = recorded.enabled;
  if (recorded.status === "unavailable") {
    try {
      const mirrored = mirroredReceiptsSetting(db, roomId);
      settingEnabled = mirrored === 1 ? 1 : mirrored === 0 ? 0 : null;
    } catch { settingEnabled = null; } // unreadable mirror: no recorded opt-in, the lot stays private
  }
  const receiptsPrivate = ownerToggleReadable(db) ? roomReceiptsPrivate(db, roomId) : false;
  return lotVisibleFromFacts({ unpublished, settingEnabled, receiptsPrivate });
}
