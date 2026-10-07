/**
 * server/session-adapter/herdr-bridge-adapter.mjs — HerdrBridgeAdapter (B4 lane).
 *
 * Worker-side HTTPS client implementing the SessionAdapter domain interface
 * (see ../session-adapter.mjs, REDESIGN.md §2.2) against bridge/herdr-bridge.mjs
 * (transport design: goals/project-room-herdr-redesign/phase2/design-docs/
 * bridge-transport.md — lane D3). Runs inside the Cloudflare Worker; the
 * bridge translates to herdr's Unix-socket protocol on lane-worker hosts.
 *
 * WORKER-SAFETY: no sockets, no subprocesses, no Node builtins. Only
 * globalThis.fetch, globalThis.crypto (subtle + randomUUID), AbortController,
 * and timers. Config is injected (readHerdrBridgeConfig(env)) — the module
 * never reads the ambient process environment. Error classes are imported from ../session-adapter.mjs (B2);
 * this module is not usable until that file merges.
 *
 * NOT MOUNTED: this module is intentionally not imported by server/http.mjs
 * and not registered in scripts/runtime-package.mjs — mounting is deferred
 * to the integration step (lease respected).
 *
 * ---------------------------------------------------------------------------
 * DEGRADATION TABLE — fail-closed semantics (the load-bearing contract)
 * ---------------------------------------------------------------------------
 * Backend selection is ALL-OR-NOTHING per session, decided once at connect().
 * There is NEVER a mid-session silent downgrade to legacy.
 *
 * connect() via connectSession():
 *   ROOM_HERDR_SESSIONS=off            → legacy (reason flag_off). Expected in Phase A.
 *   room not in allowlist              → legacy (reason room_not_listed).
 *   tenant has no route-table entry    → legacy (reason no_route). Default-deny.
 *   route entry but no master secret   → ServerError(bridge_secret_missing). Operator
 *                                        config error — LOUD, never silent.
 *   bridge unreachable / ping 5xx /
 *   connect timeout (retry budget spent)→ legacy (reason bridge_unreachable)
 *                                        + onFallback alert hook. Claiming proceeds.
 *   breaker open                       → legacy (reason circuit_open).
 *   ping 401/403                       → ServerError(auth_denied). Fail closed, never retried.
 *   protocol / binary / core-method
 *   mismatch                           → VersionMismatchError. Fail closed, NO downgrade,
 *                                        onVersionMismatch alert hook.
 *   pins unconfigured (TBD)            → VersionMismatchError(pins_unconfigured) —
 *                                        the bridge is never contacted.
 *
 * mid-session (adapter connected):
 *   idempotent reads                    → up to 3 attempts, jittered backoff, inside the
 *   (ping/snapshot/read/list/get)         call's timeout budget; then TransportError/TimeoutError.
 *   writes (spawn/send/keys/wait/       → up to 2 attempts, ONLY when no response was
 *   report/close)                         received (timeout / reset / 5xx+empty body),
 *                                         SAME idempotency key on retry — the bridge
 *                                         dedupes, so the outcome is exactly-once.
 *   4xx / auth_denied / occupant_changed /
 *   version_mismatch / method_unsupported→ NEVER retried. Surfaced immediately.
 *   route-auth allowlist                → a method missing from the tenant's bridge
 *                                         entry throws MethodUnsupportedError locally;
 *                                         the bridge is never contacted (deny-by-default).
 *   circuit breaker (per bridge host)  → 5 consecutive failures (timeout / 5xx /
 *                                         connection error) → OPEN: fail-fast
 *                                         TransportError(bridge_circuit_open); new
 *                                         connect()s fall back to legacy; half-open
 *                                         after 60s via a single ping probe.
 *   subscribe stream death /            → adapter-owned recovery: re-snapshot()
 *   events_lost                            through the SAME bridge → onReconcile(snapshot,
 *                                         lostCount) → resubscribe with the since cursor.
 *   recovery impossible                  → SubscriptionLostError to onSubscriptionLost,
 *   (breaker open / bridge down)           subscription closed; the caller re-connect()s
 *                                         (which may then select legacy).
 *   waitForState / waitForOutput         → TimeoutError on timeoutMs; an AbortSignal
 *                                         surfaces as TimeoutError("aborted").
 *
 * Fork/broker failure NEVER blocks claiming: connect-time outages fall back to
 * legacy; mid-session outages surface typed errors the caller handles. The
 * claims board stays authoritative — herdr `done` ≠ claim `done`.
 * ---------------------------------------------------------------------------
 */

import {
  SessionAdapterError,
  VersionMismatchError,
  OccupantChangedError,
  SubscriptionLostError,
  MethodUnsupportedError,
  TransportError,
  TimeoutError,
  ServerError,
  CORE_METHODS,
  PANE_SOURCES,
  MAX_RESUME_ARGS,
  MAX_RESUME_BYTES,
} from '../session-adapter.mjs';
import pinnedHerdrJson from './pinned-herdr.json' with { type: 'json' };

// Re-export the SessionAdapter error taxonomy (B2, ../session-adapter.mjs) so
// callers of this module get the single canonical taxonomy. This module must
// merge alongside B2's file — it is not usable until then.
export {
  SessionAdapterError,
  VersionMismatchError,
  OccupantChangedError,
  SubscriptionLostError,
  MethodUnsupportedError,
  TransportError,
  TimeoutError,
  ServerError,
  CORE_METHODS,
  PANE_SOURCES,
};

/** Backend name stamped on every error from this module. */
export const BRIDGE_BACKEND = 'herdr-bridge';

/** HMAC context prefix for the derived bearer token (D3 §1.2). */
export const TOKEN_DERIVATION_CONTEXT = 'herdr-bridge-v1:';

/**
 * Per-call timeout budget, Worker side (D3 §3.1). Retries run INSIDE the
 * logical call's budget — the worst case never exceeds the budget.
 */
export const BRIDGE_TIMEOUTS = {
  connect: 10_000, // includes ping + version assert
  ping: 5_000,
  snapshot: 15_000,
  list: 15_000,
  read: 15_000,
  spawn: 30_000,
  send: 15_000,
  keys: 15_000,
  waitRoundCap: 120_000, // per HTTP round-trip; the adapter re-issues rounds
  report: 10_000,
  close: 15_000,
};

/** Circuit-breaker policy (D3 §3.3). */
export const BREAKER_FAILURES_TO_OPEN = 5;
export const BREAKER_OPEN_MS = 60_000;

/** SSE heartbeat discipline: the bridge heartbeats every 25s (D3 §3.1). */
export const BRIDGE_HEARTBEAT_MS = 25_000;

/**
 * Adapter method → bridge route name (D3 §1.1 route table). Adapter-local
 * methods (connect/disconnect/supports) have no bridge route.
 */
const ADAPTER_METHOD_TO_ROUTE = {
  ping: 'ping',
  snapshot: 'snapshot',
  spawnAgent: 'spawn',
  listAgents: 'list',
  getAgent: 'list',
  readPane: 'read',
  sendText: 'send',
  sendKeys: 'keys',
  waitForState: 'wait',
  waitForOutput: 'wait',
  reportState: 'report',
  reportResume: 'report',
  reportMetadata: 'report',
  closePane: 'close',
  subscribe: 'events',
  waitForEvent: 'events',
};

