/**
 * server/session-adapter.mjs — SessionAdapter domain interface (herdr redesign).
 *
 * This module is the ONLY place Project Room code may know about session
 * backends. Callers (server/*, lanes) code against the `SessionAdapter`
 * interface and domain types below — never against a backend's wire protocol,
 * socket paths, or field names. That is the seam: swapping the backend never
 * touches callers.
 *
 * Backends:
 *  - `InMemorySessionAdapter` (this file) — hermetic backend for Worker tests,
 *    dev, and the fail-closed fallback path. Passes the shared contract suite.
 *  - `HerdrBridgeAdapter` (B4 lane, separate module) — Worker-side HTTPS client
 *    to `bridge/herdr-bridge.mjs`, which translates to herdr's Unix-socket
 *    protocol on lane-worker hosts.
 *
 * WORKER-SAFETY: this module must stay runnable inside a Cloudflare Worker.
 * It uses no sockets, no subprocesses, no Node builtins at all — only
 * `globalThis.crypto.randomUUID` (available in Workers and Node) with a
 * Math.random fallback. The transport lives in the B4 lane, not here.
 *
 * Design principles (from phase1/seam-design.md):
 *  1. Self-reported state, never screen-scraping. Lane states (working /
 *     blocked / idle / done / unknown) are declared by workers via
 *     `reportState`. Detection events are hints, never authoritative.
 *  2. Fail closed on version mismatch. `connect()` asserts the pinned protocol
 *     AND binary versions plus the core method list; any drift throws
 *     `VersionMismatchError`. No downgrade, no guessing.
 *  3. The adapter owns subscription recovery. On `events_lost` it re-runs
 *     `snapshot()`, calls `onReconcile`, then resumes the flow — callers never
 *     see a silent gap.
 *  4. Continuity without transcript replay. `spawnAgent` resumes via the agent
 *     CLI's OWN `--resume` flags (`resumeSessionRef` / `resumeCommand`); the
 *     conversation lives in the CLI's session store, never in replayed text.
 *  5. herdr `done` != claim `done`. This adapter reports agent states; the
 *     claims board stays authoritative for work completion.
 *
 * Domain types:
 *  - `AgentState`: "working" | "blocked" | "idle" | "done" | "unknown"
 *  - `AgentHandle`: { id, paneId, occupantId } — occupantId pins send/wait
 *    calls to the pane occupant present when the handle was issued.
 *  - `AgentInfo`: full inventory record (see `getAgent`).
 *  - `PaneText`: { paneId, source, lines, text }
 *  - `WorkspaceSnapshot`: { version, workspaces: [{ name, tabs: [{ name,
 *    panes: [{ id, workspace, tab, title, agentId, occupantId, state, kind }] }] }] }
 *  - `Subscription`: { id, active, close(): Promise<void> }
 *
 * Error taxonomy — every error extends `SessionAdapterError` and carries
 * `adapter: "session-adapter"` plus the backend name:
 *  - `VersionMismatchError` — pinned vs observed protocol/binary drift, or a
 *    core method missing at connect. Fail closed: no recovery, refuse to start.
 *  - `OccupantChangedError` — send/wait target's pane occupant changed since
 *    the handle was issued. Re-resolve the handle, re-confirm intent, resend.
 *  - `SubscriptionLostError` — event history overrun upstream. The adapter
 *    auto-recovers (re-snapshot + reconcile + resubscribe); surfaced to
 *    `onReconcile` observers only, never thrown at callers mid-flow.
 *  - `MethodUnsupportedError` — optional-tier method not advertised by the
 *    server. Caller degrades explicitly; never a silent no-op.
 *  - `TransportError` — not connected, or the connection dropped mid-operation.
 *    Retriable per caller policy; `ping()` to re-verify before resuming.
 *  - `TimeoutError` — a `timeoutMs` bound was exceeded. Waits accept an
 *    `AbortSignal`; abort surfaces as `TimeoutError`.
 *  - `ServerError` — the backend returned an error payload (`code` preserved).
 *
 * Contract: `tests/session-adapter-contract.test.js` runs the same assertions
 * against every backend. A backend that cannot satisfy a clause must document
 * the skip per-test in that file — never silently.
 */

const ADAPTER_NAME = 'session-adapter';

/** Exact herdr socket-protocol version this adapter speaks. No ranges. */
export const INMEMORY_PROTOCOL_VERSION = 22;
/** Binary version reported by the in-memory backend (asserted at connect). */
export const INMEMORY_HERDR_VERSION = 'inmemory-0.1.0';

