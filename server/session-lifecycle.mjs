// Worker-side session lifecycle for the herdr redesign (build lane B14).
//
// Built to D2's design doc:
//   ~/workspace/goals/project-room-herdr-redesign/phase2/design-docs/session-lifecycle.md
// and coded against the SessionAdapter domain interface (REDESIGN.md §2.2 /
// phase1/seam-design.md). B2 is building the adapter implementation in
// parallel — this module duck-types against the SPEC, never the implementation.
//
// What this module is: the room's *record of attachment* to herdr panes
// (D2 §0). It tracks the room's relationship to a pane, never the pane's
// internal truth. Two nouns stay separate: the herdr pane (herdr-owned) and
// the room session (this module, room-owned).
//
// State machine (D2 §1): spawning → active ⇄ detached ⇄ reattaching,
// suspended, draining, destroyed. Transition timeouts are room-configurable
// via DEFAULT_TIMEOUTS / constructor overrides.
//
// Idempotency (D2 §4): every mutating transition requires an idempotencyKey.
// The dedupe store is herdr_session_journal: (idempotencyKey → response,
// recordedAt). A duplicate key returns the stored response byte-for-byte with
// duplicate:true and performs NO herdr call. Keys are scoped per transition;
// entries expire after 24h (idempotencyTtlMs).
//
// Claim coupling (D2 §5): the session lifecycle is DOWNSTREAM of the claim
// lifecycle. onClaimEvent({claimId, event}) moves sessions to draining with
// grace (done 15min / failed 5min / released 30min); session death never
// touches the claim. Boundary law: herdr state never settles claims — this
// module has no code path that writes to the claims board.
//
// Fail-closed: adapter failures are recorded in herdr_backend_state and
// journaled; spawn falls back to a 503 session_backend_unavailable so the
// dispatch layer can issue a legacy session per compat-plan §3.4.
//
// Worker-safe: no node:net anywhere in this module.
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Domain errors — the seam-design §3 taxonomy. B2 owns the canonical
// definitions in server/session-adapter.mjs; these local definitions exist so
// B14 codes and tests against the spec in parallel. Integration must converge
// them (either re-export B2's or have B2 re-export these). Normalized by
// `name` so B2's real instances map identically.
// ---------------------------------------------------------------------------

class DomainError extends Error {
  constructor(message, extra = {}) {
    super(message);
    Object.assign(this, extra);
  }
}
export class VersionMismatchError extends Error { constructor(m, e = {}) { super(m); this.name = "VersionMismatchError"; Object.assign(this, e); } }
export class OccupantChangedError extends Error { constructor(m, e = {}) { super(m); this.name = "OccupantChangedError"; Object.assign(this, e); } }
export class SubscriptionLostError extends Error { constructor(m, e = {}) { super(m); this.name = "SubscriptionLostError"; Object.assign(this, e); } }
export class MethodUnsupportedError extends Error { constructor(m, e = {}) { super(m); this.name = "MethodUnsupportedError"; Object.assign(this, e); } }
export class TransportError extends Error { constructor(m, e = {}) { super(m); this.name = "TransportError"; Object.assign(this, e); } }
export class TimeoutError extends Error { constructor(m, e = {}) { super(m); this.name = "TimeoutError"; Object.assign(this, e); } }
export class ServerError extends Error { constructor(m, e = {}) { super(m); this.name = "ServerError"; Object.assign(this, e); } }
void DomainError;

// Module-level errors (input validation, state conflicts). The routes module
// maps these plus the domain taxonomy to HTTP per D2 §2.9.
export class SessionLifecycleError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.name = "SessionLifecycleError";
    this.status = status;
    this.code = code;
    Object.assign(this, extra);
  }
}

const DOMAIN_ERROR_NAMES = new Set([
  "VersionMismatchError", "OccupantChangedError", "SubscriptionLostError",
  "MethodUnsupportedError", "TransportError", "TimeoutError", "ServerError",
]);
export const isDomainError = err => !!err && DOMAIN_ERROR_NAMES.has(err?.name);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const SESSION_STATES = Object.freeze(
  ["spawning", "active", "detached", "reattaching", "suspended", "draining", "destroyed"]);
export const AGENT_STATES = Object.freeze(["working", "blocked", "idle", "done", "unknown"]);
export const TERMINAL_STATES = Object.freeze(["destroyed"]);
const MIN = 60_000;

// D2 §1.3 proposed values. PROPOSED — not yet tuned against measured bridge
// latency (no bridge exists to measure; B2/B3 in flight). All values are
// room-configurable via createSessionLifecycle options. Deviations from the
// proposal are flagged in the PR.
export const DEFAULT_TIMEOUTS = Object.freeze({
  spawnTimeoutMs: 30_000,      // T1: spawning → active confirm window
  reattachTimeoutMs: 60_000,   // T4: reattach resolve window
  destroyTimeoutMs: 60_000,    // T8: bound on the pane-close call
  pingTimeoutMs: 5_000,        // bound on adapter ping inside heartbeat
  confirmPollMs: 250,          // spawn-confirm snapshot poll interval
  heartbeatCadenceMs: 30_000,  // T2: expected beat cadence (informational)
  heartbeatFailureBudget: 3,   // T2: consecutive failures → detached (~90s)
  idempotencyTtlMs: 24 * 3600_000, // D2 §4.3: dedupe retention
  graceMs: Object.freeze({
    claim_done: 15 * MIN,      // T8: work complete; pane context unneeded
    claim_failed: 5 * MIN,     // T8: failed work, less likely adopted
    claim_released: 30 * MIN,  // §3.4: pane kept alive for warm adoption
    operator: 0,               // explicit operator destroy: immediate
    retention: 0,              // retention cleanup: immediate
  }),
});

const DESTROY_REASONS = Object.freeze(["claim_done", "claim_failed", "claim_released", "operator", "retention"]);
const CLAIM_EVENTS = Object.freeze(["done", "failed", "released"]);
const DETACH_REASONS = Object.freeze(["operator", "bridge_health", "lane_request", "heartbeat_failures"]);

const ID_PATTERN = /^[A-Za-z0-9_:.=-]{1,128}$/;
const KEY_PATTERN = /^[A-Za-z0-9_:.=+/-]{1,256}$/;

// ---------------------------------------------------------------------------
// Schema — the four REDESIGN.md §3 tables, constrained by D2 §2.8 (SessionInfo
// columns) and §4 (idempotencyKey dedupe support). B5 owns the canonical DDL;
// this schema must be a subset B5 can superset without conflict (same table
// and column names, additive only).
// ---------------------------------------------------------------------------