const ROUTE_TO_PATH = {
  ping: '/v1/ping',
  snapshot: '/v1/snapshot',
  spawn: '/v1/spawn',
  list: '/v1/list',
  read: '/v1/read',
  send: '/v1/send',
  keys: '/v1/keys',
  wait: '/v1/wait',
  report: '/v1/report',
  close: '/v1/close',
  events: '/v1/events',
};

/** Adapter methods that require a bridge route (the core tier over the wire). */
const BRIDGE_CORE_METHODS = CORE_METHODS.filter((m) => ADAPTER_METHOD_TO_ROUTE[m] != null);

// ---------------------------------------------------------------------------
// Worker-safe config
// ---------------------------------------------------------------------------

/**
 * Read the bridge client config from the Worker's env object.
 *
 * Pure function of the passed env object: no ambient environment reads,
 * no I/O, safe to call per request.
 *
 * Env vars:
 *   ROOM_HERDR_SESSIONS   "off" (default) | "on" | "room-a,room-b" (allowlist)
 *   HERDR_ROUTE_TABLE     JSON route-auth table (D3 §2.1): tenant → bridge
 *                         URL → keyId → allowed methods. Default-deny.
 *   BRIDGE_MASTER_SECRET[_<HOST>]  per-host master secret (wrangler secret).
 *                         <HOST> = bridge id uppercased, non-alnum → "_".
 *                         The bare BRIDGE_MASTER_SECRET is the single-host fallback.
 */
export function readHerdrBridgeConfig(env) {
  const e = env ?? {};
  const rawMode = typeof e.ROOM_HERDR_SESSIONS === 'string' ? e.ROOM_HERDR_SESSIONS.trim() : '';
  let mode = 'off';
  let rooms = [];
  if (rawMode === 'on') {
    mode = 'on';
  } else if (rawMode !== '' && rawMode !== 'off') {
    mode = 'rooms';
    rooms = rawMode.split(',').map((s) => s.trim()).filter(Boolean);
  }
  let routeTable = { version: 1, defaultDeny: true, bridges: {} };
  let routeTableError = null;
  if (typeof e.HERDR_ROUTE_TABLE === 'string' && e.HERDR_ROUTE_TABLE.trim() !== '') {
    try {
      const parsed = JSON.parse(e.HERDR_ROUTE_TABLE);
      if (parsed && typeof parsed === 'object' && parsed.bridges && typeof parsed.bridges === 'object') {
        routeTable = parsed;
      } else {
        routeTableError = 'HERDR_ROUTE_TABLE parsed but has no bridges object — denying all routes';
      }
    } catch (err) {
      // Fail closed: an unreadable route table denies every route.
      routeTableError = `HERDR_ROUTE_TABLE is not valid JSON — denying all routes: ${err.message}`;
    }
  }
  const secrets = {};
  for (const k of Object.keys(e)) {
    if (k === 'BRIDGE_MASTER_SECRET' || k.startsWith('BRIDGE_MASTER_SECRET_')) secrets[k] = e[k];
  }
  return { mode, rooms, routeTable, routeTableError, secrets };
}

/**
 * Resolve tenant → bridge entry. Miss → null → legacy backend (default-deny).
 * The bridge id is the route table's key; the tenant allowlist is per bridge.
 */
export function resolveBridgeRoute(config, tenantId) {
  const bridges = config?.routeTable?.bridges;
  if (!bridges || typeof bridges !== 'object') return null;
  for (const [id, b] of Object.entries(bridges)) {
    if (b && Array.isArray(b.tenants) && b.tenants.includes(tenantId)) {
      return {
        id,
        url: typeof b.url === 'string' ? b.url.replace(/\/+$/, '') : '',
        keyId: typeof b.keyId === 'string' ? b.keyId : null,
        methods: Array.isArray(b.methods) ? [...b.methods] : [],
      };
    }
  }
  return null;
}

