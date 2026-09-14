import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

// BUILD-01 D4: periodic access review (read-only). Two sources:
//   --db PATH          open the store file read-only (default ROOM_DB or .data/room.sqlite)
//   --origin URL       ask a running service; the owner key is read from the
//                      environment variable NAMED by --key-env (default ROOM_OWNER_KEY).
// Credentials are never accepted on the command line and never printed. The
// report itself contains no tokens, secrets or hashes (server/access-review.mjs).
const USAGE = `node scripts/access-review.mjs [--db PATH | --origin URL --key-env NAME] [--room ID ...] [--json]
  --db PATH        store file to read (read-only; default $ROOM_DB or .data/room.sqlite)
  --origin URL     running service origin; requires --room and an owner key in $NAME
  --key-env NAME   environment variable holding the owner key (default ROOM_OWNER_KEY)
  --room ID        room to review (repeatable; store mode defaults to every room)
  --json           print the JSON report instead of text`;

export async function accessReviewMain(argv, { env = process.env, fetcher = globalThis.fetch } = {}) {
  const { values } = parseArgs({ args: argv, options: {
    db: { type: "string" }, origin: { type: "string" }, "key-env": { type: "string" },
    room: { type: "string", multiple: true }, json: { type: "boolean" }, help: { type: "boolean" } } });
  if (values.help) return USAGE + "\n";
  if (values.db && values.origin) throw new Error("Choose --db or --origin, not both");
  const { renderAccessReview } = await import("../server/access-review.mjs");
  const reports = values.origin ? await fromService(values, env, fetcher) : await fromStore(values, env);
  return values.json ? JSON.stringify(reports.length === 1 && values.room?.length === 1 ? reports[0] : reports, null, 2) + "\n"
    : reports.map(renderAccessReview).join("\n");
}

async function fromStore(values, env) {
  const { RoomStore } = await import("../server/store.mjs");
  const { assembleAccessReview, listRoomIds } = await import("../server/access-review.mjs");
  const store = new RoomStore(resolve(values.db || env.ROOM_DB || ".data/room.sqlite"), { readOnly: true });
  try {
    const rooms = values.room?.length ? values.room : listRoomIds(store);
    return store.readTransaction(() => rooms.map(roomId => assembleAccessReview(store, roomId)));
  } finally { store.close(); }
}

async function fromService(values, env, fetcher) {
  const name = values["key-env"] || "ROOM_OWNER_KEY";
  if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw new Error("--key-env names an environment variable, never a key");
  const key = env[name];
  if (typeof key !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(key)) throw new Error(`Set ${name} to the room owner's access key (not printed)`);
  if (!values.room?.length) throw new Error("--origin requires at least one --room");
  const origin = new URL(values.origin);
  if (origin.origin !== values.origin || !["http:", "https:"].includes(origin.protocol)) throw new Error("--origin must be a bare http(s) origin");
  if (origin.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)) throw new Error("Use HTTPS for a non-loopback origin");
  const reports = [];
  for (const roomId of values.room) {
    const response = await fetcher(`${origin.origin}/api/rooms/${encodeURIComponent(roomId)}/access-review`, {
      headers: { Authorization: `Bearer ${key}` }, redirect: "error", signal: AbortSignal.timeout(15000) });
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`Access review for ${roomId} refused: ${response.status} ${body?.error?.code ?? ""}`.trim());
    reports.push(body);
  }
  return reports;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  accessReviewMain(process.argv.slice(2)).then(output => process.stdout.write(output), error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