/** Authoritative lane states. Reported by workers via reportState — never inferred. */
export const AGENT_STATES = ['working', 'blocked', 'idle', 'done', 'unknown'];

/**
 * Core tier: every backend MUST advertise all of these at connect time, or
 * connect() fails closed with VersionMismatchError. Optional-tier methods
 * (worktree.*, layout.*) are gated by supports() instead.
 */
export const CORE_METHODS = [
  'connect', 'disconnect', 'ping', 'snapshot',
  'spawnAgent', 'listAgents', 'getAgent', 'closePane',
  'readPane', 'sendText', 'sendKeys', 'waitForState', 'waitForOutput',
  'reportState', 'reportResume', 'reportMetadata',
  'subscribe', 'waitForEvent', 'supports',
];

/** Pane read sources. `detection` = the bottom-buffer view detection uses. */
export const PANE_SOURCES = ['visible', 'recent', 'recent-unwrapped', 'detection'];

export const MAX_RESUME_ARGS = 64;
export const MAX_RESUME_BYTES = 8 * 1024;
const PANE_BUFFER_LINES = 2000;

function uuid() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `id-${Date.now().toString(36)}-${Math.floor(Math.random() * 2 ** 48).toString(36)}`;
}

// ---------------------------------------------------------------------------
// Error taxonomy
// ---------------------------------------------------------------------------

/**
 * Base class for every session-adapter error. Fields: `code` (stable string),
 * `adapter` ("session-adapter"), `backend` (e.g. "inmemory", "herdr-bridge"),
 * plus per-class detail fields.
 */
export class SessionAdapterError extends Error {
  constructor(code, message, { backend = 'unknown', ...rest } = {}) {
    super(message);
    this.name = 'SessionAdapterError';
    this.code = code;
    this.adapter = ADAPTER_NAME;
    this.backend = backend;
    Object.assign(this, rest);
  }
}

/**
 * Pinned vs observed version drift (protocol, binary, or core method list).
 * Fail closed: log, alert, refuse to start. Never downgrade.
 */
export class VersionMismatchError extends SessionAdapterError {
  constructor(message, details = {}) {
    super('version_mismatch', message, details);
    this.name = 'VersionMismatchError';
  }
}

/**
 * The pane occupant changed since the handle was issued. The send/wait was
 * NOT delivered. Re-resolve the handle, re-confirm intent, then resend.
 */
export class OccupantChangedError extends SessionAdapterError {
  constructor(message, details = {}) {
    super('occupant_changed', message, details);
    this.name = 'OccupantChangedError';
  }
}

/**
 * Event history overrun upstream of adapter recovery. The adapter owns
 * recovery (re-snapshot + onReconcile + resubscribe); this error is surfaced
 * to onReconcile observers only, never thrown into caller flow.
 */
export class SubscriptionLostError extends SessionAdapterError {
  constructor(message, details = {}) {
    super('subscription_lost', message, details);
    this.name = 'SubscriptionLostError';
  }
}

/** Optional-tier method not advertised by the server. Degrade explicitly. */
export class MethodUnsupportedError extends SessionAdapterError {
  constructor(method, message, details = {}) {
    super('method_unsupported', message ?? `method not supported by backend: ${method}`, { ...details, method });
    this.name = 'MethodUnsupportedError';
  }
}

/** Not connected, or the connection dropped mid-operation. */
export class TransportError extends SessionAdapterError {
  constructor(code, message, details = {}) {
    super(code, message, details);
    this.name = 'TransportError';
  }
}

/** A timeoutMs bound was exceeded (or the wait's AbortSignal fired). */
export class TimeoutError extends SessionAdapterError {
  constructor(message, details = {}) {
    super('timeout', message, details);
    this.name = 'TimeoutError';
  }
}

/** The backend returned an error payload; `code` is the upstream code. */
export class ServerError extends SessionAdapterError {
  constructor(code, message, details = {}) {
    super(code, message, details);
    this.name = 'ServerError';
  }
}

// ---------------------------------------------------------------------------
// BaseSessionAdapter — shared orchestration (lifecycle, versions, events)
// ---------------------------------------------------------------------------

/**
 * Shared orchestration every backend reuses: fail-closed connect-time version
 * assert, subscription fan-out, adapter-owned events_lost recovery, and the
 * event-driven waitForState / waitForOutput built on top of subscribe (no
 * polling). Subclasses implement the data-plane primitives.
 */
class BaseSessionAdapter {
  /**
   * @param {object} opts — validated AdapterOptions (see createSessionAdapter)
   * @param {string} backend — backend name stamped on every error
   */
  constructor(opts, backend) {
    this._opts = opts;
    this._backend = backend;
    this._connected = false;
    this._protocolVersion = null;
    this._herdrVersion = null;
    this._methods = null;
    this._subscriptions = new Map();
    this._subSeq = 0;
  }