function masterSecretFor(config, bridgeId) {
  const hostKey = `BRIDGE_MASTER_SECRET_${String(bridgeId).toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
  return config?.secrets?.[hostKey] ?? config?.secrets?.BRIDGE_MASTER_SECRET ?? null;
}

// ---------------------------------------------------------------------------
// Bearer derivation (D3 §1.2): HMAC-SHA256(master, "herdr-bridge-v1:"+tenant)
// ---------------------------------------------------------------------------

function base64urlEncode(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Derive the tenant's bearer token. The bridge re-derives the same value and
 * compares in constant time; the tenant is bound to the token, never trusted
 * from a caller-supplied field. The master secret value is used as raw UTF-8
 * bytes, exactly as stored via `wrangler secret put`.
 */
export async function deriveBridgeToken(masterSecret, tenantId) {
  const te = new TextEncoder();
  const key = await globalThis.crypto.subtle.importKey(
    'raw', te.encode(masterSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await globalThis.crypto.subtle.sign(
    'HMAC', key, te.encode(TOKEN_DERIVATION_CONTEXT + tenantId),
  );
  return base64urlEncode(new Uint8Array(sig));
}

function newIdempotencyKey() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `idem-${Date.now().toString(36)}-${Math.floor(Math.random() * 2 ** 48).toString(36)}`;
}

// ---------------------------------------------------------------------------
// Circuit breaker (per bridge host, per isolate)
// ---------------------------------------------------------------------------

const defaultBreakerStore = new Map();

function breakerRecord(store, bridgeId) {
  let rec = store.get(bridgeId);
  if (!rec) {
    rec = { failures: 0, state: 'closed', openedAt: 0, probeSent: false };
    store.set(bridgeId, rec);
  }
  return rec;
}

/**
 * Gate a call: closed → pass; open → fail fast unless the half-open window
 * elapsed (then exactly one ping probe passes); half-open → only the ping
 * probe passes until it resolves.
 */
function breakerGate(store, bridgeId, adapterMethod, nowMs, openMs) {
  const rec = breakerRecord(store, bridgeId);
  if (rec.state === 'open') {
    if (nowMs - rec.openedAt >= openMs) {
      rec.state = 'half-open';
      rec.probeSent = false;
    } else {
      return { ok: false };
    }
  }
  if (rec.state === 'half-open') {
    if (adapterMethod !== 'ping' || rec.probeSent) return { ok: false };
    rec.probeSent = true;
    return { ok: true, probe: true };
  }
  return { ok: true };
}

/** Count a logical call failure toward the breaker (D3 §3.3 failure classes). */
function breakerNoteFailure(store, bridgeId, err, nowMs, onEvent) {
  const countable =
    err instanceof TimeoutError ||
    (err instanceof TransportError && err.code !== 'not_connected' && err.code !== 'bridge_circuit_open') ||
    (err instanceof ServerError && err.httpStatus >= 500);
  if (!countable) return false;
  const rec = breakerRecord(store, bridgeId);
  rec.failures += 1;
  if (rec.failures >= BREAKER_FAILURES_TO_OPEN && rec.state !== 'open') {
    rec.state = 'open';
    rec.openedAt = nowMs;
    rec.probeSent = false;
    try { onEvent?.({ type: 'breaker_open', bridgeId, failures: rec.failures }); } catch { /* observer */ }
    return true;
  }
  return false;
}

function breakerNoteSuccess(store, bridgeId, onEvent) {
  const rec = breakerRecord(store, bridgeId);
  const wasProbing = rec.state === 'half-open' || rec.state === 'open';
  rec.failures = 0;
  if (rec.state !== 'closed') {
    rec.state = 'closed';
    rec.probeSent = false;
    if (wasProbing) {
      try { onEvent?.({ type: 'breaker_close', bridgeId }); } catch { /* observer */ }
    }
  }
}

// ---------------------------------------------------------------------------
// HerdrBridgeAdapter
// ---------------------------------------------------------------------------

/** Internal signal: the bridge reported events_lost on the SSE stream. */
class _EventsLost extends Error {
  constructor(lostCount, lastSeq) {
    super('events_lost');
    this.lostCount = lostCount;
    this.lastSeq = lastSeq;
  }
}

/** Internal signal: the stream died and the breaker forbids recovery. */
class _BridgeDown extends Error {
  constructor(message) {
    super(message);
    this.code = 'bridge_down';
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class HerdrBridgeAdapter {
  /**
   * @param {object} opts
   * @param {{ id, url, keyId, methods }} opts.bridge — resolved route entry
   * @param {string} opts.tenantId
   * @param {string} opts.masterSecret — BRIDGE_MASTER_SECRET[_<HOST>]
   * @param {object} [opts.pins] — pinned-herdr.json content (default: the shipped file)
   * @param {(info) => void} [opts.onVersionMismatch]
   * @param {(event) => void} [opts.onEvent] — breaker transitions, subscription lifecycle
   * @param {() => number} [opts.now] — clock (injectable for tests)
   * @param {Map} [opts.breakerStore] — breaker state (injectable for tests)
   * @param {number} [opts.circuitOpenMs] — half-open window (default 60s)
   * @param {number} [opts.heartbeatTimeoutMs] — SSE dead-stream detection (default 50s)
   * @param {number} [opts.reconnectDelayMs] — backoff before resubscribing after an
   *   UNPLANNED stream end (default 1000ms). Explicit events_lost resubscribes
   *   immediately — the bridge is healthy and handing us a cursor; a delay
   *   there would only widen the gap.
   */
  constructor(opts) {
    if (!opts?.bridge?.url) throw new Error('HerdrBridgeAdapter: opts.bridge.url is required');
    if (!opts?.tenantId) throw new Error('HerdrBridgeAdapter: opts.tenantId is required');
    if (!opts?.masterSecret) throw new Error('HerdrBridgeAdapter: opts.masterSecret is required');
    this._bridge = opts.bridge;
    this._tenantId = opts.tenantId;
    this._masterSecret = opts.masterSecret;
    this._pins = opts.pins ?? pinnedHerdrJson;
    this._onVersionMismatch = typeof opts.onVersionMismatch === 'function' ? opts.onVersionMismatch : null;
    this._onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : null;
    this._now = typeof opts.now === 'function' ? opts.now : () => Date.now();
    this._breakerStore = opts.breakerStore ?? defaultBreakerStore;
    this._circuitOpenMs = typeof opts.circuitOpenMs === 'number' ? opts.circuitOpenMs : BREAKER_OPEN_MS;
    this._heartbeatTimeoutMs = typeof opts.heartbeatTimeoutMs === 'number' ? opts.heartbeatTimeoutMs : 2 * BRIDGE_HEARTBEAT_MS;
    this._reconnectDelayMs = typeof opts.reconnectDelayMs === 'number' ? opts.reconnectDelayMs : 1000;
    this._connected = false;
    this._protocolVersion = null;
    this._herdrVersion = null;
    this._advertisedRoutes = [];
    this._subscriptions = new Map();
    this._subSeq = 0;
    this._tokenPromise = null;
  }

  get connected() { return this._connected; }
  get backend() { return BRIDGE_BACKEND; }
  get protocolVersion() { return this._protocolVersion; }
  get herdrVersion() { return this._herdrVersion; }
  get tenantId() { return this._tenantId; }
  get bridgeId() { return this._bridge.id; }

  _emit(type, payload = {}) {
    try { this._onEvent?.({ type, bridgeId: this._bridge.id, tenantId: this._tenantId, at: this._now(), ...payload }); } catch { /* observer */ }
  }

  /**
   * Open the bridge session: ping + fail-closed version assert. Throws
   * VersionMismatchError on ANY drift (no downgrade). Network/timeout/5xx
   * failures propagate as TransportError/TimeoutError — connectSession()
   * converts those to the legacy fallback so claiming is never blocked.
   */
  async connect() {
    if (this._connected) return;
    const pins = this._pins ?? {};
    const missing = ['herdrVersion', 'protocolVersion', 'forkCommit', 'binarySha256']
      .filter((k) => pins[k] == null || (typeof pins[k] === 'string' && pins[k].startsWith('TBD-')));
    if (missing.length > 0) {
      throw new VersionMismatchError(
        `herdr pins not configured (${missing.join(', ')}) — refusing to start against an unpinned server`,
        { backend: BRIDGE_BACKEND, code: 'pins_unconfigured', missing },
      );
    }
    const res = await this._call({ adapterMethod: 'ping', timeoutMs: BRIDGE_TIMEOUTS.connect, body: {} });
    const observed = {
      protocolVersion: res?.protocolVersion,
      herdrVersion: res?.version,
      methods: Array.isArray(res?.methods) ? res.methods : null,
    };
    const missingCore = observed.methods == null
      ? [...BRIDGE_CORE_METHODS]
      : BRIDGE_CORE_METHODS.filter((m) => !observed.methods.includes(ADAPTER_METHOD_TO_ROUTE[m]));
    const mismatch =
      observed.methods == null ||
      observed.protocolVersion !== pins.protocolVersion ||
      observed.herdrVersion !== pins.herdrVersion ||
      missingCore.length > 0;
    if (mismatch) {
      const info = {
        backend: BRIDGE_BACKEND,
        bridgeId: this._bridge.id,
        pinnedProtocolVersion: pins.protocolVersion,
        observedProtocolVersion: observed.protocolVersion ?? null,
        pinnedHerdrVersion: pins.herdrVersion,
        observedHerdrVersion: observed.herdrVersion ?? null,
        missingCoreMethods: missingCore,
      };
      try { this._onVersionMismatch?.(info); } catch { /* observer must not break the fail-closed throw */ }
      throw new VersionMismatchError(
        `version mismatch: pinned protocol ${String(pins.protocolVersion)} / binary ${pins.herdrVersion} ` +
        `vs observed protocol ${String(observed.protocolVersion)} / binary ${observed.herdrVersion}` +
        (missingCore.length ? `; missing core methods: ${missingCore.join(', ')}` : ''),
        info,
      );
    }
    this._protocolVersion = observed.protocolVersion;
    this._herdrVersion = observed.herdrVersion;
    this._advertisedRoutes = [...observed.methods];
    this._connected = true;
    this._emit('connected', { protocolVersion: this._protocolVersion, herdrVersion: this._herdrVersion });
  }

  /** Close all subscriptions, then the bridge session. Idempotent. */
  async disconnect() {
    if (!this._connected && this._subscriptions.size === 0) return;
    for (const record of this._subscriptions.values()) {
      try { await record.sub.close(); } catch { /* best effort */ }
    }
    this._subscriptions.clear();
    this._connected = false;
    this._protocolVersion = null;
    this._herdrVersion = null;
    this._emit('disconnected', {});
  }

  /**
   * Capability probe. Before connect: the static core tier. After connect:
   * the bridge-advertised route list. The tenant route-auth allowlist is NOT
   * consulted here — a method can be advertised but denied for this tenant,
   * in which case the call throws MethodUnsupportedError (deny-by-default).
   */
  supports(method) {
    if (!this._connected) return CORE_METHODS.includes(method);
    if (method === 'connect' || method === 'disconnect' || method === 'supports') return true;
    const route = ADAPTER_METHOD_TO_ROUTE[method];
    if (!route) return false;
    return this._advertisedRoutes.includes(route);
  }

  /** @returns {Promise<{ ok: true, protocolVersion: number, herdrVersion: string }>} */
  async ping() {
    this._requireConnected();
    const res = await this._call({ adapterMethod: 'ping', timeoutMs: BRIDGE_TIMEOUTS.ping, body: {} });
    return { ok: res?.ok === true, protocolVersion: res?.protocolVersion, herdrVersion: res?.version };
  }

  /** Full workspace → tab → pane → agent bootstrap; the post-events_lost source of truth. */
  async snapshot() {
    this._requireConnected();
    return this._call({ adapterMethod: 'snapshot', timeoutMs: BRIDGE_TIMEOUTS.snapshot, body: {} });
  }

  /**
   * Launch an agent. Continuity is via the agent CLI's OWN session store
   * (resumeSessionRef / resumeCommand) — never transcript replay. The bridge
   * builds argv from allowlisted kinds; the adapter never sends raw argv
   * beyond the documented resumeCommand (capped at 64 args / 8 KiB).
   */
  async spawnAgent(opts = {}) {
    this._requireConnected();
    if (!opts || typeof opts.command !== 'string' || opts.command.length === 0) {
      throw new Error('spawnAgent: opts.command (non-empty string) is required');
    }
    const resumeCommand = validateResumeCommand(opts.resumeCommand);
    const res = await this._call({
      adapterMethod: 'spawnAgent',
      timeoutMs: BRIDGE_TIMEOUTS.spawn,
      write: true,
      body: {
        kind: opts.kind ?? null,
        command: opts.command,
        args: Array.isArray(opts.args) ? opts.args : [],
        cwd: opts.cwd ?? null,
        workspace: opts.workspace ?? null,
        tab: opts.tab ?? null,
        title: opts.title ?? null,
        resumeSessionRef: opts.resumeSessionRef ?? null,
        resumeCommand,
        metadata: opts.metadata && typeof opts.metadata === 'object' ? opts.metadata : {},
      },
    });
    if (!res || typeof res.id !== 'string' || typeof res.paneId !== 'string') {
      throw new ServerError('invalid_response', 'spawnAgent: bridge returned a malformed handle', { backend: BRIDGE_BACKEND });
    }
    return { id: res.id, paneId: res.paneId, occupantId: res.occupantId ?? null };
  }

  /** @returns {Promise<AgentInfo[]>} */
  async listAgents() {
    this._requireConnected();
    const res = await this._call({ adapterMethod: 'listAgents', timeoutMs: BRIDGE_TIMEOUTS.list, body: { op: 'list' } });
    return Array.isArray(res?.agents) ? res.agents : [];
  }

  /** @returns {Promise<AgentInfo>} — unknown id → ServerError(not_found) */
  async getAgent(agentId) {
    this._requireConnected();
    if (typeof agentId !== 'string' || agentId.length === 0) throw new Error('getAgent: agentId is required');
    const res = await this._call({ adapterMethod: 'getAgent', timeoutMs: BRIDGE_TIMEOUTS.list, body: { op: 'get', agentId } });
    if (!res?.agent) {
      throw new ServerError('not_found', `getAgent: unknown agent ${agentId}`, { backend: BRIDGE_BACKEND, agentId });
    }
    return res.agent;
  }

  /** Close a pane. Idempotent. */
  async closePane(paneId) {
    this._requireConnected();
    if (typeof paneId !== 'string' || paneId.length === 0) throw new Error('closePane: paneId is required');
    await this._call({ adapterMethod: 'closePane', timeoutMs: BRIDGE_TIMEOUTS.close, write: true, body: { paneId } });
  }

  /** Text snapshot for supervisors. No keystroke injection. */
  async readPane(paneId, source, opts = {}) {
    this._requireConnected();
    if (typeof paneId !== 'string' || paneId.length === 0) throw new Error('readPane: paneId is required');
    if (!PANE_SOURCES.includes(source)) {
      throw new Error(`readPane: unknown source ${JSON.stringify(source)} — expected one of ${PANE_SOURCES.join(', ')}`);
    }
    const lines = typeof opts.lines === 'number' && opts.lines >= 0 ? opts.lines : 200;
    const res = await this._call({ adapterMethod: 'readPane', timeoutMs: BRIDGE_TIMEOUTS.read, body: { paneId, source, lines } });
    return { paneId, source, lines: Array.isArray(res?.lines) ? res.lines : [], text: typeof res?.text === 'string' ? res.text : '' };
  }

  /**
   * Send text to the agent. Occupant-pinned: the bridge verifies occupantId
   * and rejects with OccupantChangedError when the pane occupant moved —
   * the send is NOT delivered. opts.wait = { until, timeoutMs } adds an
   * event-driven waitForState after the send.
   */
  async sendText(target, text, opts = {}) {
    this._requireConnected();
    if (typeof text !== 'string') throw new Error('sendText: text must be a string');
    const { agentId, occupantId } = splitTarget(target, 'sendText');
    const res = await this._call({
      adapterMethod: 'sendText',
      timeoutMs: BRIDGE_TIMEOUTS.send,
      write: true,
      body: { agentId, occupantId, text },
    });
    const result = { ok: res?.ok !== false, agentId, bytes: text.length };
    if (opts.wait) {
      if (!Array.isArray(opts.wait.until) || typeof opts.wait.timeoutMs !== 'number') {
        throw new Error('sendText: opts.wait must be { until: AgentState[], timeoutMs: number }');
      }
      result.finalState = await this.waitForState(agentId, opts.wait.until, { timeoutMs: opts.wait.timeoutMs });
    }
    return result;
  }

  /** Raw key injection. Same occupant pinning as sendText; supervisor flows only. */
  async sendKeys(target, keys) {
    this._requireConnected();
    if (!Array.isArray(keys)) throw new Error('sendKeys: keys must be an array of strings');
    const { agentId, occupantId } = splitTarget(target, 'sendKeys');
    await this._call({
      adapterMethod: 'sendKeys',
      timeoutMs: BRIDGE_TIMEOUTS.keys,
      write: true,
      body: { agentId, occupantId, keys },
    });
  }

  /**
   * Event-driven wait until the agent reaches one of `states`, via the
   * bridge's long-poll /v1/wait. Rounds are capped at 120s per HTTP round-trip
   * (edge limits) and re-issued with the SAME idempotency key — the bridge
   * cancels the orphaned server-side wait on key reuse. No polling.
   */
  async waitForState(target, states, opts = {}) {
    this._requireConnected();
    if (!Array.isArray(states) || states.length === 0) {
      throw new Error('waitForState: states must be a non-empty array');
    }
    const { timeoutMs, signal } = opts;
    if (typeof timeoutMs !== 'number' || !(timeoutMs >= 0)) {
      throw new Error('waitForState: opts.timeoutMs (number) is required');
    }
    const { agentId, occupantId } = splitTarget(target, 'waitForState');
    if (signal?.aborted) {
      throw new TimeoutError(`waitForState: aborted waiting for [${states.join(', ')}] on ${agentId}`, { backend: BRIDGE_BACKEND, agentId });
    }
    const idempotencyKey = newIdempotencyKey();
    const deadline = this._now() + timeoutMs;
    for (;;) {
      const remaining = deadline - this._now();
      if (remaining <= 0) {
        throw new TimeoutError(
          `waitForState: timed out after ${timeoutMs}ms waiting for [${states.join(', ')}] on ${agentId}`,
          { backend: BRIDGE_BACKEND, timeoutMs, agentId },
        );
      }
      const roundMs = Math.min(remaining, BRIDGE_TIMEOUTS.waitRoundCap);
      const res = await this._call({
        adapterMethod: 'waitForState',
        timeoutMs: roundMs,
        write: true,
        idempotencyKey,
        signal,
        body: { mode: 'state', agentId, occupantId, states, timeoutMs: roundMs },
      });
      if (res && res.matched === true && typeof res.state === 'string') return res.state;
      // Bridge-side round timeout without a match → re-issue until the deadline.
    }
  }

  /**
   * Regex wait over pane output, via the bridge's long-poll /v1/wait.
   * For non-agent processes; agent flows should prefer waitForState.
   */
  async waitForOutput(paneId, regex, opts = {}) {
    this._requireConnected();
    if (typeof paneId !== 'string' || paneId.length === 0) throw new Error('waitForOutput: paneId is required');
    const { timeoutMs, signal } = opts;
    if (typeof timeoutMs !== 'number' || !(timeoutMs >= 0)) {
      throw new Error('waitForOutput: opts.timeoutMs (number) is required');
    }
    const re = regex instanceof RegExp ? regex : new RegExp(regex);
    const idempotencyKey = newIdempotencyKey();
    const deadline = this._now() + timeoutMs;
    for (;;) {
      const remaining = deadline - this._now();
      if (remaining <= 0) {
        throw new TimeoutError(
          `waitForOutput: timed out after ${timeoutMs}ms on ${paneId}`,
          { backend: BRIDGE_BACKEND, timeoutMs, paneId },
        );
      }
      const roundMs = Math.min(remaining, BRIDGE_TIMEOUTS.waitRoundCap);
      const res = await this._call({
        adapterMethod: 'waitForOutput',
        timeoutMs: roundMs,
        write: true,
        idempotencyKey,
        signal,
        body: { mode: 'output', paneId, pattern: re.source, flags: re.flags, timeoutMs: roundMs },
      });
      if (res && res.matched === true && typeof res.matchedLine === 'string') {
        return { paneId, matched: res.matchedLine };
      }
    }
  }

  /**
   * The honesty path: the worker declares its own state. Authoritative for
   * lane state; detection events are hints only.
   */
  async reportState(paneId, state, detail) {
    this._requireConnected();
    if (typeof paneId !== 'string' || paneId.length === 0) throw new Error('reportState: paneId is required');
    await this._call({
      adapterMethod: 'reportState', timeoutMs: BRIDGE_TIMEOUTS.report, write: true,
      body: { report: 'state', paneId, state, detail: detail ?? null },
    });
  }

  /** Store the agent CLI's native session ref + resume command (capped, fail fast). */
  async reportResume(paneId, ref = {}) {
    this._requireConnected();
    if (typeof paneId !== 'string' || paneId.length === 0) throw new Error('reportResume: paneId is required');
    const resumeCommand = ref.resumeCommand !== undefined ? validateResumeCommand(ref.resumeCommand) : undefined;
    await this._call({
      adapterMethod: 'reportResume', timeoutMs: BRIDGE_TIMEOUTS.report, write: true,
      body: { report: 'resume', paneId, ref: { sessionRef: ref.sessionRef ?? null, ...(resumeCommand !== undefined ? { resumeCommand } : {}) } },
    });
  }

  /** Display-only labels/tokens with optional TTL. */
  async reportMetadata(paneId, meta, opts = {}) {
    this._requireConnected();
    if (typeof paneId !== 'string' || paneId.length === 0) throw new Error('reportMetadata: paneId is required');
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
      throw new Error('reportMetadata: meta must be a plain object of string values');
    }
    for (const [k, v] of Object.entries(meta)) {
      if (typeof v !== 'string') throw new Error(`reportMetadata: value for ${JSON.stringify(k)} must be a string`);
    }
    const ttlMs = opts.ttlMs;
    if (ttlMs !== undefined && (typeof ttlMs !== 'number' || !(ttlMs >= 0))) {
      throw new Error('reportMetadata: opts.ttlMs must be a non-negative number');
    }
    await this._call({
      adapterMethod: 'reportMetadata', timeoutMs: BRIDGE_TIMEOUTS.report, write: true,
      body: { report: 'metadata', paneId, meta, ...(ttlMs !== undefined ? { ttlMs } : {}) },
    });
  }

  /**
   * Push event feed over the bridge SSE stream. The ADAPTER owns recovery:
   * on events_lost (or stream death) it re-runs snapshot(), calls
   * onReconcile(snapshot, lostCount), then resubscribes with the since cursor.
   * Callers never see a silent gap. If the bridge is down past the breaker
   * window, the subscription closes and onSubscriptionLost fires with a
   * SubscriptionLostError — the caller then re-connect()s (may select legacy).
   */
  async subscribe(eventNames, handler, opts = {}) {
    this._requireConnected();
    if (!Array.isArray(eventNames) || eventNames.length === 0) {
      throw new Error('subscribe: eventNames must be a non-empty array of strings');
    }
    if (typeof handler !== 'function') throw new Error('subscribe: handler must be a function');
    this._requireRouteMethod('subscribe');
    const id = `sub-${++this._subSeq}-${newIdempotencyKey().slice(0, 8)}`;
    const controller = new AbortController();
    const sub = {
      id,
      active: true,
      close: async () => {
        if (!sub.active) return;
        sub.active = false;
        this._subscriptions.delete(id);
        try { controller.abort(); } catch { /* ignore */ }
        this._emit('subscription_closed', { subscriptionId: id });
      },
    };
    const record = {
      sub,
      controller,
      eventNames: new Set(eventNames),
      handler,
      onReconcile: typeof opts.onReconcile === 'function' ? opts.onReconcile : null,
      onSubscriptionLost: typeof opts.onSubscriptionLost === 'function' ? opts.onSubscriptionLost : null,
      lastSeq: 0,
    };
    this._subscriptions.set(id, record);
    // Fire-and-forget pump; every path is caught inside _pump (no unhandled rejections).
    void this._pump(record).catch(() => {});
    return sub;
  }

  /**
   * One-shot event wait on a dedicated subscription. Filter is
   * { type?, agentId?, paneId? } or a predicate function.
   */
  async waitForEvent(filter, opts = {}) {
    this._requireConnected();
    const { timeoutMs } = opts;
    if (typeof timeoutMs !== 'number' || !(timeoutMs >= 0)) {
      throw new Error('waitForEvent: opts.timeoutMs (number) is required');
    }
    const matches = typeof filter === 'function'
      ? filter
      : (ev) => {
        if (filter.type && ev.type !== filter.type) return false;
        if (filter.agentId && ev.agentId !== filter.agentId) return false;
        if (filter.paneId && ev.paneId !== filter.paneId) return false;
        return true;
      };
    let sub = null;
    try {
      return await new Promise((resolve, reject) => {
        let settled = false;
        const settle = (fn, v) => { if (settled) return; settled = true; fn(v); };
        const timer = setTimeout(() => settle(reject, new TimeoutError(
          `waitForEvent: timed out after ${timeoutMs}ms`,
          { backend: BRIDGE_BACKEND, timeoutMs },
        )), timeoutMs);
        this.subscribe(['*'], (ev) => {
          let ok = false;
          try { ok = matches(ev); } catch { ok = false; }
          if (ok) { clearTimeout(timer); settle(resolve, ev); }
        }).then((s) => { sub = s; if (settled) s.close().catch(() => {}); })
          .catch((e) => { clearTimeout(timer); settle(reject, e); });
      });
    } finally {
      if (sub) await sub.close().catch(() => {});
    }
  }

  // -- internals -------------------------------------------------------------

  _requireConnected() {
    if (!this._connected) {
      throw new TransportError('not_connected', 'session-adapter: not connected — call connect() first', { backend: BRIDGE_BACKEND });
    }
  }

  /** Route-auth allowlist check: deny-by-default, before any bridge contact. */
  _requireRouteMethod(adapterMethod) {
    const route = ADAPTER_METHOD_TO_ROUTE[adapterMethod];
    if (!route) {
      throw new MethodUnsupportedError(adapterMethod, `unknown adapter method: ${adapterMethod}`, { backend: BRIDGE_BACKEND });
    }
    if (!this._bridge.methods.includes(route)) {
      throw new MethodUnsupportedError(
        adapterMethod,
        `method not allowed for this tenant's bridge route (deny-by-default): ${adapterMethod}`,
        { backend: BRIDGE_BACKEND, bridgeId: this._bridge.id, method: adapterMethod },
      );
    }
    return route;
  }

  _bearerToken() {
    if (!this._tokenPromise) {
      this._tokenPromise = deriveBridgeToken(this._masterSecret, this._tenantId);
    }
    return this._tokenPromise;
  }

  async _authHeaders() {
    const headers = {
      authorization: `Bearer ${await this._bearerToken()}`,
    };
    if (this._bridge.keyId) headers['x-bridge-key-id'] = this._bridge.keyId;
    return headers;
  }

  /**
   * One logical bridge call: breaker gate → route-auth check → fetch with
   * retries inside the call's timeout budget → typed error mapping.
   * Reads: up to 3 attempts. Writes: up to 2 attempts, ONLY when no response
   * was received, with the SAME idempotency key (bridge dedupes).
   */
  async _call({ adapterMethod, timeoutMs, write = false, idempotencyKey, body = {}, signal, query = '' }) {
    const route = this._requireRouteMethod(adapterMethod);
    const path = ROUTE_TO_PATH[route];
    const key = write ? (idempotencyKey ?? newIdempotencyKey()) : null;
    const maxAttempts = write ? 2 : 3;
    const deadline = this._now() + timeoutMs;
    let attempt = 0;
    let lastErr = null;
    while (attempt < maxAttempts) {
      attempt += 1;
      const gate = breakerGate(this._breakerStore, this._bridge.id, adapterMethod, this._now(), this._circuitOpenMs);
      if (!gate.ok) {
        throw new TransportError(
          'bridge_circuit_open',
          `bridge circuit open for ${this._bridge.id} — failing fast (new sessions fall back to legacy)`,
          { backend: BRIDGE_BACKEND, bridgeId: this._bridge.id },
        );
      }
      const remaining = deadline - this._now();
      if (remaining <= 0) break;
      try {
        const res = await this._fetchOnce({
          adapterMethod, path, query,
          timeoutMs: Math.min(timeoutMs, remaining),
          write, idempotencyKey: key, body, signal,
        });
        breakerNoteSuccess(this._breakerStore, this._bridge.id, this._onEvent);
        return res;
      } catch (e) {
        lastErr = e;
        breakerNoteFailure(this._breakerStore, this._bridge.id, e, this._now(), this._onEvent);
        const canRetry = attempt < maxAttempts && isRetryable(e, write);
        if (!canRetry) throw e;
        // Exponential backoff with full jitter; never exceed the call budget.
        const cap = Math.min(2 ** (attempt - 1) * 250, 4000);
        const waitMs = Math.min(Math.random() * cap, Math.max(0, deadline - this._now()));
        if (waitMs > 0) await sleep(waitMs);
      }
    }
    if (lastErr instanceof TimeoutError) throw lastErr;
    throw new TimeoutError(
      `${adapterMethod}: timed out after ${timeoutMs}ms (bridge ${this._bridge.id})`,
      { backend: BRIDGE_BACKEND, bridgeId: this._bridge.id, timeoutMs, cause: lastErr?.code ?? lastErr?.message },
    );
  }

  /**
   * Single HTTP round-trip. Throws typed SessionAdapterErrors. Errors carry
   * two internal flags: `noResponse` (timeout / connection reset — nothing
   * came back) and `emptyBody5xx` (5xx with an empty body). Writes retry only
   * when one of those is set; everything else is final.
   */
  async _fetchOnce({ adapterMethod, path, query, timeoutMs, write, idempotencyKey, body, signal }) {
    const ctx = { backend: BRIDGE_BACKEND, bridgeId: this._bridge.id, adapterMethod };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let onCallerAbort = null;
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        throw new TimeoutError(`${adapterMethod}: aborted`, { ...ctx, timeoutMs });
      }
      onCallerAbort = () => controller.abort();
      signal.addEventListener('abort', onCallerAbort, { once: true });
    }
    try {
      const headers = { ...(await this._authHeaders()), 'content-type': 'application/json' };
      if (write && idempotencyKey) headers['x-idempotency-key'] = idempotencyKey;
      const res = await fetch(`${this._bridge.url}${path}${query}`, {
        method: adapterMethod === 'subscribe' || adapterMethod === 'waitForEvent' ? 'GET' : 'POST',
        headers,
        body: Object.keys(body).length > 0 ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const text = await res.text();
      let data = null;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          throw new ServerError('invalid_response', `bridge returned non-JSON on ${path}`, { ...ctx, httpStatus: res.status });
        }
      }
      if (data && typeof data === 'object' && data.error && typeof data.error === 'object') {
        throw typedBridgeError(data.error.code, data.error.message, { ...ctx, httpStatus: res.status, adapterMethod });
      }
      if (res.status === 401 || res.status === 403) {
        throw new ServerError('auth_denied', `bridge denied auth on ${path} (check BRIDGE_MASTER_SECRET)`, { ...ctx, httpStatus: res.status });
      }
      if (res.status === 404) {
        throw new MethodUnsupportedError(adapterMethod, `bridge route ${path} not found — contract drift`, { ...ctx, httpStatus: 404 });
      }
      if (res.status === 429) {
        const e = new TransportError('bridge_rate_limited', `bridge rate-limited ${path}`, { ...ctx, httpStatus: 429 });
        e.gotResponse = true;
        throw e;
      }
      if (res.status >= 500) {
        const e = new TransportError('bridge_server_error', `bridge error ${res.status} on ${path}`, { ...ctx, httpStatus: res.status });
        e.gotResponse = true;
        e.emptyBody5xx = !text;
        throw e;
      }
      if (res.status >= 400) {
        throw new ServerError('invalid_request', `bridge rejected ${path} with ${res.status}`, { ...ctx, httpStatus: res.status });
      }
      return data;
    } catch (e) {
      if (e instanceof SessionAdapterError) throw e;
      // Anything else is a transport failure (timeout abort, reset, DNS…).
      const abortedByCaller = signal?.aborted === true;
      if (abortedByCaller) {
        throw new TimeoutError(`${adapterMethod}: aborted`, { ...ctx, timeoutMs });
      }
      if (controller.signal.aborted) {
        const t = new TimeoutError(`${adapterMethod}: timed out after ${timeoutMs}ms`, { ...ctx, timeoutMs });
        t.noResponse = true;
        throw t;
      }
      const t = new TransportError('connection_error', `bridge connection failed on ${path}: ${e.message}`, { ...ctx });
      t.noResponse = true;
      throw t;
    } finally {
      clearTimeout(timer);
      if (signal && onCallerAbort) signal.removeEventListener('abort', onCallerAbort);
    }
  }

  // -- SSE subscription pump ---------------------------------------------------

  /** The pump loop: stream → dispatch; on death/events_lost → recover → resubscribe.
   * Unplanned stream ends back off before resubscribing (a bridge that closes
   * every stream must not be hammered in a hot loop); an explicit events_lost
   * resubscribes immediately. Every path is caught — no unhandled rejections. */
  async _pump(record) {
    const { sub } = record;
    while (sub.active) {
      let lost = null; // { lostCount, lastSeq } when the bridge signaled events_lost
      try {
        await this._streamEvents(record);
      } catch (e) {
        if (e instanceof _EventsLost) {
          lost = { lostCount: e.lostCount, lastSeq: e.lastSeq };
        } else if (e instanceof _BridgeDown) {
          await this._closeSubscriptionLost(record, new SubscriptionLostError(
            `events stream unrecoverable: bridge down for ${this._bridge.id}`,
            { backend: BRIDGE_BACKEND, bridgeId: this._bridge.id },
          ));
          return;
        }
        // else: unplanned death (reset, heartbeat timeout, clean close) → delayed recovery below
      }
      if (!sub.active) return;
      if (!lost) await sleep(this._reconnectDelayMs);
      if (!sub.active) return;
      const ok = await this._recoverSubscription(record, lost?.lostCount ?? null, lost?.lastSeq ?? null);
      if (!ok) return;
    }
  }

  /** Open the SSE stream and dispatch frames until it ends. Never returns normally while active. */
  async _streamEvents(record) {
    const { sub, controller } = record;
    const gate = breakerGate(this._breakerStore, this._bridge.id, 'subscribe', this._now(), this._circuitOpenMs);
    if (!gate.ok) {
      throw new _BridgeDown(`bridge circuit open for ${this._bridge.id} — cannot (re)subscribe`);
    }
    const path = `${ROUTE_TO_PATH.events}?since=${encodeURIComponent(String(record.lastSeq))}`;
    const res = await fetch(`${this._bridge.url}${path}`, {
      method: 'GET',
      headers: await this._authHeaders(),
      signal: controller.signal,
    }).catch((e) => {
      if (controller.signal.aborted) throw new _BridgeDown('subscription closed');
      const t = new TransportError('connection_error', `events stream failed: ${e.message}`, { backend: BRIDGE_BACKEND, bridgeId: this._bridge.id });
      t.noResponse = true;
      throw t;
    });
    if (res.status === 401 || res.status === 403) {
      throw new ServerError('auth_denied', 'bridge denied auth on /v1/events', { backend: BRIDGE_BACKEND, bridgeId: this._bridge.id, httpStatus: res.status });
    }
    if (!res.ok || !res.body) {
      const t = new TransportError('bridge_server_error', `events stream failed with ${res.status}`, { backend: BRIDGE_BACKEND, bridgeId: this._bridge.id, httpStatus: res.status });
      t.gotResponse = true;
      throw t;
    }
    breakerNoteSuccess(this._breakerStore, this._bridge.id, this._onEvent);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let pendingEvent = null;
    let pendingData = [];
    let lastFrameAt = this._now();
    const checkHeartbeat = () => {
      if (this._now() - lastFrameAt > this._heartbeatTimeoutMs) {
        throw new Error('stream_dead: no heartbeat within the watchdog window');
      }
    };
    const flushFrame = () => {
      const event = pendingEvent;
      const data = pendingData.join('\n');
      pendingEvent = null;
      pendingData = [];
      if (event === 'heartbeat') return; // bridge heartbeat frame
      if (event === 'events_lost') {
        let lostCount = null;
        let lastSeq = record.lastSeq;
        try {
          const p = JSON.parse(data);
          if (typeof p.lostCount === 'number') lostCount = p.lostCount;
          if (typeof p.lastSeq === 'number') lastSeq = p.lastSeq;
        } catch { /* keep defaults */ }
        throw new _EventsLost(lostCount, lastSeq);
      }
      if (!data) return;
      let ev;
      try {
        ev = JSON.parse(data);
      } catch {
        return; // ignore malformed frames; the heartbeat watchdog still guards liveness
      }
      if (typeof ev.seq === 'number' && ev.seq > record.lastSeq) record.lastSeq = ev.seq;
      const names = record.eventNames;
      if (names.has('*') || (typeof ev.type === 'string' && names.has(ev.type))) {
        try { record.handler({ at: this._now(), ...ev }); } catch { /* one bad handler must not kill the pump */ }
      }
    };

    try {
      for (;;) {
        if (!sub.active) return;
        checkHeartbeat();
        const remaining = this._heartbeatTimeoutMs - (this._now() - lastFrameAt);
        const readP = reader.read();
        let watchdog;
        const timeoutP = new Promise((_, reject) => {
          watchdog = setTimeout(() => reject(new Error('stream_dead: no heartbeat within the watchdog window')), Math.max(0, remaining));
        });
        let chunk;
        try {
          const r = await Promise.race([readP, timeoutP]);
          chunk = r;
        } catch (e) {
          try { reader.cancel().catch(() => {}); } catch { /* ignore */ }
          throw e;
        } finally {
          clearTimeout(watchdog);
        }
        if (chunk.done) {
          // Server closed the stream: treat as a death to recover from (unless we closed it).
          if (!sub.active) return;
          throw new Error('stream_closed: server ended the events stream');
        }
        lastFrameAt = this._now();
        buf += decoder.decode(chunk.value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of frame.split('\n')) {
            if (line.startsWith(':')) { lastFrameAt = this._now(); continue; } // SSE comment heartbeat
            if (line.startsWith('event:')) { pendingEvent = line.slice(6).trim(); continue; }
            if (line.startsWith('data:')) { pendingData.push(line.slice(5).trimStart()); continue; }
          }
          flushFrame();
        }
      }
    } finally {
      try { reader.cancel().catch(() => {}); } catch { /* ignore */ }
    }
  }

  /**
   * Adapter-owned recovery: re-snapshot through the SAME bridge, notify
   * onReconcile, then let the pump resubscribe with the since cursor.
   * Returns false when recovery is impossible (caller must re-connect()).
   */
  async _recoverSubscription(record, lostCount, lastSeq) {
    const { sub } = record;
    if (lastSeq != null && lastSeq > record.lastSeq) record.lastSeq = lastSeq;
    let snapshot;
    try {
      snapshot = await this._call({ adapterMethod: 'snapshot', timeoutMs: BRIDGE_TIMEOUTS.snapshot, body: {} });
    } catch (e) {
      // Breaker open or bridge unreachable: no silent gap is possible — close loudly.
      await this._closeSubscriptionLost(record, new SubscriptionLostError(
        `events stream unrecoverable: ${e.code ?? e.message}`,
        { backend: BRIDGE_BACKEND, bridgeId: this._bridge.id, cause: e.code ?? e.message },
      ));
      return false;
    }
    if (typeof record.onReconcile === 'function') {
      try { await record.onReconcile(snapshot, lostCount); } catch { /* observer must not break recovery */ }
    }
    this._emit('subscription_recovered', { subscriptionId: sub.id, lostCount });
    return true;
  }

  async _closeSubscriptionLost(record, err) {
    const { sub } = record;
    if (!sub.active) return;
    sub.active = false;
    this._subscriptions.delete(sub.id);
    try { record.controller.abort(); } catch { /* ignore */ }
    this._emit('subscription_lost', { subscriptionId: sub.id, error: err.code ?? err.message });
    if (typeof record.onSubscriptionLost === 'function') {
      try { record.onSubscriptionLost(err); } catch { /* observer */ }
    }
  }
}