export const herdrLifecycleSchema = `
  CREATE TABLE IF NOT EXISTS herdr_sessions (
    session_id TEXT PRIMARY KEY,
    room_id TEXT,
    claim_id TEXT,
    lane_member_id TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    backend TEXT NOT NULL DEFAULT 'herdr' CHECK(backend IN ('herdr')),
    state TEXT NOT NULL DEFAULT 'spawning'
      CHECK(state IN ('spawning','active','detached','reattaching','suspended','draining','destroyed')),
    kind TEXT,
    pane_id TEXT,
    agent_id TEXT,
    occupant_id TEXT,
    pin_stale INTEGER NOT NULL DEFAULT 0,
    pane_fate_unknown INTEGER NOT NULL DEFAULT 0,
    agent_state TEXT CHECK(agent_state IS NULL OR agent_state IN ('working','blocked','idle','done','unknown')),
    resume_ref TEXT,
    resume_command_json TEXT,
    metadata_json TEXT,
    workspace TEXT, tab TEXT, title TEXT, cwd TEXT,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    drain_reason TEXT,
    drain_at INTEGER,
    pane_closed INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_heartbeat_at INTEGER,
    destroyed_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS herdr_sessions_claim ON herdr_sessions(claim_id, state);
  CREATE INDEX IF NOT EXISTS herdr_sessions_member ON herdr_sessions(lane_member_id, state);
  CREATE INDEX IF NOT EXISTS herdr_sessions_drain ON herdr_sessions(state, drain_at);

  -- Append-only integrity gate (compat-plan §4). Doubles as the idempotency
  -- dedupe store (D2 §4): rows with response_json carry (idempotencyKey →
  -- stored response, recordedAt). The partial unique index enforces one
  -- stored response per key; in-flight/attempt rows (response_json NULL) do
  -- not conflict.
  CREATE TABLE IF NOT EXISTS herdr_session_journal (
    journal_id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    event TEXT NOT NULL,
    transition TEXT,
    idempotency_key TEXT,
    response_json TEXT,
    detail_json TEXT,
    created_by TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS herdr_session_journal_session ON herdr_session_journal(session_id, journal_id);
  CREATE UNIQUE INDEX IF NOT EXISTS herdr_session_journal_idem
    ON herdr_session_journal(idempotency_key) WHERE response_json IS NOT NULL AND idempotency_key IS NOT NULL;
  -- In-flight spawn lock: one live spawn attempt per key (D2 T1 — never two
  -- panes from one key). Released (deleted) when the attempt settles; the
  -- terminal spawn/spawn_failed/spawn_rejected rows remain as the audit trail.
  CREATE UNIQUE INDEX IF NOT EXISTS herdr_session_journal_spawn_inflight
    ON herdr_session_journal(idempotency_key) WHERE event = 'spawn_inflight';

  CREATE TABLE IF NOT EXISTS herdr_lane_optin (
    lane_id TEXT PRIMARY KEY,
    room_id TEXT,
    session_backend TEXT NOT NULL DEFAULT 'herdr' CHECK(session_backend IN ('herdr','legacy')),
    set_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS herdr_backend_state (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    reachable INTEGER NOT NULL DEFAULT 1,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    last_error_code TEXT,
    last_error_message TEXT,
    last_error_at INTEGER,
    last_ok_at INTEGER,
    degraded_since INTEGER,
    updated_at INTEGER NOT NULL
  );
`;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const fail = (status, code, message, extra) => { throw new SessionLifecycleError(status, code, message, extra); };
const checkId = (v, what) => {
  if (typeof v !== "string" || !ID_PATTERN.test(v)) fail(422, "invalid_lifecycle_input", `${what} must match [A-Za-z0-9_:.=-]{1,128}`);
};
const checkKey = v => {
  if (typeof v !== "string" || !KEY_PATTERN.test(v)) fail(422, "invalid_lifecycle_input", "idempotencyKey must be a 1..256 char opaque string");
};
const checkStateEnum = (v, list, what) => {
  if (!list.includes(v)) fail(422, "invalid_lifecycle_input", `${what} must be one of ${list.join(", ")}`);
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

// node:sqlite surfaces constraint violations as ERR_SQLITE_ERROR with a
// numeric errcode; 2067 = SQLITE_CONSTRAINT_UNIQUE (repo convention in
// server/store.mjs masks errcode & 0xff for the primary code).
const isUniqueViolation = e => e?.errcode === 2067;

function withTimeout(promise, ms, what) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(`${what} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const iso = ms => ms == null ? null : new Date(ms).toISOString();

function sessionView(row) {
  return Object.freeze({
    sessionId: row.session_id,
    roomId: row.room_id ?? null,
    claimId: row.claim_id ?? null,
    laneMemberId: row.lane_member_id,
    tenantId: row.tenant_id,
    state: row.state,
    backend: row.backend,
    kind: row.kind ?? null,
    paneId: row.pane_id ?? null,
    agentId: row.agent_id ?? null,
    occupantId: row.occupant_id ?? null,
    pinStale: row.pin_stale === 1,
    lastAgentState: row.agent_state ?? null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    lastHeartbeatAt: iso(row.last_heartbeat_at),
    destroyedAt: iso(row.destroyed_at),
    drainReason: row.drain_reason ?? null,
    drainAt: iso(row.drain_at),
  });
}

function journalView(row) {
  return Object.freeze({
    journalId: row.journal_id,
    sessionId: row.session_id,
    event: row.event,
    transition: row.transition ?? null,
    idempotencyKey: row.idempotency_key ?? null,
    detail: row.detail_json ? JSON.parse(row.detail_json) : null,
    response: row.response_json ? JSON.parse(row.response_json) : null,
    createdBy: row.created_by ?? null,
    createdAt: iso(row.created_at),
  });
}

// ---------------------------------------------------------------------------
// SessionLifecycle
// ---------------------------------------------------------------------------

export function createSessionLifecycle(store, opts = {}) {
  const db = store.db;
  const now = store.now ?? (() => Date.now());
  const timeouts = {
    ...DEFAULT_TIMEOUTS,
    ...(opts.timeouts ?? {}),
    graceMs: { ...DEFAULT_TIMEOUTS.graceMs, ...(opts.timeouts?.graceMs ?? {}) },
  };
  // claimReader: { isLiveClaim(claimId): boolean|Promise<boolean> } — injected
  // by the integration layer (board-owned). Absent → the liveness check is
  // skipped and the integration owns it (documented, never guessed here).
  const claimReader = opts.claimReader ?? null;
  let adapter = opts.adapter ?? null;
  const createAdapter = opts.createAdapter ?? null;

  const requireAdapter = () => {
    const a = adapter ?? (createAdapter ? (adapter = createAdapter()) : null);
    if (!a) fail(503, "session_backend_unavailable",
      "no session adapter configured — herdr backend unwired (B4); refusing to start work against an unpinned backend");
    return a;
  };

  const journal = (sessionId, event, { transition = null, idempotencyKey = null, response = null, detail = null, createdBy = null } = {}) => {
    db.prepare(`INSERT INTO herdr_session_journal
      (session_id, event, transition, idempotency_key, response_json, detail_json, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      sessionId, event, transition, idempotencyKey,
      response ? JSON.stringify(response) : null,
      detail ? JSON.stringify(detail) : null,
      createdBy, now());
  };

  const getRow = sessionId => {
    checkId(sessionId, "sessionId");
    const row = db.prepare("SELECT * FROM herdr_sessions WHERE session_id = ?").get(sessionId);
    if (!row) fail(404, "session_not_found", `no session "${sessionId}"`);
    return row;
  };
  // Dedupe lookup (D2 §4): completed rows only (response_json NOT NULL), TTL'd.
  const dedupeLookup = (key, transition) => {
    const row = db.prepare(`SELECT transition, response_json, created_at FROM herdr_session_journal
      WHERE idempotency_key = ? AND response_json IS NOT NULL
      ORDER BY journal_id DESC LIMIT 1`).get(key);
    if (!row) return null;
    if (now() - row.created_at > timeouts.idempotencyTtlMs) return null; // D2 §4.3: expired → treated as new
    if (row.transition !== transition) {
      fail(422, "idempotency_key_transition_mismatch",
        `idempotency key was recorded for transition "${row.transition}", not "${transition}" — keys are scoped per transition`);
    }
    return JSON.parse(row.response_json);
  };

  const storeResponse = (sessionId, event, key, transition, response, detail = null) => {
    const insert = () => journal(sessionId, event, { transition, idempotencyKey: key, response, detail });
    try {
      insert();
    } catch (e) {
      if (isUniqueViolation(e)) {
        // The conflicting row may be TTL-expired (D2 §4.3): evict it and
        // retry the insert once; otherwise replay the winner's response
        // (concurrent double-submit).
        db.prepare(`DELETE FROM herdr_session_journal
          WHERE idempotency_key = ? AND response_json IS NOT NULL AND created_at <= ?`)
          .run(key, now() - timeouts.idempotencyTtlMs);
        try { insert(); }
        catch (e2) {
          if (isUniqueViolation(e2)) {
            const winner = dedupeLookup(key, transition);
            if (winner) return { ...winner, duplicate: true };
          }
          throw e2;
        }
      } else throw e;
    }
    return { ...response, duplicate: false };
  };

  const storeErrorResponse = (sessionId, event, key, transition, err, detail = null) => {
    const descriptor = {
      ok: false,
      error: {
        name: err?.name ?? "Error",
        code: err instanceof SessionLifecycleError ? err.code : (err?.code ?? err?.name ?? "unknown"),
        status: err instanceof SessionLifecycleError ? err.status : 500,
        message: err?.message ?? String(err),
      },
    };
    try {
      journal(sessionId, event, { transition, idempotencyKey: key, response: descriptor, detail });
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      // Another attempt already recorded the terminal outcome — replay it.
    }
    const winner = dedupeLookup(key, transition);
    void winner;
    throw remapStoredError(descriptor);
  };

  const remapStoredError = descriptor => {
    const e = descriptor.error;
    let err;
    if (e.name && DOMAIN_ERROR_NAMES.has(e.name) && e.name !== "SubscriptionLostError") {
      const Ctor = { VersionMismatchError, OccupantChangedError, MethodUnsupportedError, TransportError, TimeoutError, ServerError }[e.name];
      err = new Ctor(e.message);
      err.code = e.code;
    } else {
      err = new SessionLifecycleError(e.status ?? 500, e.code ?? "unknown", e.message);
    }
    err.duplicate = true;
    err.settled = true; // terminal outcome already journaled — catch blocks must not re-settle
    return err;
  };

  const recordBackendFailure = (code, message) => {
    const at = now();
    db.prepare(`INSERT INTO herdr_backend_state
      (id, reachable, consecutive_failures, last_error_code, last_error_message, last_error_at, degraded_since, updated_at)
      VALUES (1, 0, 1, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET reachable = 0,
        consecutive_failures = consecutive_failures + 1,
        last_error_code = excluded.last_error_code,
        last_error_message = excluded.last_error_message,
        last_error_at = excluded.last_error_at,
        degraded_since = COALESCE(degraded_since, excluded.degraded_since),
        updated_at = excluded.updated_at`).run(code, message, at, at, at);
  };
  const recordBackendOk = () => {
    const at = now();
    db.prepare(`INSERT INTO herdr_backend_state (id, reachable, consecutive_failures, last_ok_at, updated_at)
      VALUES (1, 1, 0, ?, ?)
      ON CONFLICT(id) DO UPDATE SET reachable = 1, consecutive_failures = 0,
        last_ok_at = excluded.last_ok_at, degraded_since = NULL, updated_at = excluded.updated_at`).run(at, at);
  };

  // -- pane helpers (spec-shaped adapter calls) ---------------------------

  const findPaneInSnapshot = (snapshot, paneId) => {
    for (const ws of snapshot?.workspaces ?? []) {
      for (const tab of ws?.tabs ?? []) {
        for (const pane of tab?.panes ?? []) {
          if (pane?.paneId === paneId || pane?.id === paneId) return pane;
        }
      }
    }
    return null;
  };

  // T1 confirm: snapshot shows the pane AND getAgent returns the occupant.
  // Fail-fast (no retry) on fail-closed errors; bounded retry otherwise.
  const confirmPaneLive = async (a, paneId, agentId, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    let lastErr = null;
    for (;;) {
      try {
        const snap = await a.snapshot();
        if (findPaneInSnapshot(snap, paneId)) {
          const info = await a.getAgent(agentId);
          return { paneId, agentId, occupantId: info?.occupantId ?? info?.agentId ?? agentId };
        }
        lastErr = new Error(`pane ${paneId} not in snapshot yet`);
      } catch (e) {
        if (e?.name === "VersionMismatchError" || e?.name === "OccupantChangedError") throw e;
        lastErr = e;
      }
      if (Date.now() >= deadline) break;
      await sleep(Math.min(timeouts.confirmPollMs, Math.max(0, deadline - Date.now())));
    }
    throw lastErr instanceof TimeoutError ? lastErr
      : new TimeoutError(`spawn confirm timed out after ${timeoutMs}ms: ${lastErr?.message ?? lastErr}`);
  };

  const paneAlive = async (a, paneId) => {
    try {
      const snap = await withTimeout(a.snapshot(), timeouts.pingTimeoutMs, "snapshot");
      return !!findPaneInSnapshot(snap, paneId);
    } catch {
      return null; // unknown — caller decides (never speculate)
    }
  };

  // -- public API ----------------------------------------------------------

  async function spawnSession(req = {}) {
    const {
      idempotencyKey, claimId, laneMemberId, tenantId, kind,
      roomId = null, resumeSessionRef = null, resumeCommand = null,
      cwd = null, workspace = null, tab = null, title = null,
      metadata = null, spawnTimeoutMs = timeouts.spawnTimeoutMs,
    } = req ?? {};
    checkKey(idempotencyKey);
    checkId(claimId, "claimId");
    checkId(laneMemberId, "laneMemberId");
    checkId(tenantId, "tenantId");
    if (typeof kind !== "string" || kind.length === 0 || kind.length > 64) {
      fail(422, "invalid_lifecycle_input", "kind must be a non-empty agent-kind label (≤64 chars)");
    }
    if (roomId !== null) checkId(roomId, "roomId");
    if (resumeCommand !== null) {
      if (!Array.isArray(resumeCommand) || resumeCommand.length === 0 || resumeCommand.length > 64 ||
          !resumeCommand.every(a => typeof a === "string")) {
        fail(422, "invalid_lifecycle_input", "resumeCommand must be a 1..64 string array (native --resume shape)");
      }
    }
    if (metadata !== null) {
      if (typeof metadata !== "object" || Array.isArray(metadata) ||
          !Object.values(metadata).every(v => typeof v === "string")) {
        fail(422, "invalid_lifecycle_input", "metadata must be a Record<string,string>");
      }
    }
    if (!Number.isFinite(spawnTimeoutMs) || spawnTimeoutMs <= 0) {
      fail(422, "invalid_lifecycle_input", "spawnTimeoutMs must be a positive number");
    }

    // Dedupe: replay the stored response, no herdr call (D2 §4.2).
    const stored = dedupeLookup(idempotencyKey, "spawn");
    if (stored) {
      if (stored.ok === false) throw remapStoredError(stored);
      return { ...stored, duplicate: true };
    }

    const a = requireAdapter();

    // Same-key retry after a failed attempt: adopt the recorded partial pane
    // when it is still alive and verifiable — never a second live pane for
    // one key (D2 T1).
    const failedAttempt = db.prepare(`SELECT session_id, detail_json FROM herdr_session_journal
      WHERE idempotency_key = ? AND event = 'spawn_failed' ORDER BY journal_id DESC LIMIT 1`).get(idempotencyKey);
    if (failedAttempt) {
      const adopted = await adoptPartialPane(a, failedAttempt.session_id, failedAttempt, { idempotencyKey }, spawnTimeoutMs);
      if (adopted) {
        recordBackendOk();
        return storeResponse(failedAttempt.session_id, "spawn", idempotencyKey, "spawn", adopted, { reattachedPartialPane: true });
      }
      // Partial pane unrecoverable → fall through to a fresh spawn below.
    }

    const sessionId = randomUUID();
    const at = now();
    db.prepare(`INSERT INTO herdr_sessions
      (session_id, room_id, claim_id, lane_member_id, tenant_id, state, kind,
       resume_ref, resume_command_json, metadata_json, workspace, tab, title, cwd, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'spawning', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      sessionId, roomId, claimId, laneMemberId, tenantId, kind,
      resumeSessionRef, resumeCommand ? JSON.stringify(resumeCommand) : null,
      metadata ? JSON.stringify(metadata) : null,
      workspace, tab, title, cwd, at, at);

    // Claim the in-flight lock (unique index) — a concurrent spawn with the
    // same key gets 409 instead of a second pane.
    const releaseInflight = () => db.prepare(
      "DELETE FROM herdr_session_journal WHERE idempotency_key = ? AND event = 'spawn_inflight'").run(idempotencyKey);
    try {
      journal(sessionId, "spawn_inflight", { transition: "spawn", idempotencyKey });
    } catch (e) {
      if (isUniqueViolation(e)) {
        const existing = db.prepare(`SELECT created_at FROM herdr_session_journal
          WHERE idempotency_key = ? AND event = 'spawn_inflight'`).get(idempotencyKey);
        if (existing && now() - existing.created_at > spawnTimeoutMs) {
          releaseInflight(); // stale lock from a crashed attempt — take it over
          journal(sessionId, "spawn_inflight", { transition: "spawn", idempotencyKey });
        } else {
          fail(409, "session_spawn_inflight",
            "a spawn with this idempotency key is already in progress — retry with the same key after it settles");
        }
      } else throw e;
    }

    const failSpawn = async (event, err, detail) => {
      db.prepare("UPDATE herdr_sessions SET state = 'destroyed', destroyed_at = ?, updated_at = ? WHERE session_id = ?")
        .run(now(), now(), sessionId);
      releaseInflight();
      return storeErrorResponse(sessionId, event, idempotencyKey, "spawn", err, detail);
    };

    let handle;
    try {
      // The adapter constructs argv from the allowlisted kind (risk-register
      // rule) — this module never passes raw argv (D2 §2.1, REDESIGN.md §5).
      handle = await withTimeout(
        a.spawnAgent({ kind, resumeSessionRef, resumeCommand, cwd, workspace, tab, title, metadata }),
        spawnTimeoutMs, "spawnAgent");
    } catch (e) {
      if (e?.name === "TransportError" || e?.name === "TimeoutError") {
        // compat-plan §3.4: the lane transparently gets a legacy session —
        // issued by the dispatch layer, not here. Record the fallback.
        recordBackendFailure("herdr_transport_error", e.message);
        journal(sessionId, "spawn_fallback_legacy", {
          transition: "spawn", idempotencyKey,
          detail: { reason: "adapter unreachable; dispatch layer issues legacy session", error: e.message },
        });
        db.prepare("UPDATE herdr_sessions SET state = 'destroyed', destroyed_at = ?, updated_at = ? WHERE session_id = ?")
          .run(now(), now(), sessionId);
        releaseInflight();
        fail(503, "session_backend_unavailable",
          `herdr backend unreachable (${e.message}) — no session started; caller falls back to legacy`, { cause: e });
      }
      if (e?.name === "ServerError" && e?.retriable === false) {
        // Non-retriable (e.g. allowlist deny): terminal, replayable rejection.
        return failSpawn("spawn_rejected", e, { kind });
      }
      if (e?.name === "VersionMismatchError") {
        recordBackendFailure("herdr_version_mismatch", e.message);
        return failSpawn("spawn_failed", e, { kind });
      }
      return failSpawn("spawn_failed", e, { kind });
    }

    const paneId = handle?.paneId ?? handle?.pane_id ?? null;
    const agentId = handle?.agentId ?? handle?.agent_id ?? null;
    if (!paneId || !agentId) {
      return failSpawn("spawn_failed",
        new ServerError("adapter.spawnAgent returned no paneId/agentId"), { kind });
    }
    db.prepare("UPDATE herdr_sessions SET pane_id = ?, agent_id = ?, updated_at = ? WHERE session_id = ?")
      .run(paneId, agentId, now(), sessionId);

    // T1: confirm the pane is live and the occupant is who we spawned.
    let confirmed;
    try {
      confirmed = await confirmPaneLive(a, paneId, agentId, spawnTimeoutMs);
    } catch (e) {
      // Deviation from D2 T1 ("partial pane must be closed"), flagged in the
      // PR: the pane may be perfectly healthy — only the confirm hung.
      // Killing it would destroy a live agent. The pane is left alone, its
      // ids journaled for the operator, and a same-key retry re-attaches to
      // it (below) instead of spawning a second pane.
      recordBackendFailure("spawn_confirm_failed", e?.message ?? String(e));
      db.prepare("UPDATE herdr_sessions SET state = 'destroyed', destroyed_at = ?, updated_at = ? WHERE session_id = ?")
        .run(now(), now(), sessionId);
      journal(sessionId, "spawn_failed", {
        transition: "spawn", idempotencyKey,
        detail: { reason: "spawn confirm timed out; pane left alive for re-attach", paneId, agentId, error: e?.message ?? String(e) },
      });
      releaseInflight();
      throw e instanceof TimeoutError ? e : new TimeoutError(e?.message ?? String(e));
    }

    db.prepare(`UPDATE herdr_sessions SET state = 'active', occupant_id = ?,
      consecutive_failures = 0, updated_at = ? WHERE session_id = ?`)
      .run(confirmed.occupantId, now(), sessionId);
    recordBackendOk();
    releaseInflight();
    const response = {
      sessionId, paneId, agentId, occupantId: confirmed.occupantId, state: "active",
    };
    return storeResponse(sessionId, "spawn", idempotencyKey, "spawn", response, { kind, claimId });
  }

  // Retry helper used when a same-key spawn finds a prior failed attempt that
  // recorded a (possibly still alive) partial pane: adopt it, never spawn a
  // second live pane for one key (D2 T1).
  const adoptPartialPane = async (a, sessionId, failedRow, req, timeoutMs) => {
    const detail = failedRow.detail_json ? JSON.parse(failedRow.detail_json) : {};
    const { paneId, agentId } = detail;
    if (!paneId || !agentId) return null;
    try {
      const confirmed = await confirmPaneLive(a, paneId, agentId, Math.min(timeoutMs, 5000));
      db.prepare(`UPDATE herdr_sessions SET state = 'active', pane_id = ?, agent_id = ?,
        occupant_id = ?, consecutive_failures = 0, updated_at = ? WHERE session_id = ?`)
        .run(paneId, agentId, confirmed.occupantId, now(), sessionId);
      journal(sessionId, "spawn_reattached", {
        transition: "spawn", idempotencyKey: req.idempotencyKey,
        detail: { paneId, agentId, note: "same-key retry adopted the partial pane; no second pane spawned" },
      });
      return { sessionId, paneId, agentId, occupantId: confirmed.occupantId, state: "active" };
    } catch {
      return null; // partial pane unrecoverable → fall through to a fresh spawn
    }
  };

  async function attachSession(req = {}) {
    const {
      idempotencyKey, sessionId = null, paneId = null, claimId,
      laneMemberId, verifyOccupant = true,
    } = req ?? {};
    checkKey(idempotencyKey);
    checkId(claimId, "claimId");
    checkId(laneMemberId, "laneMemberId");
    if (sessionId === null && paneId === null) {
      fail(422, "invalid_lifecycle_input", "attachSession requires sessionId or paneId");
    }
    if (sessionId !== null) checkId(sessionId, "sessionId");
    if (paneId !== null) checkId(paneId, "paneId");

    const stored = dedupeLookup(idempotencyKey, "attach");
    if (stored) {
      if (stored.ok === false) throw remapStoredError(stored);
      return { ...stored, duplicate: true };
    }

    // D2 §2.2: the adopting claim must be LIVE. The board owns liveness; this
    // module only consults the injected reader, never the board itself.
    if (claimReader) {
      const live = await claimReader.isLiveClaim(claimId);
      if (!live) {
        const err = new SessionLifecycleError(409, "claim_not_live",
          `claim "${claimId}" is not live — attach never serves a dead/released claim`);
        return storeErrorResponse(sessionId ?? `pane:${paneId}`, "attach_rejected", idempotencyKey, "attach", err, { claimId });
      }
    }

    const a = requireAdapter();
    let row = sessionId ? getRow(sessionId) : null;

    if (row && row.claim_id === claimId && row.state === "active") {
      const response = {
        sessionId: row.session_id, paneId: row.pane_id, agentId: row.agent_id,
        occupantId: row.occupant_id, state: "active", resumed: false,
      };
      return storeResponse(row.session_id, "attach", idempotencyKey, "attach", response, { note: "already bound to this claim" });
    }
    if (row && row.state === "active" && row.claim_id !== claimId) {
      const err = new SessionLifecycleError(409, "session_claim_conflict",
        `session is actively bound to claim "${row.claim_id}" — detach it before adopting for "${claimId}"`);
      return storeErrorResponse(row.session_id, "attach_rejected", idempotencyKey, "attach", err, { claimId });
    }
    if (row && !["detached", "suspended", "draining"].includes(row.state)) {
      const err = new SessionLifecycleError(409, "session_state_conflict",
        `cannot attach a session in state "${row.state}"`);
      return storeErrorResponse(row.session_id, "attach_rejected", idempotencyKey, "attach", err, { claimId });
    }
    if (row && row.state === "draining" && row.drain_reason !== "claim_released") {
      // Warm adoption is only for release-drains (pane kept alive). Done/failed
      // drains are going away — adopting them would resurrect dead work.
      const err = new SessionLifecycleError(409, "session_state_conflict",
        `session is draining for "${row.drain_reason}" — only claim_released drains are adoptable`);
      return storeErrorResponse(row.session_id, "attach_rejected", idempotencyKey, "attach", err, { claimId });
    }

    // Resolve the pane: existing session's pane, or a raw paneId (migration).
    let targetPaneId = row?.pane_id ?? paneId;
    let targetAgentId = row?.agent_id ?? null;
    let targetSessionId = row?.session_id ?? null;
    if (!row) {
      // Raw-pane adoption: locate the agent via snapshot, then verify.
      const snap = await a.snapshot();
      const pane = findPaneInSnapshot(snap, paneId);
      if (!pane) {
        const err = new ServerError(`pane ${paneId} not found in snapshot`);
        return storeErrorResponse(`pane:${paneId}`, "attach_rejected", idempotencyKey, "attach", err, { claimId, paneId });
      }
      targetAgentId = pane.agentId ?? pane.agent_id ?? null;
      targetSessionId = randomUUID();
      const at = now();
      db.prepare(`INSERT INTO herdr_sessions
        (session_id, claim_id, lane_member_id, tenant_id, state, kind, pane_id, agent_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'reattaching', 'adopted', ?, ?, ?, ?)`).run(
        targetSessionId, claimId, laneMemberId, row?.tenant_id ?? "unknown", paneId, targetAgentId, at, at);
      row = getRow(targetSessionId);
    }

    // Occupant verification (default true) — re-pin before driving (D2 §2.2).
    let occupantId = row.occupant_id;
    let occupantChanged = false;
    if (verifyOccupant && targetAgentId) {
      let info;
      try {
        info = await a.getAgent(targetAgentId);
      } catch (e) {
        const err = new ServerError(`cannot verify occupant: ${e?.message ?? e}`);
        return storeErrorResponse(targetSessionId, "attach_rejected", idempotencyKey, "attach", err, { claimId });
      }
      const observed = info?.occupantId ?? info?.agentId ?? targetAgentId;
      if (occupantId && observed !== occupantId) {
        const err = new OccupantChangedError(
          `pane occupant changed (was ${occupantId}, now ${observed}) — re-resolve intent before driving`);
        journal(targetSessionId, "attach_occupant_mismatch", {
          transition: "attach", idempotencyKey, detail: { expected: occupantId, observed },
        });
        return storeErrorResponse(targetSessionId, "attach_rejected", idempotencyKey, "attach", err, { claimId });
      }
      occupantChanged = !!occupantId && observed !== occupantId ? false : !occupantId && !!observed;
      occupantId = observed;
    }

    const wasDraining = row.state === "draining";
    db.prepare(`UPDATE herdr_sessions SET state = 'active', claim_id = ?, lane_member_id = ?,
      occupant_id = ?, pin_stale = 0, drain_reason = NULL, drain_at = NULL, pane_fate_unknown = 0,
      consecutive_failures = 0, updated_at = ? WHERE session_id = ?`)
      .run(claimId, laneMemberId, occupantId, now(), targetSessionId);
    if (wasDraining) {
      journal(targetSessionId, "destroy_cancelled_adopted", {
        transition: "attach", detail: { claimId, note: "new live claim adopted the draining session; pending destroy cancelled" },
      });
    }
    journal(targetSessionId, "attach", {
      transition: "attach", idempotencyKey,
      detail: { claimId, laneMemberId, verifyOccupant, occupantChanged },
    });
    const response = {
      sessionId: targetSessionId, paneId: targetPaneId, agentId: targetAgentId,
      occupantId, state: "active", resumed: false,
    };
    return storeResponse(targetSessionId, "attach", idempotencyKey, "attach", response,
      { claimId, adoptedDrain: wasDraining });
  }

  async function heartbeatSession(req = {}) {
    const { sessionId, idempotencyKey = null, occupantId, reportedAgentState = null } = req ?? {};
    const row = getRow(sessionId);
    checkId(occupantId, "occupantId");
    if (idempotencyKey !== null) checkKey(idempotencyKey);
    if (reportedAgentState !== null) checkStateEnum(reportedAgentState, AGENT_STATES, "reportedAgentState");
    if (TERMINAL_STATES.includes(row.state)) {
      fail(409, "session_state_conflict", `session is ${row.state} — heartbeats stop at the terminal state`);
    }

    // Dedupe is optional for heartbeats (naturally idempotent); a repeated key
    // still replays the stored beat.
    if (idempotencyKey) {
      const stored = dedupeLookup(idempotencyKey, "heartbeat");
      if (stored) {
        if (stored.ok === false) throw remapStoredError(stored);
        return { ...stored, duplicate: true };
      }
    }

    const a = requireAdapter();
    const at = now();
    let pingOk = true;
    let pingError = null;
    try {
      await withTimeout(a.ping(), timeouts.pingTimeoutMs, "adapter ping");
    } catch (e) {
      pingOk = false;
      pingError = e?.message ?? String(e);
    }

    if (!pingOk) {
      const failures = row.consecutive_failures + 1;
      db.prepare("UPDATE herdr_sessions SET consecutive_failures = ?, updated_at = ? WHERE session_id = ?")
        .run(failures, at, sessionId);
      journal(sessionId, "heartbeat_failed", {
        transition: "heartbeat", idempotencyKey,
        detail: { consecutiveFailures: failures, error: pingError },
      });
      recordBackendFailure("herdr_transport_error", pingError);
      if (failures >= timeouts.heartbeatFailureBudget && row.state === "active") {
        // T2: observability failed, not the agent. Journal the detach with
        // reason; the claim is untouched; the pane is untouched.
        db.prepare(`UPDATE herdr_sessions SET state = 'detached', consecutive_failures = 0, updated_at = ?
          WHERE session_id = ?`).run(at, sessionId);
        journal(sessionId, "detach", {
          transition: "heartbeat",
          detail: { reason: "heartbeat_failures", consecutiveFailures: failures },
        });
        return { sessionId, state: "detached", occupantOk: false, serverTimeMs: at };
      }
      return { sessionId, state: row.state, occupantOk: false, serverTimeMs: at };
    }

    // Adapter reachable: reset the failure budget.
    const occupantOk = !row.occupant_id || row.occupant_id === occupantId;
    db.prepare(`UPDATE herdr_sessions SET consecutive_failures = 0, last_heartbeat_at = ?,
      agent_state = COALESCE(?, agent_state), pin_stale = ?, updated_at = ? WHERE session_id = ?`)
      .run(at, reportedAgentState, occupantOk ? 0 : 1, at, sessionId);
    if (!occupantOk) {
      // §3.3: the pane is fine, the pin is stale. Driving calls block until
      // reattach re-verifies; nothing is sent to the new occupant.
      journal(sessionId, "heartbeat_occupant_mismatch", {
        transition: "heartbeat", idempotencyKey,
        detail: { expected: row.occupant_id, observed: occupantId },
      });
    } else {
      journal(sessionId, "heartbeat", {
        transition: "heartbeat", idempotencyKey,
        detail: { reportedAgentState },
      });
    }
    recordBackendOk();
    const response = { sessionId, state: row.state, occupantOk, serverTimeMs: at };
    if (idempotencyKey) {
      return storeResponse(sessionId, "heartbeat", idempotencyKey, "heartbeat", response, { reportedAgentState });
    }
    return { ...response, duplicate: false };
  }

  async function detachSession(req = {}) {
    const { idempotencyKey, sessionId, reason } = req ?? {};
    checkKey(idempotencyKey);
    const row = getRow(sessionId);
    checkStateEnum(reason, DETACH_REASONS, "reason");

    const stored = dedupeLookup(idempotencyKey, "detach");
    if (stored) {
      if (stored.ok === false) throw remapStoredError(stored);
      return { ...stored, duplicate: true };
    }
    if (TERMINAL_STATES.includes(row.state)) {
      const err = new SessionLifecycleError(409, "session_state_conflict", `session is ${row.state}`);
      return storeErrorResponse(sessionId, "detach_rejected", idempotencyKey, "detach", err, { reason });
    }
    if (row.state === "detached") {
      const response = { sessionId, state: "detached" };
      return storeResponse(sessionId, "detach", idempotencyKey, "detach", response, { reason, note: "already detached" });
    }
    db.prepare("UPDATE herdr_sessions SET state = 'detached', updated_at = ? WHERE session_id = ?").run(now(), sessionId);
    const response = { sessionId, state: "detached" };
    return storeResponse(sessionId, "detach", idempotencyKey, "detach", response, { reason });
  }

  // Shared reattach core (T3/T4): detached/suspended → reattaching → active|detached.
  // Reattach is always explicit, never automatic (D2 §1.3 T3).
  const reattachCore = async ({ sessionId, idempotencyKey, transition, forceRepin = false, resumeTimeoutMs = timeouts.reattachTimeoutMs, fromStates }) => {
    const row = getRow(sessionId);
    if (!fromStates.includes(row.state)) {
      const err = new SessionLifecycleError(409, "session_state_conflict",
        `cannot reattach from state "${row.state}" (expected one of ${fromStates.join(", ")})`);
      return storeErrorResponse(sessionId, `${transition}_rejected`, idempotencyKey, transition, err, {});
    }
    const stored = dedupeLookup(idempotencyKey, transition);
    if (stored) {
      if (stored.ok === false) throw remapStoredError(stored);
      return { ...stored, duplicate: true };
    }

    const a = requireAdapter();
    const fallbackState = row.state; // timeout → back where we came from (T4)
    db.prepare("UPDATE herdr_sessions SET state = 'reattaching', updated_at = ? WHERE session_id = ?").run(now(), sessionId);
    journal(sessionId, "reattach_start", { transition, idempotencyKey, detail: { from: row.state, forceRepin } });

    const backTo = async (state, event, detail) => {
      db.prepare("UPDATE herdr_sessions SET state = ?, updated_at = ? WHERE session_id = ?").run(state, now(), sessionId);
      journal(sessionId, event, { transition, idempotencyKey, detail });
    };

    try {
      const alive = await withTimeout(paneAlive(a, row.pane_id), resumeTimeoutMs, "reattach snapshot");
      if (alive === null) throw new TimeoutError("could not determine pane liveness");
      if (!alive) {
        // §3.2 native resume path: pane gone, agent CLI's own session store
        // carries continuity — respawn via the stored --resume command, never
        // transcript replay.
        const resumeCommand = row.resume_command_json ? JSON.parse(row.resume_command_json) : null;
        if (!resumeCommand) {
          await backTo(fallbackState, "reattach_pane_gone", { paneId: row.pane_id });
          const err = new SessionLifecycleError(409, "session_pane_gone",
            "pane is gone and no native resume ref was stored — the agent must respawn");
          return storeErrorResponse(sessionId, "reattach_failed", idempotencyKey, transition, err, { paneId: row.pane_id });
        }
        const handle = await withTimeout(a.spawnAgent({
          kind: row.kind, resumeSessionRef: row.resume_ref, resumeCommand,
          cwd: row.cwd, workspace: row.workspace, tab: row.tab, title: row.title,
        }), resumeTimeoutMs, "resume spawnAgent");
        const paneId = handle?.paneId ?? handle?.pane_id;
        const agentId = handle?.agentId ?? handle?.agent_id;
        const confirmed = await confirmPaneLive(a, paneId, agentId, resumeTimeoutMs);
        db.prepare(`UPDATE herdr_sessions SET state = 'active', pane_id = ?, agent_id = ?,
          occupant_id = ?, pin_stale = 0, pane_fate_unknown = 0, consecutive_failures = 0, updated_at = ?
          WHERE session_id = ?`).run(paneId, agentId, confirmed.occupantId, now(), sessionId);
        journal(sessionId, "pane_replaced_after_restart", {
          transition, idempotencyKey,
          detail: { oldPaneId: row.pane_id, paneId, agentId, resumeCommand },
        });
        const response = {
          sessionId, paneId, agentId, occupantId: confirmed.occupantId,
          occupantChanged: true, state: "active", resumed: true,
        };
        return storeResponse(sessionId, "reattach", idempotencyKey, transition, response, { resumedVia: "native-resume" });
      }

      // Pane alive: occupant re-verification required (T4).
      const info = await withTimeout(a.getAgent(row.agent_id), resumeTimeoutMs, "reattach getAgent");
      const observed = info?.occupantId ?? info?.agentId ?? row.agent_id;
      if (row.occupant_id && observed !== row.occupant_id && !forceRepin) {
        await backTo(fallbackState, "reattach_occupant_mismatch", {
          expected: row.occupant_id, observed,
        });
        const err = new OccupantChangedError(
          `pane occupant is ${observed}, expected ${row.occupant_id} — re-pin requires explicit intent (forceRepin)`);
        return storeErrorResponse(sessionId, "reattach_failed", idempotencyKey, transition, err,
          { expected: row.occupant_id, observed });
      }
      const occupantChanged = !!row.occupant_id && observed !== row.occupant_id;
      db.prepare(`UPDATE herdr_sessions SET state = 'active', occupant_id = ?, pin_stale = 0,
        consecutive_failures = 0, updated_at = ? WHERE session_id = ?`).run(observed, now(), sessionId);
      journal(sessionId, "reattach_ok", {
        transition, idempotencyKey, detail: { occupantChanged, forceRepin },
      });
      const response = {
        sessionId, paneId: row.pane_id, agentId: row.agent_id, occupantId: observed,
        occupantChanged, state: "active", resumed: false,
      };
      return storeResponse(sessionId, "reattach", idempotencyKey, transition, response, { occupantChanged });
    } catch (e) {
      if (e?.settled) throw e; // terminal outcome already journaled — don't re-settle
      // Timeout / transport on reattach → back to the prior state (T4), never
      // a speculative new state. The original error is preserved so D2 §2.9
      // maps it honestly.
      await backTo(fallbackState, "reattach_timeout", { error: e?.message ?? String(e) });
      throw e;
    }
  };

  async function reattachSession(req = {}) {
    const { idempotencyKey, sessionId, forceRepin = false, resumeTimeoutMs = timeouts.reattachTimeoutMs } = req ?? {};
    checkKey(idempotencyKey);
    checkId(sessionId, "sessionId");
    if (typeof forceRepin !== "boolean") fail(422, "invalid_lifecycle_input", "forceRepin must be boolean");
    if (!Number.isFinite(resumeTimeoutMs) || resumeTimeoutMs <= 0) {
      fail(422, "invalid_lifecycle_input", "resumeTimeoutMs must be a positive number");
    }
    return reattachCore({ sessionId, idempotencyKey, transition: "reattach", forceRepin, resumeTimeoutMs, fromStates: ["detached"] });
  }

  async function suspendSession(req = {}) {
    const { idempotencyKey, sessionId, reason } = req ?? {};
    checkKey(idempotencyKey);
    const row = getRow(sessionId);
    if (typeof reason !== "string" || reason.length === 0 || reason.length > 256) {
      fail(422, "invalid_lifecycle_input", "reason must be a 1..256 char string");
    }
    const stored = dedupeLookup(idempotencyKey, "suspend");
    if (stored) {
      if (stored.ok === false) throw remapStoredError(stored);
      return { ...stored, duplicate: true };
    }
    if (row.state !== "active") {
      const err = new SessionLifecycleError(409, "session_state_conflict",
        `can only suspend an active session (is ${row.state})`);
      return storeErrorResponse(sessionId, "suspend_rejected", idempotencyKey, "suspend", err, { reason });
    }
    db.prepare("UPDATE herdr_sessions SET state = 'suspended', updated_at = ? WHERE session_id = ?").run(now(), sessionId);
    const response = { sessionId, state: "suspended" };
    return storeResponse(sessionId, "suspend", idempotencyKey, "suspend", response, { reason });
  }

  async function resumeSession(req = {}) {
    const { idempotencyKey, sessionId, forceRepin = false, resumeTimeoutMs = timeouts.reattachTimeoutMs } = req ?? {};
    checkKey(idempotencyKey);
    checkId(sessionId, "sessionId");
    if (typeof forceRepin !== "boolean") fail(422, "invalid_lifecycle_input", "forceRepin must be boolean");
    // resume reuses the reattach shapes (D2 §2.6); a failed resume returns to
    // suspended (the deliberate hold), not detached.
    return reattachCore({ sessionId, idempotencyKey, transition: "resume", forceRepin, resumeTimeoutMs, fromStates: ["suspended"] });
  }

  async function destroySession(req = {}) {
    const { idempotencyKey, sessionId, reason, graceMs = null, closePane = true } = req ?? {};
    checkKey(idempotencyKey);
    const row = getRow(sessionId);
    checkStateEnum(reason, DESTROY_REASONS, "reason");
    if (typeof closePane !== "boolean") fail(422, "invalid_lifecycle_input", "closePane must be boolean");
    const grace = graceMs === null ? timeouts.graceMs[reason] : graceMs;
    if (!Number.isFinite(grace) || grace < 0) fail(422, "invalid_lifecycle_input", "graceMs must be a non-negative number");

    const stored = dedupeLookup(idempotencyKey, "destroy");
    const drainMatured = row.state === "draining" && now() >= (row.drain_at ?? Infinity);
    if (stored) {
      if (stored.ok === false) throw remapStoredError(stored);
      if (stored.state === "draining" && drainMatured) {
        // Same key, grace elapsed: complete the two-phase close (D2 §2.7)
        // instead of replaying the draining record.
        return await completeDestroy(sessionId, { idempotencyKey });
      }
      return { ...stored, duplicate: true };
    }
    if (TERMINAL_STATES.includes(row.state)) {
      return { sessionId, state: "destroyed", paneClosed: row.pane_closed === 1, duplicate: false };
    }
    if (row.state === "draining") {
      if (drainMatured) return await completeDestroy(sessionId, { idempotencyKey });
      // D2 §4.6: a fresh key while draining converges on the current record —
      // no double-scheduling of the pane close.
      return { sessionId, state: "draining", paneClosed: false, duplicate: false };
    }

    const at = now();
    const drainAt = at + grace;
    const fateUnknown = row.state === "detached" ? 1 : 0; // §5: no speculative kill on an unknown pane
    db.prepare(`UPDATE herdr_sessions SET state = 'draining', drain_reason = ?, drain_at = ?,
      pane_fate_unknown = ?, updated_at = ? WHERE session_id = ?`)
      .run(reason, drainAt, fateUnknown, at, sessionId);
    journal(sessionId, "drain_start", {
      transition: "destroy", idempotencyKey,
      detail: { reason, graceMs: grace, drainAt: iso(drainAt), paneFateUnknown: fateUnknown === 1, closePane },
    });

    if (grace <= 0) {
      // Immediate destroy (operator/retention, or explicit graceMs: 0).
      return await completeDestroy(sessionId, { idempotencyKey });
    }
    const response = { sessionId, state: "draining", paneClosed: false };
    return storeResponse(sessionId, "drain_start", idempotencyKey, "destroy", response, { reason, graceMs: grace });
  }

  // Phase 2 of destroy: the sweeper (or a same-key follow-up) calls this when
  // the grace window has elapsed. Never marks destroyed on a timeout alone.
  async function completeDestroy(sessionId, { idempotencyKey = null } = {}) {
    const row = getRow(sessionId);
    if (row.state !== "draining") return sessionView(row);
    const at = now();
    if (at < (row.drain_at ?? Infinity)) return sessionView(row); // grace not elapsed
    if (row.pane_fate_unknown === 1) {
      // §5: claim went terminal while detached — no speculative kill. The
      // record reaches destroyed only via explicit confirm or pane-gone
      // evidence (confirmPaneGone).
      journal(sessionId, "destroy_deferred_unknown_pane", {
        detail: { drainReason: row.drain_reason },
      });
      return sessionView(row);
    }
    const markDestroyed = (paneClosed, detail) => {
      db.prepare(`UPDATE herdr_sessions SET state = 'destroyed', destroyed_at = ?, pane_closed = ?,
        updated_at = ? WHERE session_id = ?`).run(at, paneClosed ? 1 : 0, at, sessionId);
      journal(sessionId, "destroyed", { detail: { paneClosed, ...detail } });
      // Refresh any stored destroy response so replays converge on destroyed.
      db.prepare(`UPDATE herdr_session_journal SET response_json = ?
        WHERE session_id = ? AND transition = 'destroy' AND response_json IS NOT NULL`)
        .run(JSON.stringify({ sessionId, state: "destroyed", paneClosed }), sessionId);
      return { sessionId, state: "destroyed", paneClosed, duplicate: false };
    };

    let a = null;
    try { a = requireAdapter(); } catch { /* no adapter → cannot close; defer */ }
    if (a) {
      const alive = await paneAlive(a, row.pane_id);
      if (alive === false) {
        return markDestroyed(false, { note: "pane already gone" });
      }
      try {
        await withTimeout(a.closePane(row.pane_id), timeouts.destroyTimeoutMs, "pane close");
        recordBackendOk();
        return markDestroyed(true, { drainReason: row.drain_reason });
      } catch (e) {
        recordBackendFailure("destroy_close_failed", e?.message ?? String(e));
        journal(sessionId, "destroy_retry", {
          detail: { error: e?.message ?? String(e), drainReason: row.drain_reason },
        });
        return sessionView(getRow(sessionId)); // stays draining; sweeper retries
      }
    }
    journal(sessionId, "destroy_retry", { detail: { error: "no adapter configured", drainReason: row.drain_reason } });
    return sessionView(getRow(sessionId));
  }

  // Explicit confirmation for unknown-pane drains (§5): pane-gone evidence.
  async function confirmPaneGone(sessionId, { idempotencyKey } = {}) {
    checkKey(idempotencyKey);
    const row = getRow(sessionId);
    if (row.state !== "draining" || row.pane_fate_unknown !== 1) {
      fail(409, "session_state_conflict", "confirmPaneGone applies only to draining sessions with unknown pane fate");
    }
    const at = now();
    db.prepare(`UPDATE herdr_sessions SET state = 'destroyed', destroyed_at = ?, pane_closed = 0,
      updated_at = ? WHERE session_id = ?`).run(at, at, sessionId);
    const response = { sessionId, state: "destroyed", paneClosed: false };
    journal(sessionId, "destroyed", {
      transition: "destroy", idempotencyKey,
      detail: { paneClosed: false, note: "explicit pane-gone confirmation" },
    });
    return storeResponse(sessionId, "destroyed", idempotencyKey, "destroy", response, { confirmedPaneGone: true });
  }

  // -- claim coupling (D2 §5): downstream only -------------------------------
  //
  // The board emits; the session reacts. This module never writes work_claims
  // rows, never flips claim state, never extends a lease (boundary law).
  async function onClaimEvent({ claimId, event, idempotencyNonce = null } = {}) {
    checkId(claimId, "claimId");
    checkStateEnum(event, CLAIM_EVENTS, "event");
    const nonce = idempotencyNonce ?? randomUUID().slice(0, 8);
    const reason = `claim_${event}`;
    const rows = db.prepare(`SELECT session_id FROM herdr_sessions
      WHERE claim_id = ? AND state NOT IN ('draining', 'destroyed')`).all(claimId);
    const affected = [];
    for (const r of rows) {
      const res = await destroySession({
        idempotencyKey: `claim:${claimId}:drain:${event}:${nonce}:${r.session_id}`,
        sessionId: r.session_id, reason,
      });
      affected.push(res);
    }
    return affected;
  }

  // Session death is board-invisible: journal the loss, touch nothing else.
  // The holder decides (reattach/respawn/release) via the board's own API.
  async function onSessionLost(sessionId, detail = {}) {
    const row = getRow(sessionId);
    journal(sessionId, "session_lost", { detail: { ...detail, state: row.state, claimId: row.claim_id } });
    return { sessionId, state: row.state, claimId: row.claim_id };
  }

  // -- driving guard for B15 -------------------------------------------------
  // sendText/sendKeys/waitForState stay blocked while the pin is stale or the
  // session is not active (§3.3). The adapter never silently re-targets.
  async function isDrivable(sessionId) {
    const row = getRow(sessionId);
    if (row.state !== "active") {
      return { drivable: false, state: row.state, pinStale: row.pin_stale === 1, reason: `session is ${row.state}` };
    }
    if (row.pin_stale === 1) {
      return { drivable: false, state: row.state, pinStale: true, reason: "occupant pin stale — reattach required" };
    }
    return { drivable: true, state: row.state, pinStale: false, reason: null };
  }

  // -- reads -----------------------------------------------------------------

  async function getSession(sessionId) { return sessionView(getRow(sessionId)); }

  async function listSessions({ roomId = null, claimId = null, laneMemberId = null, state = null, limit = 50, after = null } = {}) {
    if (state !== null) checkStateEnum(state, SESSION_STATES, "state");
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) fail(422, "invalid_lifecycle_input", "limit must be an integer 1..200");
    const conds = [];
    const params = [];
    if (roomId !== null) { conds.push("room_id = ?"); params.push(roomId); }
    if (claimId !== null) { conds.push("claim_id = ?"); params.push(claimId); }
    if (laneMemberId !== null) { conds.push("lane_member_id = ?"); params.push(laneMemberId); }
    if (state !== null) { conds.push("state = ?"); params.push(state); }
    if (after !== null) {
      checkId(after, "after");
      const anchor = db.prepare("SELECT created_at FROM herdr_sessions WHERE session_id = ?").get(after);
      if (!anchor) fail(422, "invalid_lifecycle_input", "after cursor unknown");
      conds.push("(created_at > ? OR (created_at = ? AND session_id > ?))");
      params.push(anchor.created_at, anchor.created_at, after);
    }
    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    const rows = db.prepare(`SELECT * FROM herdr_sessions ${where}
      ORDER BY created_at ASC, session_id ASC LIMIT ?`).all(...params, limit + 1);
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    return {
      sessions: page.map(sessionView),
      next: hasMore ? page[page.length - 1].session_id : null,
      hasMore,
    };
  }

  async function sessionJournal(sessionId, { limit = 100, after = null } = {}) {
    getRow(sessionId); // 404 when unknown
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) fail(422, "invalid_lifecycle_input", "limit must be an integer 1..500");
    const params = [sessionId];
    let afterClause = "";
    if (after !== null) {
      if (!Number.isInteger(after) || after < 1) fail(422, "invalid_lifecycle_input", "after must be a journal id");
      afterClause = "AND journal_id > ?";
      params.push(after);
    }
    params.push(limit + 1);
    const rows = db.prepare(`SELECT * FROM herdr_session_journal
      WHERE session_id = ? ${afterClause} ORDER BY journal_id ASC LIMIT ?`).all(...params);
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    return {
      entries: page.map(journalView),
      next: hasMore ? page[page.length - 1].journal_id : null,
      hasMore,
    };
  }

  // -- lane opt-in (Phase B gating marker) ------------------------------------

  async function setLaneOptIn({ laneId, roomId = null, setBy, backend = "herdr" } = {}) {
    checkId(laneId, "laneId");
    checkId(setBy, "setBy");
    if (roomId !== null) checkId(roomId, "roomId");
    checkStateEnum(backend, ["herdr", "legacy"], "backend");
    const at = now();
    db.prepare(`INSERT INTO herdr_lane_optin (lane_id, room_id, session_backend, set_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(lane_id) DO UPDATE SET room_id = excluded.room_id, session_backend = excluded.session_backend,
        set_by = excluded.set_by, updated_at = excluded.updated_at`)
      .run(laneId, roomId, backend, setBy, at, at);
    return getLaneOptIn(laneId);
  }

  async function getLaneOptIn(laneId) {
    checkId(laneId, "laneId");
    const row = db.prepare("SELECT * FROM herdr_lane_optin WHERE lane_id = ?").get(laneId);
    if (!row) return null;
    return Object.freeze({
      laneId: row.lane_id, roomId: row.room_id, sessionBackend: row.session_backend,
      setBy: row.set_by, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
    });
  }

  // -- backend health ----------------------------------------------------------

  async function recordBackendHealth({ reachable, errorCode = null, errorMessage = null } = {}) {
    if (typeof reachable !== "boolean") fail(422, "invalid_lifecycle_input", "reachable must be boolean");
    if (reachable) recordBackendOk();
    else recordBackendFailure(errorCode ?? "unknown", errorMessage ?? "unknown");
    return getBackendState();
  }

  async function getBackendState() {
    const row = db.prepare("SELECT * FROM herdr_backend_state WHERE id = 1").get();
    if (!row) {
      return Object.freeze({ reachable: 1, consecutiveFailures: 0, lastErrorCode: null, lastErrorMessage: null, lastErrorAt: null, lastOkAt: null, degradedSince: null, updatedAt: null });
    }
    return Object.freeze({
      reachable: row.reachable, consecutiveFailures: row.consecutive_failures,
      lastErrorCode: row.last_error_code, lastErrorMessage: row.last_error_message,
      lastErrorAt: iso(row.last_error_at), lastOkAt: iso(row.last_ok_at),
      degradedSince: iso(row.degraded_since), updatedAt: iso(row.updated_at),
    });
  }

  // -- schema self-check (repo convention: module verifies its own schema) ------

  function schemaCheck() {
    const missing = [];
    for (const t of ["herdr_sessions", "herdr_session_journal", "herdr_lane_optin", "herdr_backend_state"]) {
      const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
      if (!row) missing.push(t);
    }
    if (missing.length) fail(500, "lifecycle_schema_missing", `missing tables: ${missing.join(", ")}`);
    return { ok: true };
  }

  return {
    spawnSession, attachSession, heartbeatSession, detachSession,
    reattachSession, suspendSession, resumeSession, destroySession,
    completeDestroy, confirmPaneGone,
    onClaimEvent, onSessionLost, isDrivable,
    getSession, listSessions, sessionJournal,
    setLaneOptIn, getLaneOptIn,
    recordBackendHealth, getBackendState,
    schemaCheck,
    timeouts,
  };
}
