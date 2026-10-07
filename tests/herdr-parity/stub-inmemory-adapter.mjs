// B9-LOCAL STUB — stand-in for B2's `server/session-adapter.mjs`
// (`InMemorySessionAdapter`) until that lane lands. Implements the
// SessionAdapter domain interface per REDESIGN.md §2.2 (seam-design §2):
// connect/disconnect/ping/snapshot/spawnAgent/readPane/sendText/sendKeys/
// waitForState/waitForOutput/reportState/reportResume/reportMetadata/
// subscribe/supports + the error taxonomy. The parity suite drives the
// herdr-side run through this stub; when B2 lands, the herdr driver swaps
// its import to the real module and this file is deleted.
//
// This is TEST SUPPORT, not a platform double: the method set is fixed and
// closed. Anything outside the §2.2 core set is answered by `supports()`
// (false) — there is no catch-all that accepts unknown calls.
//
// DEPENDENCY: B2 (herdr-b2-adapter, lane jill-herdr-b2) owns the real
// `server/session-adapter.mjs`. This stub must not drift from §2.2.

export const PROTOCOL_VERSION = 22;
export const HERDR_VERSION = "stub-0.0.0";

// Lane states are SELF-REPORTED via reportState (REDESIGN §1, room-arch
// mapping #8). The adapter never infers them.
export const AGENT_STATES = Object.freeze(["working", "blocked", "idle", "done", "unknown"]);

const PANE_SOURCES = Object.freeze(["visible", "recent", "recent-unwrapped", "detection"]);

// Core tier per seam-design §2.6: absence of any of these at connect time is
// a VersionMismatchError (fail closed). The stub always advertises all of
// them; optional-tier methods (worktree.*, layout.*, server.*, plugin.*,
// integration.*) are never advertised.
const CORE_METHODS = Object.freeze([
  "connect", "disconnect", "ping", "snapshot",
  "spawnAgent", "listAgents", "getAgent", "closePane",
  "readPane", "sendText", "sendKeys", "waitForState", "waitForOutput",
  "reportState", "reportResume", "reportMetadata",
  "subscribe", "waitForEvent",
]);

function baseError(name, code, message) {
  const err = new Error(message);
  err.name = name;
  err.code = code;
  err.adapter = "session-adapter";
  err.backend = "inmemory";
  return err;
}

export class VersionMismatchError extends Error {
  constructor(message, { pinned = null, observed = null } = {}) {
    super(message);
    this.name = "VersionMismatchError";
    this.code = "version_mismatch";
    this.adapter = "session-adapter";
    this.backend = "inmemory";
    this.pinned = pinned;
    this.observed = observed;
  }
}
export class OccupantChangedError extends Error {
  constructor(message, { agentId = null } = {}) {
    super(message);
    this.name = "OccupantChangedError";
    this.code = "occupant_changed";
    this.adapter = "session-adapter";
    this.backend = "inmemory";
    this.agentId = agentId;
  }
}
export const SubscriptionLostError = (message) => baseError("SubscriptionLostError", "subscription_lost", message);
export const MethodUnsupportedError = (message) => baseError("MethodUnsupportedError", "method_unsupported", message);
export const TransportError = (message) => baseError("TransportError", "transport_error", message);
export const TimeoutError = (message) => baseError("TimeoutError", "timeout", message);
export const ServerError = (message, code = "server_error") => baseError("ServerError", code, message);

// ---------------------------------------------------------------------------
// InMemorySessionAdapter — the §2.2 contract, in memory.
//
// Deterministic: ids are per-instance counters (agent-1, pane-1, …),
// timestamps come from an injectable `now` (the parity suite passes its
// virtual clock). Two adapters built the same way produce identical traces.
// ---------------------------------------------------------------------------

class InMemorySessionAdapter {
  constructor({ pinnedProtocolVersion, pinnedHerdrVersion = null, now = () => Date.now() } = {}) {
    if (pinnedProtocolVersion !== undefined && pinnedProtocolVersion !== PROTOCOL_VERSION) {
      throw new VersionMismatchError(
        `pinned protocol version ${pinnedProtocolVersion} does not match adapter protocol ${PROTOCOL_VERSION} — refusing to start (fail closed)`,
        { pinned: pinnedProtocolVersion, observed: PROTOCOL_VERSION },
      );
    }
    if (pinnedHerdrVersion !== null && pinnedHerdrVersion !== HERDR_VERSION) {
      throw new VersionMismatchError(
        `pinned herdr version ${pinnedHerdrVersion} does not match adapter build ${HERDR_VERSION} — refusing to start (fail closed)`,
        { pinned: pinnedHerdrVersion, observed: HERDR_VERSION },
      );
    }
    this._now = now;
    this._connected = false;
    this._seq = 0;
    this._ids = 0;
    this._workspaces = new Map(); // name -> { name, tabs: Map(name -> { name, panes: [paneId] }) }
    this._panes = new Map();      // paneId -> pane
    this._agents = new Map();     // agentId -> agent
    this._subscriptions = new Set();
  }

