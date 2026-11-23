import { safelyObserve } from './stage-observer.mjs';
// One ACP agent process with one ACP session per Room thread.
import { spawnAgent, initialize } from "./agents.mjs";
import { TurnRecorder } from "./render.mjs";

export class AgentHost {
  constructor({ candidate, cwd = process.cwd(), env = process.env, mode = null, onPermission = null, log = () => {}, savedSessions = null }) {
    Object.assign(this, { candidate, cwd, env, mode, onPermission, log, savedSessions });
    this.sessions = new Map(); // threadKey -> sessionId
    this.closing = new Map(); // threadKey -> provider with an unconfirmed close
    this.recorders = new Map(); // sessionId -> TurnRecorder (one turn in flight per session)
    this.threadOf = new Map(); // sessionId -> threadKey
    this.process = null; this.capabilities = null; this.exitListeners = new Set();
  }

  async start({ timeoutMs = 30000 } = {}) {
    const spawned = spawnAgent(this.candidate, {
      cwd: this.cwd, env: this.env, log: this.log,
      onNotification: (method, params) => { if (method === "session/update") this.recorders.get(params.sessionId)?.update(params.update); },
      onRequest: (method, params) => this.#agentRequest(method, params),
    });
    this.process = spawned;
    let initialized = false;
    const exited = new Promise(resolve => spawned.child.once("exit", (code, signal) => resolve({ code, signal })));
    exited.then(info => { if (this.process === spawned) { this.process = null; this.capabilities = null; this.sessions.clear(); this.threadOf.clear(); this.closing.clear(); if (initialized) for (const listener of this.exitListeners) listener(info); } });
    spawned.child.once("error", error => this.log(`agent failed to start: ${error.message}`));
    try {
      const capabilities = await Promise.race([initialize(spawned.peer, { timeoutMs }), exited.then(info => { throw new Error(`agent exited during initialize (code ${info.code})`); })]);
      if (this.process !== spawned) throw new Error('agent stopped during initialize');
      this.capabilities = capabilities;
      initialized = true;
      return capabilities;
    } catch (error) {
      if (this.process === spawned) { this.process = null; this.capabilities = null; }
      spawned.peer.close(); spawned.child.kill();
      throw error;
    }
  }

