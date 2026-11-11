// Thread -> ACP session id map, saved next to the connection so a restarted
// agent can resume each thread with session/load. Holds no secrets.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "./credentials.mjs";

const LIMIT = 200;

export class SessionMap {
  constructor({ roomId, hostId, env = process.env, persist = true }) {
    this.path = persist ? join(configDir(env), `sessions-${`${roomId}-${hostId}`.replace(/[^A-Za-z0-9._-]/g, "_")}.json`) : null;
    this.map = new Map();
    if (this.path) { try { this.map = new Map(Object.entries(JSON.parse(readFileSync(this.path, "utf8")))); } catch { /* fresh */ } }
  }
  get(threadKey) { return this.map.get(threadKey) ?? null; }
  set(threadKey, sessionId) {
    this.map.delete(threadKey); this.map.set(threadKey, sessionId);
    while (this.map.size > LIMIT) this.map.delete(this.map.keys().next().value);
    if (this.path) {
      mkdirSync(join(this.path, ".."), { recursive: true, mode: 0o700 });
      writeFileSync(this.path, JSON.stringify(Object.fromEntries(this.map)), { mode: 0o600 });
    }
  }
}