// ---------------------------------------------------------------------------
// connectSession — all-or-nothing backend selection
// ---------------------------------------------------------------------------

/**
 * Decide the session backend for a tenant, once, at connect time.
 *
 * Returns `{ backend: "herdr", adapter }` (adapter already connected) or
 * `{ backend: "legacy", reason, detail? }`. The legacy branch is the
 * fail-closed path: flag off, room not listed, no route (default-deny),
 * bridge unreachable, or breaker open. Version/auth problems throw instead
 * of silently degrading — a misconfigured or unpinned bridge must be LOUD.
 *
 * @param {object} opts
 * @param {object} opts.config — readHerdrBridgeConfig(env)
 * @param {string} opts.tenantId
 * @param {string} opts.roomId — for the ROOM_HERDR_SESSIONS room allowlist
 * @param {object} opts.env — the Worker env (secret lookup)
 * @param {object} [opts.pins] — default: the shipped pinned-herdr.json
 * @param {(info) => void} [opts.onVersionMismatch]
 * @param {(fallback) => void} [opts.onFallback] — alert hook for legacy fallbacks
 * @param {(event) => void} [opts.onEvent]
 * @param {() => number} [opts.now]
 * @param {Map} [opts.breakerStore]
 * @param {number} [opts.circuitOpenMs]
 * @param {number} [opts.heartbeatTimeoutMs]
 */