  get protocolVersion() { return PROTOCOL_VERSION; }

  _iso() { return new Date(this._now()).toISOString(); }
  _nextId(prefix) { this._ids += 1; return `${prefix}-${this._ids}`; }
  _emit(type, payload = {}) {
    this._seq += 1;
    const ev = Object.freeze({ type, seq: this._seq, at: this._iso(), ...payload });
    for (const sub of [...this._subscriptions]) {
      if (!sub.active) continue;
      if (sub.eventNames.includes(type) || sub.eventNames.includes("*")) {
        try { sub.handler(ev); } catch { /* subscriber errors never break the adapter */ }
      }
    }
    return ev;
  }
  _requireConnected() {
    if (!this._connected) throw TransportError("adapter is not connected");
  }
  _paneOf(paneId) {
    const pane = this._panes.get(paneId);
    if (!pane || pane.closed) throw ServerError(`unknown pane: ${paneId}`, "unknown_pane");
    return pane;
  }
  _agentOf(agentId) {
    const agent = this._agents.get(agentId);
    if (!agent) throw ServerError(`unknown agent: ${agentId}`, "unknown_agent");
    return agent;
  }
  _checkOccupant(agent, occupant) {
    if (occupant !== undefined && occupant !== null && occupant !== agent.occupant) {
      throw new OccupantChangedError(
        `pane occupant changed since the handle was obtained (agent ${agent.agentId})`,
        { agentId: agent.agentId },
      );
    }
  }

  async connect() {
    // Core-tier assert: the stub always advertises the full core set, so
    // this is the fail-closed gate B2's HerdrSocketAdapter performs against
    // the server's advertised method list.
    for (const method of CORE_METHODS) {
      if (typeof this[method] !== "function") {
        throw new VersionMismatchError(`core method missing: ${method}`, { observed: PROTOCOL_VERSION });
      }
    }
    this._connected = true;
  }

  async disconnect() {
    for (const sub of [...this._subscriptions]) sub.active = false;
    this._subscriptions.clear();
    this._connected = false;
  }

  async ping() {
    this._requireConnected();
    return { ok: true, protocolVersion: PROTOCOL_VERSION, herdrVersion: HERDR_VERSION };
  }

  async snapshot() {
    this._requireConnected();
    const workspaces = [...this._workspaces.values()].map(ws => ({
      name: ws.name,
      tabs: [...ws.tabs.values()].map(tab => ({
        name: tab.name,
        panes: tab.panes.map(paneId => {
          const pane = this._panes.get(paneId);
          return { paneId, title: pane.title, agentId: pane.agentId, closed: pane.closed };
        }),
      })),
    }));
    const agents = [...this._agents.values()].map(a => ({
      agentId: a.agentId, paneId: a.paneId, kind: a.kind, state: a.state,
      occupant: a.occupant, lastReportAt: a.lastReportAt,
    }));
    return { workspaces, agents };
  }

  supports(method) { return CORE_METHODS.includes(method); }

  async spawnAgent({ kind = "agent", command, args = [], cwd = null, workspace = null, tab = null, title = null, metadata = {} } = {}) {
    this._requireConnected();
    if (typeof command !== "string" || command.length === 0) throw ServerError("spawnAgent requires a command", "invalid_spawn");
    if (!Array.isArray(args) || args.length > 64) throw ServerError("spawnAgent args must be ≤64 entries", "invalid_spawn");
    const wsName = workspace ?? "default";
    const tabName = tab ?? "main";
    let ws = this._workspaces.get(wsName);
    if (!ws) { ws = { name: wsName, tabs: new Map() }; this._workspaces.set(wsName, ws); }
    let tb = ws.tabs.get(tabName);
    if (!tb) { tb = { name: tabName, panes: [] }; ws.tabs.set(tabName, tb); }
    const paneId = this._nextId("pane");
    const agentId = this._nextId("agent");
    const occupant = this._nextId("occ");
    const pane = {
      paneId, agentId, title: title ?? `${kind}:${agentId}`, closed: false,
      output: [], metadata: { ...metadata }, workspace: wsName, tab: tabName,
    };
    const agent = {
      agentId, paneId, kind, command, args: [...args], cwd, occupant,
      state: "unknown", detail: null, lastReportAt: null, sessionRef: null, resumeCommand: null,
    };
    this._panes.set(paneId, pane);
    this._agents.set(agentId, agent);
    tb.panes.push(paneId);
    this._emit("pane.created", { paneId, agentId, workspace: wsName, tab: tabName });
    return { agentId, paneId, occupant, workspace: wsName, tab: tabName };
  }

