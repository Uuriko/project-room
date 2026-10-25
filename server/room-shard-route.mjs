// Where a room's bytes live. Flag off, or storage_home other than "room",
// always names the directory object invite-only-pilot. The Worker fetch
// path still calls getByName('invite-only-pilot') itself; this function is
// what later copy and compare steps use. It does not open an object.
import { perRoomObjectsEnabled, readStorageHome } from "./room-shard-flag.mjs";

const PILOT = Object.freeze({ home: "pilot", binding: "ROOM", name: "invite-only-pilot" });

export function resolveRoomHome(env, roomId, db = null) {
  if (!perRoomObjectsEnabled(env)) return PILOT;
  if (typeof roomId !== "string" || roomId.length === 0 || roomId === "invite-only-pilot") return PILOT;
  if (!db || readStorageHome(db, roomId) !== "room") return PILOT;
  return { home: "room", binding: "ROOM_SHARD", name: roomId };
}