  /** True after a successful connect(), false after disconnect(). */
  get connected() { return this._connected; }

  /** Backend name, e.g. "inmemory". Stamped on every error. */
  get backend() { return this._backend; }

  /** The server-advertised protocol version asserted at connect(). */
  get protocolVersion() { return this._protocolVersion; }

  /** The server-advertised binary version asserted at connect(). */
  get herdrVersion() { return this._herdrVersion; }

  /**
   * Opens the backend, runs the handshake, and asserts the pinned versions
   * plus the core method list. Throws VersionMismatchError on ANY drift —
   * fail closed, no usable connection is returned. Emits nothing; observers
   * use onVersionMismatch for alerting (the throw still happens).
   */
  async connect() {
    if (this._connected) return;
    const { pinnedProtocolVersion, pinnedHerdrVersion, onVersionMismatch } = this._opts;
    const observed = await this._handshake();
    const missingCore = CORE_METHODS.filter((m) => !observed.methods.includes(m));
    const mismatch =
      observed.protocolVersion !== pinnedProtocolVersion ||
      (pinnedHerdrVersion != null && observed.herdrVersion !== pinnedHerdrVersion) ||
      missingCore.length > 0;
    if (mismatch) {
      const info = {
        backend: this._backend,
        pinnedProtocolVersion,
        observedProtocolVersion: observed.protocolVersion,
        pinnedHerdrVersion: pinnedHerdrVersion ?? null,
        observedHerdrVersion: observed.herdrVersion,
        missingCoreMethods: missingCore,
      };
      if (typeof onVersionMismatch === 'function') {
        try { onVersionMismatch(info); } catch { /* observer must not break the fail-closed throw */ }
      }
      throw new VersionMismatchError(
        `version mismatch: pinned protocol ${String(pinnedProtocolVersion)}${pinnedHerdrVersion != null ? ` / binary ${pinnedHerdrVersion}` : ''} ` +
        `vs observed protocol ${String(observed.protocolVersion)} / binary ${observed.herdrVersion}` +
        (missingCore.length ? `; missing core methods: ${missingCore.join(', ')}` : ''),
        info,
      );
    }
    this._protocolVersion = observed.protocolVersion;
    this._herdrVersion = observed.herdrVersion;
    this._methods = [...observed.methods];
    this._connected = true;
    await this._onConnect();
  }

  /**
   * Closes all subscriptions, then the backend connection. Idempotent.
   */
  async disconnect() {
    if (!this._connected) return;
    for (const { sub } of this._subscriptions.values()) {
      try { await sub.close(); } catch { /* best effort */ }
    }
    this._subscriptions.clear();
    await this._onDisconnect();
    this._connected = false;
    this._protocolVersion = null;
    this._herdrVersion = null;
  }

  /**
   * Capability probe for the optional tier (worktree.*, layout.*, …).
   * Core-tier methods always return true after a successful connect.
   */
  supports(method) {
    return (this._methods ?? CORE_METHODS).includes(method);
  }

