// Operator door for the room message archive (projection cap relief).
//
// archiveMessages (server/messages-store.mjs) has existed since MSG-3 but
// nothing outside tests called it, so a room nearing PILOT_LIMITS.projectionBytes
// had no way to free space. This is the one caller: operator-only, dry run by
// default, a real run only against the counts of a dry run (409 plan_changed
// when they moved), and an operator_actions audit row for every call.
//
// Archive needs the room's messages table certified at the room's current
// head. The deferred integrity job certifies one room per visit and the next
// event in that room voids it, so on a busy room the bare call would refuse
// almost always. The door therefore catches the room's messages table up and
// certifies that room itself, synchronously, immediately before archiving:
// no other request can land between the certification and the archive.

import { ServiceError } from "./service-error.mjs";
import { validId } from "../src/events.js";
import { appendOperatorAction } from "./operator-actions.mjs";
import { certifyRoomMessagesAtHead, ARCHIVE_CERTIFY_BUDGET_MS } from "./messages-store.mjs";

export const ARCHIVE_DEFAULT_KEEP = 2000;
export const ARCHIVE_MIN_KEEP = 100;
export const ARCHIVE_MAX_KEEP = 100_000;
const FIELDS = new Set(["roomId", "keepNewest", "dryRun", "reason", "expect", "belowCursor"]);
// The catch-up that certifies a room before archiving is bounded by calls
// and by events, not by the wall clock alone (inside a Durable Object
// Date.now() advances only across I/O, and the backfill is synchronous
// SQLite work). The bounded loop itself lives in messages-store.mjs
// (certifyRoomMessagesAtHead), shared with the messages-archive job; this
// is the per-call event budget this door passes to it. A room further
// behind is caught up by repeating the dry run, which keeps every
// committed chunk (409 backfill_not_caught_up, then call again).
export const CATCH_UP_EVENT_CAP = 4_000;

const fail = (status, code, message) => { throw new ServiceError(status, code, message); };

function projectionBytes(db, roomId) {
  return db.prepare("SELECT length(CAST(projection AS BLOB)) AS bytes FROM rooms WHERE id=?").get(roomId)?.bytes ?? 0;
}

function parse(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail(422, "invalid_archive_request", "Send a JSON object with roomId and reason");
  for (const key of Object.keys(input)) if (!FIELDS.has(key)) fail(422, "invalid_archive_request", `Unknown field: ${String(key).slice(0, 40)}`);
  const { roomId } = input;
  if (!validId(roomId)) fail(422, "invalid_room_id", "roomId must be a room id");
  const keepNewest = input.keepNewest ?? ARCHIVE_DEFAULT_KEEP;
  if (!Number.isInteger(keepNewest) || keepNewest < ARCHIVE_MIN_KEEP || keepNewest > ARCHIVE_MAX_KEEP) {
    fail(422, "invalid_keep_newest", `keepNewest must be an integer from ${ARCHIVE_MIN_KEEP} to ${ARCHIVE_MAX_KEEP}`);
  }
  const dryRun = input.dryRun ?? true;
  if (typeof dryRun !== "boolean") fail(422, "invalid_archive_request", "dryRun must be true or false");
  const belowCursor = input.belowCursor ?? false;
  if (typeof belowCursor !== "boolean") fail(422, "invalid_archive_request", "belowCursor must be true or false");
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (!reason || reason.length > 200) fail(422, "reason_required", "Give a reason of 1 to 200 characters");
  let expect = null;
  if (dryRun) {
    if (input.expect !== undefined) fail(422, "invalid_archive_request", "expect is for a real run (dryRun: false)");
  } else {
    expect = input.expect;
    if (!expect || typeof expect !== "object" || Array.isArray(expect)
      || !Number.isInteger(expect.archived) || !Number.isInteger(expect.throughSeq)
      || Object.keys(expect).some(key => key !== "archived" && key !== "throughSeq")) {
      fail(422, "dry_run_required", "A real run needs expect: { archived, throughSeq } from a dry run of the same room and keepNewest");
    }
  }
  return { roomId, keepNewest, dryRun, reason, expect, belowCursor };
}

export function operatorArchive(store, input, requestId = null, { clock = () => Date.now(), eventCap = CATCH_UP_EVENT_CAP } = {}) {
  if (!Number.isInteger(eventCap) || eventCap < 1) throw new TypeError("eventCap must be a positive integer");
  if (store?.readOnly) fail(409, "read_only", "This store is read-only");
  const request = parse(input);
  const { roomId, keepNewest, dryRun, reason, expect, belowCursor } = request;
  if (!store.db.prepare("SELECT 1 FROM rooms WHERE id=?").get(roomId)) fail(404, "room_not_found", "Room not found");
  const audit = (result, counts) => appendOperatorAction(store, {
    action: dryRun ? "messages_archive_plan" : "messages_archive",
    targetKind: "room", targetId: roomId, reason, counts: { keepNewest, ...(belowCursor ? { belowCursor } : {}), ...counts }, result, requestId
  });
  const before = projectionBytes(store.db, roomId);
  // belowCursor (a room parked behind its head): no catch-up, which would
  // re-run the parked backfill; the archive itself plans only below the
  // cursor and keeps every message a later event names.
  const certified = belowCursor ? { ok: true } : certifyRoomMessagesAtHead(store, roomId, { deadline: clock() + ARCHIVE_CERTIFY_BUDGET_MS, eventCap });
  if (!certified.ok) {
    audit("refused", { detail: certified.detail, projectionBytes: before });
    fail(409, "archive_not_ready", `The room's messages table could not be certified at its head (${certified.detail}); nothing was archived`);
  }
  const plan = store.archiveMessages(roomId, { keepNewest, dryRun: true, belowCursor });
  if (!plan.ok) {
    audit("refused", { detail: plan.reason, projectionBytes: before });
    fail(409, "archive_not_ready", `Archive refused (${plan.reason}); nothing was archived`);
  }
  if (!dryRun && (plan.archived !== expect.archived || plan.throughSeq !== expect.throughSeq)) {
    audit("plan_changed", { archived: plan.archived, throughSeq: plan.throughSeq, expected: expect });
    fail(409, "plan_changed", "The archive plan changed since the dry run; run the dry run again and send its archived and throughSeq");
  }
  const done = dryRun ? plan : store.archiveMessages(roomId, { keepNewest, dryRun: false, belowCursor });
  if (!done.ok) {
    audit("refused", { detail: done.reason, projectionBytes: before });
    fail(409, "archive_not_ready", `Archive refused (${done.reason}); nothing was archived`);
  }
  const after = projectionBytes(store.db, roomId);
  const counts = { archived: done.archived, retained: done.retained, freedBytes: done.freedBytes, throughSeq: done.throughSeq,
    ...(belowCursor ? { cursorSeq: done.cursorSeq, touchedKept: done.touchedKept } : {}), projectionBytes: { before, after } };
  audit("ok", counts);
  return { ok: true, roomId, dryRun, keepNewest, ...counts, expect: { archived: done.archived, throughSeq: done.throughSeq } };
}
