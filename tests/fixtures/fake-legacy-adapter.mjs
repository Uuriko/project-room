/**
 * fake-legacy-adapter.mjs — minimal in-memory stand-in for the legacy
 * session backend, for the fail-closed degradation tests.
 *
 * Test fixture only (lane T1). It implements just enough of the
 * SessionAdapter domain interface (seam-design §2) to prove the
 * degradation rule: when the bridge is unreachable at connect(), the
 * adapter must degrade to legacy — serving calls and reporting the
 * degradation — rather than throwing. Every result is tagged
 * backend:'legacy' so tests can assert which backend served the call.
 */

export function createFakeLegacyAdapter() {
  let n = 0;
  const agents = new Map();
  const events = [];
  return {
    backend: 'legacy',
    connected: false,
    async connect() {
      this.connected = true;
    },
    async disconnect() {
      this.connected = false;
    },
    async ping() {
      return { ok: true, backend: 'legacy' };
    },
    get protocolVersion() {
      return 0;
    },
    async snapshot() {
      return { workspaces: [], backend: 'legacy' };
    },
    async spawnAgent(opts = {}) {
      n += 1;
      const agentId = `legacy-agent-${n}`;
      const paneId = `legacy-pane-${n}`;
      agents.set(agentId, { id: agentId, paneId, state: 'working', title: opts.title || paneId });
      return { agentId, paneId, backend: 'legacy', occupantToken: 'legacy-occ' };
    },
    async listAgents() {
      return { agents: [...agents.values()], backend: 'legacy' };
    },
    async getAgent(agentId) {
      const a = agents.get(agentId);
      if (!a) {
        const e = new Error(`unknown agent ${agentId}`);
        e.name = 'ServerError';
        e.code = 'not_found';
        throw e;
      }
      return { ...a, backend: 'legacy' };
    },
    async readPane(paneId) {
      return { paneId, text: 'legacy pane text', source: 'visible', backend: 'legacy' };
    },
    async sendText(agentId, text) {
      if (!agents.has(agentId)) {
        const e = new Error(`unknown agent ${agentId}`);
        e.name = 'ServerError';
        e.code = 'not_found';
        throw e;
      }
      return { sent: true, agentId, text, backend: 'legacy' };
    },
    async sendKeys() {
      return { sent: true, backend: 'legacy' };
    },
    async waitForState(agentId, states) {
      const a = agents.get(agentId);
      const state = a && states.includes(a.state) ? a.state : states[0];
      return { agentId, state, backend: 'legacy' };
    },
    async waitForOutput(paneId) {
      return { paneId, match: '', backend: 'legacy' };
    },
    async reportState(paneId, state) {
      events.push({ kind: 'state', paneId, state });
    },
    async reportResume(paneId, ref) {
      events.push({ kind: 'resume', paneId, ref });
    },
    async reportMetadata(paneId, meta) {
      events.push({ kind: 'metadata', paneId, meta });
    },
    async closePane(paneId) {
      for (const [id, a] of agents) {
        if (a.paneId === paneId) agents.delete(id);
      }
    },
    async subscribe() {
      return { active: true, close: async () => {} };
    },
    async waitForEvent() {
      const e = new Error('not supported by legacy fixture');
      e.name = 'MethodUnsupportedError';
      throw e;
    },
    supports() {
      return false;
    },
    reported: events,
  };
}
