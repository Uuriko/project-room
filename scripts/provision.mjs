import { parseArgs } from "node:util";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

const { values } = parseArgs({ options: { init: { type: "boolean" }, room: { type: "string", default: "commons" }, member: { type: "string", default: "owner" }, name: { type: "string" }, kind: { type: "string", default: "human" }, permissions: { type: "string", default: "accept_work,complete_work,verify" } } });
const filename = resolve(process.env.ROOM_DB || ".data/room.sqlite");
mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
const store = new RoomStore(filename);
try {
  if (values.init) store.initialize(initialRoom(values.room, values.member));
  const { state } = store.room(values.room);
  if (!Object.hasOwn(state.members, values.member)) {
    if (!values.name) throw new Error("New members require --name");
    // Local database administration is intentionally separate from the public HTTP API.
    const admin = store.insertCredential(values.room, state.room.ownerId, "access", null, Date.now() + 60000);
    try { store.command(admin, values.room, { id: crypto.randomUUID(), type: T.MEMBER_ADDED, data: { memberId: values.member, displayName: values.name, kind: values.kind, permissions: values.permissions ? values.permissions.split(",") : [] } }); }
    finally { store.revoke(admin); }
  }
  const accessKey = store.issueAccessKey(values.room, values.member);
  process.stdout.write(`New key for ${values.member} in ${values.room}; previous keys and sessions revoked. Expires in seven days. Keep private; never paste into GitHub.\n${accessKey}\n`);
} finally { store.close(); }
