/**
 * fake-herdr-bridge.mjs — scripted fake of the herdr bridge HTTP service.
 *
 * Test fixture only (lane T1, herdr redesign). It implements the bridge HTTP
 * route table from phase2/design-docs/bridge-transport.md §1.1 (D3) and
 * translates each route to the fake socket wire protocol (see
 * tests/fixtures/fake-herdr-socket.mjs). It is a CONTRACT fixture: the
 * routes, auth shape, error codes, and SSE framing below are what the
 * Worker-side HerdrBridgeAdapter (lane B4) must speak.
 *
 * Routes (all JSON; bearer required except /healthz):
 *   GET  /healthz                 { ok, service, version, pinnedProtocol, missing[] }
 *   POST /v1/ping                 -> socket ping        { ok, protocolVersion, herdrVersion, methods }
 *   POST /v1/snapshot             -> session.snapshot  { ok, workspaces:[...] }
 *   POST /v1/spawn                -> agent.start        { ok, agentId, paneId, occupantToken, workspace, tab }
 *   POST /v1/read                 -> pane.read          { ok, paneId, text, source }
 *   POST /v1/send                 -> agent.prompt       { ok, sent, agentId, occupantToken }  (occupant-pinned)
 *   POST /v1/keys                 -> agent.send_keys    { ok, sent, keys }                    (occupant-pinned)
 *   POST /v1/wait                 -> agent.wait | pane.wait_for_output (long-poll, bounded by timeoutMs)
 *   POST /v1/report               -> pane.report_agent* { ok, recorded }
 *   POST /v1/close                -> pane.close         { ok, closed }
 *   POST /v1/list                 -> agent.list | agent.get
 *   GET  /v1/events               Server-Sent Events; forwards socket event frames
 *                                  as `data: {"type":"event"|"events_lost",...}`
 *
 * Error mapping (fixture contract for B4's error taxonomy):
 *   socket code 'occupant_changed' -> HTTP 409 { ok:false, code:'occupant_changed' }
 *   socket code 'not_found'        -> HTTP 404 { ok:false, code:'not_found' }
 *   socket code 'invalid_args'     -> HTTP 422 { ok:false, code:'invalid_args' }
 *   socket timeout / refused       -> HTTP 504/502 { ok:false, code:'timeout' | 'transport_error' }
 *   malformed socket frame         -> HTTP 502 { ok:false, code:'transport_error', detail:'malformed_frame' }
 *   other socket errors            -> HTTP 500 { ok:false, code:'server_error', upstream:{code,message} }
 *   missing/invalid bearer         -> HTTP 401 { ok:false, code:'auth_denied' }
 *
 * Fixture simplifications (documented, not hidden): the bearer token is a
 * static string (D3's HMAC-derived per-tenant token is B3's production
 * concern); tenant is fixed per bridge instance; there is no audit log,
 * no idempotency dedupe cache, and no per-tenant UID supervision.
 */

import http from 'node:http';
import net from 'node:net';

const SERVICE_VERSION = 't1-fixture-0';

let bridgeSeq = 0;

class MalformedFrameError extends Error {
  constructor() {
    super('malformed frame from herdr socket');
    this.code = 'malformed_frame';
  }
}

class SocketTimeoutError extends Error {
  constructor(method) {
    super(`socket request timed out: ${method}`);
    this.code = 'socket_timeout';
  }
}

class SocketAbortedError extends Error {
  constructor() {
    super('socket request aborted');
    this.code = 'socket_aborted';
  }
}

/** Minimal NDJSON socket client used by the fixture bridge.
 *  `signal` (AbortSignal) lets the long-poll /v1/wait cancel a held socket
 *  request when the caller's timeoutMs elapses. */
function socketRequest(socketPath, method, params, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(socketPath);
    let settled = false;
    const done = (fn) => (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      try {
        sock.destroy();
      } catch {
        // ignore
      }
      fn(v);
    };
    const onAbort = () => fail(new SocketAbortedError());
    const fail = done(reject);
    const ok = done(resolve);
    if (signal) {
      if (signal.aborted) {
        fail(new SocketAbortedError());
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    const timer = setTimeout(() => fail(new SocketTimeoutError(method)), timeoutMs);
    let buf = '';
    let helloSeen = false;
    const id = 1;
    sock.setEncoding('utf8');
    sock.on('connect', () => {
      sock.write(JSON.stringify({ id, method, params: params || {} }) + '\n');
    });
    sock.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        let frame;
        try {
          frame = JSON.parse(line);
        } catch {
          fail(new MalformedFrameError());
          return;
        }
        if (!helloSeen && frame && frame.type === 'hello') {
          helloSeen = true;
          continue;
        }
        if (frame && frame.id === id) {
          if (frame.ok) ok(frame.result);
          else fail(Object.assign(new Error(frame.error?.message || 'socket error'), { socketError: frame.error }));
          return;
        }
        // Any other non-hello frame on a request connection is malformed.
        fail(new MalformedFrameError());
        return;
      }
    });
    sock.on('error', (e) => fail(e));
    sock.on('close', () => {
      if (!settled) fail(new SocketTimeoutError(method));
    });
  });
}