export async function connectSession(opts = {}) {
  const {
    config, tenantId, roomId,
    pins = pinnedHerdrJson,
    onVersionMismatch, onFallback, onEvent, now, breakerStore,
    circuitOpenMs, heartbeatTimeoutMs,
  } = opts;
  const nowFn = typeof now === 'function' ? now : () => Date.now();
  const store = breakerStore ?? defaultBreakerStore;
  const openMs = typeof circuitOpenMs === 'number' ? circuitOpenMs : BREAKER_OPEN_MS;

  const fallback = (reason, detail) => {
    const f = { backend: 'legacy', reason, ...(detail !== undefined ? { detail } : {}) };
    try { onFallback?.({ tenantId, roomId, ...f }); } catch { /* observer */ }
    return f;
  };

  if (!config || config.mode === 'off') return fallback('flag_off');
  if (config.mode === 'rooms' && !(config.rooms ?? []).includes(roomId)) return fallback('room_not_listed');

  const route = resolveBridgeRoute(config, tenantId);
  if (!route) return fallback('no_route');
  if (!route.url) {
    throw new ServerError('bridge_no_url', `route table entry for bridge ${route.id} has no url`, { backend: BRIDGE_BACKEND, bridgeId: route.id });
  }

  const secret = masterSecretFor(config, route.id);
  if (!secret) {
    // Config error, not an outage: loud, never a silent legacy fallback.
    throw new ServerError(
      'bridge_secret_missing',
      `route table points tenant ${tenantId} at bridge ${route.id} but no BRIDGE_MASTER_SECRET is configured`,
      { backend: BRIDGE_BACKEND, bridgeId: route.id, tenantId },
    );
  }

  const gate = breakerGate(store, route.id, 'ping', nowFn(), openMs);
  if (!gate.ok) return fallback('circuit_open', `breaker open for bridge ${route.id}`);

  const adapter = new HerdrBridgeAdapter({
    bridge: route, tenantId, masterSecret: secret, pins,
    onVersionMismatch, onEvent, now: nowFn, breakerStore: store,
    circuitOpenMs: openMs, heartbeatTimeoutMs,
  });
  try {
    await adapter.connect();
  } catch (e) {
    if (e instanceof VersionMismatchError) throw e; // fail closed, no downgrade
    if (e instanceof ServerError && (e.code === 'auth_denied' || e.code === 'bridge_secret_missing')) throw e;
    // Unreachable / timeout / 5xx / contract drift at connect: legacy, loudly.
    return fallback('bridge_unreachable', e?.code ?? e?.message ?? String(e));
  }
  return { backend: 'herdr', adapter };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Map a bridge typed-error body to the SessionAdapter error taxonomy. */
function typedBridgeError(code, message, ctx) {
  const msg = typeof message === 'string' && message.length > 0 ? message : `bridge error: ${code}`;
  switch (code) {
    case 'occupant_changed':
      return new OccupantChangedError(msg, { ...ctx });
    case 'version_mismatch':
      return new VersionMismatchError(msg, { ...ctx });
    case 'method_unsupported':
      return new MethodUnsupportedError(ctx.adapterMethod, msg, { ...ctx });
    default:
      return new ServerError(code ?? 'bridge_error', msg, { ...ctx });
  }
}

/**
 * Retry policy (D3 §3.2): idempotent reads retry on transport/5xx failures;
 * writes retry ONLY when no response was received (timeout / reset / 5xx with
 * an empty body) — and then with the same idempotency key. Typed errors,
 * 4xx, and auth failures never retry.
 */
function isRetryable(err, write) {
  if (err instanceof OccupantChangedError) return false;
  if (err instanceof VersionMismatchError) return false;
  if (err instanceof MethodUnsupportedError) return false;
  if (err instanceof ServerError) {
    if (err.code === 'auth_denied' || err.code === 'invalid_request' || err.code === 'invalid_response') return false;
    if (write) return err.noResponse === true || err.emptyBody5xx === true;
    return true;
  }
  if (err instanceof TransportError) {
    if (err.code === 'not_connected' || err.code === 'bridge_circuit_open') return false;
    if (write) return err.noResponse === true || err.emptyBody5xx === true;
    return true;
  }
  if (err instanceof TimeoutError) return true; // fresh attempt inside the budget
  return false;
}

function splitTarget(target, method) {
  if (typeof target === 'string') return { agentId: target, occupantId: null };
  if (target && typeof target === 'object' && typeof target.id === 'string') {
    return { agentId: target.id, occupantId: typeof target.occupantId === 'string' ? target.occupantId : null };
  }
  throw new Error(`${method}: target must be an agent id string or an AgentHandle`);
}

function validateResumeCommand(resumeCommand) {
  if (resumeCommand == null) return null;
  if (!Array.isArray(resumeCommand)) throw new Error('resumeCommand must be an array of strings');
  if (resumeCommand.length > MAX_RESUME_ARGS) {
    throw new Error(`resumeCommand exceeds the ${MAX_RESUME_ARGS}-arg cap (got ${resumeCommand.length})`);
  }
  const bytes = resumeCommand.join(' ').length;
  if (bytes > MAX_RESUME_BYTES) {
    throw new Error(`resumeCommand exceeds the ${MAX_RESUME_BYTES}-byte cap (got ${bytes})`);
  }
  for (const a of resumeCommand) {
    if (typeof a !== 'string') throw new Error('resumeCommand args must all be strings');
  }
  return [...resumeCommand];
}
