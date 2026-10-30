// Room mode gate (dev-mode slice 1): whether this server may create lab
// rooms, and how a creation request's `mode` field resolves.
//
// ROOM_LAB_MODE_ENABLED is off unless the env value is exactly "1" — the
// same convention as ROOM_PER_ROOM_OBJECTS (server/room-shard-flag.mjs)
// and the other ROOM_* env flags. Unset, "0" and any other string keep
// every server production-only by default.
//
// The arm is read through the store's feature-env bag when the store
// carries one (the collisionAlertsEnabled / project-map featureEnv
// pattern): cloudflare/room.mjs sets `store.featureEnv` to the Worker
// bindings, because service code cannot assume process.env carries them.
// roomModeEnv(store) below mirrors featureEnv(store) in
// server/project-map-store.mjs — a store with an own object `featureEnv`
// uses that bag outright; every other store falls back to process.env.
//
// Refusal shape: requesting "lab" while the flag is off is refused with
// 422 invalid_room_request — the creation-field refusal both creation
// paths (server/room-lifecycle.mjs, server/agent-rooms.mjs) already use
// for an invalid `kind`. The request is never silently coerced to
// production: a caller who asked for a lab room must learn they got none.
// The same 422 refuses a lab request whose room id does not carry the
// `lab-` prefix: the prefix is what makes a lab room distinguishable in
// every surface that shows the id (including the signed receipt body a
// later slice puts the roomId in), so a lab room may not hide behind a
// plausible unmarked name.
import { ROOM_MODES } from "../src/events.js";
import { ServiceError } from "./service-error.mjs";

export const ROOM_LAB_MODE_ENV = "ROOM_LAB_MODE_ENABLED";
export const LAB_ROOM_ID_PREFIX = "lab-";

// The env bag a store's room-mode decisions read: the store's featureEnv
// when it carries one (Worker bindings in production), else process.env.
// Mirrors featureEnv(store) in server/project-map-store.mjs exactly.
export function roomModeEnv(store) {
  if (store && Object.hasOwn(store, "featureEnv") && store.featureEnv && typeof store.featureEnv === "object") return store.featureEnv;
  return globalThis.process?.env ?? {};
}

export function roomLabModeEnabled(env = globalThis.process?.env ?? {}) {
  return env?.[ROOM_LAB_MODE_ENV] === "1";
}

// Resolve a creation request's optional mode field to the mode the new
// room is created with. Absent means "production". Throws ServiceError
// 422 invalid_room_request for an unknown value, for "lab" while the
// flag is off, or for "lab" under a room id without the `lab-` prefix
// (when the caller supplies the id — both creation paths do). Mode is
// creation-only: no caller may invoke this for an existing room, and the
// creation paths compare the resolved mode on idempotent replays so a
// replay cannot flip a room's mode.
export function requestedRoomMode(value, env = globalThis.process?.env ?? {}, roomId = undefined) {
  if (value === undefined) return "production";
  if (!ROOM_MODES.includes(value)) {
    throw new ServiceError(422, "invalid_room_request", "Room mode must be production or lab");
  }
  if (value === "lab" && !roomLabModeEnabled(env)) {
    throw new ServiceError(422, "invalid_room_request",
      "Lab rooms are not enabled on this server (ROOM_LAB_MODE_ENABLED is off)");
  }
  if (value === "lab" && roomId !== undefined && !(typeof roomId === "string" && roomId.startsWith(LAB_ROOM_ID_PREFIX))) {
    throw new ServiceError(422, "invalid_room_request",
      `Lab room ids must start with ${LAB_ROOM_ID_PREFIX}`);
  }
  return value;
}