export function createFakeHerdrBridge(opts = {}) {
  const {
    socketPath,
    token = 'test-bearer-token',
    socketTimeoutMs = 3000,
    heartbeatMs = 250, // SSE heartbeat; short for tests (D3 §3.1: 25s in prod)
  } = opts;
  if (!socketPath) throw new Error('fake bridge requires socketPath');

  const journal = []; // { route, status, tenant } per call, for assertions
  let eventStreams = 0; // number of SSE connections opened (resubscribe counting)
  let server = null;

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let data = '';
      req.on('data', (c) => {
        data += c;
      });
      req.on('end', () => {
        if (!data) return resolve({});
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
      req.on('error', reject);
    });
  }

  function sendJson(res, status, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  }

  function mapSocketError(res, route, err) {
    if (err instanceof MalformedFrameError) {
      journal.push({ route, status: 502 });
      return sendJson(res, 502, { ok: false, code: 'transport_error', detail: 'malformed_frame', message: err.message });
    }
    if (err instanceof SocketTimeoutError) {
      journal.push({ route, status: 504 });
      return sendJson(res, 504, { ok: false, code: 'timeout', message: err.message });
    }
    if (err && err.code === 'ECONNREFUSED') {
      journal.push({ route, status: 502 });
      return sendJson(res, 502, { ok: false, code: 'transport_error', message: 'herdr socket refused' });
    }
    const sc = err && err.socketError;
    if (sc) {
      const status = sc.code === 'occupant_changed' ? 409 : sc.code === 'not_found' ? 404 : sc.code === 'invalid_args' ? 422 : 500;
      const code = status === 500 ? 'server_error' : sc.code;
      journal.push({ route, status });
      return sendJson(res, status, { ok: false, code, message: sc.message, upstream: { code: sc.code, message: sc.message } });
    }
    journal.push({ route, status: 502 });
    return sendJson(res, 502, { ok: false, code: 'transport_error', message: String((err && err.message) || err) });
  }

  async function handleRoute(req, res, url) {
    const route = `${req.method} ${url.pathname}`;
    if (url.pathname === '/healthz' && req.method === 'GET') {
      return sendJson(res, 200, { ok: true, service: 'fake-herdr-bridge', version: SERVICE_VERSION, pinnedProtocol: 22, missing: [] });
    }
    const auth = req.headers.authorization || '';
    if (auth !== `Bearer ${token}`) {
      journal.push({ route, status: 401 });
      return sendJson(res, 401, { ok: false, code: 'auth_denied', message: 'missing or invalid bearer token' });
    }

    try {
      if (url.pathname === '/v1/ping' && req.method === 'POST') {
        const r = await socketRequest(socketPath, 'ping', {}, socketTimeoutMs);
        journal.push({ route, status: 200 });
        return sendJson(res, 200, { ok: true, protocolVersion: r.protocolVersion, herdrVersion: r.herdrVersion, methods: r.methods || undefined });
      }
      if (url.pathname === '/v1/snapshot' && req.method === 'POST') {
        const r = await socketRequest(socketPath, 'session.snapshot', {}, socketTimeoutMs);
        journal.push({ route, status: 200 });
        return sendJson(res, 200, { ok: true, ...r });
      }
      if (url.pathname === '/v1/spawn' && req.method === 'POST') {
        const b = await readBody(req);
        const r = await socketRequest(socketPath, 'agent.start', b, socketTimeoutMs);
        journal.push({ route, status: 200 });
        return sendJson(res, 200, { ok: true, ...r });
      }
      if (url.pathname === '/v1/read' && req.method === 'POST') {
        const b = await readBody(req);
        const r = await socketRequest(socketPath, 'pane.read', b, socketTimeoutMs);
        journal.push({ route, status: 200 });
        return sendJson(res, 200, { ok: true, ...r });
      }
      if (url.pathname === '/v1/send' && req.method === 'POST') {
        const b = await readBody(req);
        const r = await socketRequest(socketPath, 'agent.prompt', b, socketTimeoutMs);
        journal.push({ route, status: 200 });
        return sendJson(res, 200, { ok: true, ...r });
      }
      if (url.pathname === '/v1/keys' && req.method === 'POST') {
        const b = await readBody(req);
        const r = await socketRequest(socketPath, 'agent.send_keys', b, socketTimeoutMs);
        journal.push({ route, status: 200 });
        return sendJson(res, 200, { ok: true, ...r });
      }
      if (url.pathname === '/v1/wait' && req.method === 'POST') {
        const b = await readBody(req);
        const method = b.kind === 'output' ? 'pane.wait_for_output' : 'agent.wait';
        // Long-poll bounded by the caller's timeoutMs (D3 §3.1): when it
        // elapses the held socket request is cancelled and the bridge
        // answers 504 { code:'timeout' } — it never holds the HTTP request
        // open past the caller's budget.
        const waitMs = Math.min(Math.max(b.timeoutMs || 1000, 50), 15000);
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), waitMs);
        try {
          const r = await socketRequest(socketPath, method, b, waitMs + socketTimeoutMs, ctrl.signal);
          clearTimeout(timer);
          journal.push({ route, status: 200 });
          return sendJson(res, 200, { ok: true, ...r });
        } catch (err) {
          clearTimeout(timer);
          if (err && err.code === 'socket_aborted') {
            journal.push({ route, status: 504 });
            return sendJson(res, 504, { ok: false, code: 'timeout', message: `wait timed out after ${waitMs}ms` });
          }
          throw err;
        }
      }
      if (url.pathname === '/v1/report' && req.method === 'POST') {
        const b = await readBody(req);
        const method =
          b.kind === 'resume' ? 'pane.report_agent_session' : b.kind === 'metadata' ? 'pane.report_metadata' : 'pane.report_agent';
        const r = await socketRequest(socketPath, method, b, socketTimeoutMs);
        journal.push({ route, status: 200 });
        return sendJson(res, 200, { ok: true, ...r });
      }
      if (url.pathname === '/v1/close' && req.method === 'POST') {
        const b = await readBody(req);
        const r = await socketRequest(socketPath, 'pane.close', b, socketTimeoutMs);
        journal.push({ route, status: 200 });
        return sendJson(res, 200, { ok: true, ...r });
      }
      if (url.pathname === '/v1/list' && req.method === 'POST') {
        const b = await readBody(req);
        const method = b.agentId ? 'agent.get' : 'agent.list';
        const r = await socketRequest(socketPath, method, b, socketTimeoutMs);
        journal.push({ route, status: 200 });
        return sendJson(res, 200, { ok: true, ...r });
      }
      if (url.pathname === '/v1/events' && req.method === 'GET') {
        eventStreams += 1;
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        res.write(': connected\n\n');
        const since = url.searchParams.get('since');
        const sock = net.createConnection(socketPath);
        let buf = '';
        let helloSeen = false;
        let alive = true;
        const hb = setInterval(() => {
          if (alive) res.write(': heartbeat\n\n');
        }, heartbeatMs);
        const teardown = () => {
          alive = false;
          clearInterval(hb);
          try {
            sock.destroy();
          } catch {
            // ignore
          }
          try {
            res.end();
          } catch {
            // ignore
          }
        };
        sock.setEncoding('utf8');
        sock.on('connect', () => {
          sock.write(JSON.stringify({ id: 1, method: 'events.subscribe', params: { since } }) + '\n');
        });
        sock.on('data', (chunk) => {
          buf += chunk;
          let idx;
          while ((idx = buf.indexOf('\n')) !== -1) {
            const line = buf.slice(0, idx);
            buf = buf.slice(idx + 1);
            if (!line.trim()) continue;
            let frame;
            try {
              frame = JSON.parse(line);
            } catch {
              continue;
            }
            if (!helloSeen && frame && frame.type === 'hello') {
              helloSeen = true;
              continue;
            }
            if (frame && frame.id === 1 && frame.ok) continue; // subscribe ack
            if (frame && (frame.type === 'event' || frame.type === 'events_lost')) {
              if (alive) res.write(`data: ${JSON.stringify(frame)}\n\n`);
              if (frame.type === 'events_lost') {
                // herdr killed the subscription on overrun; drop the socket
                // side so the adapter's resubscribe opens a fresh stream.
                try {
                  sock.destroy();
                } catch {
                  // ignore
                }
              }
            }
          }
        });
        sock.on('error', () => {});
        sock.on('close', () => {});
        req.on('close', teardown);
        journal.push({ route, status: 200 });
        return;
      }
      journal.push({ route, status: 404 });
      return sendJson(res, 404, { ok: false, code: 'not_found', message: `no route ${route}` });
    } catch (err) {
      return mapSocketError(res, route, err);
    }
  }

  return {
    token,
    journal,
    get eventStreamCount() {
      return eventStreams;
    },
    async start() {
      const id = bridgeSeq++;
      await new Promise((resolve, reject) => {
        server = http.createServer((req, res) => {
          const url = new URL(req.url, 'http://localhost');
          handleRoute(req, res, url).catch((e) => {
            try {
              sendJson(res, 500, { ok: false, code: 'server_error', message: String(e && e.message) });
            } catch {
              // ignore
            }
          });
        });
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          server.removeListener('error', reject);
          resolve();
        });
      });
      return { id };
    },
    get url() {
      const addr = server.address();
      return `http://127.0.0.1:${addr.port}`;
    },
    async close() {
      if (!server) return;
      await new Promise((resolve) => server.close(resolve));
      server = null;
    },
  };
}
