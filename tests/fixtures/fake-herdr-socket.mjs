/**
 * fake-herdr-socket.mjs — scripted fake of the herdr Unix-socket server.
 *
 * Test fixture only (lane T1, herdr redesign). It implements the wire shape
 * the seam-design lane documented for herdr's newline-delimited JSON socket
 * API (protocol v22): a hello banner, per-request id echo, and pushed event
 * frames. It is NOT a herdr implementation — it is a contract fixture whose
 * scripted behaviors let the adapter-seam integration tests drive the
 * adapter's happy paths and chaos paths deterministically.
 *
 * Wire protocol (fixture contract):
 *   server banner (first frame on connect):
 *     {"type":"hello","protocolVersion":22,"herdrVersion":"0.14.2","methods":[...]}
 *   request:  {"id":<n>,"method":"<m>","params":{...}}
 *   response: {"id":<n>,"ok":true,"result":{...}}
 *           | {"id":<n>,"ok":false,"error":{"code":"<code>","message":"<msg>"}}
 *   pushed:   {"type":"event","id":"ev-<n>","name":"<herdr event name>","data":{...}}
 *           | {"type":"events_lost","lostCount":<n>}
 *
 * Scriptable server behaviors (used by the chaos tests):
 *   - setAgentState(agentId, state) — resolves pending agent.wait + emits
 *     pane.agent_status_changed to subscribers.
 *   - appendOutput(paneId, text) — resolves matching pane.wait_for_output,
 *     emits pane.output_matched.
 *   - changeOccupant(agentId) — rotates the pane occupant token; pending
 *     agent.wait calls fail with code 'occupant_changed'; subsequent
 *     agent.prompt / agent.send_keys with the stale token fail the same way.
 *   - emitEventsLost(lostCount) — pushes {"type":"events_lost"} to
 *     subscribers, then kills those subscriptions (further pushed events to
 *     them are dropped, mimicking herdr's bounded-history overrun).
 *   - mode: 'garbage' — after the hello banner, any request gets raw
 *     non-JSON bytes and no response (drives the malformed-frame path).
 */

import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const FAKE_PROTOCOL_VERSION = 22;
export const FAKE_HERDR_VERSION = '0.14.2';

/** Core tier per seam-design §2.6 — absence of any of these at connect is a
 *  VersionMismatchError (fail closed) in the real adapter. */
export const CORE_METHODS = [
  'ping',
  'session.snapshot',
  'agent.start',
  'agent.list',
  'agent.get',
  'pane.read',
  'agent.prompt',
  'agent.send_keys',
  'agent.wait',
  'pane.wait_for_output',
  'pane.report_agent',
  'pane.report_agent_session',
  'pane.report_metadata',
  'pane.close',
  'events.subscribe',
];

const OPTIONAL_METHODS = ['worktree.create', 'layout.export', 'layout.apply'];

let fixtureSeq = 0;

function tmpSocketPath() {
  const dir = process.env.TMPDIR || os.tmpdir();
  return path.join(dir, `fake-herdr-${process.pid}-${fixtureSeq++}.sock`);
}

function occupantTokenFor(agentId, gen) {
  return `occ-${agentId}-g${gen}`;
}

