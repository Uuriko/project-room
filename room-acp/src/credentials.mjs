// The saved Room connection: one private JSON file per room under
// ~/.config/room-acp (0700 dir, 0600 file). Never printed.
import { rmSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { atomicPrivateJson, assertPrivatePath, ensurePrivateDirectory, readPrivateJson } from "./private-files.mjs";
import { registerSecret } from "./redact.mjs";

export function configDir(env = process.env) {
  return env.ROOM_ACP_HOME || join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "room-acp");
}
const fileFor = (roomId, env) => join(configDir(env), `${roomId.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);

export function saveConnection(connection, env = process.env) {
  const dir = configDir(env);
  ensurePrivateDirectory(dir, {recursive: true});
  const path = fileFor(connection.roomId, env);
  atomicPrivateJson(path, connection);
  return path;
}

export function listConnections(env = process.env) {
  let names = [];
  try { assertPrivatePath(configDir(env), true); names = readdirSync(configDir(env)).filter(name => name.endsWith(".json") && !name.startsWith("sessions-")); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
  return names.map(name => {
    const path = join(configDir(env), name);
    const value = readPrivateJson(path);
    registerSecret(value.credential);
    registerSecret(value.identitySecret);
    return value;
  });
}

export function loadConnection({ roomId = null } = {}, env = process.env) {
  const all = listConnections(env);
  if (roomId) return all.find(entry => entry.roomId === roomId) ?? null;
  if (all.length > 1) throw new Error(`several rooms are saved (${all.map(entry => entry.roomId).join(", ")}); pass --room <id>`);
  return all[0] ?? null;
}

export function forgetConnection(roomId, env = process.env) { rmSync(fileFor(roomId, env), { force: true }); }

// What `status` may show: everything except secrets.
export function publicView(connection) {
  const { credential: _credential, identitySecret: _identitySecret, ...rest } = connection;
  return { ...rest, credential: connection.credential ? "saved" : "missing" };
}
