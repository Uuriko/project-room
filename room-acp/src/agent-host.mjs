// One ACP agent process with one ACP session per Room thread.
import { spawnAgent, initialize } from "./agents.mjs";
import { TurnRecorder } from "./render.mjs";

export class AgentHost {
  constructor({ candidate, cwd = process.cwd(), env = process.env, mode = null, onPermission = null, log = () => {} }) {
    Object.assign(this, { candidate, cwd, env, mode, onPermission, log });
    this.sessions = new Map(); // threadKey -> sessionId
    this.recorders = new Map(); // sessionId -> TurnRecorder (one turn in flight per session)
    this.threadOf = new Map(); // sessionId -> threadKey
    this.process = null; this.capabilities = null; this.exitListeners = new Set();
  }

  async start() {
    const spawned = spawnAgent(this.candidate, {
      cwd: this.cwd, env: this.env, log: this.log,
      onNotification: (method, params) => { if (method === "session/update") this.recorders.get(params.sessionId)?.update(params.update); },
      onRequest: (method, params) => this.#agentRequest(method, params),
    });
    this.process = spawned;
    const exited = new Promise(resolve => spawned.child.once("exit", (code, signal) => resolve({ code, signal })));
    exited.then(info => { if (this.process === spawned) { this.process = null; for (const listener of this.exitListeners) listener(info); } });
    spawned.child.once("error", error => this.log(`agent failed to start: ${error.message}`));
    this.capabilities = await Promise.race([initialize(spawned.peer, { timeoutMs: 30000 }), exited.then(info => { throw new Error(`agent exited during initialize (code ${info.code})`); })]);
    return this.capabilities;
  }

  async #agentRequest(method, params) {
    if (method === "session/request_permission") {
      if (!this.onPermission) return { outcome: { outcome: "cancelled" } };
      return this.onPermission({ threadKey: this.threadOf.get(params.sessionId) ?? null, ...params });
    }
    // fs/* and terminal/* are not advertised; refuse anything else.
    const error = new Error(`room-acp does not provide ${method}`); error.code = -32601; throw error;
  }

  async session(threadKey) {
    if (this.sessions.has(threadKey)) return { sessionId: this.sessions.get(threadKey), created: false };
    const { sessionId } = await this.process.peer.request("session/new", { cwd: this.cwd, mcpServers: [] }, { timeoutMs: 60000 });
    if (this.mode) await this.process.peer.request("session/set_mode", { sessionId, modeId: this.mode }, { timeoutMs: 15000 }).catch(error => this.log(`set_mode ${this.mode} failed: ${error.message}`));
    this.sessions.set(threadKey, sessionId); this.threadOf.set(sessionId, threadKey);
    return { sessionId, created: true };
  }

  // Run one prompt turn on the thread's session. Returns the recorder and stopReason.
  async prompt(threadKey, prompt, { sessionId } = {}) {
    if (!this.process) throw new Error("agent is not running");
    const id = sessionId ?? (await this.session(threadKey)).sessionId;
    const recorder = new TurnRecorder();
    this.recorders.set(id, recorder);
    const peer = this.process.peer;
    try {
      const result = await peer.request("session/prompt", { sessionId: id, prompt });
      return { recorder, stopReason: result?.stopReason ?? "end_turn" };
    } finally { this.recorders.delete(id); }
  }

  cancel(threadKey) {
    const sessionId = this.sessions.get(threadKey);
    if (sessionId && this.process) this.process.peer.notify("session/cancel", { sessionId });
  }

  onExit(listener) { this.exitListeners.add(listener); return () => this.exitListeners.delete(listener); }

  stop() {
    const current = this.process; this.process = null;
    if (current) { current.peer.close(); current.child.kill(); }
  }
}
