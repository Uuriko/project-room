// Wakeable agent presence (RC-2026-09-18-051) + push wake path (RC-2026-09-24-203).
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
// status: online when any host was seen inside its reachability window,
// offline when every host is stale, unregistered when no host ever
// reported. Wake signals are a durable queue: mentioning or DM'ing an
// offline registered agent enqueues one signal per message (coalesced on
// agent+message), and the host collects pending signals on its next
// heartbeat and acknowledges them once handled.
//
// RC-2026-09-24-203 adds the push wake path: a host may declare its poll
// cadence and register a pushNotification subscription (url + opaque token
// + optional bearer auth). Room events relevant to an offline agent
// (message mentions, DMs, bond proposals, work assignments) then POST a
// pointer-only doorbell to the push url — push is the doorbell, the
// agent-inbox pull is the mail. The reachability window per host is
// max(180s, cadenceSeconds * 1.5); undeclared hosts read stale after 180s.
//
// SQLite persistence survives restarts; the schema is purely additive
// (no migration, no schema-version bump), matching the wake-queue pattern.
import { randomBytes } from "node:crypto";
import { validateWebhookUrl, assertWebhookHostDnsPublic, WAKE_ACK_HINT } from "./outbound-webhooks.mjs";
import { postDelivery } from "./webhook-dispatch.mjs";

const MODES = Object.freeze(["wakeable", "pull-only"]);
const WAKE_KINDS = Object.freeze(["mention", "dm"]);
const STATUSES = Object.freeze(["online", "offline", "unregistered"]);
// RC-2026-09-24-203: the default reachability window is 180s (was 60s).
// Per host the window is max(180s, cadenceSeconds * 1.5).
export const HEARTBEAT_STALE_AFTER_MS = 180000;
const MAX_PENDING_WAKES = 50;
const AGENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const HOST_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
// Push wake path (RC-2026-09-24-203): token bounds, delivery timeout, and
// the consecutive-failure count that suspends a subscription.
const PUSH_TOKEN_MIN = 1;
const PUSH_TOKEN_MAX = 500;
const PUSH_DELIVERY_TIMEOUT_MS = 5000;
const PUSH_SUSPEND_AFTER_FAILURES = 3;
const PUSH_EVENT_TYPES = Object.freeze(["message.posted", "dm.posted", "bond.proposed", "assignment.created", "land.updated"]);

// RC-2026-09-24-203: agent_push_configs carries per-host push-notification
// subscriptions and poll cadence. Purely additive: agent_hosts is never
// altered, one row per (agent, host), replaced on each heartbeat that
// carries push/cadence fields. The token and bearer credentials are stored
// but never returned in any response, never logged, and never put in room
// state/events.
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
  CREATE TABLE IF NOT EXISTS agent_push_configs (
    agent_id TEXT NOT NULL, host_id TEXT NOT NULL,
    cadence_seconds REAL,
    push_url TEXT, push_token TEXT, push_auth_json TEXT,
    push_failures INTEGER NOT NULL DEFAULT 0,
    push_suspended INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(agent_id, host_id)
  );
  CREATE INDEX IF NOT EXISTS agent_push_configs_seen ON agent_push_configs(agent_id, updated_at);
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

// RC-2026-09-24-203: cadence is the host's declared poll interval in
// seconds. Positive and finite; absent means the 180s default window.
const checkCadenceSeconds = cadenceSeconds =>
  check(Number.isFinite(cadenceSeconds) && cadenceSeconds > 0,
    422, "invalid_heartbeat", "cadenceSeconds must be a positive finite number");