  async listAgents() {
    this._requireConnected();
    return [...this._agents.values()].map(a => ({
      agentId: a.agentId, paneId: a.paneId, kind: a.kind, state: a.state,
      occupant: a.occupant, lastReportAt: a.lastReportAt,
    }));
  }

  async getAgent(agentId) {
    this._requireConnected();
    const a = this._agentOf(agentId);
    return { agentId: a.agentId, paneId: a.paneId, kind: a.kind, state: a.state, occupant: a.occupant,
      lastReportAt: a.lastReportAt, detail: a.detail, sessionRef: a.sessionRef, resumeCommand: a.resumeCommand };
  }

  async closePane(paneId) {
    this._requireConnected();
    const pane = this._paneOf(paneId);
    pane.closed = true;
    this._agents.delete(pane.agentId);
    this._emit("pane.closed", { paneId, agentId: pane.agentId });
  }

  async readPane(paneId, source, { lines = 50 } = {}) {
    this._requireConnected();
    const pane = this._paneOf(paneId);
    if (!PANE_SOURCES.includes(source)) throw ServerError(`unknown pane source: ${source}`, "invalid_source");
    const text = pane.output.slice(-lines).join("\n");
    return { paneId, source, text };
  }

  async sendText(agentId, text, { wait = null, occupant = null } = {}) {
    this._requireConnected();
    const agent = this._agentOf(agentId);
    this._checkOccupant(agent, occupant);
    const pane = this._paneOf(agent.paneId);
    pane.output.push(String(text));
    this._emit("pane.output", { paneId: pane.paneId, agentId });
    if (wait) return { ok: true, agentId, paneId: pane.paneId, waited: await this.waitForState(agentId, wait.until, { timeoutMs: wait.timeoutMs, occupant }) };
    return { ok: true, agentId, paneId: pane.paneId };
  }

  async sendKeys(agentId, keys, { occupant = null } = {}) {
    this._requireConnected();
    const agent = this._agentOf(agentId);
    this._checkOccupant(agent, occupant);
    const pane = this._paneOf(agent.paneId);
    pane.output.push(`[keys:${[].concat(keys).join("+")}]`);
    this._emit("pane.output", { paneId: pane.paneId, agentId });
  }

