// Agent host heartbeats and the durable mention/DM wake queue.
//
// Each agent identity has zero or more hosts. A host is wakeable (the
// default) or pull-only. Wakeable hosts wait on GET /api/agent-wakes/poll
// and may also register an HTTPS wake URL. Pull-only hosts register no
// wake URL. Presence is online when any host was seen inside its
// reachability window (max(180s, cadenceSeconds * 1.5)), offline when
// every host is stale, and unregistered when no host has reported.
//
// Any agent with at least one registered host gets one wake signal per
// mention or DM, whatever the host's mode or presence. The same message
// coalesces to one signal (agent plus message). POST /api/agent-heartbeats
// returns that host's unacknowledged signals in pendingWakes, oldest
// first, at most 50, with more:true when the page is truncated. The poll
// does not acknowledge. The host acknowledges with ackWakes.
//
// Push is a separate doorbell. An offline wakeable host with a usable
// push subscription receives a pointer-only POST. Push does not decide
// who gets a queued signal.
//
// SQLite persistence survives restarts. The schema is additive.
import { randomBytes } from "node:crypto";
import { validateWebhookUrl, assertWebhookHostDnsPublic, WAKE_ACK_HINT } from "./outbound-webhooks.mjs";
import { postDelivery } from "./webhook-dispatch.mjs";
import { recordWakeEvent, wakeAccounting } from "./wake-metrics.mjs";
import { sqlChunks, sqlPlaceholders } from "./sql-binds.mjs";

const MODES = Object.freeze(["wakeable", "pull-only"]);
const WAKE_KINDS = Object.freeze(["mention", "dm", "bond", "assignment", "land"]);
const STATUSES = Object.freeze(["online", "offline", "unregistered"]);
// RC-2026-09-24-203: the default reachability window is 180s (was 60s).
// Per host the window is max(180s, cadenceSeconds * 1.5).
export const HEARTBEAT_STALE_AFTER_MS = 180000;
// plan-wake-live: an agent is "wakeable" when it polled (GET
// /api/agent-wakes/poll) or heartbeated within the last 24h. Deliberately
// far wider than the 180s presence window: presence measures host
// liveness, wakeability measures listener recency — the room must tell a
// live listener from an idle agent whose queue merely looks empty.
export const WAKEABLE_WINDOW_MS = 24 * 60 * 60 * 1000;
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
//
// Issue #2913: wake-signal coalescing is scoped per room. Message and
// claim-wake ids repeat across rooms (claim TASK-1 can exist in two rooms),
// but the original table declared UNIQUE(agent_id, message_id), so a wake
// enqueued for room A suppressed the same message id's wake for room B. The
// coalescing key is now the unique index agent_wake_signals_coalesce on
// (agent_id, COALESCE(room_id, ''), message_id): the expression keeps
// room-less signals coalescing with each other (a plain UNIQUE would treat
// NULL room_ids as distinct and stop coalescing them). Deployed databases
// still carry the old table-level constraint — convergeWakeSignalRoomScope
// (below) rebuilds the table row-preserving at boot, mirroring
// convergeBountyDeployedSchema, because CREATE TABLE IF NOT EXISTS cannot
// rewrite stored DDL and the strict DDL-text verifySchema compares it
// verbatim.
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
    kind TEXT NOT NULL CHECK(kind IN ('mention','dm','bond','assignment','land')),
    room_id TEXT, message_id TEXT,
    created_at INTEGER NOT NULL, delivered_at INTEGER
  );
  CREATE UNIQUE INDEX IF NOT EXISTS agent_wake_signals_coalesce ON agent_wake_signals(agent_id, COALESCE(room_id, ''), message_id);
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
  CREATE TABLE IF NOT EXISTS agent_wake_polls (
    agent_id TEXT PRIMARY KEY,
    last_polled_at INTEGER NOT NULL
  );
