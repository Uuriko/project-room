import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { connectRoom } from "../../client/agent-setup.mjs";
import { readAgentConnection } from "../../client/agent-connection.mjs";
import { rememberSecret } from "../auth.mjs";
import { connectionHome, safeName, tightenConnection, writePointer } from "../paths.mjs";

function parse(argv) {
  const flags = { accept: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--accept") { flags.accept = true; continue; }
    if (arg === "--room" || arg === "--name") {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
      flags[arg.slice(2)] = value;
      continue;
    }
    rest.push(arg);
  }
  if (rest.length) throw new Error("Unknown login argument. Use room login --room <invite-or-room-url>.");
  return flags;
}

// choose_room carries the caller's memberships and the opted-in public directory.
// Whitelist each field; never spread the raw response (it may grow secrets).
const str = value => typeof value === "string" ? value : null;
const int = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const time = value => typeof value === "string" || int(value) !== null ? value : null;
export function chooseRoomLists(result) {
  const memberships = Array.isArray(result.memberships) ? result.memberships.map(room => ({
    roomId: str(room?.roomId), title: str(room?.title), memberId: str(room?.memberId), archivedAt: time(room?.archivedAt),
  })).filter(room => room.roomId) : null;
  // A missing or malformed directory is unavailable, never an empty list of choices.
  const raw = result.directory;
  const directory = raw && typeof raw === "object" && !Array.isArray(raw) && Array.isArray(raw.rooms) ? {
    rooms: raw.rooms.map(room => ({
      roomId: str(room?.roomId), title: str(room?.title), purpose: str(room?.purpose), kind: str(room?.kind),
      memberCount: int(room?.memberCount), listedAt: time(room?.listedAt),
    })).filter(room => room.roomId),
    nextCursor: str(raw.nextCursor),
  } : null;
  return { memberships, directory };
}

function publicResult(result) {
  if (result.status === "choose_room") {
    return { status: "choose_room", identityId: result.identityId, ...chooseRoomLists(result), next: result.next };
  }
  if (result.status === "connected") {
    return {
      status: "connected",
      origin: result.origin,
      roomId: result.roomId,
      memberId: result.memberId,
      connection: result.connection,
      next: "Run room setup <tool> in the repo. The tool config does not contain the identity secret.",
    };
  }
  const preview = result.preview ? {
    roomId: result.preview.roomId,
    permissions: result.preview.permissions,
    expiresAt: result.preview.expiresAt,
  } : undefined;
  return {
    status: result.status,
    roomId: result.roomId,
    identityId: result.identityId,
    ...(preview ? { preview } : {}),
    next: result.next,
  };
}

export async function loginCommand(argv, { env = process.env, fetchImpl, out = console.log } = {}) {
  const flags = parse(argv);
  if (!flags.room) throw new Error("Use room login --room <invite-or-room-url>.");
  const name = flags.name ?? "Room agent";
  const slug = safeName(name);
  const directory = connectionHome(slug, env);
  mkdirSync(join(directory, ".."), { recursive: true, mode: 0o700 });
  const result = await connectRoom({
    target: flags.room,
    directory,
    name,
    accept: flags.accept,
    fetchImpl,
  });
  if (result.status === "connected") {
    tightenConnection(result.configDirectory);
    const saved = readAgentConnection(result.configDirectory);
    await rememberSecret(slug, saved.token, env);
    writePointer(slug, result.configDirectory, env);
  }
  const printed = publicResult({ ...result, connection: slug });
  out(JSON.stringify(printed));
  return result.status === "connected" ? 0 : 1;
}
