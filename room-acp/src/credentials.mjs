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

export function forgetConnection(roomId, env = process.env) {
  rmSync(fileFor(roomId, env), { force: true });
  rmSync(mcpHeadersFile(roomId, env), { force: true });
}

// What `status` may show: everything except secrets.
export function publicView(connection) {
  const { credential: _credential, identitySecret: _identitySecret, ...rest } = connection;
  return { ...rest, credential: connection.credential ? "saved" : "missing" };
}

// MCP hosts read their Authorization header from a command, so the secret never
// lands in the host's own config, argv or shell history. This file holds the one
// JSON object such a command prints. It lives in a subdirectory so the connection
// list above (which reads only *.json files directly in the config directory)
// never mistakes it for a connection. Same 0700 directory, 0600 file.
export function mcpHeadersFile(roomId, env = process.env) {
  return join(configDir(env), "mcp", `${roomId.replace(/[^A-Za-z0-9._-]/g, "_")}.headers.json`);
}

export function saveMcpHeaders(connection, env = process.env) {
  const secret = typeof connection.identitySecret === "string" && connection.identitySecret.startsWith("pri_")
    ? connection.identitySecret : connection.credential;
  if (typeof secret !== "string" || !secret) throw new Error("The saved connection has no credential to put in an MCP header");
  registerSecret(secret);
  const dir = join(configDir(env), "mcp");
  ensurePrivateDirectory(configDir(env), {recursive: true});
  ensurePrivateDirectory(dir, {recursive: true});
  const path = mcpHeadersFile(connection.roomId, env);
  atomicPrivateJson(path, { Authorization: `Bearer ${secret}` });
  return path;
}
