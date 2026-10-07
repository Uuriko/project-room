import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readAgentConnection } from "../client/agent-connection.mjs";

export function homeOf(env = process.env) {
  return env.HOME || homedir();
}

export function connectionsRoot(env = process.env) {
  return join(homeOf(env), ".project-room", "connections");
}

export function safeName(name) {
  const slug = String(name ?? "").trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!slug || slug.length > 80) throw new Error("Choose an agent name of 1–80 characters");
  return slug;
}

export function connectionHome(name, env = process.env) {
  return join(connectionsRoot(env), safeName(name));
}

function privateFile(path) {
  const stat = statSync(path);
  if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0) {
    throw new Error(`chmod 600 ${path}`);
  }
}

export function writePrivateJson(path, value) {
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(value) + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function writePointer(name, configDirectory, env = process.env) {
  const slug = safeName(name);
  const directory = connectionHome(slug, env);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  writePrivateJson(join(directory, "pointer.json"), { version: 1, name: slug, configDirectory });
}

export function readPointer(name, env = process.env) {
  const file = join(connectionHome(name, env), "pointer.json");
  if (!existsSync(file)) return null;
  privateFile(file);
  const value = JSON.parse(readFileSync(file, "utf8"));
  if (value?.version !== 1 || typeof value.configDirectory !== "string") throw new Error("Saved connection pointer is invalid");
  const root = realpathSync(connectionsRoot(env));
  const configDirectory = realpathSync(value.configDirectory);
  if (configDirectory !== root && !configDirectory.startsWith(root + "/")) throw new Error("Saved connection pointer is outside the connection directory");
  return { name: value.name, configDirectory };
}

export function listConnectionNames(env = process.env) {
  const root = connectionsRoot(env);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && existsSync(join(root, entry.name, "pointer.json")))
    .map(entry => entry.name)
    .sort();
}

export function projectFile(project) {
  return join(project, ".project-room", "project.json");
}

export function readProject(project) {
  const file = projectFile(project);
  if (!existsSync(file)) return null;
  const value = JSON.parse(readFileSync(file, "utf8"));
  if (value?.version !== 1 || typeof value.connection !== "string") throw new Error("Project Room file is invalid. Run room setup again.");
  return value;
}

export function writeProject(project, value) {
  const file = projectFile(project);
  mkdirSync(join(project, ".project-room"), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify({ version: 1, ...value }, null, 2) + "\n", { mode: 0o600 });
  chmodSync(file, 0o600);
}

export function loadConnection({ project, name, env = process.env }) {
  const fromProject = name ? null : readProject(project);
  const selected = name ? safeName(name) : fromProject?.connection;
  let pointer = selected ? readPointer(selected, env) : null;
  if (!pointer && !selected) {
    const names = listConnectionNames(env);
    if (names.length === 1) pointer = readPointer(names[0], env);
    else if (names.length === 0) throw new Error("Run room login --room <invite-or-room-url>.");
    else throw new Error("More than one saved connection. Run room setup --name <agent name>.");
  }
  if (!pointer) throw new Error("Run room login --room <invite-or-room-url>.");
  let config;
  try { config = readAgentConnection(pointer.configDirectory); }
  catch (error) {
    if (error.code === "config_not_private") throw new Error("chmod 600 " + join(pointer.configDirectory, "connection.json"));
    if (error.code === "config_not_found") throw new Error("Run room login --room <invite-or-room-url>.");
    throw new Error("The saved connection file is invalid. Run room login again.");
  }
  return { name: pointer.name, configDirectory: pointer.configDirectory, config };
}

export function tightenConnection(configDirectory) {
  const file = join(configDirectory, "connection.json");
  chmodSync(configDirectory, 0o700);
  chmodSync(file, 0o600);
  privateFile(file);
}
