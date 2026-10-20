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
//             AND NOT internal-room
//             AND (for a public-work row) a verification fact is recorded
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
// Internal-room (PROOF-WALL-FLIP): any room the receipt belongs to (the
// same room set as the owner leg) is recorded internal in
// internal_rooms — the mirror of the room owner's room.internal_set
// record, which marks the room as the platform team's own traffic
// (drills, QA, fleet coordination). Internal rooms' receipts are real
// records, kept in-room; they never exhibit on public proof surfaces.
// Absent mirror row = not internal: only a recorded marking hides, so
// no stranger's room can be mislabelled by inference.
//
// Public-work verification fact (PROOF-WALL-FLIP, enforcing #3636
// Option 1 at the read): a public-work receipt's fact arrives after
// projection, through the review path, so it is enforced here rather
// than in the projector. A public-work row serves only when its own
// records carry a fact: the receipt record stamped verified, or its
// verification tier system_checked, or a review record carrying a
// decision state (accepted / rejected / revision_requested), or a
// PASS/FAIL verification verdict. A merely submitted, hash-only,
// unreviewed record has no fact and stays in-room. The other sources
// enforce the same rule at projection (work-claim: a recorded
// verification tier; work-item: a recorded reporter), so this leg
// applies to source = 'public-work' only.
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
//             AND NOT internal-room (the room recorded internal above;
//                 the settlement verdict is the lot's verification
//                 fact, so no further fact leg applies)
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

// Internal-room leg: a recorded internal marking on any of the
// receipt's rooms (the read model's internal_rooms mirror of the
// owner's room.internal_set record).
export const INTERNAL_HIDDEN_RECEIPT_SQL = `NOT EXISTS (
  SELECT 1 FROM internal_rooms i
  WHERE i.enabled = 1
    AND (i.room_id = public_receipts.origin_room_id
         OR i.room_id = public_receipts.room_id
         OR i.room_id IN (
           SELECT pwt.room_id FROM public_work_receipts pwr
           JOIN public_work_tasks pwt ON pwt.offer_id = pwr.offer_id
           WHERE pwr.receipt_id = public_receipts.id)))`;

// The internal leg without the task-record resolution, for stores that
// predate the public-work tables (same degradation as the owner leg).
export const INTERNAL_HIDDEN_ORIGIN_RECEIPT_SQL = `NOT EXISTS (
  SELECT 1 FROM internal_rooms i
  WHERE i.enabled = 1
    AND (i.room_id = public_receipts.origin_room_id
         OR i.room_id = public_receipts.room_id))`;

export function internalHiddenReceiptSql({ taskRoomLeg = true } = {}) {
  return taskRoomLeg ? INTERNAL_HIDDEN_RECEIPT_SQL : INTERNAL_HIDDEN_ORIGIN_RECEIPT_SQL;
}

// Public-work verification-fact leg (see the rule above): the row's own
// records must carry a fact. The full form reads the review record as
// well as the receipt record; the records-only form is for stores
// predating the reviews table, whose receipts can only carry the fact
// on the receipt record itself.
export const PUBLIC_WORK_FACT_RECEIPT_SQL = `(public_receipts.source <> 'public-work' OR EXISTS (
  SELECT 1 FROM public_work_receipts pwr
  WHERE pwr.receipt_id = public_receipts.id
    AND (json_extract(pwr.receipt_json, '$.state') = 'verified'
         OR json_extract(pwr.receipt_json, '$.verification') = 'system_checked')
) OR EXISTS (
  SELECT 1 FROM public_work_reviews rev
  WHERE rev.receipt_id = public_receipts.id
    AND (json_extract(rev.state_json, '$.state') IN ('accepted', 'rejected', 'revision_requested')
         OR json_extract(rev.state_json, '$.verification.verdict') IN ('PASS', 'FAIL'))
))`;