  /**
   * Push event feed. The adapter owns recovery: on events_lost it re-runs
   * snapshot(), calls onReconcile(snapshot, lostCount), then resumes the flow.
   * Callers never see a silent gap.
   *
   * @param {string[]} eventNames — e.g. ["pane.agent_status_changed"]; "*" matches all
   * @param {(ev: object) => void} handler
   * @param {{ onReconcile?: (snapshot, lostCount) => void|Promise<void> }} opts
   * @returns {Promise<{ id: string, active: boolean, close(): Promise<void> }>}
   */
  async subscribe(eventNames, handler, opts = {}) {
    this._requireConnected();
    if (!Array.isArray(eventNames) || eventNames.length === 0) {
      throw new Error('subscribe: eventNames must be a non-empty array of strings');
    }
    if (typeof handler !== 'function') throw new Error('subscribe: handler must be a function');
    const id = `sub-${++this._subSeq}-${uuid().slice(0, 8)}`;
    const record = {
      eventNames: new Set(eventNames),
      handler,
      onReconcile: typeof opts.onReconcile === 'function' ? opts.onReconcile : null,
      sub: null,
    };
    const sub = {
      id,
      active: true,
      close: async () => {
        if (!sub.active) return;
        sub.active = false;
        this._subscriptions.delete(id);
      },
    };
    record.sub = sub;
    this._subscriptions.set(id, record);
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
          { backend: this._backend, timeoutMs },
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

  /**
   * Event-driven wait until the agent reaches one of `states`. No polling:
   * resolves off the subscription feed. Pins the pane occupant when `target`
   * is a handle. Prefer this over polling pane output.
   *
   * @param {AgentHandle|string} target — handle (occupant-pinned) or bare agent id
   * @param {AgentState[]} states
   * @param {{ timeoutMs: number, signal?: AbortSignal }} opts
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
    const agentId = await this._assertOccupant(target, 'waitForState');
    const current = await this.getAgent(agentId);
    if (states.includes(current.state)) return current.state;

    let sub = null;
    let timer = null;
    let onAbort = null;
    const cleanup = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      if (signal && onAbort) { signal.removeEventListener('abort', onAbort); onAbort = null; }
      if (sub) { const s = sub; sub = null; s.close().catch(() => {}); }
    };
    const timeoutErr = (why) => new TimeoutError(
      `waitForState: ${why} waiting for [${states.join(', ')}] on ${agentId}`,
      { backend: this._backend, timeoutMs, agentId },
    );
    try {
      return await new Promise((resolve, reject) => {
        let settled = false;
        const settle = (fn, v) => { if (settled) return; settled = true; cleanup(); fn(v); };
        timer = setTimeout(() => settle(reject, timeoutErr(`timed out after ${timeoutMs}ms`)), timeoutMs);
        if (signal) {
          if (signal.aborted) { settle(reject, timeoutErr('aborted')); return; }
          onAbort = () => settle(reject, timeoutErr('aborted'));
          signal.addEventListener('abort', onAbort, { once: true });
        }
        this.subscribe(['pane.agent_status_changed'], (ev) => {
          if (ev.agentId === agentId && states.includes(ev.state)) settle(resolve, ev.state);
        }).then((s) => { if (settled) s.close().catch(() => {}); else sub = s; })
          .catch((e) => settle(reject, e));
      });
    } catch (e) {
      cleanup();
      throw e;
    }
  }

  /**
   * Regex wait over pane output. For non-agent processes; agent flows should
   * prefer waitForState (self-reported state beats output scraping).
   *
   * @returns {Promise<{ paneId: string, matched: string }>} the first matching line
   */
  async waitForOutput(paneId, regex, opts = {}) {
    this._requireConnected();
    const { timeoutMs } = opts;
    if (typeof timeoutMs !== 'number' || !(timeoutMs >= 0)) {
      throw new Error('waitForOutput: opts.timeoutMs (number) is required');
    }
    const re = regex instanceof RegExp ? regex : new RegExp(regex);
    const scan = async () => {
      const pt = await this.readPane(paneId, 'recent', { lines: PANE_BUFFER_LINES });
      for (const line of pt.lines) {
        if (re.test(line)) return { paneId, matched: line };
      }
      return null;
    };
    const hit = await scan();
    if (hit) return hit;

    let sub = null;
    let timer = null;
    const cleanup = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      if (sub) { const s = sub; sub = null; s.close().catch(() => {}); }
    };
    try {
      return await new Promise((resolve, reject) => {
        let settled = false;
        const settle = (fn, v) => { if (settled) return; settled = true; cleanup(); fn(v); };
        timer = setTimeout(() => settle(reject, new TimeoutError(
          `waitForOutput: timed out after ${timeoutMs}ms on ${paneId}`,
          { backend: this._backend, timeoutMs, paneId },
        )), timeoutMs);
        const onOutput = async (ev) => {
          if (ev.paneId !== paneId) return;
          try {
            const found = await scan();
            if (found) settle(resolve, found);
          } catch (e) { settle(reject, e); }
        };
        this.subscribe(['pane.output'], onOutput)
          .then((s) => { if (settled) s.close().catch(() => {}); else sub = s; })
          .catch((e) => settle(reject, e));
      });
    } catch (e) {
      cleanup();
      throw e;
    }
  }

  // -- adapter-owned recovery -------------------------------------------------
  /**
   * Runs the events_lost recovery the adapter owns: re-snapshot, notify each
   * live subscription's onReconcile, then resume the flow. Subscriptions stay
   * active throughout; callers never see a silent gap.
   */
  async _recoverFromEventsLost(lostCount) {
    const snapshot = await this.snapshot();
    for (const { onReconcile, sub } of this._subscriptions.values()) {
      if (!sub.active || typeof onReconcile !== 'function') continue;
      await onReconcile(snapshot, lostCount);
    }
    this._emit('subscription.recovered', { lostCount });
  }

