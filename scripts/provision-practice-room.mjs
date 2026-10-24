import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

// Issue #602: provision the well-known practice room (id "practice") in
// the store file. This is the operator act that brings the room up — the
// server never self-provisions it. Idempotent: an existing practice room
// is reported and left untouched.
//
//   node scripts/provision-practice-room.mjs [--db PATH]
//     --db PATH   store file (default $ROOM_DB or .data/room.sqlite)
const USAGE = `node scripts/provision-practice-room.mjs [--db PATH]
  --db PATH   store file (default $ROOM_DB or .data/room.sqlite)`;

export async function provisionPracticeRoomMain(argv, { env = process.env } = {}) {
  const { values } = parseArgs({ args: argv, options: {
    db: { type: "string" }, help: { type: "boolean" } } });
  if (values.help) return USAGE + "\n";
  const dbPath = resolve(values.db ?? env.ROOM_DB ?? ".data/room.sqlite");
  const { RoomStore } = await import("../server/store.mjs");
  const { provisionPracticeRoom, PRACTICE_ROOM_ID } = await import("../server/practice-room.mjs");
  const store = new RoomStore(dbPath);
  try {
    const result = provisionPracticeRoom(store);
    return result.created
      ? `Practice room "${PRACTICE_ROOM_ID}" provisioned in ${dbPath}. Verified pri_ identities can now self-join with chat scope via POST /api/access-requests.\n`
      : `Practice room "${PRACTICE_ROOM_ID}" already exists in ${dbPath}; nothing changed.\n`;
  } finally {
    store.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(await provisionPracticeRoomMain(process.argv.slice(2)));
}
