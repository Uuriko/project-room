// Room mode gate (dev-mode slice 1): whether this server may create lab
// rooms, and how a creation request's `mode` field resolves.
//
// ROOM_LAB_MODE_ENABLED is off unless the env value is exactly "1" — the
// same convention as ROOM_PER_ROOM_OBJECTS (server/room-shard-flag.mjs)
// and the other ROOM_* env flags. Unset, "0" and any other string keep
// every server production-only by default.
//
// Refusal shape: requesting "lab" while the flag is off is refused with
// 422 invalid_room_request — the creation-field refusal both creation
// paths (server/room-lifecycle.mjs, server/agent-rooms.mjs) already use
// for an invalid `kind`. The request is never silently coerced to
// production: a caller who asked for a lab room must learn they got none.
import { ROOM_MODES } from "../src/events.js";
import { ServiceError } from "./service-error.mjs";

export const ROOM_LAB_MODE_ENV = "ROOM_LAB_MODE_ENABLED";

export function roomLabModeEnabled(env = globalThis.process?.env ?? {}) {
  return env?.[ROOM_LAB_MODE_ENV] === "1";
}

// Resolve a creation request's optional mode field to the mode the new
// room is created with. Absent means "production". Throws ServiceError
// 422 invalid_room_request for an unknown value, or for "lab" while the
// flag is off. Mode is creation-only: no caller may invoke this for an
// existing room, and the creation paths compare the resolved mode on
// idempotent replays so a replay cannot flip a room's mode.
export function requestedRoomMode(value, env = globalThis.process?.env ?? {}) {
  if (value === undefined) return "production";
  if (!ROOM_MODES.includes(value)) {
    throw new ServiceError(422, "invalid_room_request", "Room mode must be production or lab");
  }
  if (value === "lab" && !roomLabModeEnabled(env)) {
    throw new ServiceError(422, "invalid_room_request",
      "Lab rooms are not enabled on this server (ROOM_LAB_MODE_ENABLED is off)");
  }
  return value;
}
