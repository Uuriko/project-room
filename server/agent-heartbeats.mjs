// Wakeable agent presence (RC-2026-09-18-051).
//
// A durable registry of agent host heartbeats. Each agent identity runs zero
// or more hosts; every host reports a mode:
//
//   wakeable  - the host registers an https wake URL and accepts wake pings
//               when it is mentioned or DM'd while away;
//   pull-only - the host polls on its own cadence; queued wake signals are
//               delivered on its next heartbeat instead of a ping.
//
// The registry tracks last-seen per host and derives the agent's effective
// status: online when any host was seen inside the staleness window,
// offline when every host is stale, unregistered when no host ever
// reported. Wake signals are a durable queue: mentioning or DM'ing an
// offline registered agent enqueues one signal per message (coalesced on
// agent+message), and the host collects pending signals on its next
// heartbeat and acknowledges them once handled.
//
// SQLite persistence survives restarts; the schema is purely additive
// (no migration, no schema-version bump), matching the wake-queue pattern.
import { randomBytes } from "node:crypto";
import { validateWebhookUrl, WAKE_ACK_HINT } from "./outbound-webhooks.mjs";

const MODES = Object.freeze(["wakeable", "pull-only"]);
const WAKE_KINDS = Object.freeze(["mention", "dm"]);
const STATUSES = Object.freeze(["online", "offline", "unregistered"]);
export const HEARTBEAT_STALE_AFTER_MS = 60000;
const MAX_PENDING_WAKES = 50;
const AGENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const HOST_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

export const agentHeartbeatSchema = `
  CREATE TABLE IF NOT EXISTS agent_hosts (
    agent_id TEXT NOT NULL, host_id TEXT NOT NULL,
    mode TEXT NOT NULL CHECK(mode IN ('wakeable','pull-only')),
    wake_url TEXT, last_seen_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    PRIMARY KEY(agent_id, host_id)
  );
  CREATE INDEX IF NOT EXISTS agent_hosts_seen ON agent_hosts(agent_id, last_seen_at);
  CREATE TABLE IF NOT EXISTS agent_wake_signals (
    signal_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('mention','dm')),
    room_id TEXT, message_id TEXT,
    created_at INTEGER NOT NULL, delivered_at INTEGER,
    UNIQUE(agent_id, message_id)
  );
  CREATE INDEX IF NOT EXISTS agent_wake_signals_pending ON agent_wake_signals(agent_id, delivered_at);
`;

export class HeartbeatError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "HeartbeatError";
    this.status = status;
    this.code = code;
  }
}
const fail = (status, code, message) => { throw new HeartbeatError(status, code, message); };
const check = (condition, status, code, message) => { if (!condition) fail(status, code, message); };

const checkAgentId = agentId =>
  check(typeof agentId === "string" && AGENT_ID_PATTERN.test(agentId),
    422, "invalid_heartbeat", "agentId must match [A-Za-z0-9_-]{1,64}");
const checkHostId = hostId =>
  check(typeof hostId === "string" && HOST_ID_PATTERN.test(hostId),
    422, "invalid_heartbeat", "hostId must match [A-Za-z0-9._-]{1,128}");

const hostView = row => Object.freeze({
  agentId: row.agent_id, hostId: row.host_id, mode: row.mode,
  wakeUrl: row.wake_url, lastSeenAt: row.last_seen_at,
  createdAt: row.created_at, updatedAt: row.updated_at,
});
const signalView = row => Object.freeze({
  signalId: row.signal_id, agentId: row.agent_id, kind: row.kind,
  roomId: row.room_id, messageId: row.message_id,
  createdAt: row.created_at, deliveredAt: row.delivered_at,
  // Tag acknowledgment (2026-09-23): the one-tap ack copy rides the journaled
  // pending-wake signal too, so an agent reading its heartbeat queue learns a
  // bare 👍 react counts as a response. Additive — every existing field stands.
  ackHint: WAKE_ACK_HINT,
});

export class AgentHeartbeats {
  constructor(store, { staleAfterMs = HEARTBEAT_STALE_AFTER_MS } = {}) {
    this.store = store;
    this.db = store.db;
    check(Number.isFinite(staleAfterMs) && staleAfterMs > 0,
      500, "invalid_heartbeat_config", "staleAfterMs must be positive");
    this.staleAfterMs = staleAfterMs;
  }

  now() { return this.store.now(); }

  // Read-only never migrates: verify the additive tables only when present.
  verifySchema({ allowAbsent = false } = {}) {
    const normalize = sql => sql?.trim().replace(/;$/, "").replace(/IF NOT EXISTS /g, "").replace(/\s+/g, " ");
    const expected = agentHeartbeatSchema.trim().split(/;\s*(?=CREATE|$)/).filter(Boolean)
      .map(sql => ({ sql, actual: this.db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(/^CREATE (?:TABLE|INDEX) (?:IF NOT EXISTS )?([a-z_]+)/.exec(sql.trim())[1])?.sql }));
    if (allowAbsent && expected.every(({ actual }) => actual === undefined)) return false;
    for (const { sql, actual } of expected) {
      if (normalize(actual) !== normalize(sql)) throw new Error("Agent heartbeat schema requires operator reconciliation");
    }
    return true;
  }

