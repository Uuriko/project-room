// Panel wrapper for Slice 2 guarded room delete — Path A only
// (MGMT-PANEL PANEL-SPEC v2 §2.4, MF-4: outright delete of a live room is
// NOT built here and is not reachable through this wrapper).
//
// The wrapper rides the generic purge machinery (createOperatorPurge) for a
// single lifecycle-archived room and adds, server-side:
//   G-2  a fresh per-room export on record before execute (pre-forward
//        check only — an export record cannot un-happen, MF-3);
//   G-3  the room is lifecycle-archived (rooms.archived_at verified on the
//        room row, MF-5a) — only that verified state lets the wrapper pass
//        allowActiveMembers to the underlying plan;
//   G-4  exactly one target, and it is the room named in the path;
//   MF-5 the typed confirmation (title + id) is verified against the room
//        row here, before anything is forwarded — never UI-only.
// G-1 (money/proof clearance) is NOT re-implemented here: it lives in
// operator-purge.mjs roomGuards() and binds every caller (MF-1). This
// wrapper surfaces its result in the plan response for display only.

import { validId } from "../src/events.js";
import { ServiceError } from "./service-error.mjs";
import { createOperatorPurge } from "./operator-purge.mjs";

export const EXPORT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const fail = (status, code, message) => { throw new ServiceError(status, code, message); };

function roomRow(store, roomId) {
  if (!validId(roomId)) fail(422, "invalid_room_id", "roomId must be a room id");
  const row = store.db.prepare(
    "SELECT archived_at AS archivedAt, json_extract(projection, '$.room.title') AS title FROM rooms WHERE id=?"
  ).get(roomId);
  if (!row) fail(404, "unknown_target", "No such room");
  return row;
}

// G-3 + MF-5a: returns the verified lifecycle-archived row or refuses.
function archivedRow(store, roomId) {
  const row = roomRow(store, roomId);
  if (row.archivedAt == null) {
    fail(422, "room_not_archived", `Room ${roomId} is not lifecycle-archived. Only a room whose owner has archived it (writes closed) can be purged from the panel`);
  }
  return row;
}

function checkTargetsField(body, roomId) {
  if (body?.targets === undefined) return;
  const targets = body.targets;
  if (!Array.isArray(targets) || targets.length !== 1 || targets[0]?.kind !== "room" || targets[0]?.id !== roomId) {
    fail(422, "invalid_purge", "The panel purge accepts exactly one target: the room named in the path");
  }
}

function latestExportAt(store, roomId) {
  const row = store.db.prepare(
    "SELECT at FROM operator_actions WHERE action='room_export' AND target_kind='room' AND target_id=? AND result='ok' ORDER BY at DESC, id DESC LIMIT 1"
  ).get(roomId);
  return row ? row.at : null;
}

export function createOperatorRoomPurge(store, purge = createOperatorPurge(store)) {
  return {
    plan(roomId, body, requestId) {
      if (!body || Array.isArray(body)) fail(422, "invalid_purge", "Supply a reason");
      checkTargetsField(body, roomId);
      const row = archivedRow(store, roomId);
      // MF-5a: allowActiveMembers is passed ONLY because archived_at was
      // just verified on this room row — the lifecycle archive already
      // closed every write, which is what discharges that guard's purpose.
      const plan = purge.plan(
        { targets: [{ kind: "room", id: roomId }], reason: body.reason, allowActiveMembers: true },
        requestId
      );
      return {
        ...plan,
        title: typeof row.title === "string" && row.title ? row.title : null,
        archivedAt: row.archivedAt,
        moneyProof: "clear",
        exportOnRecordAt: latestExportAt(store, roomId)
      };
    },

    execute(roomId, body, requestId) {
      if (!body || Array.isArray(body)) fail(422, "invalid_purge", "Supply planId, confirmToken, confirmTitle and confirmId");
      const row = archivedRow(store, roomId);
      // MF-5: typed confirmation verified server-side against the room row.
      // The expected title falls back to the id when the room has no title
      // (the shipped UI's own rule); the id is always required as well,
      // because titles are not unique across rooms.
      const expectedTitle = typeof row.title === "string" && row.title ? row.title : roomId;
      if (body.confirmId !== roomId || body.confirmTitle !== expectedTitle) {
        fail(422, "confirmation_mismatch", "Type the room title and the room id exactly as shown to confirm this purge");
      }
      if (body.exportHeld !== undefined && body.exportHeld !== true) {
        fail(422, "confirmation_mismatch", "Confirm that you hold the export file for this room before executing");
      }
      // G-2 (pre-forward only, MF-3): a room_export audit row for this room,
      // result ok, no older than 24 hours.
      const exportedAt = latestExportAt(store, roomId);
      if (exportedAt == null || store.now() - exportedAt > EXPORT_MAX_AGE_MS) {
        fail(409, "export_required", "Export this room from the panel first. Execute needs a room export on record no older than 24 hours");
      }
      if (typeof body.planId !== "string" || typeof body.confirmToken !== "string") {
        fail(422, "invalid_purge", "Supply the planId and confirmToken from the plan");
      }
      return purge.execute({ planId: body.planId, confirmToken: body.confirmToken }, requestId);
    }
  };
}