// RC-2026-09-24-203: validate a pushNotification subscription body.
// Returns the normalized { url, token, authJson }. The sync shape checks
// live here; the async DNS-rebinding check runs in assertPushDns (the route
// awaits it before heartbeat() stores anything). The token and bearer
// credentials are validated for shape only and are NEVER echoed — the
// caller stores them, responses never include them.
const PUSH_NOTIFICATION_KEYS = Object.freeze(["url", "token", "authentication"]);
const checkPushNotification = pushNotification => {
  check(pushNotification !== null && typeof pushNotification === "object" && !Array.isArray(pushNotification),
    422, "invalid_heartbeat", "pushNotification must be an object");
  const keys = Object.keys(pushNotification);
  check(keys.includes("url") && keys.includes("token")
    && keys.every(key => PUSH_NOTIFICATION_KEYS.includes(key)),
    422, "invalid_heartbeat", "pushNotification accepts url, token, and optional authentication");
  const { url, token, authentication } = pushNotification;
  let validatedUrl;
  try { validatedUrl = validateWebhookUrl(url); }
  catch (error) { fail(422, "invalid_heartbeat", `pushNotification.url is not a usable push target: ${error.message}`); }
  check(typeof token === "string" && token.length >= PUSH_TOKEN_MIN && token.length <= PUSH_TOKEN_MAX,
    422, "invalid_heartbeat", `pushNotification.token must be a ${PUSH_TOKEN_MIN}-${PUSH_TOKEN_MAX} char opaque string`);
  let authJson = null;
  if (authentication !== undefined && authentication !== null) {
    check(typeof authentication === "object" && !Array.isArray(authentication),
      422, "invalid_heartbeat", "pushNotification.authentication must be an object");
    const authKeys = Object.keys(authentication);
    check(authKeys.length === 2 && authKeys.includes("schemes") && authKeys.includes("credentials"),
      422, "invalid_heartbeat", "pushNotification.authentication must be exactly { schemes, credentials }");
    check(Array.isArray(authentication.schemes) && authentication.schemes.length === 1
      && authentication.schemes[0] === "bearer",
      422, "invalid_heartbeat", "pushNotification.authentication.schemes must be [\"bearer\"]");
    check(typeof authentication.credentials === "string" && authentication.credentials.length > 0,
      422, "invalid_heartbeat", "pushNotification.authentication.credentials must be a non-empty string");
    authJson = JSON.stringify({ schemes: ["bearer"], credentials: authentication.credentials });
  }
  return { url: validatedUrl, token, authJson };
};

