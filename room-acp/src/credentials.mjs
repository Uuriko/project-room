// The saved Room connection: one private JSON file per room under
// ~/.config/room-acp (0700 dir, 0600 file). Never printed.
import { mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, chmodSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { registerSecret } from "./redact.mjs";

export function configDir(env = process.env) {
  return env.ROOM_ACP_HOME || join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "room-acp");
}
const fileFor = (roomId, env) => join(configDir(env), `${roomId.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);

export function saveConnection(connection, env = process.env) {
  const dir = configDir(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const path = fileFor(connection.roomId, env);
  writeFileSync(path, JSON.stringify(connection, null, 2) + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

export function listConnections(env = process.env) {
  let names = [];
  try { names = readdirSync(configDir(env)).filter(name => name.endsWith(".json") && !name.startsWith("sessions-")); } catch { return []; }
  return names.map(name => {
    const path = join(configDir(env), name);
    if (process.platform !== "win32" && (statSync(path).mode & 0o077)) throw new Error(`${path} is readable by other users; run chmod 600 on it`);
    const value = JSON.parse(readFileSync(path, "utf8"));
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