`;
// plan-wake-live: agent_wake_polls is the durable per-agent last-polled-at.
// Recorded on poll AND heartbeat activity (a heartbeat carries the pending
// queue, so it proves the host is listening). Purely additive: existing
// tables are never altered; agents from before this table existed simply
// read as not wakeable until they next poll or heartbeat. (The comment
// lives outside the template: verifySchema() splits the schema on
// statement boundaries and SQL comments between statements break it.)

// Bolter steal #5 — durable listener queue: single-listener leases with
// fencing tokens, atomic batch claims, and redelivery flags. Kept OUT of
// agentHeartbeatSchema and created lazily (CREATE TABLE IF NOT EXISTS), so
// old databases keep passing the strict DDL-text verifySchema and no
// store.mjs migration hook is needed. Signals leave the queue only through
// ackWakes(); the lease layer only decides WHO may claim and ack them.
export const wakeListenerLeaseSchema = `
  CREATE TABLE IF NOT EXISTS agent_wake_listener_leases (
    agent_id TEXT NOT NULL, room_key TEXT NOT NULL DEFAULT '',
    listener_id TEXT NOT NULL, fencing_token TEXT NOT NULL,
    lease_expires_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    PRIMARY KEY(agent_id, room_key)
  );
  CREATE TABLE IF NOT EXISTS agent_wake_signal_claims (
    signal_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL,
    claimed_by TEXT NOT NULL, claimed_at INTEGER NOT NULL,
    redelivered INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS agent_wake_signal_claims_agent ON agent_wake_signal_claims(agent_id, claimed_at);
`;
// A claim is abandoned when its fencing token no longer holds a live lease;
// redelivery replays the batch with redelivered=true.
export const WAKE_LISTENER_LEASE_TTL_MS = 60000;

// CX5-FIX: room-attributed listener activity. agent_wake_polls is the
// identity-GLOBAL last-activity stamp; activity performed under a
// room-scoped credential (a room access key, or a rak_ API key bound to one
// room by its mcp:room: scope) must not advertise the identity as wakeable
// in other rooms, so scoped activity is stamped here instead — one row per
// (agent, room). Lazy DDL for the same reason as the lease tables: kept out
// of agentHeartbeatSchema so deployed databases keep passing the strict
// DDL-text verifySchema.
// Scoped host registrations are namespaced by credential-derived prefixes
// (room-key-presence.mjs): rk_<sha256(secret) hex>_ for room access keys,
// ak_<sha256(keyId) hex, 32 chars>_ for scoped API keys. Presence consumers
// that must see identity-level activity only (pushTargets) exclude them.
export const wakeRoomActivitySchema = `
  CREATE TABLE IF NOT EXISTS agent_wake_room_activity (
    agent_id TEXT NOT NULL, room_id TEXT NOT NULL,
    last_polled_at INTEGER NOT NULL,
    PRIMARY KEY(agent_id, room_id)
  );
`;
export const SCOPED_LISTENER_HOST_PATTERN = /^(?:rk_[a-f0-9]{64}|ak_[a-f0-9]{32})_/;
export const isScopedListenerHostId = hostId =>
  typeof hostId === "string" && SCOPED_LISTENER_HOST_PATTERN.test(hostId);
const WAKE_SIGNAL_FENCED_CODE = "wake_signal_fenced";
const WAKE_SIGNAL_FENCED_MESSAGE = "one or more signals are claimed by another listener — claim them again, then ack with the claiming fencing token";

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
// Bounded above: the window is cadence x 1.5, so an unbounded cadence (1e300)
// kept one heartbeat "online" for good and land-queue wakes (sent only to
// offline claimants) never fired for an agent that had stopped.
export const MAX_CADENCE_SECONDS = 7 * 24 * 3600;
const checkCadenceSeconds = cadenceSeconds =>
  check(Number.isFinite(cadenceSeconds) && cadenceSeconds > 0 && cadenceSeconds <= MAX_CADENCE_SECONDS,
    422, "invalid_heartbeat", `cadenceSeconds must be a positive number of seconds, at most ${MAX_CADENCE_SECONDS} (7 days)`);

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
  // RC-2026-09-24-203: the host's declared poll cadence (null when none
  // is in effect — never declared, or cleared by an explicit null);
  // drives the per-host reachability window.
  cadenceSeconds,
});
// work-claim:{id}:{reason}:… is the claim wake id. Poll and heartbeat
// readers triage on reason without a second table. Other signals stay
// the same shape.
const claimWakeOf = messageId => {
  if (typeof messageId !== "string" || !messageId.startsWith("work-claim:")) return null;
  const parts = messageId.split(":");
  if (parts.length < 3 || parts[1].length === 0 || parts[2].length === 0) return null;
  return { workClaim: parts[1], reason: parts[2] };
};
const signalView = row => {
  const claim = claimWakeOf(row.message_id);
  return Object.freeze({
    signalId: row.signal_id, agentId: row.agent_id, kind: row.kind,
    roomId: row.room_id, messageId: row.message_id,
    createdAt: row.created_at, deliveredAt: row.delivered_at,
    ...(claim ? { workClaim: claim.workClaim, reason: claim.reason } : {}),
    // The explicit ack copy rides the journaled pending-wake signal too.
    ackHint: WAKE_ACK_HINT,
  });
};

// A pre-migration or read-only DB lacks these tables; that is the only error the
// fail-closed reads below may absorb. Busy, locked and I/O errors must surface.
function isMissingTable(error) {
  return /no such (table|column)/i.test(String(error?.message ?? ""));
}

// Issue #2913: deployed databases carry agent_wake_signals with the original
// table-level UNIQUE(agent_id, message_id). ALTER TABLE cannot rewrite the
// stored CREATE TABLE text, so — like convergeBountyDeployedSchema — rebuild
// the table row-preserving when its stored DDL has drifted from the expected
// text, then recreate its indexes (RENAME drops them). Idempotent: a
// converged (or fresh, or absent) table is left alone. Runs inside the
// store's boot transaction before the schema exec; the table is unfenced.
export function convergeWakeSignalRoomScope(db) {
  const normalize = sql => sql?.trim().replace(/;$/, "").replace(/IF NOT EXISTS /g, "").replace(/\s+/g, " ");
  const chunks = agentHeartbeatSchema.trim().split(/;\s*(?=CREATE|$)/).filter(Boolean);
  let tableDdl = null;
  const indexDdls = [];
  for (const sql of chunks) {
    const normalized = normalize(sql);
    if (/^CREATE TABLE agent_wake_signals\b/.test(normalized)) tableDdl = sql;
    else if (/^CREATE (?:UNIQUE )?INDEX \w+ ON agent_wake_signals\b/.test(normalized)) indexDdls.push(sql);
  }
  const tableRow = name => db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name);
  const actual = tableRow("agent_wake_signals")?.sql;
  if (!actual) return; // Fresh database: the schema exec creates the new shape.
  if (normalize(actual) === normalize(tableDdl)) {
    // Table already converged; the coalesce index is purely additive.
    for (const indexDdl of indexDdls) db.exec(indexDdl);
    return;
  }
  const legacy = "agent_wake_signals_legacy_2913";
  if (tableRow(legacy)) throw new Error(`Wake signal schema convergence blocked: ${legacy} already exists`);
  const cols = db.prepare("SELECT name FROM pragma_table_info(?)").all("agent_wake_signals").map(r => r.name);
  const colList = cols.join(", ");
  db.exec(`ALTER TABLE agent_wake_signals RENAME TO ${legacy}`);
  db.exec(tableDdl);
  db.exec(`INSERT INTO agent_wake_signals (${colList}) SELECT ${colList} FROM ${legacy}`);
  db.exec(`DROP TABLE ${legacy}`);
  for (const indexDdl of indexDdls) db.exec(indexDdl);
}

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
    // RC-2026-09-28-3602: in-process wake waiters for the room-hosted poll.
    // agentId+hostId -> { roomId, onWake }. One waiter per host: a second
    // waiter with the same hostId releases the first (it resolves
    // immediately so a reconnecting host never wedges the slot), while a
    // different host's wait is never disturbed. In-memory only — a restart
    // drops waiters, never the durable signals they wait on.
    this._wakeWaiters = new Map();
  }

  now() { return this.store.now(); }

  // Read-only never migrates: verify the additive tables only when present.
  verifySchema({ allowAbsent = false } = {}) {
    const normalize = sql => sql?.trim().replace(/;$/, "").replace(/IF NOT EXISTS /g, "").replace(/\s+/g, " ");
    const expected = agentHeartbeatSchema.trim().split(/;\s*(?=CREATE|$)/).filter(Boolean)
      .map(sql => ({ sql, actual: this.db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(/^CREATE (?:TABLE|(?:UNIQUE )?INDEX) (?:IF NOT EXISTS )?([a-z_]+)/.exec(sql.trim())[1])?.sql }));
    if (allowAbsent && expected.every(({ actual }) => actual === undefined)) return false;
    for (const { sql, actual } of expected) {
      if (normalize(actual) !== normalize(sql)) throw new Error("Agent heartbeat schema requires operator reconciliation");
    }
    return true;
  }

  // Idempotent DDL for the room-activity table (no-op on warm databases).
  ensureRoomActivitySchema() {
    this.db.exec(wakeRoomActivitySchema);
    return this;
  }

  // plan-wake-live: stamp the agent's last-polled-at. Polls and
  // heartbeats both prove the host is listening (a heartbeat response
  // carries the pending wake queue), so both count as poll activity.
  // CX5-FIX: activity under a room-scoped credential passes its roomId and
  // stamps ONLY the room row — never the identity-global row — so scoped
  // listening in one room cannot advertise wakeability in another.
  recordPollActivity(agentId, at = this.now(), roomId = null) {
    if (roomId !== null) {
      check(typeof roomId === "string" && roomId.length > 0,
        422, "invalid_heartbeat", "roomId must be a non-empty string or null");
      this.ensureRoomActivitySchema();
      this.db.prepare(`INSERT INTO agent_wake_room_activity (agent_id, room_id, last_polled_at)
        VALUES (?, ?, ?) ON CONFLICT(agent_id, room_id) DO UPDATE SET last_polled_at=excluded.last_polled_at`)
        .run(agentId, roomId, at);
      return this;
    }
    this.db.prepare(`INSERT INTO agent_wake_polls (agent_id, last_polled_at)
      VALUES (?, ?) ON CONFLICT(agent_id) DO UPDATE SET last_polled_at=excluded.last_polled_at`)
      .run(agentId, at);
    return this;
  }

  // CX5-FIX: the agent's room-scoped activity stamps (one per room it has
  // listened in under a scoped credential). Missing-table tolerant like
  // the other read paths: a pre-feature database reads as no activity.
  roomActivityOf(agentId) {
    try {
      const rows = this.db.prepare(
        "SELECT room_id AS roomId, last_polled_at AS lastPolledAt FROM agent_wake_room_activity WHERE agent_id=?")
        .all(agentId);
      return Object.freeze(rows.map(row => Object.freeze(row)));
    } catch (error) {
      if (!isMissingTable(error)) throw error;
      return Object.freeze([]);
    }
  }

  // plan-wake-live: wakeable = the agent polled or heartbeated within
  // WAKEABLE_WINDOW_MS. Agents that never polled (including host rows
  // from before agent_wake_polls existed) read as not wakeable with a
  // null stamp — never as an error. The COMMS-02 mention-target-warning
  // surface consumes this to warn the poster before @mentioning an
  // idle agent.
  wakeStatusOf(agentId) {
    checkAgentId(agentId);
    let row = null;
    try {
      row = this.db.prepare(
        "SELECT last_polled_at AS lastPolledAt FROM agent_wake_polls WHERE agent_id=?").get(agentId);
    } catch (error) {
      if (!isMissingTable(error)) throw error;
      // Pre-migration DB without agent_wake_polls (read-only opens never
      // migrate): read as not wakeable, mirroring wakeStatusList.
      row = null;
    }
    // CX5-FIX: the identity's own wakeability also counts its room-scoped
    // activity (listening in any room means the identity is listening);
    // room-scoped *consumers* use wakeStatusListForRoom, which attributes
    // per room. lastPolledAt is the freshest stamp of either kind.
    let lastPolledAt = row?.lastPolledAt ?? null;
    for (const roomRow of this.roomActivityOf(agentId)) {
      if (lastPolledAt === null || roomRow.lastPolledAt > lastPolledAt) lastPolledAt = roomRow.lastPolledAt;
    }
    return Object.freeze({
      agentId, lastPolledAt, windowMs: WAKEABLE_WINDOW_MS,
      wakeable: lastPolledAt !== null && this.now() - lastPolledAt <= WAKEABLE_WINDOW_MS,
    });
  }

  // CX5-FIX: wakeStatusList attributed to ONE room. An agent is wakeable
  // for this room when it has fresh identity-level activity (an unscoped
  // listener hears every room it belongs to) OR fresh room-scoped activity
  // attributed to this room. Activity scoped to OTHER rooms never leaks in
  // — the pre-fix list used the identity-global stamp for every room, so a
  // room-key registration made in one room advertised the identity as
  // wakeable in any room it later joined. Entries carry the freshest
  // applicable stamp (the room stamp when it is what qualifies the agent).
  wakeStatusListForRoom(roomId) {
    check(typeof roomId === "string" && roomId.length > 0,
      422, "invalid_heartbeat", "roomId must be a non-empty string");
    const base = this.wakeStatusList();
    const at = this.now();
    let roomRows = [];
    try {
      roomRows = this.db.prepare(
        "SELECT agent_id AS agentId, last_polled_at AS lastPolledAt FROM agent_wake_room_activity WHERE room_id=?")
        .all(roomId);
    } catch (error) {
      if (!isMissingTable(error)) throw error;
      roomRows = [];
    }
    const roomFresh = new Map();
    for (const row of roomRows) {
      if (at - row.lastPolledAt <= WAKEABLE_WINDOW_MS) roomFresh.set(row.agentId, row.lastPolledAt);
    }
    if (roomFresh.size === 0) return base;
    const wakeable = [], notWakeable = [];
    const seen = new Set();
    for (const entry of base.wakeable) { wakeable.push(entry); seen.add(entry.agentId); }
    for (const entry of base.notWakeable) {
      seen.add(entry.agentId);
      const roomStamp = roomFresh.get(entry.agentId);
      if (roomStamp !== undefined) {
        wakeable.push(Object.freeze({ agentId: entry.agentId, lastPolledAt: roomStamp }));
      } else notWakeable.push(entry);
    }
    for (const [agentId, roomStamp] of roomFresh) {
      if (!seen.has(agentId)) wakeable.push(Object.freeze({ agentId, lastPolledAt: roomStamp }));
    }
    wakeable.sort((a, b) => a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0);
    return Object.freeze({
      windowMs: base.windowMs, asOf: base.asOf,
      wakeable: Object.freeze(wakeable), notWakeable: Object.freeze(notWakeable),
    });
  }

  // plan-wake-live: every registered agent partitioned into the wakeable
  // list and the not-wakeable list. Read-only; never migrates (an older
  // DB without agent_wake_polls lists everyone as not wakeable; a
  // pre-heartbeat DB without any of the tables lists nobody at all).
  wakeStatusList() {
    const at = this.now();
    let rows;
    try {
      rows = this.db.prepare(`SELECT h.agent_id AS agentId, p.last_polled_at AS lastPolledAt
        FROM (SELECT DISTINCT agent_id FROM agent_hosts) h
        LEFT JOIN agent_wake_polls p ON p.agent_id = h.agent_id
        ORDER BY h.agent_id`).all();
    } catch (error) {
      if (!isMissingTable(error)) throw error;
      rows = [];
      try {
        rows = this.db.prepare("SELECT DISTINCT agent_id AS agentId FROM agent_hosts ORDER BY agent_id")
          .all().map(row => ({ agentId: row.agentId, lastPolledAt: null }));
      } catch (error) {
        if (!isMissingTable(error)) throw error;
        // Pre-heartbeat DB without agent_hosts either (read-only opens
        // never migrate): nobody registered, both lists stay empty.
      }
    }
    const wakeable = [], notWakeable = [];
    for (const row of rows) {
      const lastPolledAt = row.lastPolledAt ?? null;
      const entry = Object.freeze({ agentId: row.agentId, lastPolledAt });
      (lastPolledAt !== null && at - lastPolledAt <= WAKEABLE_WINDOW_MS ? wakeable : notWakeable).push(entry);
    }
    return Object.freeze({
      windowMs: WAKEABLE_WINDOW_MS, asOf: at,
      wakeable: Object.freeze(wakeable), notWakeable: Object.freeze(notWakeable),
    });
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
  //
  // Cadence is sticky (rotation review P5-F2): cadenceSeconds defaults to
  // undefined, and omission is distinct from an explicit null. Omitting
  // the field preserves the stored declaration; a number replaces it;
  // only an explicit null clears it (back to the 180s default window).
  // The old shape defaulted to null, so any bare heartbeat silently
  // erased a declared cadence — collapsing the presence window, and
  // with #3592 the wakeability window too — for a host that had
  // declared its cadence once and then heartbeated bare.
  heartbeat({ agentId, hostId, mode, wakeUrl = null, cadenceSeconds = undefined, pushNotification = null, workWakes = undefined, workScopeRoomId = null, activityRoomId = null, door = "heartbeat" }) {
    checkAgentId(agentId);
    checkHostId(hostId);
    check(workWakes === undefined || typeof workWakes === "boolean", 422, "invalid_heartbeat", "workWakes must be a boolean");
    // RC-2026-09-28-3602: wakeable is the default; mode may be null when the
    // caller omits it. An explicitly invalid value still fails.
    const effectiveMode = mode === undefined || mode === null ? "wakeable" : mode;
    check(MODES.includes(effectiveMode), 422, "invalid_heartbeat",
      `mode must be one of ${MODES.join(", ")}`);
    if (cadenceSeconds !== null && cadenceSeconds !== undefined) checkCadenceSeconds(cadenceSeconds);
    const push = (pushNotification === null || pushNotification === undefined)
      ? null : checkPushNotification(pushNotification);
    // RC-2026-09-28-3602: wakeUrl is optional for wakeable hosts — without
    // one the host is reached through the room-hosted wake poll; with one
    // it also gets the true-push journal fan-out. pull-only stays
    // self-driven: no push URL.
    let url = null;
    if (effectiveMode === "wakeable") {
      if (wakeUrl !== null && wakeUrl !== undefined) {
        try { url = validateWebhookUrl(wakeUrl); }
        catch (error) { fail(422, "invalid_heartbeat", `invalid wakeUrl: ${error.message}`); }
      }
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
      .run(agentId, hostId, effectiveMode, url, at, at, at);
    // plan-wake-live: heartbeat activity proves the host is listening.
    // CX5-FIX: a room-scoped credential's heartbeat (activityRoomId set by
    // the route) stamps room activity only — never the global stamp.
    this.recordPollActivity(agentId, at, activityRoomId);
    // The push/cadence row tracks the latest heartbeat; push fields change
    // only when the body carries pushNotification (never on bare
    // heartbeats), and a fresh subscription resets failures/suspension.
    // Cadence is sticky (see the heartbeat() header): an omitted
    // cadenceSeconds resolves to the stored declaration before the
    // upsert, so the upsert itself always writes the effective value.
    const cadence = cadenceSeconds === undefined
      ? this.db.prepare("SELECT cadence_seconds AS cadenceSeconds FROM agent_push_configs WHERE agent_id=? AND host_id=?")
          .get(agentId, hostId)?.cadenceSeconds ?? null
      : cadenceSeconds;
    this.db.prepare(`INSERT INTO agent_push_configs
      (agent_id, host_id, cadence_seconds, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(agent_id, host_id) DO UPDATE SET
        cadence_seconds=excluded.cadence_seconds, updated_at=excluded.updated_at`)
      .run(agentId, hostId, cadence, at);
    if (push) {
      this.db.prepare(`UPDATE agent_push_configs
        SET push_url=?, push_token=?, push_auth_json=?, push_failures=0, push_suspended=0, updated_at=?
        WHERE agent_id=? AND host_id=?`)
        .run(push.url, push.token, push.authJson, at, agentId, hostId);
    }
    if (workWakes !== undefined) this.store.workWakes.setHost(agentId, hostId, workWakes, workScopeRoomId);
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
    // RC-2026-09-28-3602: effectiveMode — mode defaults to wakeable.
    const reachability = Object.freeze({
      mode: at > reachableUntil ? "none"
        : (effectiveMode === "wakeable" && pushConfigured && !pushSuspended ? "push" : "poller"),
      reachableUntil,
    });
    const page = this.pendingWakePage(agentId, { hostId, roomId: workScopeRoomId, door });
    const pausedRooms = this.pausedRoomsOf(agentId);
    return Object.freeze({
      host: { ...host, workWakes: this.store.workWakes?.hostEnabled(agentId, hostId) ?? false },
      pendingWakes: page.signals, more: page.more, nextCursor: page.nextCursor,
      ...(pausedRooms.length ? { paused: pausedRooms } : {}),
      pushConfigured, pushSuspended, reachability,
    });
  }

  // R327-1 (r6): the rooms where this identity's member has wakes paused,
  // with who holds the pause ("owner" or "self"). Empty when nothing is
  // paused, so callers can spread the field conditionally.
  pausedRoomsOf(agentId) {
    let rows = [];
    try {
      rows = this.db.prepare(`SELECT l.room_id AS roomId, p.paused_at AS pausedAt, p.reason AS reason, b.paused_role AS role
        FROM identity_links l JOIN wake_queue_pause p ON p.room_id=l.room_id AND p.member_id=l.member_id
        LEFT JOIN wake_queue_pause_by b ON b.room_id=l.room_id AND b.member_id=l.member_id
        WHERE l.identity_id=? ORDER BY l.room_id`).all(agentId);
    } catch (error) {
      // A store without the pause tables has nothing paused; never fail the
      // wake/heartbeat path for it.
      if (!isMissingTable(error)) throw error;
      rows = [];
    }
    return rows.map(row => Object.freeze({ roomId: row.roomId, pausedAt: row.pausedAt, reason: row.reason ?? null,
      heldBy: row.role === "self" ? "self" : "owner",
      resume: row.role === "self" ? "wake_resume lifts your own pause" : "only the room owner or a member manager can resume" }));
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
  // Production never calls this: postDelivery then uses the DNS-pinned
  // transport on Node (plain fetch on Workers) and the real DNS resolver.
  // Tests inject mocks here.
  setPushTransport({ fetchImpl = null, dnsResolvers = null } = {}) {
    this.pushFetchImpl = fetchImpl;
    this.pushDnsResolvers = dnsResolvers;
    return this;
  }

  // Eligible push targets for an agent: wakeable hosts with a configured,
  // non-suspended push subscription, and only when the agent is offline.
  // This push policy is separate from durable wake queue eligibility:
  // fresh heartbeat presence does not prove message delivery.
  // Never throws for missing tables (older DB) — returns no
  // targets. The returned targets carry the token only in memory; it is
  // never logged and never enters room state.
  pushTargets(agentId) {
    try {
      checkAgentId(agentId);
      const status = this.statusOf(agentId);
      // CX5-FIX: the offline gate reads IDENTITY-LEVEL presence only.
      // Room-scoped registrations (rk_/ak_ namespaced hosts) must not
      // suppress push: a pull-only room-key heartbeat in one room used to
      // hold the identity "online" globally and silently starve the push
      // doorbell for its real wakeable hosts. Scoped hosts can never carry
      // push configs (scoped credentials are refused push registration),
      // so excluding them from the gate changes nothing else.
      const ownHosts = status.hosts.filter(host => !isScopedListenerHostId(host.hostId));
      const identityOnline = ownHosts.some(host => host.state === "online");
      if (ownHosts.length === 0 || identityOnline) return Object.freeze([]);
      const configs = new Map(this.db.prepare(
        "SELECT host_id AS hostId, push_url AS pushUrl, push_token AS pushToken, push_suspended AS pushSuspended FROM agent_push_configs WHERE agent_id=?")
        .all(agentId).map(row => [row.hostId, row]));
      const targets = [];
      for (const host of ownHosts) {
        if (host.mode !== "wakeable") continue;
        const config = configs.get(host.hostId);
        if (!config || !config.pushUrl || config.pushSuspended) continue;
        targets.push(Object.freeze({ agentId, hostId: host.hostId, url: config.pushUrl, token: config.pushToken }));
      }
      return Object.freeze(targets);
    } catch (error) {
      if (!isMissingTable(error)) throw error;
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
        // M-3: settled deliveries self-remove — without this, one settled
        // promise is retained per offline wakeable host per event, forever.
        this._pushInflight.push(pending);
        pending.then(() => {
          const at = this._pushInflight.indexOf(pending);
          if (at >= 0) this._pushInflight.splice(at, 1);
        });
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
      // No fetchImpl here: production uses postDelivery's DNS-pinned
      // transport (M-1 fix). Tests inject one via setPushTransport.
      result = await postDelivery({
        ...(this.pushFetchImpl ? { fetchImpl: this.pushFetchImpl } : {}),
        url, envelope, headers,
        timeoutMs: PUSH_DELIVERY_TIMEOUT_MS,
        dnsResolvers: this.pushDnsResolvers ?? undefined,
      });
    } catch (error) {
      result = { ok: false, error: String(error?.message ?? error).slice(0, 500) };
    }
    const at = this.now();
    // #3345: the doorbell is not delivery, but its failures used to exist
    // only as a per-host counter nobody aggregated — count every outcome
    // and journal the failures (reason code only, never the error text).
    const pushKind = { "message.posted": "mention", "dm.posted": "dm", "bond.proposed": "bond",
      "assignment.created": "assignment", "land.updated": "land" }[eventType] ?? "";
    recordWakeEvent(this.db, { at, roomId, store: "signals",
      event: result.ok ? "doorbell_delivered" : "doorbell_failed", door: "push", kind: pushKind,
      subjectId: agentId, ...(result.ok ? {} : { reason: "push_delivery_failed" }) });
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

  // Mark wake signals delivered after the host handled them (ack is
  // idempotent). While a listener lease is live for a signal's room, acks
  // for that signal must carry the lease's fencing token or they get 409
  // listener_fenced; with no lease the call behaves exactly as before
  // (backward compatible). The fence keys off the SIGNALS' rooms, not the
  // ack call's roomId: a null roomId acks across rooms, so looking the
  // lease up by the ack's own room key let a wrong token bypass a live
  // lease covering the signals' actual rooms. The check and the mutation
  // run under one write lock (a savepoint when the caller already holds a
  // transaction, else BEGIN IMMEDIATE), so a lease expiring or changing
  // hands between the check and the UPDATE cannot let a stale ack through.
  ackWakes({ agentId, signalIds, roomId = null, fencingToken = null, door = "rest" }) {
    checkAgentId(agentId);
    check(Array.isArray(signalIds) && signalIds.length > 0
      && signalIds.every(id => typeof id === "string" && id.length > 0),
      422, "invalid_heartbeat_ack", "signalIds must be a non-empty string array");
    check(fencingToken === null || (typeof fencingToken === "string" && fencingToken.length > 0),
      422, "invalid_heartbeat_ack", "fencingToken must be a non-empty string or null");
    // #3266: the registration gate poll enforces applies at ack too — an
    // identity no host has ever reported for has no queue to drain, on
    // either door (both REST and MCP funnel through here). Before this,
    // poll said "not registered / nothing to wait on" while ack happily
    // drained the same identity's queue, so the contract contradicted
    // itself by door.
    let known = null;
    try {
      known = this.db.prepare("SELECT 1 FROM agent_hosts WHERE agent_id=? LIMIT 1").get(agentId);
    } catch (error) {
      if (!isMissingTable(error)) throw error;
    }
    if (!known) {
      recordWakeEvent(this.db, { at: this.now(), roomId, store: "signals",
        event: "ack_unregistered", door, subjectId: agentId });
      fail(404, "agent_not_registered",
        "No host has reported for this identity yet — POST /api/agent-heartbeats first, then poll.");
    }
    const at = this.now();
    this.ensureListenerSchema();
    // The Worker's SQL takes at most 100 binds and the REST door does not cap
    // signalIds, so the id lists below are bound in chunks (sql-binds.mjs).
    const chunks = [...sqlChunks(signalIds)];
    // The store's own transaction runner owns the write lock: BEGIN IMMEDIATE on
    // Node, transactionSync on a Durable Object (which rejects raw BEGIN,
    // SAVEPOINT and COMMIT), and a join when the caller already holds one. The
    // check and the UPDATE loop run under one lock, so a lease expiring or
    // changing hands between them cannot let a stale ack through.
    return this.store.transaction(() => {
      const holders = chunks.flatMap(chunk => this.db.prepare(`SELECT DISTINCT l.fencing_token AS fencingToken
        FROM agent_wake_signals s
        JOIN agent_wake_listener_leases l
          ON l.agent_id = s.agent_id AND l.room_key = COALESCE(s.room_id, '')
        WHERE s.agent_id = ? AND s.signal_id IN (${sqlPlaceholders(chunk)})
          AND s.delivered_at IS NULL AND (? IS NULL OR s.room_id = ?)
          AND l.lease_expires_at > ?`)
        .all(agentId, ...chunk, roomId, roomId, at));
      if (holders.some(({ fencingToken: holder }) => holder !== fencingToken)) {
        fail(409, "listener_fenced",
          "a live listener lease holds this agent's wake queue — ack with its fencing token");
      }
      // Owner fence: a pending signal with a claim row belongs to the token
      // that claimed it, live lease or not. Another token (or no token) must
      // claim it again first, so an abandoned batch is redelivered with its
      // flag and never deleted by a listener that did not handle it. Signals
      // that were never claimed keep the old behavior. Same write lock as the
      // check above, so nothing can change between this read and the UPDATE.
      const foreign = chunks.reduce((n, chunk) => n + this.db.prepare(`SELECT COUNT(*) AS n FROM agent_wake_signals s
        JOIN agent_wake_signal_claims c ON c.signal_id = s.signal_id
        WHERE s.agent_id = ? AND s.signal_id IN (${sqlPlaceholders(chunk)})
          AND s.delivered_at IS NULL AND (? IS NULL OR s.room_id = ?)
          AND (? IS NULL OR c.claimed_by != ?)`)
        .get(agentId, ...chunk, roomId, roomId, fencingToken, fencingToken).n, 0);
      if (foreign > 0) {
        fail(409, WAKE_SIGNAL_FENCED_CODE, WAKE_SIGNAL_FENCED_MESSAGE);
      }
      const acknowledged = [];
      const stmt = this.db.prepare(
        "UPDATE agent_wake_signals SET delivered_at=? WHERE agent_id=? AND signal_id=? AND delivered_at IS NULL AND (? IS NULL OR room_id=?)");
      for (const signalId of signalIds) {
        if (stmt.run(at, agentId, signalId, roomId, roomId).changes > 0) acknowledged.push(signalId);
      }
      // #3345: acks are the delivery completion — count them per door,
      // with each signal's own kind/room (an ack may span rooms).
      if (acknowledged.length > 0) {
        const kinds = new Map([...sqlChunks(acknowledged)].flatMap(chunk => this.db.prepare(
          `SELECT signal_id AS signalId, kind, room_id AS roomId FROM agent_wake_signals WHERE signal_id IN (${sqlPlaceholders(chunk)})`)
          .all(...chunk)).map(row => [row.signalId, row]));
        for (const signalId of acknowledged) {
          const row = kinds.get(signalId);
          recordWakeEvent(this.db, { at, roomId: row?.roomId ?? roomId, store: "signals",
            event: "acked", door, kind: row?.kind ?? "", subjectId: agentId });
        }
      }
      const workAcked = this.store.workWakes?.ack(agentId, signalIds, roomId) ?? [];
      for (const signalId of workAcked) {
        recordWakeEvent(this.db, { at, roomId, store: "work",
          event: "acked", door, kind: "work", subjectId: agentId });
        acknowledged.push(signalId);
      }
      return Object.freeze({ acknowledged: Object.freeze(acknowledged) });
    });
  }

  // Idempotent DDL for the lease tables (no-op on warm databases).
  ensureListenerSchema() {
    this.db.exec(wakeListenerLeaseSchema);
    return this;
  }

  roomKeyOf(roomId) {
    check(roomId === null || (typeof roomId === "string" && roomId.length > 0),
      422, "invalid_listener_lease", "roomId must be a non-empty string or null");
    return roomId ?? "";
  }

  // One live lease per (agent, room): a second listener is refused and the
  // refusal names the running listener. The same listenerId renews its own
  // lease and keeps its fencing token; an expired lease is free for anyone.
  acquireListenerLease({ agentId, roomId = null, listenerId, ttlMs = WAKE_LISTENER_LEASE_TTL_MS }) {
    checkAgentId(agentId);
    const roomKey = this.roomKeyOf(roomId);
    check(typeof listenerId === "string" && HOST_ID_PATTERN.test(listenerId),
      422, "invalid_listener_lease", "listenerId must match [A-Za-z0-9._-]{1,128}");
    check(Number.isFinite(ttlMs) && ttlMs > 0,
      422, "invalid_listener_lease", "ttlMs must be a positive number");
    this.ensureListenerSchema();
    const at = this.now();
    const existing = this.db.prepare(`SELECT listener_id AS listenerId, fencing_token AS fencingToken,
      lease_expires_at AS leaseExpiresAt FROM agent_wake_listener_leases WHERE agent_id=? AND room_key=?`)
      .get(agentId, roomKey);
    if (existing && existing.leaseExpiresAt > at) {
      if (existing.listenerId === listenerId) {
        this.db.prepare(`UPDATE agent_wake_listener_leases SET lease_expires_at=?, updated_at=?
          WHERE agent_id=? AND room_key=?`).run(at + ttlMs, at, agentId, roomKey);
        return Object.freeze({ acquired: true, fencingToken: existing.fencingToken, listenerId, renewed: true, leaseExpiresAt: at + ttlMs });
      }
      return Object.freeze({ acquired: false, activeListenerId: existing.listenerId, leaseExpiresAt: existing.leaseExpiresAt });
    }
    const fencingToken = randomBytes(16).toString("base64url");
    this.db.prepare(`INSERT INTO agent_wake_listener_leases
      (agent_id, room_key, listener_id, fencing_token, lease_expires_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(agent_id, room_key) DO UPDATE SET listener_id=excluded.listener_id,
        fencing_token=excluded.fencing_token, lease_expires_at=excluded.lease_expires_at,
        updated_at=excluded.updated_at`)
      .run(agentId, roomKey, listenerId, fencingToken, at + ttlMs, at);
    return Object.freeze({ acquired: true, fencingToken, listenerId, renewed: false, leaseExpiresAt: at + ttlMs });
  }

  // Claim the oldest unacked wake signals as one atomic batch for the
  // fencing-token holder. A single INSERT...SELECT is implicitly atomic, so
  // no explicit transaction is needed. Signals already claimed by this same
  // token are skipped; signals whose token no longer holds a live lease are
  // reclaimed with redelivered=true. Requires a live lease for the token —
  // otherwise 409 stale_listener. Claimed signals leave the queue only
  // through ackWakes().
  claimWakeBatch({ agentId, roomId = null, fencingToken, limit = MAX_PENDING_WAKES }) {
    checkAgentId(agentId);
    const roomKey = this.roomKeyOf(roomId);
    check(typeof fencingToken === "string" && fencingToken.length > 0,
      422, "invalid_wake_claim", "fencingToken is required");
    check(Number.isInteger(limit) && limit > 0 && limit <= MAX_PENDING_WAKES,
      422, "invalid_wake_claim", `limit must be 1..${MAX_PENDING_WAKES}`);
    this.ensureListenerSchema();
    const at = this.now();
    const lease = this.db.prepare(`SELECT fencing_token AS fencingToken, lease_expires_at AS leaseExpiresAt
      FROM agent_wake_listener_leases WHERE agent_id=? AND room_key=?`).get(agentId, roomKey);
    if (!lease || lease.leaseExpiresAt <= at || lease.fencingToken !== fencingToken)
      fail(409, "stale_listener", "no live listener lease for this fencing token — acquire a lease first");
    const claimed = this.db.prepare(`INSERT INTO agent_wake_signal_claims
        (signal_id, agent_id, claimed_by, claimed_at, redelivered)
        SELECT s.signal_id, ?, ?, ?, CASE WHEN c.signal_id IS NULL THEN 0 ELSE 1 END
        FROM agent_wake_signals s
        LEFT JOIN agent_wake_signal_claims c ON c.signal_id = s.signal_id
        WHERE s.agent_id=? AND s.delivered_at IS NULL AND (? IS NULL OR s.room_id=?)
          AND (c.signal_id IS NULL OR (c.claimed_by != ? AND NOT EXISTS (
            SELECT 1 FROM agent_wake_listener_leases o
            WHERE o.agent_id = s.agent_id AND o.fencing_token = c.claimed_by AND o.lease_expires_at > ?)))
          AND EXISTS (SELECT 1 FROM agent_wake_listener_leases l
            WHERE l.agent_id = ? AND l.room_key = ? AND l.fencing_token = ? AND l.lease_expires_at > ?)
        ORDER BY s.created_at ASC LIMIT ?
        ON CONFLICT(signal_id) DO UPDATE SET claimed_by=excluded.claimed_by,
          claimed_at=excluded.claimed_at, redelivered=excluded.redelivered
        RETURNING signal_id, redelivered`)
      .all(agentId, fencingToken, at, agentId, roomId, roomId, fencingToken, at, agentId, roomKey, fencingToken, at, limit);
    const views = this.db.prepare("SELECT * FROM agent_wake_signals WHERE signal_id=?");
    const signals = claimed.map(({ signal_id, redelivered }) =>
      Object.freeze({ ...signalView(views.get(signal_id)), redelivered: redelivered === 1 }));
    // #3345: a claimed batch is a delivery on the listener door.
    for (const signal of signals) {
      recordWakeEvent(this.db, { at, roomId: signal.roomId ?? roomId, store: "signals",
        event: "delivered", door: "listener", kind: signal.kind, subjectId: agentId });
    }
    return Object.freeze({ signals: Object.freeze(signals) });
  }

  // Release a listener lease. The holder's unacked claims are freed at once —
  // marked redelivered so the next claim replays them immediately (flagged).
  // A wrong token releases nothing.
  releaseListenerLease({ agentId, roomId = null, fencingToken }) {
    checkAgentId(agentId);
    const roomKey = this.roomKeyOf(roomId);
    check(typeof fencingToken === "string" && fencingToken.length > 0,
      422, "invalid_listener_lease", "fencingToken is required");
    this.ensureListenerSchema();
    const dropped = this.db.prepare(`DELETE FROM agent_wake_listener_leases
      WHERE agent_id=? AND room_key=? AND fencing_token=?`).run(agentId, roomKey, fencingToken);
    if (dropped.changes > 0) {
      this.db.prepare(`UPDATE agent_wake_signal_claims
        SET claimed_by='', redelivered=1 WHERE claimed_by=?`).run(fencingToken);
    }
    return Object.freeze({ released: dropped.changes > 0 });
  }

  // Enqueue a wake signal for an agent (mention, DM, bond, assignment, or
  // land update — WAKE_KINDS). Coalesced on
  // (agent_id, room_id, message_id) — issue #2913: message ids repeat
  // across rooms, so the same message wakes an agent once per room.
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
    // #3345: every emission attempt resolves to exactly one audited outcome.
    recordWakeEvent(this.db, { at, roomId, store: "signals",
      event: applied.changes > 0 ? "emitted" : "coalesced", kind, subjectId: agentId });
    const row = this.db.prepare(
      "SELECT * FROM agent_wake_signals WHERE agent_id=? AND room_id IS ? AND message_id=?").get(agentId, roomId, messageId);
    // RC-2026-09-28-3602: a genuinely new signal releases the room-hosted
    // poll waiter (coalesced duplicates don't — nothing new arrived).
    // R327-1 (r6): a held (paused) room wake does not release the host's
    // poll; it stays queued until the pause is lifted.
    if (applied.changes > 0 && !(roomId && this.pausedRoomsOf(agentId).some(p => p.roomId === roomId))) this._releaseWakeWaiter(agentId, roomId);
    return Object.freeze({ enqueued: applied.changes > 0, signal: signalView(row) });
  }

  // Undelivered wake signals, oldest first, capped at the caller's limit.
  pendingWakes(agentId, options = {}) {
    return this.pendingWakePage(agentId, options).signals;
  }

  // One page of unacknowledged signals for the host's rooms, oldest first.
  // `more` is true when a signal remains past the cap. Fetching one extra
  // row from each source is enough: the oldest page takes at most `limit`
  // rows from either source.
  pendingWakePage(agentId, { limit = MAX_PENDING_WAKES, roomId = null, hostId = null, door = "heartbeat", cursor = null } = {}) {
    checkAgentId(agentId);
    check(Number.isInteger(limit) && limit > 0 && limit <= MAX_PENDING_WAKES,
      422, "invalid_heartbeat", `limit must be 1..${MAX_PENDING_WAKES}`);
    const scope = [1, agentId, roomId, hostId];
    let after = null;
    if (cursor !== null) {
      try {
        if (typeof cursor !== "string" || cursor.length > 1024) throw new Error();
        const value = JSON.parse(Buffer.from(cursor, "base64url").toString());
        if (!Array.isArray(value) || value.length !== 6 || JSON.stringify(value.slice(0, 4)) !== JSON.stringify(scope)
          || !Number.isSafeInteger(value[4]) || value[4] < 0 || typeof value[5] !== "string" || value[5].length > 128) throw new Error();
        after = { createdAt: value[4], signalId: value[5] };
      } catch { check(false, 422, "invalid_wake_cursor", "Wake cursor does not match this scope"); }
    }
    const probe = limit + 1;
    const held = new Set(this.pausedRoomsOf(agentId).map(p => p.roomId));
    const messages = this.db.prepare(`SELECT * FROM agent_wake_signals
      WHERE agent_id=? AND delivered_at IS NULL AND (? IS NULL OR room_id=?)
      AND (? IS NULL OR created_at>? OR (created_at=? AND signal_id>?))
      AND (room_id IS NULL OR room_id NOT IN (SELECT value FROM json_each(?)))
      ORDER BY created_at,signal_id LIMIT ?`)
      .all(agentId, roomId, roomId, after?.createdAt ?? null, after?.createdAt ?? 0,
        after?.createdAt ?? 0, after?.signalId ?? "", JSON.stringify([...held]), probe).map(signalView);
    const work = this.store.workWakes?.pending(agentId, { roomId, hostId, limit: probe, after }) ?? [];
    const combined = [...messages, ...work].filter(s => !held.has(s.roomId))
      .sort((a, b) => a.createdAt - b.createdAt || (a.signalId < b.signalId ? -1 : a.signalId > b.signalId ? 1 : 0));
    const page = combined.slice(0, limit);
    // #3345: a served page is a delivery on this door. Count presentations
    // per store/kind (batched) so emitted vs delivered vs acked reconciles.
    if (page.length > 0) {
      const workIds = new Set(work.map(entry => entry.signalId));
      const batches = new Map();
      for (const signal of page) {
        const isWork = workIds.has(signal.signalId);
        const key = `${isWork ? "work" : "signals"}\0${isWork ? "work" : signal.kind}\0${signal.roomId ?? ""}`;
        batches.set(key, (batches.get(key) ?? 0) + 1);
      }
      for (const [key, n] of batches) {
        const [store, kind, room] = key.split("\0");
        recordWakeEvent(this.db, { at: this.now(), roomId: room === "" ? null : room,
          store, event: "delivered", door, kind, n });
      }
    }
    return Object.freeze({
      signals: Object.freeze(page),
      more: combined.length > limit,
      nextCursor: combined.length > limit ? Buffer.from(JSON.stringify([...scope, page.at(-1).createdAt, page.at(-1).signalId])).toString("base64url") : null,
    });
  }

  // RC-2026-09-28-3602: room-hosted wake poll — a synchronous, durable,
  // non-consuming read of the agent's pending wake signals. When called
  // before any wait, it returns the current pending set immediately (so
  // the HTTP wait layer can release instantly on a signal that landed
  // between requests); called after a wait it returns the fresh set.
  // Registration is established by heartbeat(), so notePoll refuses
  // unregistered agents the same way presence reads report them
  // "unregistered" — an unknown agent has nothing to wait on. This never
  // acknowledges: signals leave the queue only through ackWakes().
  notePoll({ agentId, roomId = null, hostId = null, cursor = null }) {
    checkAgentId(agentId);
    let known = null;
    try {
      known = this.db.prepare("SELECT 1 FROM agent_hosts WHERE agent_id=? LIMIT 1").get(agentId);
    } catch (error) {
      if (!isMissingTable(error)) throw error;
      // Pre-heartbeat DB without agent_hosts (read-only opens never
      // migrate): no host ever reported, so the agent is unregistered.
    }
    if (!known) return Object.freeze({ agentId, registered: false, pendingWakes: Object.freeze([]), more: false });
    // plan-wake-live: the poll itself is listener evidence — best-effort on
    // pre-migration DBs without agent_wake_polls (read-only never migrates).
    // The pending-wake read below still serves; only the stamp is skipped.
    // recordPollActivity stays loud for its write-path caller heartbeat():
    // a missing stamp table there is a real problem, not a legacy DB.
    // CX5-FIX: notePoll's roomId is the caller's credential scope (only
    // room-scoped credentials carry one on this route), so a scoped poll
    // stamps room activity; an unscoped poll stamps the global row.
    try { this.recordPollActivity(agentId, this.now(), roomId); } catch (error) { if (!isMissingTable(error)) throw error; /* no stamp table yet */ }
    // #3262: the poll door is a hosted read, not a hostless one — the caller
    // passes the hostId it required so WorkWakes.pending can apply that
    // host's opt-in consent, exactly as heartbeat() does. Omitting hostId
    // keeps the legacy hostless contract (no work signals).
    // #3265: the poll door carries the same truncation flag as heartbeat —
    // the page object used to be discarded here, so a poll-only agent
    // could not distinguish "exactly 50 pending" from a longer queue.
    const page = this.pendingWakePage(agentId, { roomId, hostId, door: "poll", cursor });
    return Object.freeze({
      agentId, registered: true, pendingWakes: page.signals, more: page.more, nextCursor: page.nextCursor,
    });
  }

  // RC-2026-09-28-3602: register one in-process waiter per HOST for the
  // agent's next wake signal. Returns a release function (idempotent).
  // onWake fires when enqueueWake lands a NEW signal matching the waiter's
  // roomId filter (null matches every room). Reconnecting with the same
  // hostId replaces only that host's waiter, so a stale slot never wedges
  // a host — and a second host's wait is never disturbed (per-agent
  // replacement caused a two-host livelock: each poll released the other
  // and neither ever waited).
  addWakeWaiter(agentId, hostId, { roomId = null, onWake }) {
    checkAgentId(agentId);
    checkHostId(hostId);
    check(typeof onWake === "function", 500, "invalid_wake_waiter", "onWake must be a function");
    const key = `${agentId}\0${hostId}`;
    const previous = this._wakeWaiters.get(key);
    const entry = { roomId, onWake };
    this._wakeWaiters.set(key, entry);
    if (previous && previous !== entry) {
      try { previous.onWake(); } catch { /* a throwing waiter must not break the new one */ }
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (this._wakeWaiters.get(key) === entry) this._wakeWaiters.delete(key);
    };
  }

  // Release every waiter held by the agent's hosts when a new signal lands
  // (roomId-scoped). Never throws — the wake path must not fail the
  // message post.
  _releaseWakeWaiter(agentId, roomId) {
    try {
      const prefix = `${agentId}\0`;
      for (const [key, waiter] of this._wakeWaiters) {
        if (!key.startsWith(prefix)) continue;
        if (waiter.roomId !== null && waiter.roomId !== roomId) continue;
        this._wakeWaiters.delete(key);
        waiter.onWake();
      }
    } catch { /* waiters are best-effort; the durable queue is the contract */ }
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
    let hosts;
    try {
      hosts = this.db.prepare("SELECT * FROM agent_hosts WHERE agent_id=? ORDER BY last_seen_at DESC")
        .all(agentId);
    } catch (error) {
      if (!isMissingTable(error)) throw error;
      // Pre-heartbeat DB without agent_hosts (read-only opens never
      // migrate): no host ever reported — read as unregistered, never an
      // error. presenceForCard promises null for absent heartbeat tables;
      // that promise runs through this shape.
      return Object.freeze({ agentId, status: "unregistered", lastSeenAt: null, hosts: Object.freeze([]) });
    }
    if (hosts.length === 0) {
      return Object.freeze({ agentId, status: "unregistered", lastSeenAt: null, hosts: Object.freeze([]) });
    }
    let cadences = new Map();
    try {
      cadences = new Map(this.db.prepare(
        "SELECT host_id AS hostId, cadence_seconds AS cadenceSeconds FROM agent_push_configs WHERE agent_id=?")
        .all(agentId).map(row => [row.hostId, row.cadenceSeconds]));
    } catch (error) {
      if (!isMissingTable(error)) throw error;
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

  // Queue a wake for every agent that has registered at least one host.
  // Mode and presence do not matter. An agent with no host has nowhere to
  // deliver the signal. Coalescing stays on agent plus room plus message.
  wakeIfOffline({ agentId, kind, roomId = null, messageId }) {
    checkAgentId(agentId);
    if (this.statusOf(agentId).hosts.length === 0) {
      // #3345: the no-host suppression is the documented contract, but it
      // used to be invisible — count it so "agent never registered" is
      // distinguishable from a lost wake.
      recordWakeEvent(this.db, { at: this.now(), roomId, store: "signals",
        event: "suppressed_no_host", kind, subjectId: agentId });
      return Object.freeze({ woken: false, signal: null });
    }
    const { enqueued, signal } = this.enqueueWake({ agentId, kind, roomId, messageId });
    return Object.freeze({ woken: true, enqueued, signal });
  }

  // #3345: the wake-reliability accounting view over this fabric (see
  // server/wake-metrics.mjs for the denominator this number stands on).
  accounting({ roomId = null } = {}) {
    return wakeAccounting(this.db, { now: this.now(), roomId });
  }
}
export { MODES, WAKE_KINDS, STATUSES, HOST_ID_PATTERN };
