import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_ALLOW, DEADMAN_DEFAULT_SECONDS, RETENTION_DAYS_DEFAULT } from "./protocol.mjs";

export function configHome(env = process.env) {
  if (env.ROOM_MACHINE_HOME) return env.ROOM_MACHINE_HOME;
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "room-machine");
  return join(homedir(), ".local", "share", "room-machine");
}

export function defaultConfig() {
  return {
    enabled: false,
    label: "",
    machineId: "",
    relayUrl: "",
    roomOrigin: "",
    roomId: "",
    ownerMemberId: "",
    displayName: "Room machine",
    allow: [...DEFAULT_ALLOW],
    deadmanSeconds: DEADMAN_DEFAULT_SECONDS,
    retentionDays: RETENTION_DAYS_DEFAULT,
    reconnectBackoffMs: 1000,
    provider: null,
    egressAllow: [],
    slots: { desk: null, scratch: null },
    haltEpoch: 0,
    halted: false,
    pausedUntil: null,
  };
}

export function loadConfig(home = configHome()) {
  const path = join(home, "config.json");
  const config = defaultConfig();
  if (!existsSync(path)) return config;
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  return { ...config, ...parsed, slots: { ...config.slots, ...(parsed.slots ?? {}) } };
}

export function saveConfig(config, home = configHome()) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const path = join(home, "config.json");
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return path;
}