  // Record a heartbeat from one of the agent's hosts. Upserts the host row
  // and returns the host plus the agent's currently pending wake signals.
  // Pending signals are NOT marked delivered here — the host acknowledges
  // them via ackWakes once it has actually handled them.
  heartbeat({ agentId, hostId, mode, wakeUrl = null }) {
    checkAgentId(agentId);
    checkHostId(hostId);
    check(MODES.includes(mode), 422, "invalid_heartbeat",
      `mode must be one of ${MODES.join(", ")}`);
    let url = null;
    if (mode === "wakeable") {
      try { url = validateWebhookUrl(wakeUrl); }
      catch (error) { fail(422, "invalid_heartbeat", `wakeable hosts must register a wake URL: ${error.message}`); }
    } else if (wakeUrl !== null && wakeUrl !== undefined) {
      fail(422, "invalid_heartbeat", "pull-only hosts cannot register a wake URL");
    }
    const at = this.now();
    this.db.prepare(`INSERT INTO agent_hosts
      (agent_id, host_id, mode, wake_url, last_seen_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(agent_id, host_id) DO UPDATE SET mode=excluded.mode,
        wake_url=excluded.wake_url, last_seen_at=excluded.last_seen_at,
        updated_at=excluded.updated_at`)
      .run(agentId, hostId, mode, url, at, at, at);
    const host = hostView(this.db.prepare(
      "SELECT * FROM agent_hosts WHERE agent_id=? AND host_id=?").get(agentId, hostId));
    return Object.freeze({ host, pendingWakes: this.pendingWakes(agentId) });
  }

  // Mark wake signals delivered after the host handled them. Returns the
  // ids that were actually pending (unknown or already-delivered ids are
  // reported, not applied — ack is idempotent).
  ackWakes({ agentId, signalIds }) {
    checkAgentId(agentId);
    check(Array.isArray(signalIds) && signalIds.length > 0
      && signalIds.every(id => typeof id === "string" && id.length > 0),
      422, "invalid_heartbeat_ack", "signalIds must be a non-empty string array");
    const at = this.now();
    const acknowledged = [];
    const stmt = this.db.prepare(
      "UPDATE agent_wake_signals SET delivered_at=? WHERE agent_id=? AND signal_id=? AND delivered_at IS NULL");
    for (const signalId of signalIds) {
      if (stmt.run(at, agentId, signalId).changes > 0) acknowledged.push(signalId);
    }
    return Object.freeze({ acknowledged: Object.freeze(acknowledged) });
  }

  // Enqueue a wake signal for an agent (mention or DM). Coalesced on
  // (agent_id, message_id): the same message wakes an agent exactly once.
  enqueueWake({ agentId, kind, roomId = null, messageId }) {
    checkAgentId(agentId);
    check(WAKE_KINDS.includes(kind), 422, "invalid_wake",
      `kind must be one of ${WAKE_KINDS.join(", ")}`);
    check(typeof messageId === "string" && messageId.length > 0,
      422, "invalid_wake", "messageId must be a non-empty string");
    check(roomId === null || (typeof roomId === "string" && roomId.length > 0),
      422, "invalid_wake", "roomId must be a non-empty string or null");
    const at = this.now();
    const signalId = `ws_${at.toString(36)}${randomBytes(6).toString("base64url")}`;
    const applied = this.db.prepare(`INSERT OR IGNORE INTO agent_wake_signals
      (signal_id, agent_id, kind, room_id, message_id, created_at, delivered_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL)`).run(signalId, agentId, kind, roomId, messageId, at);
    const row = this.db.prepare(
      "SELECT * FROM agent_wake_signals WHERE agent_id=? AND message_id=?").get(agentId, messageId);
    return Object.freeze({ enqueued: applied.changes > 0, signal: signalView(row) });
  }

  // Undelivered wake signals, oldest first.
  pendingWakes(agentId, { limit = MAX_PENDING_WAKES } = {}) {
    checkAgentId(agentId);
    check(Number.isInteger(limit) && limit > 0 && limit <= MAX_PENDING_WAKES,
      422, "invalid_heartbeat", `limit must be 1..${MAX_PENDING_WAKES}`);
    return Object.freeze(this.db.prepare(`SELECT * FROM agent_wake_signals
      WHERE agent_id=? AND delivered_at IS NULL ORDER BY created_at ASC LIMIT ?`)
      .all(agentId, limit).map(signalView));
  }

  // Effective presence for an agent: online when any host was seen inside
  // the staleness window, offline when every host is stale, unregistered
  // when no host ever reported.
  statusOf(agentId) {
    checkAgentId(agentId);
    const at = this.now();
    const hosts = this.db.prepare("SELECT * FROM agent_hosts WHERE agent_id=? ORDER BY last_seen_at DESC")
      .all(agentId);
    if (hosts.length === 0) {
      return Object.freeze({ agentId, status: "unregistered", lastSeenAt: null, hosts: Object.freeze([]) });
    }
    const withState = hosts.map(row => {
      const view = hostView(row);
      return Object.freeze({ ...view, state: at - view.lastSeenAt <= this.staleAfterMs ? "online" : "stale" });
    });
    const online = withState.some(host => host.state === "online");
    return Object.freeze({
      agentId,
      status: online ? "online" : "offline",
      lastSeenAt: withState[0].lastSeenAt,
      hosts: Object.freeze(withState),
    });
  }

  // Wake-on-mention entry point. Only an offline agent with at least one
  // registered host gets a signal: an online agent already sees the
  // message, and an unregistered agent has nowhere to deliver to.
  wakeIfOffline({ agentId, kind, roomId = null, messageId }) {
    checkAgentId(agentId);
    const status = this.statusOf(agentId);
    if (status.status !== "offline") return Object.freeze({ woken: false, signal: null });
    const { enqueued, signal } = this.enqueueWake({ agentId, kind, roomId, messageId });
    return Object.freeze({ woken: true, enqueued, signal });
  }
}
export { MODES, WAKE_KINDS, STATUSES };