export const PUBLIC_WORK_FACT_RECORDS_RECEIPT_SQL = `(public_receipts.source <> 'public-work' OR EXISTS (
  SELECT 1 FROM public_work_receipts pwr
  WHERE pwr.receipt_id = public_receipts.id
    AND (json_extract(pwr.receipt_json, '$.state') = 'verified'
         OR json_extract(pwr.receipt_json, '$.verification') = 'system_checked')
))`;

export function publicWorkFactReceiptSql(level = "full") {
  if (level === "full") return PUBLIC_WORK_FACT_RECEIPT_SQL;
  if (level === "records") return PUBLIC_WORK_FACT_RECORDS_RECEIPT_SQL;
  return null;
}

// The composed SQL predicate over a public_receipts row. publicWorkFact
// is "full" | "records" | "none": the composed-for-a-store form below
// probes which of the fact leg's tables can be read and picks the level;
// "none" (the default for direct callers) omits the leg, as a store with
// no readable public_work_receipts has no fact records to consult.
export function receiptVisibilitySql({ ownerToggle = true, taskRoomLeg = true, internalLeg = true, publicWorkFact = "none" } = {}) {
  const legs = [OPERATOR_HIDDEN_RECEIPT_SQL];
  if (ownerToggle) legs.push(ownerHiddenReceiptSql({ taskRoomLeg }));
  if (internalLeg) legs.push(internalHiddenReceiptSql({ taskRoomLeg }));
  const fact = publicWorkFactReceiptSql(publicWorkFact);
  if (fact) legs.push(fact);
  return legs.join(" AND ");
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

// Whether the internal_rooms mirror can be read here. The mirror ships
// in the read model's own schema, so a store that has public_receipts
// through the current code has it; a store predating it has no recorded
// internal rooms by definition, so the leg applies only where readable.
export function internalRoomsReadable(db) {
  try {
    db.prepare("SELECT room_id, enabled FROM internal_rooms LIMIT 0").all();
    return true;
  } catch (error) {
    if (!/no such (column|table)/i.test(error?.message ?? "")) throw error;
    return false;
  }
}

// Whether the receipt records the fact leg reads can be read here.
export function publicWorkReceiptsReadable(db) {
  try {
    db.prepare("SELECT receipt_id, receipt_json FROM public_work_receipts LIMIT 0").all();
    return true;
  } catch (error) {
    if (!/no such (column|table)/i.test(error?.message ?? "")) throw error;
    return false;
  }
}

// Whether the review records the fact leg reads can be read here.
export function publicWorkReviewsReadable(db) {
  try {
    db.prepare("SELECT receipt_id, state_json FROM public_work_reviews LIMIT 0").all();
    return true;
  } catch (error) {
    if (!/no such (column|table)/i.test(error?.message ?? "")) throw error;
    return false;
  }
}

// The composed predicate for a concrete store, with every schema probe
// applied — the form consumers use.
export function receiptVisibilitySqlFor(db) {
  return receiptVisibilitySql({
    ownerToggle: ownerToggleReadable(db),
    taskRoomLeg: publicWorkTablesReadable(db),
    internalLeg: internalRoomsReadable(db),
    publicWorkFact: !publicWorkReceiptsReadable(db) ? "none"
      : publicWorkReviewsReadable(db) ? "full" : "records",
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
export function receiptVisibleFromFacts({ unpublished = false, receiptsPrivate = false, internalRoom = false, missingVerificationFact = false } = {}) {
  return !unpublished && !receiptsPrivate && !internalRoom && !missingVerificationFact;
}

export function lotVisibleFromFacts({ unpublished = false, settingEnabled = null, receiptsPrivate = false, internalRoom = false } = {}) {
  if (unpublished) return false;
  if (internalRoom) return false;
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
      rows = db.prepare(`SELECT pr.id AS id, pr.room_id AS roomId, pr.origin_room_id AS origin, pwt.room_id AS taskRoom, pr.source AS source
        FROM public_receipts pr
        LEFT JOIN public_work_receipts pwr ON pwr.receipt_id = pr.id
        LEFT JOIN public_work_tasks pwt ON pwt.offer_id = pwr.offer_id
        WHERE pr.id IN (SELECT value FROM json_each(?))`).all(idList);
    } catch {
      rows = db.prepare(`SELECT id, room_id AS roomId, origin_room_id AS origin, NULL AS taskRoom, source
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
  // The internal-room leg, only where the mirror can be read; a room is
  // internal only on a recorded enabled = 1 marking.
  const internalRooms = new Set();
  if (internalRoomsReadable(db)) {
    const candidates = new Set();
    for (const row of rowsById.values()) {
      if (row.taskRoom) candidates.add(row.taskRoom);
      if (row.roomId) candidates.add(row.roomId);
      if (row.origin) candidates.add(row.origin);
    }
    if (candidates.size) {
      try {
        for (const row of db.prepare(`SELECT room_id FROM internal_rooms
            WHERE enabled = 1 AND room_id IN (SELECT value FROM json_each(?))`).all(JSON.stringify([...candidates]))) {
          internalRooms.add(row.room_id);
        }
      } catch { return new Set(receiptIds); } // readable a moment ago, unreadable now: fail closed
    }
  }
  // The public-work fact leg: a public-work row whose own records carry
  // no verification fact is hidden. Applies only where the receipt
  // records can be read (the composed SQL form probes the same way);
  // the review record counts only where it can be read.
  const factless = new Set();
  const pwrIds = [...rowsById.values()].filter(row => row.source === "public-work").map(row => row.id);
  if (pwrIds.length && publicWorkReceiptsReadable(db)) {
    const withFact = new Set();
    try {
      for (const row of db.prepare(`SELECT receipt_id, receipt_json FROM public_work_receipts
          WHERE receipt_id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(pwrIds))) {
        let record = null;
        try { record = JSON.parse(row.receipt_json); } catch { record = null; }
        if (record && (record.state === "verified" || record.verification === "system_checked")) withFact.add(row.receipt_id);
      }
      if (publicWorkReviewsReadable(db)) {
        for (const row of db.prepare(`SELECT receipt_id, state_json FROM public_work_reviews
            WHERE receipt_id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(pwrIds))) {
          let saved = null;
          try { saved = JSON.parse(row.state_json); } catch { saved = null; }
          if (saved && (["accepted", "rejected", "revision_requested"].includes(saved.state)
            || ["PASS", "FAIL"].includes(saved.verification?.verdict))) withFact.add(row.receipt_id);
        }
      }
    } catch { return new Set(receiptIds); } // a fact check that cannot run hides the rows it covers
    for (const id of pwrIds) if (!withFact.has(id)) factless.add(id);
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
    const rooms = [row.taskRoom, row.roomId, row.origin].filter(Boolean);
    if (rooms.some(roomId => internalRooms.has(roomId))) hidden.add(id);
    if (factless.has(id)) hidden.add(id);
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
// the owner's directory toggle, and the internal-room marking, composed
// in one place so the read model and any other lot consumer cannot
// apply different subsets.
export function lotReceiptVisible(db, { id, roomId } = {}) {
  if (typeof id !== "string" || !id || typeof roomId !== "string" || !roomId) return false;
  const unpublished = isUnpublished(db, "receipt", id) || isUnpublished(db, "room", roomId);
  let settingEnabled = null;
  try {
    const row = db.prepare("SELECT enabled FROM room_public_receipts_setting WHERE room_id=?").get(roomId);
    settingEnabled = row ? row.enabled : null;
  } catch { settingEnabled = null; } // a store that cannot answer recorded no opt-in
  const receiptsPrivate = ownerToggleReadable(db) ? roomReceiptsPrivate(db, roomId) : false;
  // The internal-room leg: a store predating the mirror has no recorded
  // internal rooms, so an unreadable mirror reads as not internal.
  let internalRoom = false;
  try {
    const row = db.prepare("SELECT enabled FROM internal_rooms WHERE room_id=?").get(roomId);
    internalRoom = row ? row.enabled === 1 : false;
  } catch { internalRoom = false; }
  return lotVisibleFromFacts({ unpublished, settingEnabled, receiptsPrivate, internalRoom });
}