export function createFakeHerdrSocket(opts = {}) {
  const {
    protocolVersion = FAKE_PROTOCOL_VERSION,
    herdrVersion = FAKE_HERDR_VERSION,
    methods = [...CORE_METHODS, ...OPTIONAL_METHODS],
    mode = 'normal', // 'normal' | 'garbage'
    socketPath = tmpSocketPath(),
  } = opts;

  const server = net.createServer();
  const panes = new Map(); // paneId -> pane record
  const agents = new Map(); // agentId -> agent record
  const waits = new Map(); // waitId -> { kind, agentId|paneId, match, resolve, reject }
  const subscribers = new Set(); // sockets with an active events.subscribe
  const deadSubscribers = new Set(); // subscriptions killed by events_lost
  const journal = []; // every method invoked, for assertions
  let agentSeq = 0;
  let paneSeq = 0;
  let eventSeq = 0;
  let waitSeq = 0;
  let closed = false;

  function sendFrame(sock, obj) {
    if (closed) return;
    try {
      sock.write(JSON.stringify(obj) + '\n');
    } catch {
      // client gone; ignore
    }
  }

  function pushEvent(name, data) {
    const frame = { type: 'event', id: `ev-${++eventSeq}`, name, data };
    for (const sock of subscribers) {
      if (!deadSubscribers.has(sock)) sendFrame(sock, frame);
    }
    return frame;
  }

  function recordPane(workspace, tab, title, kind, command) {
    const paneId = `pane-${++paneSeq}`;
    const agentId = `agent-${++agentSeq}`;
    const occupant = occupantTokenFor(agentId, 1);
    const pane = {
      id: paneId,
      workspace: workspace || 'default',
      tab: tab || 'main',
      title: title || `${kind || 'agent'} ${paneId}`,
      agentId,
      occupantToken: occupant,
      occupantGen: 1,
      state: 'working',
      output: [`$ ${command || 'agent'}\n`],
      sessionRef: null,
      resumeCommand: null,
      metadata: {},
    };
    panes.set(paneId, pane);
    agents.set(agentId, {
      id: agentId,
      paneId,
      kind: kind || 'agent',
      state: 'working',
      occupantToken: occupant,
    });
    return { agentId, paneId, occupantToken: occupant };
  }

  function checkOccupant(agentId, token) {
    const agent = agents.get(agentId);
    if (!agent) return { ok: false, error: { code: 'not_found', message: `unknown agent ${agentId}` } };
    if (token != null && token !== agent.occupantToken) {
      return { ok: false, error: { code: 'occupant_changed', message: `occupant of ${agentId} changed` } };
    }
    return { ok: true, agent };
  }

  function resolveWaitsForState(agent) {
    for (const [id, w] of waits) {
      if (w.kind === 'state' && w.agentId === agent.id && w.states.includes(agent.state)) {
        waits.delete(id);
        w.resolve({ ok: true, result: { agentId: agent.id, state: agent.state, occupantToken: agent.occupantToken } });
      }
    }
  }

  function resolveWaitsForOutput(pane) {
    const text = pane.output.join('');
    for (const [id, w] of waits) {
      if (w.kind === 'output' && w.paneId === pane.id) {
        const m = text.match(w.regex);
        if (m) {
          waits.delete(id);
          pushEvent('pane.output_matched', { paneId: pane.id, pattern: w.pattern, match: m[0] });
          w.resolve({ ok: true, result: { paneId: pane.id, match: m[0] } });
        }
      }
    }
  }

  const handlers = {
    ping() {
      return { ok: true, result: { protocolVersion, herdrVersion } };
    },
    'session.snapshot'() {
      const byWorkspace = new Map();
      for (const pane of panes.values()) {
        if (!byWorkspace.has(pane.workspace)) byWorkspace.set(pane.workspace, new Map());
        const tabs = byWorkspace.get(pane.workspace);
        if (!tabs.has(pane.tab)) tabs.set(pane.tab, []);
        tabs.get(pane.tab).push({
          id: pane.id,
          agentId: pane.agentId,
          occupantToken: pane.occupantToken,
          state: pane.state,
          title: pane.title,
        });
      }
      return {
        ok: true,
        result: {
          workspaces: [...byWorkspace.entries()].map(([name, tabs]) => ({
            name,
            tabs: [...tabs.entries()].map(([tname, plist]) => ({ name: tname, panes: plist })),
          })),
        },
      };
    },
    'agent.start'(params) {
      if (params && params.resumeCommand && params.resumeCommand.length > 64) {
        return { ok: false, error: { code: 'invalid_args', message: 'resumeCommand exceeds 64 args' } };
      }
      const rec = recordPane(params?.workspace, params?.tab, params?.title, params?.kind, params?.command);
      const pane = panes.get(rec.paneId);
      if (params?.resumeSessionRef) pane.sessionRef = params.resumeSessionRef;
      if (params?.resumeCommand) pane.resumeCommand = params.resumeCommand;
      pushEvent('pane.created', { paneId: rec.paneId, agentId: rec.agentId });
      return { ok: true, result: rec };
    },
    'agent.list'() {
      return {
        ok: true,
        result: {
          agents: [...agents.values()].map((a) => ({
            id: a.id,
            paneId: a.paneId,
            kind: a.kind,
            state: a.state,
            occupantToken: a.occupantToken,
          })),
        },
      };
    },
    'agent.get'(params) {
      const agent = agents.get(params?.agentId);
      if (!agent) return { ok: false, error: { code: 'not_found', message: `unknown agent ${params?.agentId}` } };
      return {
        ok: true,
        result: { id: agent.id, paneId: agent.paneId, kind: agent.kind, state: agent.state, occupantToken: agent.occupantToken },
      };
    },
    'pane.read'(params) {
      const pane = panes.get(params?.paneId);
      if (!pane) return { ok: false, error: { code: 'not_found', message: `unknown pane ${params?.paneId}` } };
      const lines = params?.lines ?? 200;
      const text = pane.output.join('').split('\n').slice(-lines).join('\n');
      return { ok: true, result: { paneId: pane.id, text, source: params?.source || 'visible' } };
    },
    'agent.prompt'(params) {
      const chk = checkOccupant(params?.agentId, params?.occupantToken);
      if (!chk.ok) return chk;
      const pane = panes.get(chk.agent.paneId);
      pane.output.push(`> ${params?.text ?? ''}\n`);
      resolveWaitsForOutput(pane);
      return { ok: true, result: { sent: true, agentId: chk.agent.id, occupantToken: chk.agent.occupantToken } };
    },
    'agent.send_keys'(params) {
      const chk = checkOccupant(params?.agentId, params?.occupantToken);
      if (!chk.ok) return chk;
      return { ok: true, result: { sent: true, keys: params?.keys ?? [] } };
    },
    'agent.wait'(params, ctx) {
      const chk = checkOccupant(params?.agentId, params?.occupantToken);
      if (!chk.ok) return chk;
      const agent = chk.agent;
      const states = params?.states ?? [];
      if (states.includes(agent.state)) {
        return { ok: true, result: { agentId: agent.id, state: agent.state, occupantToken: agent.occupantToken } };
      }
      // Hold the request open; the test drives it via setAgentState /
      // changeOccupant. The pending wait registers its own respond/reject;
      // 'held' tells handleRequest not to answer yet.
      const id = `wait-${++waitSeq}`;
      waits.set(id, {
        kind: 'state',
        agentId: agent.id,
        states,
        id,
        resolve: (resp) => ctx.respond(resp),
        reject: (err) => ctx.respond({ ok: false, error: err }),
      });
      return 'held';
    },
    'pane.wait_for_output'(params, ctx) {
      const pane = panes.get(params?.paneId);
      if (!pane) return { ok: false, error: { code: 'not_found', message: `unknown pane ${params?.paneId}` } };
      let regex;
      try {
        regex = new RegExp(params?.regex ?? '');
      } catch {
        return { ok: false, error: { code: 'invalid_args', message: 'bad regex' } };
      }
      const m = pane.output.join('').match(regex);
      if (m) {
        pushEvent('pane.output_matched', { paneId: pane.id, pattern: params.regex, match: m[0] });
        return { ok: true, result: { paneId: pane.id, match: m[0] } };
      }
      const id = `wait-${++waitSeq}`;
      waits.set(id, {
        kind: 'output',
        paneId: pane.id,
        regex,
        pattern: params.regex,
        id,
        resolve: (resp) => ctx.respond(resp),
        reject: (err) => ctx.respond({ ok: false, error: err }),
      });
      return 'held';
    },
    'pane.report_agent'(params) {
      const pane = panes.get(params?.paneId);
      if (!pane) return { ok: false, error: { code: 'not_found', message: `unknown pane ${params?.paneId}` } };
      pane.state = params?.state ?? pane.state;
      return { ok: true, result: { recorded: true } };
    },
    'pane.report_agent_session'(params) {
      const pane = panes.get(params?.paneId);
      if (!pane) return { ok: false, error: { code: 'not_found', message: `unknown pane ${params?.paneId}` } };
      if (params?.resumeCommand && params.resumeCommand.length > 64) {
        return { ok: false, error: { code: 'invalid_args', message: 'resumeCommand exceeds 64 args' } };
      }
      pane.sessionRef = params?.sessionRef ?? pane.sessionRef;
      pane.resumeCommand = params?.resumeCommand ?? pane.resumeCommand;
      return { ok: true, result: { recorded: true } };
    },
    'pane.report_metadata'(params) {
      const pane = panes.get(params?.paneId);
      if (!pane) return { ok: false, error: { code: 'not_found', message: `unknown pane ${params?.paneId}` } };
      Object.assign(pane.metadata, params?.metadata ?? {});
      return { ok: true, result: { recorded: true } };
    },
    'pane.close'(params) {
      const pane = panes.get(params?.paneId);
      if (!pane) return { ok: false, error: { code: 'not_found', message: `unknown pane ${params?.paneId}` } };
      panes.delete(params.paneId);
      agents.delete(pane.agentId);
      pushEvent('pane.closed', { paneId: params.paneId, agentId: pane.agentId });
      return { ok: true, result: { closed: true } };
    },
    'events.subscribe'(params, ctx) {
      subscribers.add(ctx.socket);
      return { ok: true, result: { subscribed: true, since: params?.since ?? null } };
    },
  };

  function handleRequest(sock, req) {
    journal.push({ method: req.method, params: req.params });
    if (mode === 'garbage' && req.method !== 'ping') {
      // Malformed-frame chaos: raw bytes, no JSON, no response.
      try {
        sock.write('THIS IS NOT JSON{{{\n');
      } catch {
        // ignore
      }
      return;
    }
    const handler = handlers[req.method];
    const respond = (resp) => sendFrame(sock, { id: req.id, ...resp });
    if (!handler) {
      respond({ ok: false, error: { code: 'unknown_method', message: `unknown method ${req.method}` } });
      return;
    }
    const ctx = { socket: sock, respond };
    const out = handler(req.params || {}, ctx);
    // Handlers that hold the request open (agent.wait, pane.wait_for_output)
    // return 'held' and answer later via ctx.respond.
    if (out !== 'held') respond(out);
  }

  server.on('connection', (sock) => {
    sock.setEncoding('utf8');
    sendFrame(sock, { type: 'hello', protocolVersion, herdrVersion, methods });
    let buf = '';
    sock.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        let req;
        try {
          req = JSON.parse(line);
        } catch {
          // Client sent garbage; ignore (server-side fixture only).
          continue;
        }
        if (req && typeof req.id !== 'undefined' && typeof req.method === 'string') {
          handleRequest(sock, req);
        }
      }
    });
    const drop = () => {
      subscribers.delete(sock);
      deadSubscribers.delete(sock);
    };
    sock.on('close', drop);
    sock.on('error', drop);
  });

  return {
    path: socketPath,
    journal,
    async start() {
      try {
        fs.unlinkSync(socketPath);
      } catch {
        // no stale socket
      }
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, () => {
          server.removeListener('error', reject);
          resolve();
        });
      });
    },
    async close() {
      closed = true;
      for (const sock of subscribers) {
        try {
          sock.destroy();
        } catch {
          // ignore
        }
      }
      subscribers.clear();
      await new Promise((resolve) => server.close(resolve));
      try {
        fs.unlinkSync(socketPath);
      } catch {
        // already gone
      }
    },
    /** Drive a state transition; resolves matching agent.wait calls and emits
     *  pane.agent_status_changed to subscribers. */
    setAgentState(agentId, state) {
      const agent = agents.get(agentId);
      if (!agent) throw new Error(`fake: unknown agent ${agentId}`);
      const previousState = agent.state;
      agent.state = state;
      const pane = panes.get(agent.paneId);
      if (pane) pane.state = state;
      resolveWaitsForState(agent);
      pushEvent('pane.agent_status_changed', {
        agentId,
        paneId: agent.paneId,
        state,
        previousState,
        occupantToken: agent.occupantToken,
      });
    },
    /** Rotate the pane occupant token; pending agent.wait calls fail with
     *  code 'occupant_changed'. */
    changeOccupant(agentId) {
      const agent = agents.get(agentId);
      if (!agent) throw new Error(`fake: unknown agent ${agentId}`);
      agent.occupantGen = (agent.occupantGen || 1) + 1;
      agent.occupantToken = occupantTokenFor(agentId, agent.occupantGen);
      const pane = panes.get(agent.paneId);
      if (pane) pane.occupantToken = agent.occupantToken;
      for (const [id, w] of waits) {
        if (w.kind === 'state' && w.agentId === agentId) {
          waits.delete(id);
          w.reject({ code: 'occupant_changed', message: `occupant of ${agentId} changed mid-wait` });
        }
      }
      return agent.occupantToken;
    },
    /** Append pane output; resolves matching pane.wait_for_output. */
    appendOutput(paneId, text) {
      const pane = panes.get(paneId);
      if (!pane) throw new Error(`fake: unknown pane ${paneId}`);
      pane.output.push(text);
      resolveWaitsForOutput(pane);
    },
    /** Push an arbitrary event frame to subscribers (test-driven). */
    emitEvent(name, data) {
      return pushEvent(name, data);
    },
    /** Simulate herdr's bounded-history overrun: subscribers get events_lost
     *  and their subscriptions die (further pushes to them are dropped). */
    emitEventsLost(lostCount) {
      for (const sock of subscribers) {
        deadSubscribers.add(sock);
        sendFrame(sock, { type: 'events_lost', lostCount });
      }
    },
    agentCount() {
      return agents.size;
    },
    getPane(paneId) {
      return panes.get(paneId);
    },
    getAgent(agentId) {
      return agents.get(agentId);
    },
  };
}