  /** Fan-out to matching live subscriptions. A throwing handler never kills siblings. */
  _emit(type, payload = {}) {
    const ev = { type, at: Date.now(), ...payload };
    for (const { eventNames, handler, sub } of this._subscriptions.values()) {
      if (!sub.active) continue;
      if (!eventNames.has(type) && !eventNames.has('*')) continue;
      try { handler(ev); } catch { /* one bad handler must not break the bus */ }
    }
  }

  _requireConnected() {
    if (!this._connected) {
      throw new TransportError('not_connected', 'session-adapter: not connected — call connect() first', { backend: this._backend });
    }
  }

  // -- subclass primitives ----------------------------------------------------
  /** @returns {Promise<{ protocolVersion: number, herdrVersion: string, methods: string[] }>} */
  async _handshake() { throw new Error(`${this._backend}: _handshake not implemented`); }
  async _onConnect() {}
  async _onDisconnect() {}
  /**
   * Resolve a send/wait target to its agent id, enforcing occupant pinning
   * when the target is a handle carrying an occupantId.
   * @returns {Promise<string>} agent id
   */
  async _assertOccupant(_target, _method) { throw new Error(`${this._backend}: _assertOccupant not implemented`); }

  // -- data-plane interface (subclass implements) ------------------------------
  async ping() { throw new MethodUnsupportedError('ping', undefined, { backend: this._backend }); }
  async snapshot() { throw new MethodUnsupportedError('snapshot', undefined, { backend: this._backend }); }
  async spawnAgent() { throw new MethodUnsupportedError('spawnAgent', undefined, { backend: this._backend }); }
  async listAgents() { throw new MethodUnsupportedError('listAgents', undefined, { backend: this._backend }); }
  async getAgent() { throw new MethodUnsupportedError('getAgent', undefined, { backend: this._backend }); }
  async closePane() { throw new MethodUnsupportedError('closePane', undefined, { backend: this._backend }); }
  async readPane() { throw new MethodUnsupportedError('readPane', undefined, { backend: this._backend }); }
  async sendText() { throw new MethodUnsupportedError('sendText', undefined, { backend: this._backend }); }
  async sendKeys() { throw new MethodUnsupportedError('sendKeys', undefined, { backend: this._backend }); }
  async reportState() { throw new MethodUnsupportedError('reportState', undefined, { backend: this._backend }); }
  async reportResume() { throw new MethodUnsupportedError('reportResume', undefined, { backend: this._backend }); }
  async reportMetadata() { throw new MethodUnsupportedError('reportMetadata', undefined, { backend: this._backend }); }
}

// ---------------------------------------------------------------------------
// InMemorySessionAdapter — hermetic backend (tests, dev, fail-closed fallback)
// ---------------------------------------------------------------------------

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

/**
 * Hermetic SessionAdapter backend. Same contract as the production backend,
 * zero I/O: workspaces/tabs/panes/agents live in Maps. `sendText` echoes into
 * the pane buffer (emulating terminal echo) so `readPane`/`waitForOutput`
 * have deterministic content; lane-side behavior (state reports, output
 * production) is driven by the caller via the report* methods.
 */
export class InMemorySessionAdapter extends BaseSessionAdapter {
  constructor(opts) {
    super(opts, 'inmemory');
    this._workspaces = new Map();
    this._panes = new Map();
    this._agents = new Map();
  }

  async _handshake() {
    return {
      protocolVersion: INMEMORY_PROTOCOL_VERSION,
      herdrVersion: INMEMORY_HERDR_VERSION,
      methods: [...CORE_METHODS],
    };
  }

  /** @returns {Promise<{ ok: true, protocolVersion: number, herdrVersion: string }>} */
  async ping() {
    this._requireConnected();
    return { ok: true, protocolVersion: this._protocolVersion, herdrVersion: this._herdrVersion };
  }

  /**
   * Full bootstrap of workspace → tab → pane → agent. The reconciliation
   * source of truth after events_lost.
   */
  async snapshot() {
    this._requireConnected();
    const workspaces = [];
    for (const ws of this._workspaces.values()) {
      const tabs = [];
      for (const tab of ws.tabs.values()) {
        const panes = [];
        for (const paneId of tab.paneIds) {
          const pane = this._panes.get(paneId);
          if (!pane) continue;
          const agent = pane.agentId ? this._agents.get(pane.agentId) : null;
          panes.push({
            id: pane.id, workspace: pane.workspace, tab: pane.tab, title: pane.title,
            agentId: pane.agentId, occupantId: pane.occupantId,
            state: agent ? agent.state : 'unknown', kind: agent ? agent.kind : null,
          });
        }
        tabs.push({ name: tab.name, panes });
      }
      workspaces.push({ name: ws.name, tabs });
    }
    return { version: 1, workspaces };
  }