  // Event-driven wait: resolves on the next matching pane.agent_status_changed.
  async waitForState(agentId, states, { timeoutMs, signal = null, occupant = null } = {}) {
    this._requireConnected();
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw ServerError("waitForState requires a positive timeoutMs", "invalid_wait");
    const agent = this._agentOf(agentId);
    this._checkOccupant(agent, occupant);
    const wanted = new Set([].concat(states));
    if (wanted.has(agent.state)) return Promise.resolve(agent.state);
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (fn, value) => { if (!done) { done = true; cleanup(); fn(value); } };
      const timer = setTimeout(() => finish(reject, TimeoutError(`waitForState timed out after ${timeoutMs}ms`)), timeoutMs);
      const onAbort = () => finish(reject, TimeoutError("waitForState aborted"));
      const handler = (ev) => {
        if (ev.type === "pane.agent_status_changed" && ev.agentId === agentId && wanted.has(ev.state)) {
          try { this._checkOccupant(this._agentOf(agentId), occupant); }
          catch (err) { finish(reject, err); return; }
          finish(resolve, ev.state);
        }
      };
      const sub = { eventNames: ["pane.agent_status_changed"], handler, active: true };
      const cleanup = () => { clearTimeout(timer); sub.active = false; this._subscriptions.delete(sub); if (signal) signal.removeEventListener("abort", onAbort); };
      this._subscriptions.add(sub);
      if (signal) {
        if (signal.aborted) return onAbort();
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }

  // One-shot regex wait on pane output.
  waitForOutput(paneId, regex, { timeoutMs } = {}) {
    this._requireConnected();
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw ServerError("waitForOutput requires a positive timeoutMs", "invalid_wait");
    const pane = this._paneOf(paneId);
    const re = new RegExp(regex);
    const current = pane.output.join("\n");
    if (re.test(current)) return Promise.resolve({ paneId, matched: current.match(re)[0] });
    return new Promise((resolve, reject) => {
      let done = false;
      const timer = setTimeout(() => { if (!done) { done = true; this._subscriptions.delete(sub); reject(TimeoutError(`waitForOutput timed out after ${timeoutMs}ms`)); } }, timeoutMs);
      const sub = { eventNames: ["pane.output"], active: true, handler: (ev) => {
        if (ev.paneId !== paneId || done) return;
        const text = pane.output.join("\n");
        const m = text.match(re);
        if (m) { done = true; clearTimeout(timer); this._subscriptions.delete(sub); resolve({ paneId, matched: m[0] }); }
      } };
      this._subscriptions.add(sub);
    });
  }

  // The honesty path: lane workers self-report working/blocked/idle/done.
  // Authoritative for lane state — the adapter never infers it.
  async reportState(paneId, state, detail = null) {
    this._requireConnected();
    if (!AGENT_STATES.includes(state)) throw ServerError(`unknown agent state: ${state}`, "invalid_agent_state");
    const pane = this._paneOf(paneId);
    const agent = this._agentOf(pane.agentId);
    const previousState = agent.state;
    agent.state = state;
    agent.detail = detail ?? null;
    agent.lastReportAt = this._iso();
    this._emit("pane.agent_status_changed", { paneId, agentId: agent.agentId, state, previousState, detail: agent.detail });
  }

  async reportResume(paneId, { sessionRef, resumeCommand } = {}) {
    this._requireConnected();
    const pane = this._paneOf(paneId);
    const agent = this._agentOf(pane.agentId);
    if (typeof sessionRef !== "string" || sessionRef.length === 0) throw ServerError("reportResume requires a sessionRef", "invalid_resume");
    if (!Array.isArray(resumeCommand) || resumeCommand.length === 0 || resumeCommand.length > 64) {
      throw ServerError("reportResume requires a resumeCommand of 1..64 args", "invalid_resume");
    }
    agent.sessionRef = sessionRef;
    agent.resumeCommand = [...resumeCommand];
  }

  async reportMetadata(paneId, meta, { ttlMs = null } = {}) {
    this._requireConnected();
    const pane = this._paneOf(paneId);
    if (!meta || typeof meta !== "object") throw ServerError("reportMetadata requires a metadata object", "invalid_metadata");
    pane.metadata = { ...pane.metadata, ...meta };
    if (ttlMs !== null) pane.metadataTtlMs = ttlMs;
  }

  // Push feed. The adapter owns reconciliation: on events_lost it would
  // re-snapshot and call onReconcile before resuming — the stub never drops
  // events, so the recovery path is documented but not simulated.
  async subscribe(eventNames, handler, { onReconcile = null } = {}) {
    this._requireConnected();
    if (typeof handler !== "function") throw ServerError("subscribe requires a handler function", "invalid_subscribe");
    const sub = {
      eventNames: [...eventNames], handler, active: true, onReconcile,
      close: async () => { sub.active = false; this._subscriptions.delete(sub); },
    };
    this._subscriptions.add(sub);
    return sub;
  }

  async waitForEvent(filter, { timeoutMs } = {}) {
    this._requireConnected();
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw ServerError("waitForEvent requires a positive timeoutMs", "invalid_wait");
    const match = typeof filter === "function" ? filter : (ev) => ev.type === filter;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this._subscriptions.delete(sub); reject(TimeoutError(`waitForEvent timed out after ${timeoutMs}ms`)); }, timeoutMs);
      const sub = { eventNames: ["*"], active: true, handler: (ev) => {
        if (match(ev)) { clearTimeout(timer); this._subscriptions.delete(sub); resolve(ev); }
      } };
      this._subscriptions.add(sub);
    });
  }
}

// Async factory per §2.1: version pins are asserted before any connection
// object is usable — a mismatch throws and no adapter is returned.
export async function createSessionAdapter(opts = {}) {
  return new InMemorySessionAdapter(opts);
}
