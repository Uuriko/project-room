// Operator projection repair (guardian census F5, 2026-10-18): the safe
// rebuild path for a room whose stored projection no longer parses — or
// parses to the wrong shape (#4127: hollow states, foreign room ids).
//
// The journal is the source of truth: rooms.projection is a materialization
// the store can rebuild from the retained checkpoint plus the event tail
// (store.rebuildProjection) WITHOUT reading the torn projection. Repair is
// therefore a replace-the-materialization act, never journal surgery:
//   plan    — read-only (plus the audit row): names the torn bytes by
//             digest, proves the replay succeeds, and reports exactly
//             what the rebuilt state carries (members, messages, head).
//   execute — presents the plan's digests; any drift since the plan is a
//             409 plan_changed. Replays again inside the write
//             transaction and replaces only rooms.projection. If the
//             replay throws (torn event body, torn checkpoint, sequence
//             gap) nothing is written — that room's path is the backup
//             restore, and this surface says so instead of improvising.
// Boundaries, deliberately: a projection that parses AND is well-shaped
// is not repaired here (drift between stored and replayed state is the
// recovery audit's reconciliation, server/recovery.mjs); a parseable
// projection with the wrong shape is corruption of the same class as
// unparseable bytes and IS repaired here. Archived rooms keep their
// compacted projection shape and are refused; events and checkpoints are
// never touched. The torn bytes are identified by SHA-256 in the plan, the
// response, and the append-only operator audit — the daily room-backup
// export retains the pre-repair store for byte-level recovery.
// A successful repair also clears the room's patrol park (patrol_blocks):
// the park skipped the room while its head was unchanged, and the head
// does not move here, so without clearing it the repaired room would
// never be re-patrolled. The next natural tick re-patrols from the
// cursor; a room that still throws re-parks fresh and fails loudly once.

import { createHash } from "node:crypto";
import { validId } from "../src/events.js";
import { ServiceError } from "./store.mjs";
import { projectionShapeProblem } from "./projection-at-rest.mjs";
import { appendOperatorAction } from "./operator-actions.mjs";

const fail = (status, code, message) => { throw new ServiceError(status, code, message); };
const sha256 = text => createHash("sha256").update(text).digest("hex");
const errorClassOf = error => {
  const name = typeof error?.name === "string" ? error.name : "";
  return /^[a-z][a-z0-9_]{0,63}$/i.test(name) ? name : "unknown";
};
const errorTextOf = error => String(error?.message ?? error).replace(/\s+/g, " ").trim().slice(0, 240);

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

function rawRoom(store, roomId) {
  return store.db.prepare("SELECT sequence, projection, archived_at FROM rooms WHERE id=?").get(roomId) ?? null;
}

function patrolPark(store, roomId) {
  if (!tableExists(store.db, "patrol_blocks")) return null;
  const row = store.db.prepare("SELECT sequence, event_id, head_seq, error_class, error, blocked_at FROM patrol_blocks WHERE room_id=?").get(roomId);
  return row ? { sequence: row.sequence, eventId: row.event_id, headSeq: row.head_seq, errorClass: row.error_class, error: row.error, blockedAt: row.blocked_at } : null;
}

// The shared read model behind plan and execute's pre-checks. Pure reads.
function diagnose(store, roomId) {
  const raw = rawRoom(store, roomId);
  if (!raw) fail(404, "room_not_found", "Room not found");
  const projection = typeof raw.projection === "string" ? raw.projection : "";
  const digest = sha256(projection);
  let parse = { ok: false, errorClass: null };
  let parsedState = null;
  try {
    parsedState = JSON.parse(projection);
    parse = { ok: Boolean(parsedState && typeof parsedState === "object"), errorClass: null };
  } catch (error) {
    parse = { ok: false, errorClass: errorClassOf(error) };
  }
  // #4127: repairability covers shape failures, not only parse failures —
  // the same shared validator the read path enforces.
  const shapeProblem = parse.ok ? projectionShapeProblem(parsedState, roomId) : null;
  const events = store.db.prepare("SELECT count(*) AS n FROM events WHERE room_id=?").get(roomId).n;
  let replay = { ok: false, errorClass: null, error: null };
  try {
    // The boundary is passed explicitly: rebuildProjection's default
    // resolves it through store.room(), which parses the very projection
    // under repair and would throw before the replay starts.
    const rebuilt = store.rebuildProjection(roomId, raw.sequence);
    const state = rebuilt.state ?? {};
    replay = {
      ok: true,
      sequence: rebuilt.sequence,
      members: state.members && typeof state.members === "object" ? Object.keys(state.members).length : 0,
      messages: Array.isArray(state.messages) ? state.messages.length : 0,
      rebuiltSha256: sha256(store.storedProjection(roomId, state)),
      errorClass: null,
      error: null
    };
  } catch (error) {
    replay = { ok: false, errorClass: errorClassOf(error), error: errorTextOf(error) };
  }
  const archived = raw.archived_at != null;
  return {
    roomId,
    sequence: raw.sequence,
    events,
    archived,
    stored: { bytes: Buffer.byteLength(projection), sha256: digest, parses: parse.ok, parseErrorClass: parse.errorClass, shapeProblem },
    replay,
    park: patrolPark(store, roomId),
    repairable: (!parse.ok || Boolean(shapeProblem)) && !archived && replay.ok,
    executeGuard: { expectedSha256: digest, expectedSequence: raw.sequence }
  };
}

