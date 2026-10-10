// STORM kill-switch (FIX-66; docs/KILL-SWITCH.md).
//
// "Who holds the global STOP if the control plane goes silent mid-flood?"
// The room owner, and only the room owner — never agents. While engaged,
// every work-claim mutation is refused with 503 kill_switch_engaged;
// reads stay live.
//
// Fail-safe by construction: enforcement state is in-memory only, per room,
// and defaults OFF. It is never persisted — a crashed or restarted server
// always comes back OFF, never stuck ON. Engage/disengage actions are
// recorded as room events (the audit trail); the event log is durable but
// does not drive enforcement.
import { randomUUID } from "node:crypto";
import { EVENT_TYPES, applyEvent, event, isRoomArchived } from "../src/events.js";
import { ServiceError } from "./service-error.mjs";

export const KILL_SWITCH_ENGAGED_CODE = "kill_switch_engaged";
export const KILL_SWITCH_OWNER_CODE = "owner_required";
export const KILL_SWITCH_MESSAGE =
  "The room owner has engaged the work-claim kill switch; claim writes are frozen while it is engaged.";

// In-memory only. A new instance (process restart, new store) is always OFF.
export function createKillSwitchState() {
  const engagedRooms = new Set();
  return {
    isEngaged(roomId) {
      return typeof roomId === "string" && engagedRooms.has(roomId);
    },
    engage(roomId) {
      if (typeof roomId === "string") engagedRooms.add(roomId);
    },
    disengage(roomId) {
      engagedRooms.delete(roomId);
    },
  };
}

// Throwing guard for the non-HTTP claim-mutation paths. The MCP tools call
// the work-claim functions directly, bypassing handleWorkClaims, so each
// agent-reachable mutation entry point enforces the freeze itself.
// Agent-initiated claim mutations freeze while engaged; the room's own
// time-based housekeeping (lease expiry, PR settlement) is not
// agent-initiated and keeps running — leases keep their TTLs.
export function assertKillSwitchOpen(store, roomId) {
  const killSwitch = store?.killSwitch;
  if (killSwitch && killSwitch.isEngaged(roomId)) {
    throw new ServiceError(503, KILL_SWITCH_ENGAGED_CODE, KILL_SWITCH_MESSAGE);
  }
}

// Audit append for engage/disengage. Mirrors emitWorkClaimEvent's append path
// (server/work-claim-events.mjs): the event row and the projection update
// commit inside the caller's transaction. A store without an event log
// (pure-test fixture) records nothing here.
export function appendKillSwitchEvent(store, roomId, { actorId, engaged, reason = null, atMs = null }) {
  if (!store?.db || typeof store.room !== "function") return null;
  const stamp = Number.isFinite(atMs) ? atMs : (typeof store.now === "function" ? store.now() : Date.now());
  const room = store.room(roomId);
  // The event log refuses anything after archive (applyEvent throws). The
  // route refuses engagement on archived rooms first; this is the backstop.
  if (isRoomArchived(room.state)) return null;
  const actor = room.state.members?.[actorId];
  const incoming = event({
    id: randomUUID(),
    idempotencyKey: randomUUID(),
    type: EVENT_TYPES.WORK_CLAIM_KILL_SWITCH_SET,
    actorId: actor && actor.active !== false ? actorId : room.state.room.ownerId,
    roomId,
    at: new Date(stamp).toISOString(),
    data: {
      engaged: engaged === true,
      ...(typeof reason === "string" && reason ? { reason } : {}),
    },
  });
  const state = applyEvent(room.state, incoming);
  const sequence = room.sequence + 1;
  store.db.prepare("INSERT INTO events VALUES(?,?,?,?)").run(roomId, sequence, incoming.id, JSON.stringify(incoming));
  const compact = { ...state, eventLog: [], seenEvents: {}, seenIdempotencyKeys: {} };
  store.db.prepare("UPDATE rooms SET sequence=?, projection=? WHERE id=?").run(sequence, store.storedProjection(roomId, compact), roomId);
  try {
    if (store.agentPlugin) store.agentPlugin.fanoutRoomEvent({ roomId, event: incoming });
  } catch (error) {
    console.error("kill switch fan-out failed:", error?.message ?? error);
  }
  return { sequence, event: incoming };
}