  async #agentRequest(method, params) {
    if (method === "session/request_permission") {
      if (!this.onPermission) return { outcome: { outcome: "cancelled" } };
      return this.onPermission({ threadKey: this.threadOf.get(params.sessionId) ?? null, ...params });
    }
    // fs/* and terminal/* are not advertised; refuse anything else.
    const error = new Error(`room-acp does not provide ${method}`); error.code = -32601; throw error;
  }

  async session(threadKey, { timeoutMs = 60000 } = {}) {
    const closing = this.closing.get(threadKey);
    if (closing && closing === this.process) {
      throw Object.assign(new Error("ACP session close is not yet confirmed"), { code: "session_close_pending" });
    }
    if (this.sessions.has(threadKey)) {
      const sessionId = this.sessions.get(threadKey);
      this.sessions.delete(threadKey);
      this.sessions.set(threadKey, sessionId);
      return { sessionId, created: false };
    }
    if (!this.process) throw new Error("agent is not running");
    // After a restart, resume the thread's saved session when the agent can.
    const saved = this.savedSessions?.get(threadKey);
    if (saved && this.capabilities?.loadSession) {
      let loaded = false;
      try {
        const recorder = { update() {} }; // replayed history is not re-posted
        this.recorders.set(saved, recorder);
        await this.process.peer.request("session/load", { sessionId: saved, cwd: this.cwd, mcpServers: [] }, { timeoutMs });
        loaded = true;
      } catch (error) { this.log(`could not resume the saved session (${error.message}); starting fresh`); }
      finally { this.recorders.delete(saved); }
      if (loaded) {
        // Mode refusal is not a load failure: never fall back or prompt past it.
        if (this.mode) await this.process.peer.request("session/set_mode", { sessionId: saved, modeId: this.mode }, { timeoutMs: 15000 });
        this.sessions.set(threadKey, saved); this.threadOf.set(saved, threadKey);
        return { sessionId: saved, created: false, loaded: true };
      }
    }
    const { sessionId } = await this.process.peer.request("session/new", { cwd: this.cwd, mcpServers: [] }, { timeoutMs });
    if (typeof sessionId !== "string" || !sessionId.trim()) throw new Error("ACP agent returned no usable session ID");
    if (this.mode) await this.process.peer.request("session/set_mode", { sessionId, modeId: this.mode }, { timeoutMs: 15000 });
    this.sessions.set(threadKey, sessionId); this.threadOf.set(sessionId, threadKey);
    this.savedSessions?.set(threadKey, sessionId);
    return { sessionId, created: true };
  }

  // Free idle provider resources while keeping the saved thread binding.
  // Closing without load support would lose the conversation on the next turn.
  async trimIdleSessions(limit, isBusy) {
    const provider = this.process;
    if (!provider || provider.idleCloseFailed || !this.capabilities?.closeSession || !this.capabilities.loadSession) return;
    if (!provider.idleTrim) {
      provider.idleTrim = Promise.resolve().then(() => this.#trimOnProvider(provider, limit, isBusy));
    }
    return provider.idleTrim;
  }

  async #trimOnProvider(provider, limit, isBusy) {
    // Coalesce overlapping cleanup requests and recheck busy threads after
    // each close, so a stalled provider only has one idle close in flight.
    try {
      while (this.process === provider) {
        const idle = [...this.sessions].filter(([threadKey, sessionId]) =>
          !isBusy(threadKey) && !this.recorders.has(sessionId) && this.savedSessions?.get(threadKey) === sessionId);
        if (idle.length <= limit) return;
        const [threadKey, sessionId] = idle[0];
        this.sessions.delete(threadKey);
        this.threadOf.delete(sessionId);
        this.closing.set(threadKey, provider);
        try {
          // A client timeout cannot prove the adapter stopped touching this ID.
          // This cleanup is outside the queue and keeps at most one pending RPC.
          await provider.peer.request("session/close", { sessionId });
        } catch {
          provider.idleCloseFailed = true;
          this.log("Could not confirm idle ACP session close");
          return;
        }
        if (this.closing.get(threadKey) === provider) this.closing.delete(threadKey);
      }
    } finally {
      provider.idleTrim = null;
    }
  }

  // Run one prompt turn on the thread's session. Returns the recorder and stopReason.
  async prompt(threadKey, prompt, { sessionId, onDispatched = null, onFirstOutput = null } = {}) {
    if (!this.process) throw new Error("agent is not running");
    const id = sessionId ?? (await this.session(threadKey)).sessionId;
    const recorder = new TurnRecorder();
    let observed = false;
    this.recorders.set(id, { update: update => {
      recorder.update(update);
      const kind = update?.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text'
        && typeof update.content.text === 'string' && update.content.text.trim() ? 'text'
        : update?.sessionUpdate === 'tool_call' && typeof update.toolCallId === 'string' && update.toolCallId.trim() ? 'tool' : null;
      if (!observed && kind) { observed = true; safelyObserve(onFirstOutput, kind); }
    } });
    const peer = this.process.peer;
    try {
      const pending = peer.request("session/prompt", { sessionId: id, prompt });
      safelyObserve(onDispatched);
      const result = await pending;
      return { recorder, stopReason: result?.stopReason ?? "end_turn" };
    } finally { this.recorders.delete(id); }
  }

  cancel(threadKey) {
    const sessionId = this.sessions.get(threadKey);
    if (sessionId && this.process) this.process.peer.notify("session/cancel", { sessionId });
  }

  onExit(listener) { this.exitListeners.add(listener); return () => this.exitListeners.delete(listener); }

  get running() { return Boolean(this.process); }

  stop() {
    const current = this.process; this.process = null; this.capabilities = null; this.stopped = true;
    this.closing.clear();
    if (current) { current.peer.close(); current.child.kill(); }
  }
}
