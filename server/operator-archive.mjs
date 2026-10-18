// P0-6: the operator (owner-only) half of messages archival. Mounted from
// server/operator-routes.mjs under the same operator-token gate as purge,
// status, and drift: no configured token, no surface; a wrong or missing
// token answers the same 404 as an unknown path. This module only runs
// after that gate has passed.
//
// POST /api/operator/messages/archive { roomId, keepNewest?, live? }
//   Default (live omitted or false): a dry-run report for the named room —
//   what WOULD move (message count, bytes, oldest/newest timestamps,
//   resulting projection size) against the room's current size and the
//   70%-of-cap trigger. Nothing moves.
//   live:true is the explicit opt-in that performs the archival in the
//   same request. It is never the default, and the job's live mode is a
//   separate env opt-in — shipping this route performs no live run.
//
// Every call writes an operator audit row (ids and counts only, never
// message bodies), following operator-purge's pattern.

import { validId } from "../src/events.js";
import { ServiceError } from "./store.mjs";
import { appendOperatorAction } from "./operator-actions.mjs";
import { archiveRoomMessages } from "./messages-store.mjs";
import {
  ARCHIVE_MIN_KEEP_NEWEST, archiveDryRunReport, archiveTriggerBytes
} from "./messages-archive.mjs";
import { PILOT_LIMITS } from "./store.mjs";

const fail = (status, code, message) => { throw new ServiceError(status, code, message); };

function parseBody(body) {
  if (!body || Array.isArray(body) || typeof body !== "object") {
    fail(422, "invalid_archive", "Supply a roomId; live:true performs the archival, anything else is a dry run");
  }
  const allowed = new Set(["roomId", "keepNewest", "live"]);
  if (Object.keys(body).some(key => !allowed.has(key))) {
    fail(422, "invalid_archive", "Only roomId, keepNewest, and live are accepted");
  }
  if (typeof body.roomId !== "string" || !validId(body.roomId)) {
    fail(422, "invalid_archive", "roomId must be a valid room id");
  }
  if (body.keepNewest != null && (!Number.isInteger(body.keepNewest) || body.keepNewest < 1)) {
    fail(422, "invalid_archive", "keepNewest must be a positive integer");
  }
  if (body.live != null && typeof body.live !== "boolean") {
    fail(422, "invalid_archive", "live must be true or false");
  }
  return {
    roomId: body.roomId,
    keepNewest: body.keepNewest ?? null,
    live: body.live === true
  };
}

function audit(store, row) {
  appendOperatorAction(store, row);
}

export function createOperatorArchive(store) {
  return {
    archive(body, requestId) {
      const base = { action: "messages_archive", requestId, targetKind: "room" };
      let parsed = null;
      try {
        parsed = parseBody(body);
        const { roomId, live } = parsed;
        if (!store.db.prepare("SELECT 1 FROM rooms WHERE id=?").get(roomId)) {
          fail(404, "unknown_target", "No such room");
        }
        if (!live) {
          // Explicit keepNewest: report archiveRoomMessages' own dry-run
          // plan for exactly that cut, plus the trigger context. Without
          // one: the target-seeking report the job also produces.
          const report = parsed.keepNewest != null
            ? explicitDryRun(store, roomId, parsed.keepNewest)
            : archiveDryRunReport(store, roomId);
          audit(store, {
            ...base, targetId: roomId, result: "dry_run",
            counts: {
              dryRun: true,
              wouldArchive: report.wouldArchive ?? report.plan?.archived ?? 0,
              projectionBytes: report.projectionBytes ?? null,
              overTrigger: report.overTrigger ?? null
            }
          });
          return report;
        }
        const keepNewest = parsed.keepNewest ?? defaultLiveKeepNewest(store, roomId);
        const result = archiveRoomMessages(store, roomId, { keepNewest, dryRun: false });
        audit(store, {
          ...base, targetId: roomId, result: result.ok ? "archived" : (result.reason ?? "error"),
          counts: {
            dryRun: false, keepNewest,
            archived: result.archived ?? 0, freedBytes: result.freedBytes ?? 0
          }
        });
        return { ...result, roomId, live: true };
      } catch (error) {
        audit(store, {
          ...base, targetId: parsed?.roomId ?? null,
          result: error.code || "error"
        });
        throw error;
      }
    }
  };
}

// Dry-run for an operator-named cut: archiveRoomMessages' plan, wrapped in
// the same trigger context as the target-seeking report.
function explicitDryRun(store, roomId, keepNewest) {
  const plan = store.archiveMessages(roomId, { keepNewest, dryRun: true });
  const capBytes = PILOT_LIMITS.projectionBytes;
  const projectionBytes = plan.projectionBytesBefore ?? null;
  return {
    ok: plan.ok, roomId, dryRun: true, live: false,
    projectionBytes, capBytes, triggerBytes: archiveTriggerBytes(capBytes),
    overTrigger: projectionBytes != null ? projectionBytes >= archiveTriggerBytes(capBytes) : null,
    keepNewest, wouldArchive: plan.archived ?? 0, plan
  };
}

// Live without a named cut keeps the trigger-seeking plan's keepNewest, so
// the room lands at or below the target share of the cap.
function defaultLiveKeepNewest(store, roomId) {
  const report = archiveDryRunReport(store, roomId);
  return report.keepNewest ?? ARCHIVE_MIN_KEEP_NEWEST;
}