const hostView = (row, cadenceSeconds = null) => Object.freeze({
  agentId: row.agent_id, hostId: row.host_id, mode: row.mode,
  wakeUrl: row.wake_url, lastSeenAt: row.last_seen_at,
  createdAt: row.created_at, updatedAt: row.updated_at,
  // RC-2026-09-24-203: the host's declared poll cadence (null when the host
  // never declared one); drives the per-host reachability window.
  cadenceSeconds,
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
    // Push delivery transport (RC-2026-09-24-203). Production leaves both
    // null: postDelivery then uses the real fetch and real DNS. Tests inject
    // mocks via setPushTransport so the push path never touches the network.
    this.pushFetchImpl = null;
    this.pushDnsResolvers = null;
    // Fire-and-forget push POSTs in flight; flushPushes() awaits them.
    this._pushInflight = [];
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
  //
  // RC-2026-09-24-203: cadenceSeconds (optional) declares the host's poll
  // cadence and drives its reachability window; pushNotification (optional)
  // registers a push subscription for the wake path. One subscription per
  // (agent, host): each heartbeat replaces the host's push config — a body
  // that carries pushNotification stores it fresh (resetting the failure
  // counters, which re-arms a suspended subscription); a body without it
  // leaves the existing subscription untouched, so old heartbeat bodies
  // keep working unchanged.
  heartbeat({ agentId, hostId, mode, wakeUrl = null, cadenceSeconds = null, pushNotification = null }) {
    checkAgentId(agentId);
    checkHostId(hostId);
    check(MODES.includes(mode), 422, "invalid_heartbeat",
      `mode must be one of ${MODES.join(", ")}`);
    if (cadenceSeconds !== null && cadenceSeconds !== undefined) checkCadenceSeconds(cadenceSeconds);
    const push = (pushNotification === null || pushNotification === undefined)
      ? null : checkPushNotification(pushNotification);
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
    // The push/cadence row tracks the latest heartbeat; push fields change
    // only when the body carries pushNotification (never on bare
    // heartbeats), and a fresh subscription resets failures/suspension.
    this.db.prepare(`INSERT INTO agent_push_configs
      (agent_id, host_id, cadence_seconds, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(agent_id, host_id) DO UPDATE SET
        cadence_seconds=excluded.cadence_seconds, updated_at=excluded.updated_at`)
      .run(agentId, hostId, cadenceSeconds ?? null, at);
    if (push) {
      this.db.prepare(`UPDATE agent_push_configs
        SET push_url=?, push_token=?, push_auth_json=?, push_failures=0, push_suspended=0, updated_at=?
        WHERE agent_id=? AND host_id=?`)
        .run(push.url, push.token, push.authJson, at, agentId, hostId);
    }
    const cadence = cadenceSeconds ?? null;
    const host = hostView(this.db.prepare(
      "SELECT * FROM agent_hosts WHERE agent_id=? AND host_id=?").get(agentId, hostId), cadence);
    const pushRow = this.db.prepare(
      "SELECT push_url AS pushUrl, push_suspended AS pushSuspended FROM agent_push_configs WHERE agent_id=? AND host_id=?")
      .get(agentId, hostId);
    const pushConfigured = pushRow?.pushUrl != null;
    const pushSuspended = pushRow?.pushSuspended === 1;
    const windowMs = this.windowFor(cadence);
    const reachableUntil = host.lastSeenAt + windowMs;
    // "push": wakeable host, usable push subscription, inside the window.
    // "poller": inside the window but no usable push. "none": stale.
    const reachability = Object.freeze({
      mode: at > reachableUntil ? "none"
        : (mode === "wakeable" && pushConfigured && !pushSuspended ? "push" : "poller"),
      reachableUntil,
    });
    return Object.freeze({
      host, pendingWakes: this.pendingWakes(agentId),
      pushConfigured, pushSuspended, reachability,
    });
  }

  // Per-host reachability window (RC-2026-09-24-203):
  // max(baseWindow, cadenceSeconds * 1.5). Undeclared cadence reads the
  // 180s default.
  windowFor(cadenceSeconds) {
    const cadence = Number(cadenceSeconds);
    const cadenceMs = Number.isFinite(cadence) && cadence > 0 ? cadence * 1500 : 0;
    return Math.max(this.staleAfterMs, cadenceMs);
  }

  // Async subscribe-time DNS-rebinding check for a push url. The route
  // awaits this BEFORE the sync heartbeat() upsert stores anything, so a
  // hostname that resolves internal never lands in the table. Resolvers
  // are injectable (setPushTransport) so tests never touch the network;
  // omitted they default to the real resolver (fail closed in production).
  async assertPushDns(url) {
    try {
      await assertWebhookHostDnsPublic(url, this.pushDnsResolvers ?? {});
    } catch (error) {
      fail(422, "invalid_heartbeat", `pushNotification.url rejected: ${error.message}`);
    }
    return url;
  }

  // Override the push delivery transport (fetch impl + DNS resolvers).
  // Production never calls this: postDelivery then uses the real fetch and
  // the real DNS resolver. Tests inject mocks here.
  setPushTransport({ fetchImpl = null, dnsResolvers = null } = {}) {
    this.pushFetchImpl = fetchImpl;
    this.pushDnsResolvers = dnsResolvers;
    return this;
  }

  // Eligible push targets for an agent: wakeable hosts with a configured,
  // non-suspended push subscription, and only when the agent is offline
  // (the wakeIfOffline gating pattern — an online agent already sees the
  // event). Never throws for missing tables (older DB) — returns no
  // targets. The returned targets carry the token only in memory; it is
  // never logged and never enters room state.
  pushTargets(agentId) {
    try {
      checkAgentId(agentId);
      const status = this.statusOf(agentId);
      if (status.status !== "offline") return Object.freeze([]);
      const configs = new Map(this.db.prepare(
        "SELECT host_id AS hostId, push_url AS pushUrl, push_token AS pushToken, push_suspended AS pushSuspended FROM agent_push_configs WHERE agent_id=?")
        .all(agentId).map(row => [row.hostId, row]));
      const targets = [];
      for (const host of status.hosts) {
        if (host.mode !== "wakeable") continue;
        const config = configs.get(host.hostId);
        if (!config || !config.pushUrl || config.pushSuspended) continue;
        targets.push(Object.freeze({ agentId, hostId: host.hostId, url: config.pushUrl, token: config.pushToken }));
      }
      return Object.freeze(targets);
    } catch {
      return Object.freeze([]);
    }
  }

  // Fire-and-forget push fan-out for one room event. The synchronous part
  // (offline gating + target selection) runs on the request path; each
  // POST runs async and its outcome updates the durable failure counters.
  // Total: the push path can never fail or delay the caller's command.
  pushNotify({ identityId, eventType, roomId, id, ts } = {}) {
    try {
      check(typeof identityId === "string" && identityId.length > 0, 422, "invalid_heartbeat", "identityId is required");
      check(PUSH_EVENT_TYPES.includes(eventType), 422, "invalid_heartbeat", `eventType must be one of ${PUSH_EVENT_TYPES.join(", ")}`);
      for (const target of this.pushTargets(identityId)) {
        const pending = this.deliverPush({ ...target, eventType, roomId, id, ts }).catch(() => {});
        this._pushInflight.push(pending);
      }
    } catch {
      // The push path never fails the caller.
    }
    return this;
  }

  // Test helper: await every push POST scheduled so far.
  async flushPushes() {
    const pending = this._pushInflight.splice(0, this._pushInflight.length);
    await Promise.all(pending);
  }

  // POST one push doorbell. Pointer-only body — never message bodies; the
  // receiver pulls the real event from its agent inbox. 2xx within 5s is
  // delivered (failures reset); anything else increments push_failures,
  // and 3 consecutive failures suspend the subscription until the agent
  // re-arms it with a fresh pushNotification.
  async deliverPush({ agentId, hostId, url, token, eventType, roomId, id, ts }) {
    const envelope = Object.freeze({ eventType, roomId, id, ts });
    const headers = Object.freeze({
      "Content-Type": "application/json",
      "X-Room-Notification-Token": token,
    });
    let result;
    try {
      result = await postDelivery({
        fetchImpl: this.pushFetchImpl ?? ((...args) => fetch(...args)),
        url, envelope, headers,
        timeoutMs: PUSH_DELIVERY_TIMEOUT_MS,
        dnsResolvers: this.pushDnsResolvers ?? undefined,
      });
    } catch (error) {
      result = { ok: false, error: String(error?.message ?? error).slice(0, 500) };
    }
    const at = this.now();
    if (result.ok) {
      this.db.prepare("UPDATE agent_push_configs SET push_failures=0, updated_at=? WHERE agent_id=? AND host_id=?")
        .run(at, agentId, hostId);
    } else {
      const row = this.db.prepare(
        "SELECT push_failures AS pushFailures FROM agent_push_configs WHERE agent_id=? AND host_id=?")
        .get(agentId, hostId);
      const failures = (row?.pushFailures ?? 0) + 1;
      this.db.prepare(`UPDATE agent_push_configs
        SET push_failures=?, push_suspended=?, updated_at=? WHERE agent_id=? AND host_id=?`)
        .run(failures, failures >= PUSH_SUSPEND_AFTER_FAILURES ? 1 : 0, at, agentId, hostId);
    }
    return result;
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
  // its own reachability window, offline when every host is stale,
  // unregistered when no host ever reported.
  //
  // RC-2026-09-24-203: the window is per host — max(180s, cadenceSeconds *
  // 1.5) — read from the host's push/cadence row; hosts that never declared
  // a cadence read the 180s default.
  statusOf(agentId) {
    checkAgentId(agentId);
    const at = this.now();
    const hosts = this.db.prepare("SELECT * FROM agent_hosts WHERE agent_id=? ORDER BY last_seen_at DESC")
      .all(agentId);
    if (hosts.length === 0) {
      return Object.freeze({ agentId, status: "unregistered", lastSeenAt: null, hosts: Object.freeze([]) });
    }
    let cadences = new Map();
    try {
      cadences = new Map(this.db.prepare(
        "SELECT host_id AS hostId, cadence_seconds AS cadenceSeconds FROM agent_push_configs WHERE agent_id=?")
        .all(agentId).map(row => [row.hostId, row.cadenceSeconds]));
    } catch {
      // Older database without the push table: every host reads the
      // default window (read-only never migrates).
    }
    const withState = hosts.map(row => {
      const cadenceSeconds = cadences.get(row.host_id) ?? null;
      const windowMs = this.windowFor(cadenceSeconds);
      const view = hostView(row, cadenceSeconds);
      return Object.freeze({ ...view, state: at - view.lastSeenAt <= windowMs ? "online" : "stale" });
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
