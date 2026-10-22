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
//             AND the room's recorded public-receipts setting is ON
//                 (room_public_receipts_setting.enabled = 1 — a settled
//                 lot is public only with the owner's recorded opt-in,
//                 #3594: never-recorded, recorded-off, and unreadable
//                 are all private)
//             AND NOT owner-hidden (the directory toggle above)
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

// The composed SQL predicate over a public_receipts row.
export function receiptVisibilitySql({ ownerToggle = true, taskRoomLeg = true } = {}) {
  return ownerToggle
    ? `${OPERATOR_HIDDEN_RECEIPT_SQL} AND ${ownerHiddenReceiptSql({ taskRoomLeg })}`
    : OPERATOR_HIDDEN_RECEIPT_SQL;
}

// Whether the public-work tables the task leg reads can be read here.
export function publicWorkTablesReadable(db) {
  try {
    db.prepare("SELECT receipt_id, offer_id FROM public_work_receipts LIMIT 0").all();
    db.prepare("SELECT offer_id, room_id FROM public_work_tasks LIMIT 0").all();
    return true;
  } catch (error) {
    if (!/no such (column|table)/i.test(error?.message ?? "")) throw error;
    return false;
  }
}

// The composed predicate for a concrete store, with both schema probes
// applied — the form consumers use.
export function receiptVisibilitySqlFor(db) {
  return receiptVisibilitySql({
    ownerToggle: ownerToggleReadable(db),
    taskRoomLeg: publicWorkTablesReadable(db),
  });
}

// A legacy store whose settings table predates the toggle column has no
// private rooms by definition, so the owner leg applies only where the
// column can be read.
export function ownerToggleReadable(db) {
  try {
    db.prepare("SELECT public_receipts FROM room_directory_settings LIMIT 0").all();
    return true;
  } catch (error) {
    if (!/no such (column|table)/i.test(error?.message ?? "")) throw error;
    return false;
  }
}

// Pure-data forms of the two rules, for consumers that work from plain
// row values rather than a live db (the dataset packager's U5 filter
// reads snapshot tables). lotReceiptVisible/receiptVisible below are
// these functions over facts read from the db; a snapshot consumer that
// derives the same facts must reach the same verdicts — that parity is
// the U5 obligation, pinned by the conformance corpus.
export function receiptVisibleFromFacts({ unpublished = false, receiptsPrivate = false } = {}) {
  return !unpublished && !receiptsPrivate;
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
  const unpublishedReceipts = new Set();
  const unpublishedRooms = new Set();
  try {
    rowsById = new Map();
    // The task-room resolution joins the public-work tables; a store
    // predating them has no task records, so the join's absence degrades
    // to the origin room alone rather than failing the whole check.
    let rows;
    try {
      rows = db.prepare(`SELECT pr.id AS id, pr.room_id AS roomId, pr.origin_room_id AS origin, pwt.room_id AS taskRoom
        FROM public_receipts pr
        LEFT JOIN public_work_receipts pwr ON pwr.receipt_id = pr.id
        LEFT JOIN public_work_tasks pwt ON pwt.offer_id = pwr.offer_id
        WHERE pr.id IN (SELECT value FROM json_each(?))`).all(idList);
    } catch {
      rows = db.prepare(`SELECT id, room_id AS roomId, origin_room_id AS origin, NULL AS taskRoom
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
  for (const id of receiptIds) {
    const row = rowsById.get(id);
    if (!row || unpublishedReceipts.has(id)) { hidden.add(id); continue; }
    if ((row.roomId && unpublishedRooms.has(row.roomId)) || (row.origin && unpublishedRooms.has(row.origin))) {
      hidden.add(id);
      continue;
    }
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

// The lot rule over a live db: operator unpublish, the recorded opt-in,
// and the owner's directory toggle, composed in one place so the read
// model and any other lot consumer cannot apply different subsets.
export function lotReceiptVisible(db, { id, roomId } = {}) {
  if (typeof id !== "string" || !id || typeof roomId !== "string" || !roomId) return false;
  const unpublished = isUnpublished(db, "receipt", id) || isUnpublished(db, "room", roomId);
  let settingEnabled = null;
  try {
    const row = db.prepare("SELECT enabled FROM room_public_receipts_setting WHERE room_id=?").get(roomId);
    settingEnabled = row ? row.enabled : null;
  } catch { settingEnabled = null; } // a store that cannot answer recorded no opt-in
  const receiptsPrivate = ownerToggleReadable(db) ? roomReceiptsPrivate(db, roomId) : false;
  return lotVisibleFromFacts({ unpublished, settingEnabled, receiptsPrivate });
}