export function planProjectionRepair(store, input = {}, requestId = null) {
  const roomId = typeof input.roomId === "string" ? input.roomId : "";
  if (!validId(roomId)) fail(422, "invalid_room", "roomId is required");
  const plan = diagnose(store, roomId);
  appendOperatorAction(store, {
    action: "projection_repair.plan",
    targetKind: "room",
    targetId: roomId,
    reason: typeof input.reason === "string" ? input.reason.slice(0, 240) : null,
    planHash: plan.stored.sha256,
    counts: { sequence: plan.sequence, events: plan.events, storedBytes: plan.stored.bytes, repairable: plan.repairable },
    result: plan.repairable ? "repairable" : "not_repairable",
    requestId
  });
  return plan;
}

export function executeProjectionRepair(store, input = {}, requestId = null) {
  const roomId = typeof input.roomId === "string" ? input.roomId : "";
  if (!validId(roomId)) fail(422, "invalid_room", "roomId is required");
  const expectedSha256 = typeof input.expectedSha256 === "string" ? input.expectedSha256 : "";
  const expectedSequence = input.expectedSequence;
  if (!/^[a-f0-9]{64}$/.test(expectedSha256) || !Number.isSafeInteger(expectedSequence)) {
    fail(422, "invalid_plan", "expectedSha256 and expectedSequence from the repair plan are required");
  }
  const auditRefusal = (code, counts = {}) => appendOperatorAction(store, {
    action: "projection_repair.execute",
    targetKind: "room",
    targetId: roomId,
    reason: typeof input.reason === "string" ? input.reason.slice(0, 240) : null,
    planHash: expectedSha256,
    counts,
    result: `refused:${code}`,
    requestId
  });
  let outcome;
  try {
    outcome = store.transaction(() => {
      const raw = rawRoom(store, roomId);
      if (!raw) fail(404, "room_not_found", "Room not found");
      const projection = typeof raw.projection === "string" ? raw.projection : "";
      const digest = sha256(projection);
      if (digest !== expectedSha256 || raw.sequence !== expectedSequence) {
        fail(409, "plan_changed", "The stored projection or room head moved since the plan; re-plan before repairing");
      }
      // #4127: "parses" alone is not "sound" — well-formed JSON with the
      // wrong shape is the same class of corruption. Only a projection
      // that parses AND is well-shaped is refused here.
      let shapeProblem = "unparseable";
      try {
        const state = JSON.parse(projection);
        shapeProblem = state && typeof state === "object" ? projectionShapeProblem(state, roomId) : "not_an_object";
      } catch { /* shapeProblem stays "unparseable" */ }
      if (!shapeProblem) fail(422, "not_corrupt", "The stored projection parses and is well-shaped; drift reconciliation belongs to the recovery audit, not this repair");
      if (raw.archived_at != null) fail(422, "repair_unsupported", "Archived rooms keep a compacted projection shape; repair runs through the archive path");
      // Replay BEFORE any write, inside the transaction: a throw here
      // aborts with nothing written (the torn-journal case — the backup
      // restore is that room's path, named in the plan's replay error).
      // Explicit boundary, as in diagnose: the default reads the torn
      // projection to find the head.
      const rebuilt = store.rebuildProjection(roomId, raw.sequence);
      const serialized = store.storedProjection(roomId, rebuilt.state);
      JSON.parse(serialized);
      const written = store.db.prepare("UPDATE rooms SET projection=? WHERE id=? AND sequence=?").run(serialized, roomId, raw.sequence);
      if (written.changes !== 1) fail(409, "plan_changed", "The room head moved during repair; nothing was written");
      store._projectionCache?.clear?.();
      let parkCleared = false;
      if (tableExists(store.db, "patrol_blocks")) {
        parkCleared = store.db.prepare("DELETE FROM patrol_blocks WHERE room_id=?").run(roomId).changes > 0;
      }
      const state = rebuilt.state ?? {};
      return {
        roomId,
        sequence: raw.sequence,
        events: store.db.prepare("SELECT count(*) AS n FROM events WHERE room_id=?").get(roomId).n,
        members: state.members && typeof state.members === "object" ? Object.keys(state.members).length : 0,
        messages: Array.isArray(state.messages) ? state.messages.length : 0,
        before: { bytes: Buffer.byteLength(projection), sha256: digest },
        after: { bytes: Buffer.byteLength(serialized), sha256: sha256(serialized) },
        parkCleared
      };
    });
  } catch (error) {
    auditRefusal(error?.code ?? errorClassOf(error), { sequence: expectedSequence });
    throw error;
  }
  appendOperatorAction(store, {
    action: "projection_repair.execute",
    targetKind: "room",
    targetId: roomId,
    reason: typeof input.reason === "string" ? input.reason.slice(0, 240) : null,
    planHash: expectedSha256,
    counts: { sequence: outcome.sequence, events: outcome.events, members: outcome.members, messages: outcome.messages, beforeBytes: outcome.before.bytes, afterBytes: outcome.after.bytes, parkCleared: outcome.parkCleared },
    result: "repaired",
    requestId
  });
  return outcome;
}