  /**
   * Launch an agent in a pane (workspace/tab created if missing).
   * Continuity is via the agent CLI's own session store: pass
   * `resumeSessionRef` + `resumeCommand` (e.g. ["claude", "--resume", id]) —
   * never transcript replay. Returns the occupant-pinned AgentHandle.
   *
   * opts.signal (AbortSignal, optional): abort propagation into pane
   * creation. An abort before creation rejects with TimeoutError and creates
   * nothing; an abort racing creation tears the half-built pane back down and
   * rejects — the caller never observes a pane the aborter didn't ask for.
   */
  async spawnAgent(opts = {}) {
    this._requireConnected();
    if (!opts || typeof opts.command !== 'string' || opts.command.length === 0) {
      throw new Error('spawnAgent: opts.command (non-empty string) is required');
    }
    const { signal } = opts;
    if (signal && signal.aborted) {
      throw new TimeoutError('spawnAgent: aborted before pane creation', { backend: this._backend });
    }
    const resumeCommand = validateResumeCommand(opts.resumeCommand);
    const ws = this._ensureWorkspace(opts.workspace ?? 'default');
    const tab = this._ensureTab(ws, opts.tab ?? 'main');
    const paneId = `pane-${uuid()}`;
    const agentId = `agent-${uuid()}`;
    const occupantId = `occ-${uuid()}`;
    const now = Date.now();
    const pane = {
      id: paneId, workspace: ws.name, tab: tab.name,
      title: opts.title ?? opts.command, agentId, occupantId,
      buffer: [], createdAt: now,
    };
    const agent = {
      id: agentId, paneId, occupantId,
      kind: opts.kind ?? null, command: opts.command, args: opts.args ? [...opts.args] : [],
      cwd: opts.cwd ?? null, title: opts.title ?? opts.command,
      state: 'unknown', sessionRef: opts.resumeSessionRef ?? null, resumeCommand,
      metadata: new Map(), createdAt: now,
    };
    this._panes.set(paneId, pane);
    this._agents.set(agentId, agent);
    tab.paneIds.push(paneId);
    // A racing abort must not leave a half-built pane behind. The listener
    // tears the pane down; the re-check below turns the race into a
    // TimeoutError before any handle or event escapes.
    const onAbort = () => { this._destroyPane(paneId); };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    try {
      // Yield so an interleaved abort runs the teardown before the handle is
      // returned (pane creation suspends in real backends).
      await Promise.resolve();
      if (signal && signal.aborted) {
        throw new TimeoutError('spawnAgent: aborted during pane creation', { backend: this._backend });
      }
      this._emit('pane.created', { paneId, agentId, workspace: ws.name, tab: tab.name });
      this._emit('agent.started', { paneId, agentId, kind: agent.kind, command: agent.command });
      return { id: agentId, paneId, occupantId };
    } catch (err) {
      this._destroyPane(paneId); // idempotent: no-op if the listener already ran
      throw err;
    } finally {
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  /** Inventory + state rollup for the sidebar/supervisor. */
  async listAgents() {
    this._requireConnected();
    return [...this._agents.keys()].map((id) => this._agentInfo(id));
  }

  /** Single agent detail. Unknown id → ServerError("not_found"). */
  async getAgent(agentId) {
    this._requireConnected();
    const info = this._agentInfo(agentId);
    if (!info) {
      throw new ServerError('not_found', `getAgent: unknown agent ${agentId}`, { backend: this._backend, agentId });
    }
    return info;
  }

  /** Close a pane (agent teardown is the agent's own exit). Idempotent. */
  async closePane(paneId) {
    this._requireConnected();
    this._destroyPane(paneId);
  }

  /** Synchronous pane teardown shared by closePane and the spawn abort path. */
  _destroyPane(paneId) {
    const pane = this._panes.get(paneId);
    if (!pane) return;
    this._panes.delete(paneId);
    if (pane.agentId) this._agents.delete(pane.agentId);
    const ws = this._workspaces.get(pane.workspace);
    const tab = ws?.tabs.get(pane.tab);
    if (tab) tab.paneIds = tab.paneIds.filter((id) => id !== paneId);
    this._emit('pane.closed', { paneId, agentId: pane.agentId });
  }

  /**
   * Text snapshot for supervisors ("what did the agent just do?").
   * No keystroke injection. `detection` returns the bottom-buffer view.
   */
  async readPane(paneId, source, opts = {}) {
    this._requireConnected();
    if (!PANE_SOURCES.includes(source)) {
      throw new Error(`readPane: unknown source ${JSON.stringify(source)} — expected one of ${PANE_SOURCES.join(', ')}`);
    }
    const pane = this._panes.get(paneId);
    if (!pane) {
      throw new ServerError('not_found', `readPane: unknown pane ${paneId}`, { backend: this._backend, paneId });
    }
    const lines = typeof opts.lines === 'number' && opts.lines >= 0 ? opts.lines : 200;
    const buf = source === 'detection' ? pane.buffer.slice(-30) : pane.buffer.slice(-lines);
    return { paneId, source, lines: [...buf], text: buf.join('\n') };
  }

  /**
   * Send text to the agent (herdr `agent.prompt`). Occupant-pinned: rejects
   * with OccupantChangedError if the pane occupant changed since the handle
   * was issued. `opts.wait = { until: AgentState[], timeoutMs }` adds an
   * event-driven wait after the send.
   */
  async sendText(target, text, opts = {}) {
    this._requireConnected();
    if (typeof text !== 'string') throw new Error('sendText: text must be a string');
    const { agent, pane } = this._resolvePinnedTarget(target, 'sendText');
    for (const line of text.split('\n')) pane.buffer.push(line);
    this._trimBuffer(pane);
    this._emit('pane.output', { paneId: pane.id, agentId: agent.id, lines: text.split('\n').length });
    const result = { ok: true, agentId: agent.id, bytes: text.length };
    if (opts.wait) {
      if (!Array.isArray(opts.wait.until) || typeof opts.wait.timeoutMs !== 'number') {
        throw new Error('sendText: opts.wait must be { until: AgentState[], timeoutMs: number }');
      }
      result.finalState = await this.waitForState(agent.id, opts.wait.until, { timeoutMs: opts.wait.timeoutMs });
    }
    return result;
  }

  /**
   * Raw key injection (herdr `agent.send_keys`). Same occupant pinning as
   * sendText. Reserved for supervisor flows (approvals, interrupts); normal
   * messaging uses sendText.
   */
  async sendKeys(target, keys) {
    this._requireConnected();
    if (!Array.isArray(keys)) throw new Error('sendKeys: keys must be an array of strings');
    const { agent, pane } = this._resolvePinnedTarget(target, 'sendKeys');
    pane.buffer.push(`[keys: ${keys.join(' ')}]`);
    this._trimBuffer(pane);
    this._emit('pane.output', { paneId: pane.id, agentId: agent.id, lines: 1 });
  }

  /**
   * The honesty path: the worker declares its own state. Authoritative for
   * lane state; herdr detection events are hints only.
   */
  async reportState(paneId, state, detail) {
    this._requireConnected();
    if (!AGENT_STATES.includes(state)) {
      throw new Error(`reportState: unknown state ${JSON.stringify(state)} — expected one of ${AGENT_STATES.join(', ')}`);
    }
    const pane = this._panes.get(paneId);
    const agent = pane?.agentId ? this._agents.get(pane.agentId) : null;
    if (!agent) {
      throw new ServerError('not_found', `reportState: unknown pane ${paneId}`, { backend: this._backend, paneId });
    }
    const prev = agent.state;
    agent.state = state;
    this._emit('pane.agent_status_changed', {
      paneId, agentId: agent.id, state, prev, detail: detail ?? null,
    });
  }

  /**
   * Store the agent CLI's native session reference + resume command so
   * restarts resume via the CLI's own flag. resumeCommand is capped at
   * 64 args / 8 KiB (fail fast, never silently truncate).
   */
  async reportResume(paneId, ref = {}) {
    this._requireConnected();
    const agent = this._agentForPane(paneId, 'reportResume');
    agent.sessionRef = ref.sessionRef ?? agent.sessionRef;
    if (ref.resumeCommand !== undefined) agent.resumeCommand = validateResumeCommand(ref.resumeCommand);
  }

  /**
   * Display-only labels/tokens. Values must be strings; `ttlMs` expires keys
   * (lazy expiry on read).
   */
  async reportMetadata(paneId, meta, opts = {}) {
    this._requireConnected();
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
      throw new Error('reportMetadata: meta must be a plain object of string values');
    }
    const agent = this._agentForPane(paneId, 'reportMetadata');
    const ttlMs = opts.ttlMs;
    if (ttlMs !== undefined && (typeof ttlMs !== 'number' || !(ttlMs >= 0))) {
      throw new Error('reportMetadata: opts.ttlMs must be a non-negative number');
    }
    const expiresAt = ttlMs == null ? null : Date.now() + ttlMs;
    for (const [k, v] of Object.entries(meta)) {
      if (typeof v !== 'string') throw new Error(`reportMetadata: value for ${JSON.stringify(k)} must be a string`);
      agent.metadata.set(k, { value: v, expiresAt });
    }
  }

  /**
   * TEST-ONLY hook: drives the adapter's real events_lost recovery path
   * (re-snapshot → onReconcile → resubscribe). Not part of the SessionAdapter
   * interface; real overrun timing is the bridge backend's concern.
   */
  async _simulateEventsLost(lostCount = 1) {
    this._requireConnected();
    await this._recoverFromEventsLost(lostCount);
  }

  // -- internals -------------------------------------------------------------
  async _assertOccupant(target, method) {
    const { agent } = this._resolvePinnedTarget(target, method);
    return agent.id;
  }

  _resolvePinnedTarget(target, method) {
    const id = typeof target === 'string' ? target : target?.id;
    const presented = typeof target === 'object' && target !== null ? target.occupantId : undefined;
    const agent = typeof id === 'string' ? this._agents.get(id) : null;
    if (!agent) {
      throw new ServerError('not_found', `${method}: unknown agent ${String(id)}`, { backend: this._backend, agentId: id });
    }
    const pane = this._panes.get(agent.paneId);
    if (!pane) {
      throw new ServerError('not_found', `${method}: pane for agent ${id} is gone`, { backend: this._backend, agentId: id });
    }
    if (presented !== undefined && presented !== pane.occupantId) {
      throw new OccupantChangedError(
        `${method}: pane occupant changed since the handle was issued — send NOT delivered`,
        { backend: this._backend, agentId: id, expectedOccupant: presented, observedOccupant: pane.occupantId },
      );
    }
    return { agent, pane };
  }

  _agentForPane(paneId, method) {
    const pane = this._panes.get(paneId);
    const agent = pane?.agentId ? this._agents.get(pane.agentId) : null;
    if (!agent) {
      throw new ServerError('not_found', `${method}: unknown pane ${paneId}`, { backend: this._backend, paneId });
    }
    return agent;
  }

  _agentInfo(agentId) {
    const agent = this._agents.get(agentId);
    if (!agent) return null;
    const now = Date.now();
    const metadata = {};
    for (const [k, { value, expiresAt }] of agent.metadata) {
      if (expiresAt !== null && expiresAt <= now) continue;
      metadata[k] = value;
    }
    return {
      id: agent.id, paneId: agent.paneId, occupantId: agent.occupantId,
      kind: agent.kind, command: agent.command, args: [...agent.args], cwd: agent.cwd,
      title: agent.title, state: agent.state,
      sessionRef: agent.sessionRef, resumeCommand: agent.resumeCommand ? [...agent.resumeCommand] : null,
      metadata, createdAt: agent.createdAt,
    };
  }

  _ensureWorkspace(name) {
    let ws = this._workspaces.get(name);
    if (!ws) {
      ws = { name, tabs: new Map() };
      this._workspaces.set(name, ws);
      this._emit('workspace.created', { workspace: name });
    }
    return ws;
  }

  _ensureTab(ws, name) {
    let tab = ws.tabs.get(name);
    if (!tab) {
      tab = { name, paneIds: [] };
      ws.tabs.set(name, tab);
      this._emit('tab.created', { workspace: ws.name, tab: name });
    }
    return tab;
  }

  _trimBuffer(pane) {
    if (pane.buffer.length > PANE_BUFFER_LINES) {
      pane.buffer.splice(0, pane.buffer.length - PANE_BUFFER_LINES);
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a SessionAdapter.
 *
 * @param {object} opts
 * @param {string} [opts.backend="inmemory"] — "inmemory" only in this lane.
 *   "herdr"/"bridge" (B3/B4) throw MethodUnsupportedError until those lanes land.
 * @param {number} opts.pinnedProtocolVersion — exact pin, e.g. 22. No ranges. Required.
 * @param {string} [opts.pinnedHerdrVersion] — exact binary version pin (optional).
 * @param {number} [opts.connectTimeoutMs=10_000]
 * @param {(info: object) => void} [opts.onVersionMismatch] — observer; mismatch still throws.
 * @returns {Promise<SessionAdapter>}
 */
export async function createSessionAdapter(opts = {}) {
  if (!opts || typeof opts.pinnedProtocolVersion !== 'number') {
    throw new Error('createSessionAdapter: opts.pinnedProtocolVersion (number) is required — exact pin, no ranges');
  }
  const backend = opts.backend ?? 'inmemory';
  if (backend === 'inmemory') return new InMemorySessionAdapter(opts);
  throw new MethodUnsupportedError(
    'createSessionAdapter',
    `backend "${backend}" is not available in this build (interface + in-memory only; see the bridge lane)`,
    { backend },
  );
}
