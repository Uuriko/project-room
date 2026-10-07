/**
 * tests/herdr-bridge-adapter.test.js — HerdrBridgeAdapter (B4 worker-wiring lane).
 *
 * Fail-first contract tests for the Worker-side HTTPS client to
 * bridge/herdr-bridge.mjs, against a REAL mock bridge HTTP server
 * (node:http) and REAL fetch — no stubbed doubles. The mock throws 404 on
 * unknown routes, so the adapter cannot pass by calling the wrong route.
 *
 * What each group guards (test-audit authoring gate):
 *  A. Flag/route gating — the fail-closed default-deny path. Regression: a
 *     refactor that routes a tenant to herdr when the flag is off or the
 *     tenant has no route (would phone a bridge that must not be touched).
 *  B. Bearer derivation — the exact HMAC wire contract B3 must verify.
 *     Regression: derivation drift (prefix, encoding) breaks every bridge
 *     call with 401s.
 *  C. Version pinning — connect-time assert, fail closed. Regression: a
 *     lenient connect (upstream herdr's default) lets work start against an
 *     unpinned server.
 *  D. Connect resilience — broker down at connect() must not block claiming.
 *     Regression: connect() throwing TransportError instead of returning
 *     the legacy fallback.
 *  E. Transport semantics — idempotent-read retries, write exactly-once via
 *     idempotency keys, no-retry on 4xx/typed errors. Regression: a dropped
 *     send retried without the same key double-executes a prompt injection.
 *  F. Circuit breaker — fail-fast + legacy fallback for new sessions.
 *     Regression: a sick bridge hangs every caller until edge timeouts.
 *  G. Subscribe/SSE — adapter-owned events_lost recovery (re-snapshot,
 *     onReconcile, resubscribe with cursor). Regression: a silent event gap
 *     after stream death.
 *  H. Route-auth method allowlist — deny-by-default before any bridge call.
 *     Regression: a disallowed method (e.g. keys) reaching the bridge.
 *  I. Spawn/report request shapes — the body contract B3 implements.
 *     Regression: drift in field names the bridge parses.
 *  J. Worker safety — the module must stay runnable in a Cloudflare Worker.
 *     Regression: someone imports node:net/node:fs and the Worker build
 *     breaks at deploy time.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';

const ADAPTER_PATH = '../server/session-adapter/herdr-bridge-adapter.mjs';

const TEST_PINS = {
  herdrVersion: 'herdr-0.14.2',
  protocolVersion: 22,
  forkCommit: 'abc123def456',
  binarySha256: 'deadbeef'.repeat(8),
};
const ALL_BRIDGE_METHODS = ['ping', 'snapshot', 'spawn', 'read', 'send', 'keys', 'wait', 'report', 'close', 'list', 'events'];

/** Independent re-derivation of the bearer contract (D3 §1.2). */
async function expectedBearerToken(masterSecret, tenantId) {
  const key = await webcrypto.subtle.importKey(
    'raw', new TextEncoder().encode(masterSecret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await webcrypto.subtle.sign('HMAC', key, new TextEncoder().encode(`herdr-bridge-v1:${tenantId}`));
  const bytes = new Uint8Array(sig);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return Buffer.from(s, 'binary').toString('base64url');
}

// ---------------------------------------------------------------------------
// Mock bridge — implements the BRIDGE-API contract the adapter expects.
// Throws 404 on unknown routes. Scriptable per test.
// ---------------------------------------------------------------------------

function startMockBridge(script = {}) {
  const state = {
    requests: [],
    seenIdempotencyKeys: new Map(), // key -> response body (15-min dedupe sim)
    execCount: 0,
    protocolVersion: script.protocolVersion ?? 22,
    version: script.version ?? 'herdr-0.14.2',
    methods: script.methods ?? [...ALL_BRIDGE_METHODS],
    masterSecret: script.masterSecret ?? 'test-master-secret',
    forceStatus: { ...(script.forceStatus ?? {}) },       // route -> status (persistent)
    failTimes: { ...(script.failTimes ?? {}) },           // route -> remaining 500s
    dropTimes: { ...(script.dropTimes ?? {}) },           // route -> remaining socket destroys
    errorBody: { ...(script.errorBody ?? {}) },           // route -> one-shot { error: { code, message } }
    waitDelayMs: script.waitDelayMs ?? 0,
    eventConnections: 0,
    onEvents: script.onEvents ?? null,                    // (req, res, ctx) => void|Promise
    handlers: { ...(script.handlers ?? {}) },             // route -> custom async handler
  };

  const readBody = (req) => new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve(null);
      try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const route = url.pathname;
    const body = req.method === 'POST' ? await readBody(req) : null;
    state.requests.push({
      route, method: req.method,
      query: Object.fromEntries(url.searchParams.entries()),
      headers: { authorization: req.headers.authorization, 'x-bridge-key-id': req.headers['x-bridge-key-id'], 'x-idempotency-key': req.headers['x-idempotency-key'] },
      body,
    });

    const send = (status, obj) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };

    // Auth: every route except /healthz requires the derived bearer.
    if (route !== '/healthz') {
      const expected = `Bearer ${await expectedBearerToken(state.masterSecret, 'tenant-a')}`;
      if (req.headers.authorization !== expected) return send(401, { error: { code: 'auth_denied', message: 'bad bearer' } });
    }

    // Scripted failures.
    if (state.dropTimes[route] > 0) { state.dropTimes[route] -= 1; req.socket.destroy(); return; }
    if (state.failTimes[route] > 0) { state.failTimes[route] -= 1; return send(500, { error: { code: 'internal', message: 'boom' } }); }
    if (state.forceStatus[route]) return send(state.forceStatus[route], { error: { code: 'forced', message: 'forced status' } });
    if (state.errorBody[route]) { const b = state.errorBody[route]; delete state.errorBody[route]; return send(200, b); }
    if (state.handlers[route]) return state.handlers[route]({ req, res, url, body, state, send });

    // Idempotency dedupe (bridge-side 15-min cache simulation) for writes.
    const idem = req.headers['x-idempotency-key'];
    if (idem && state.seenIdempotencyKeys.has(idem)) return send(200, state.seenIdempotencyKeys.get(idem));
    const maybeDedupe = (obj) => { if (idem) state.seenIdempotencyKeys.set(idem, obj); state.execCount += 1; return obj; };

    switch (route) {
      case '/v1/ping':
        return send(200, { ok: true, service: 'herdr-bridge', version: state.version, protocolVersion: state.protocolVersion, methods: state.methods });
      case '/v1/snapshot':
        return send(200, { version: 1, workspaces: [] });
      case '/v1/spawn':
        return send(200, maybeDedupe({ id: 'agent-1', paneId: 'pane-1', occupantId: 'occ-1' }));
      case '/v1/list':
        return send(200, body?.op === 'get'
          ? { agent: { id: body.agentId, paneId: 'pane-1', occupantId: 'occ-1', state: 'working', kind: 'claude' } }
          : { agents: [] });
      case '/v1/read':
        return send(200, { paneId: body?.paneId, source: body?.source, lines: ['hello'], text: 'hello' });
      case '/v1/send':
        return send(200, maybeDedupe({ ok: true, agentId: body?.agentId, bytes: body?.text?.length ?? 0 }));
      case '/v1/keys':
        return send(200, maybeDedupe({ ok: true }));
      case '/v1/wait':
        if (state.waitDelayMs) await new Promise((r) => setTimeout(r, state.waitDelayMs));
        return send(200, maybeDedupe({ matched: true, state: body?.states?.[0] ?? null, elapsedMs: 1 }));
      case '/v1/report':
        return send(200, maybeDedupe({ ok: true }));
      case '/v1/close':
        return send(200, maybeDedupe({ ok: true }));
      case '/v1/events': {
        state.eventConnections += 1;
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        if (state.onEvents) { await state.onEvents({ req, res, url, state, send }); return; }
        res.end();
        return;
      }
      default:
        return send(404, { error: { code: 'not_found', message: `unknown route ${route}` } });
    }
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        server, port, url: `http://127.0.0.1:${port}`, state,
        // Destroy pooled keep-alive connections first: undici's fetch keeps
        // sockets open, and server.close() alone would wait on them forever.
        close: () => new Promise((r) => {
          try { server.closeAllConnections(); } catch { /* ignore */ }
          server.close(r);
        }),
      });
    });
  });
}

function makeEnv(mock, { mode = 'on', methods, tenants = ['tenant-a'], masterSecret = 'test-master-secret' } = {}) {
  return {
    ROOM_HERDR_SESSIONS: mode,
    HERDR_ROUTE_TABLE: JSON.stringify({
      version: 1,
      defaultDeny: true,
      bridges: {
        'host-1': {
          url: mock.url,
          keyId: '2026-10-a',
          methods: methods ?? [...ALL_BRIDGE_METHODS],
          tenants,
        },
      },
    }),
    BRIDGE_MASTER_SECRET: masterSecret,
  };
}

async function loadAdapter() {
  return import(ADAPTER_PATH);
}

// ---------------------------------------------------------------------------
// A. Flag / route gating — fail-closed default-deny
// ---------------------------------------------------------------------------

test('A1: flag off → legacy backend, bridge never contacted', async () => {
  const { readHerdrBridgeConfig, connectSession } = await loadAdapter();
  const mock = await startMockBridge();
  try {
    const env = makeEnv(mock, { mode: 'off' });
    const out = await connectSession({ config: readHerdrBridgeConfig(env), tenantId: 'tenant-a', roomId: 'room-x', env, pins: TEST_PINS });
    assert.equal(out.backend, 'legacy');
    assert.equal(out.reason, 'flag_off');
    assert.equal(mock.state.requests.length, 0);
  } finally { await mock.close(); }
});

test('A2: room allowlist — unlisted room → legacy; listed room → herdr', async () => {
  const { readHerdrBridgeConfig, connectSession } = await loadAdapter();
  const mock = await startMockBridge();
  try {
    const env = makeEnv(mock, { mode: 'room-a, room-b' });
    const config = readHerdrBridgeConfig(env);
    const missed = await connectSession({ config, tenantId: 'tenant-a', roomId: 'room-c', env, pins: TEST_PINS });
    assert.equal(missed.backend, 'legacy');
    assert.equal(missed.reason, 'room_not_listed');
    const hit = await connectSession({ config, tenantId: 'tenant-a', roomId: 'room-b', env, pins: TEST_PINS });
    assert.equal(hit.backend, 'herdr');
    assert.ok(hit.adapter.connected);
    await hit.adapter.disconnect();
  } finally { await mock.close(); }
});

test('A3: tenant with no route → legacy (default-deny), bridge never contacted', async () => {
  const { readHerdrBridgeConfig, connectSession } = await loadAdapter();
  const mock = await startMockBridge();
  try {
    const env = makeEnv(mock, { tenants: ['tenant-a'] });
    const out = await connectSession({ config: readHerdrBridgeConfig(env), tenantId: 'tenant-stranger', roomId: 'room-x', env, pins: TEST_PINS });
    assert.equal(out.backend, 'legacy');
    assert.equal(out.reason, 'no_route');
    assert.equal(mock.state.requests.length, 0);
  } finally { await mock.close(); }
});

// ---------------------------------------------------------------------------
// B. Bearer auth — the derived-token wire contract
// ---------------------------------------------------------------------------

test('B1: requests carry the derived bearer token and key-id header', async () => {
  const { readHerdrBridgeConfig, connectSession, deriveBridgeToken } = await loadAdapter();
  const mock = await startMockBridge();
  try {
    const env = makeEnv(mock);
    const out = await connectSession({ config: readHerdrBridgeConfig(env), tenantId: 'tenant-a', roomId: 'room-x', env, pins: TEST_PINS });
    assert.equal(out.backend, 'herdr');
    const pingReq = mock.state.requests.find((r) => r.route === '/v1/ping');
    const expected = await expectedBearerToken('test-master-secret', 'tenant-a');
    assert.equal(pingReq.headers.authorization, `Bearer ${expected}`);
    assert.equal(pingReq.headers['x-bridge-key-id'], '2026-10-a');
    // The adapter's own derivation must match the independent derivation.
    assert.equal(await deriveBridgeToken('test-master-secret', 'tenant-a'), expected);
    await out.adapter.disconnect();
  } finally { await mock.close(); }
});

test('B2: bridge 401 at connect → ServerError(auth_denied), fail-closed, no retry', async () => {
  const { readHerdrBridgeConfig, connectSession, ServerError } = await loadAdapter();
  const mock = await startMockBridge();
  try {
    // Wrong secret on the Worker side: the bridge's 401 must surface, not retry.
    const env = makeEnv(mock, { masterSecret: 'wrong-secret' });
    await assert.rejects(
      connectSession({ config: readHerdrBridgeConfig(env), tenantId: 'tenant-a', roomId: 'room-x', env, pins: TEST_PINS }),
      (e) => e instanceof ServerError && e.code === 'auth_denied',
    );
    assert.equal(mock.state.requests.filter((r) => r.route === '/v1/ping').length, 1);
  } finally { await mock.close(); }
});

// ---------------------------------------------------------------------------
// C. Version pinning — connect-time assert, fail closed
// ---------------------------------------------------------------------------

test('C1: protocol version mismatch → VersionMismatchError, observer called', async () => {
  const { readHerdrBridgeConfig, connectSession, VersionMismatchError } = await loadAdapter();
  const mock = await startMockBridge({ protocolVersion: 23 });
  try {
    const env = makeEnv(mock);
    let observed = null;
    await assert.rejects(
      connectSession({ config: readHerdrBridgeConfig(env), tenantId: 'tenant-a', roomId: 'room-x', env, pins: TEST_PINS, onVersionMismatch: (i) => { observed = i; } }),
      (e) => e instanceof VersionMismatchError,
    );
    assert.ok(observed, 'onVersionMismatch observer must fire');
    assert.equal(observed.observedProtocolVersion, 23);
    assert.equal(observed.pinnedProtocolVersion, 22);
  } finally { await mock.close(); }
});

test('C2: binary version mismatch → VersionMismatchError', async () => {
  const { readHerdrBridgeConfig, connectSession, VersionMismatchError } = await loadAdapter();
  const mock = await startMockBridge({ version: 'herdr-9.9.9' });
  try {
    const env = makeEnv(mock);
    await assert.rejects(
      connectSession({ config: readHerdrBridgeConfig(env), tenantId: 'tenant-a', roomId: 'room-x', env, pins: TEST_PINS }),
      (e) => e instanceof VersionMismatchError,
    );
  } finally { await mock.close(); }
});

test('C3: missing core method in advertised list → VersionMismatchError', async () => {
  const { readHerdrBridgeConfig, connectSession, VersionMismatchError } = await loadAdapter();
  const mock = await startMockBridge({ methods: ALL_BRIDGE_METHODS.filter((m) => m !== 'send') });
  try {
    const env = makeEnv(mock);
    await assert.rejects(
      connectSession({ config: readHerdrBridgeConfig(env), tenantId: 'tenant-a', roomId: 'room-x', env, pins: TEST_PINS }),
      (e) => e instanceof VersionMismatchError && /sendText/.test(e.message),
    );
  } finally { await mock.close(); }
});

test('C4: placeholder pins → VersionMismatchError without contacting the bridge', async () => {
  const { readHerdrBridgeConfig, connectSession, VersionMismatchError } = await loadAdapter();
  const mock = await startMockBridge();
  try {
    const env = makeEnv(mock);
    const pins = { ...TEST_PINS, herdrVersion: 'TBD-pin-by-B13' };
    await assert.rejects(
      connectSession({ config: readHerdrBridgeConfig(env), tenantId: 'tenant-a', roomId: 'room-x', env, pins }),
      (e) => e instanceof VersionMismatchError && e.code === 'pins_unconfigured',
    );
    assert.equal(mock.state.requests.length, 0, 'no bridge contact with unconfigured pins');
  } finally { await mock.close(); }
});

test('C5: matching pins → connected; protocolVersion getter; supports() gating', async () => {
  const { readHerdrBridgeConfig, connectSession } = await loadAdapter();
  const mock = await startMockBridge();
  try {
    const env = makeEnv(mock);
    const out = await connectSession({ config: readHerdrBridgeConfig(env), tenantId: 'tenant-a', roomId: 'room-x', env, pins: TEST_PINS });
    assert.equal(out.backend, 'herdr');
    assert.equal(out.adapter.protocolVersion, 22);
    assert.equal(out.adapter.herdrVersion, 'herdr-0.14.2');
    assert.equal(out.adapter.backend, 'herdr-bridge');
    assert.ok(out.adapter.supports('spawnAgent'));
    assert.ok(!out.adapter.supports('worktree.create'));
    await out.adapter.disconnect();
  } finally { await mock.close(); }
});

// ---------------------------------------------------------------------------
// D. Connect resilience — a down broker must not block claiming
// ---------------------------------------------------------------------------

test('D1: bridge unreachable at connect → legacy fallback, no throw', async () => {
  const { readHerdrBridgeConfig, connectSession } = await loadAdapter();
  const mock = await startMockBridge();
  const deadUrl = mock.url;
  await mock.close(); // nothing listening anymore
  const env = {
    ROOM_HERDR_SESSIONS: 'on',
    HERDR_ROUTE_TABLE: JSON.stringify({ version: 1, defaultDeny: true, bridges: { 'host-1': { url: deadUrl, keyId: 'k', methods: [...ALL_BRIDGE_METHODS], tenants: ['tenant-a'] } } }),
    BRIDGE_MASTER_SECRET: 'test-master-secret',
  };
  const out = await connectSession({ config: readHerdrBridgeConfig(env), tenantId: 'tenant-a', roomId: 'room-x', env, pins: TEST_PINS });
  assert.equal(out.backend, 'legacy');
  assert.equal(out.reason, 'bridge_unreachable');
});

test('D2: bridge 500s every ping → legacy fallback after the retry budget', async () => {
  const { readHerdrBridgeConfig, connectSession } = await loadAdapter();
  const mock = await startMockBridge({ failTimes: { '/v1/ping': 99 } });
  try {
    const env = makeEnv(mock);
    let fallback = null;
    const out = await connectSession({
      config: readHerdrBridgeConfig(env), tenantId: 'tenant-a', roomId: 'room-x', env, pins: TEST_PINS,
      onFallback: (f) => { fallback = f; },
    });
    assert.equal(out.backend, 'legacy');
    assert.equal(out.reason, 'bridge_unreachable');
    assert.ok(fallback && fallback.reason === 'bridge_unreachable', 'onFallback alert hook must fire');
    const pings = mock.state.requests.filter((r) => r.route === '/v1/ping').length;
    assert.ok(pings >= 1 && pings <= 3, `ping retried within budget, got ${pings}`);
  } finally { await mock.close(); }
});

// ---------------------------------------------------------------------------
// E. Transport semantics — retries, exactly-once writes, no-retry errors
// ---------------------------------------------------------------------------

async function connectedAdapter(t, mock, opts = {}) {
  const { readHerdrBridgeConfig, connectSession } = await import(ADAPTER_PATH);
  const env = makeEnv(mock, opts.envOpts);
  const out = await connectSession({
    config: readHerdrBridgeConfig(env), tenantId: 'tenant-a', roomId: 'room-x', env,
    pins: TEST_PINS, breakerStore: new Map(), ...opts.connectOpts,
  });
  assert.equal(out.backend, 'herdr', `expected herdr backend, got ${out.backend}:${out.reason}`);
  t.after(async () => { await out.adapter.disconnect().catch(() => {}); });
  return { adapter: out.adapter, env };
}

test('E1: idempotent read retries transient 500s, then succeeds', async (t) => {
  const mock = await startMockBridge({ failTimes: { '/v1/read': 2 } });
  try {
    const { adapter } = await connectedAdapter(t, mock);
    const pt = await adapter.readPane('pane-1', 'recent');
    assert.equal(pt.text, 'hello');
    assert.equal(mock.state.requests.filter((r) => r.route === '/v1/read').length, 3);
  } finally { await mock.close(); }
});

test('E2: write retried after a dropped connection reuses the idempotency key — exactly once', async (t) => {
  const mock = await startMockBridge({ dropTimes: { '/v1/send': 1 } });
  try {
    const { adapter } = await connectedAdapter(t, mock);
    const res = await adapter.sendText('agent-1', 'hello');
    assert.equal(res.ok, true);
    const sends = mock.state.requests.filter((r) => r.route === '/v1/send');
    assert.equal(sends.length, 2, 'one dropped attempt + one retry');
    assert.ok(sends[0].headers['x-idempotency-key'], 'retry must carry an idempotency key');
    assert.equal(sends[0].headers['x-idempotency-key'], sends[1].headers['x-idempotency-key'], 'same key on retry');
    assert.equal(mock.state.execCount, 1, 'bridge dedupe: executed exactly once');
  } finally { await mock.close(); }
});

test('E3: 4xx on a write is never retried', async (t) => {
  const mock = await startMockBridge({ forceStatus: { '/v1/send': 400 } });
  try {
    const { adapter } = await connectedAdapter(t, mock);
    const { ServerError } = await import(ADAPTER_PATH);
    await assert.rejects(adapter.sendText('agent-1', 'x'), (e) => e instanceof ServerError);
    assert.equal(mock.state.requests.filter((r) => r.route === '/v1/send').length, 1);
  } finally { await mock.close(); }
});

test('E4: occupant_changed surfaces as OccupantChangedError, single attempt', async (t) => {
  const mock = await startMockBridge({ errorBody: { '/v1/send': { error: { code: 'occupant_changed', message: 'occupant moved' } } } });
  try {
    const { adapter } = await connectedAdapter(t, mock);
    const { OccupantChangedError } = await import(ADAPTER_PATH);
    await assert.rejects(
      adapter.sendText({ id: 'agent-1', paneId: 'pane-1', occupantId: 'occ-stale' }, 'x'),
      (e) => e instanceof OccupantChangedError,
    );
    assert.equal(mock.state.requests.filter((r) => r.route === '/v1/send').length, 1, 'typed errors are never retried');
  } finally { await mock.close(); }
});

test('E5: waitForState exceeding its timeout → TimeoutError', async (t) => {
  const mock = await startMockBridge({ waitDelayMs: 2000 });
  try {
    const { adapter } = await connectedAdapter(t, mock);
    const { TimeoutError } = await import(ADAPTER_PATH);
    await assert.rejects(
      adapter.waitForState('agent-1', ['done'], { timeoutMs: 400 }),
      (e) => e instanceof TimeoutError,
    );
  } finally { await mock.close(); }
});

test('E6: calls after disconnect → TransportError(not_connected)', async (t) => {
  const mock = await startMockBridge();
  try {
    const { adapter } = await connectedAdapter(t, mock);
    const { TransportError } = await import(ADAPTER_PATH);
    await adapter.disconnect();
    await adapter.disconnect(); // idempotent
    await assert.rejects(adapter.ping(), (e) => e instanceof TransportError && e.code === 'not_connected');
  } finally { await mock.close(); }
});

// ---------------------------------------------------------------------------
// F. Circuit breaker — fail fast, legacy for new sessions
// ---------------------------------------------------------------------------

test('F1: 5 consecutive failures open the breaker; new sessions fall back to legacy', async (t) => {
  const mock = await startMockBridge({ failTimes: { '/v1/read': 999, '/v1/ping': 999 } });
  try {
    const { readHerdrBridgeConfig, connectSession, TransportError, ServerError } = await import(ADAPTER_PATH);
    const breakerStore = new Map();
    const env = makeEnv(mock);
    const config = readHerdrBridgeConfig(env);
    // Connect against a healthy ping first: temporarily allow ping through.
    mock.state.failTimes['/v1/ping'] = 0;
    const out = await connectSession({ config, tenantId: 'tenant-a', roomId: 'room-x', env, pins: TEST_PINS, breakerStore, circuitOpenMs: 120_000 });
    assert.equal(out.backend, 'herdr');
    const { adapter } = out;
    t.after(async () => { await adapter.disconnect().catch(() => {}); });
    // 5 failed reads trip the breaker (each read exhausts its retry budget).
    // The mock's 500s carry a typed error body → ServerError, which is the
    // correct taxonomy mapping ("backend returned an error payload").
    for (let i = 0; i < 5; i++) {
      await assert.rejects(adapter.readPane('pane-1', 'recent'), (e) => e instanceof TransportError || e instanceof ServerError);
    }
    const before = mock.state.requests.length;
    await assert.rejects(
      adapter.readPane('pane-1', 'recent'),
      (e) => e instanceof TransportError && e.code === 'bridge_circuit_open',
    );
    assert.equal(mock.state.requests.length, before, 'open breaker makes no bridge calls');
    // New sessions for this bridge's tenants fall back to legacy at connect().
    const again = await connectSession({ config, tenantId: 'tenant-a', roomId: 'room-x', env, pins: TEST_PINS, breakerStore, circuitOpenMs: 120_000 });
    assert.equal(again.backend, 'legacy');
    assert.equal(again.reason, 'circuit_open');
  } finally { await mock.close(); }
});

test('F2: half-open probe success closes the breaker', async (t) => {
  const mock = await startMockBridge({ failTimes: { '/v1/read': 999 } });
  try {
    const { readHerdrBridgeConfig, connectSession, TransportError, ServerError } = await import(ADAPTER_PATH);
    const breakerStore = new Map();
    const env = makeEnv(mock);
    const config = readHerdrBridgeConfig(env);
    const out = await connectSession({ config, tenantId: 'tenant-a', roomId: 'room-x', env, pins: TEST_PINS, breakerStore, circuitOpenMs: 150 });
    assert.equal(out.backend, 'herdr');
    const { adapter } = out;
    t.after(async () => { await adapter.disconnect().catch(() => {}); });
    for (let i = 0; i < 5; i++) {
      await assert.rejects(adapter.readPane('pane-1', 'recent'), (e) => e instanceof TransportError || e instanceof ServerError);
    }
    await assert.rejects(adapter.readPane('pane-1', 'recent'), (e) => e.code === 'bridge_circuit_open');
    await new Promise((r) => setTimeout(r, 200)); // pass the half-open window
    mock.state.failTimes['/v1/read'] = 0;          // bridge recovers
    const pong = await adapter.ping();             // the single half-open probe
    assert.equal(pong.ok, true);
    const pt = await adapter.readPane('pane-1', 'recent'); // normal traffic resumes
    assert.equal(pt.text, 'hello');
  } finally { await mock.close(); }
});

// ---------------------------------------------------------------------------
// G. Subscribe / SSE — adapter-owned events_lost recovery
// ---------------------------------------------------------------------------

function sseFrames(...frames) {
  return frames.map((f) => {
    if (typeof f === 'string') return `${f}\n\n`;
    const ev = f.event ? `event: ${f.event}\n` : '';
    return `${ev}data: ${JSON.stringify(f.data)}\n\n`;
  }).join('');
}

test('G1: subscribe dispatches matching events to the handler', async (t) => {
  const mock = await startMockBridge({
    // Steady-state stream: two events, then heartbeats, held open until the
    // subscriber goes away. A clean server close would (correctly) trigger a
    // resubscribe, so the steady-state mock must not end the stream.
    onEvents: ({ res, req }) => new Promise((resolve) => {
      res.write(sseFrames(
        { data: { seq: 1, type: 'pane.agent_status_changed', agentId: 'agent-1', state: 'blocked' } },
        { data: { seq: 2, type: 'pane.output', paneId: 'pane-9' } },
      ));
      const beat = setInterval(() => { try { res.write(': heartbeat\n\n'); } catch { /* closed */ } }, 150);
      req.on('close', () => { clearInterval(beat); resolve(); });
    }),
  });
  try {
    const { adapter } = await connectedAdapter(t, mock, { connectOpts: { heartbeatTimeoutMs: 500 } });
    const seen = [];
    const sub = await adapter.subscribe(['pane.agent_status_changed'], (ev) => seen.push(ev), {});
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(seen.length, 1);
    assert.equal(seen[0].state, 'blocked');
    assert.ok(sub.active);
    await sub.close();
    assert.ok(!sub.active);
  } finally { await mock.close(); }
});

test('G2: events_lost → re-snapshot → onReconcile → resubscribe with cursor', async (t) => {
  const mock = await startMockBridge({
    onEvents: async ({ req, res, url, state }) => {
      const n = state.eventConnections;
      if (n === 1) {
        res.write(sseFrames(
          { data: { seq: 1, type: 'pane.agent_status_changed', agentId: 'agent-1', state: 'working' } },
          { data: { seq: 2, type: 'pane.output', paneId: 'pane-1' } },
          { event: 'events_lost', data: { lostCount: 3, lastSeq: 2 } },
        ));
        res.end();
        return;
      }
      // Second connection: record the cursor, deliver one event, then hold the
      // stream open with heartbeats (a clean close would trigger another
      // recovery cycle, which is correct behavior but not what this test
      // measures).
      state.secondEventsSince = url.searchParams.get('since');
      res.write(sseFrames({ data: { seq: 3, type: 'pane.agent_status_changed', agentId: 'agent-1', state: 'done' } }));
      const beat = setInterval(() => { try { res.write(': heartbeat\n\n'); } catch { /* closed */ } }, 150);
      await new Promise((resolve) => { req.on('close', () => { clearInterval(beat); resolve(); }); });
      return;
    },
  });
  try {
    const { adapter } = await connectedAdapter(t, mock, { connectOpts: { heartbeatTimeoutMs: 800 } });
    const seen = [];
    let reconciled = null;
    const sub = await adapter.subscribe(['*'], (ev) => seen.push(ev), {
      onReconcile: (snapshot, lostCount) => { reconciled = { snapshot, lostCount }; },
    });
    await new Promise((r) => setTimeout(r, 900));
    assert.ok(reconciled, 'onReconcile must fire after events_lost');
    assert.equal(reconciled.lostCount, 3);
    assert.deepEqual(reconciled.snapshot, { version: 1, workspaces: [] });
    assert.ok(mock.state.requests.some((r) => r.route === '/v1/snapshot'), 'adapter re-snapshots through the same bridge');
    assert.equal(mock.state.eventConnections, 2, 'adapter resubscribes');
    assert.equal(mock.state.secondEventsSince, '2', 'resubscribe carries the since cursor');
    assert.ok(seen.some((e) => e.seq === 3 && e.state === 'done'), 'post-recovery events flow');
    assert.ok(sub.active, 'subscription stays active across recovery');
    await sub.close();
  } finally { await mock.close(); }
});

test('G3: unrecoverable stream death surfaces SubscriptionLostError and closes the sub', async (t) => {
  const mock = await startMockBridge({
    failTimes: { '/v1/read': 999 },
    onEvents: async ({ res }) => { res.write(': hi\n\n'); res.destroy(); },
  });
  try {
    const { readHerdrBridgeConfig, connectSession, TransportError, ServerError, SubscriptionLostError } = await import(ADAPTER_PATH);
    const breakerStore = new Map();
    const env = makeEnv(mock);
    const config = readHerdrBridgeConfig(env);
    const out = await connectSession({ config, tenantId: 'tenant-a', roomId: 'room-x', env, pins: TEST_PINS, breakerStore, circuitOpenMs: 120_000, heartbeatTimeoutMs: 200 });
    assert.equal(out.backend, 'herdr');
    const { adapter } = out;
    t.after(async () => { await adapter.disconnect().catch(() => {}); });
    // Trip the breaker so recovery cannot resubscribe (500s carry typed bodies → ServerError).
    for (let i = 0; i < 5; i++) {
      await assert.rejects(adapter.readPane('p', 'recent'), (e) => e instanceof TransportError || e instanceof ServerError);
    }
    let lost = null;
    const sub = await adapter.subscribe(['*'], () => {}, { onSubscriptionLost: (e) => { lost = e; } });
    await new Promise((r) => setTimeout(r, 700));
    assert.ok(lost instanceof SubscriptionLostError, 'bridge down past the window → SubscriptionLostError');
    assert.ok(!sub.active, 'dead subscription is closed; caller re-connect()s (may select legacy)');
  } finally { await mock.close(); }
});

// ---------------------------------------------------------------------------
// H. Route-auth method allowlist — deny by default, before any bridge call
// ---------------------------------------------------------------------------

test('H1: method not in the route entry allowlist → MethodUnsupportedError, no bridge call', async (t) => {
  const mock = await startMockBridge();
  try {
    const { adapter } = await connectedAdapter(t, mock, { envOpts: { methods: ALL_BRIDGE_METHODS.filter((m) => m !== 'keys') } });
    const { MethodUnsupportedError } = await import(ADAPTER_PATH);
    await assert.rejects(adapter.sendKeys('agent-1', ['Enter']), (e) => e instanceof MethodUnsupportedError);
    assert.equal(mock.state.requests.filter((r) => r.route === '/v1/keys').length, 0);
  } finally { await mock.close(); }
});

// ---------------------------------------------------------------------------
// I. Spawn / report request shapes — the body contract B3 implements
// ---------------------------------------------------------------------------

test('I1: spawnAgent posts adapter-constructed argv fields + idempotency key', async (t) => {
  const mock = await startMockBridge();
  try {
    const { adapter } = await connectedAdapter(t, mock);
    const handle = await adapter.spawnAgent({
      kind: 'claude', command: 'claude', args: ['--dangerously-skip-permissions'],
      cwd: '/tmp/w', workspace: 'ws', tab: 't', title: 'lane',
      resumeSessionRef: 'sess-1', resumeCommand: ['claude', '--resume', 'sess-1'],
      metadata: { lane: 'grokbot' },
    });
    assert.deepEqual(handle, { id: 'agent-1', paneId: 'pane-1', occupantId: 'occ-1' });
    const req = mock.state.requests.find((r) => r.route === '/v1/spawn');
    assert.equal(req.body.command, 'claude');
    assert.deepEqual(req.body.args, ['--dangerously-skip-permissions']);
    assert.deepEqual(req.body.resumeCommand, ['claude', '--resume', 'sess-1']);
    assert.equal(req.body.resumeSessionRef, 'sess-1');
    assert.ok(req.headers['x-idempotency-key'], 'writes carry idempotency keys');
  } finally { await mock.close(); }
});

test('I2: spawnAgent rejects oversized resumeCommand locally, without a bridge call', async (t) => {
  const mock = await startMockBridge();
  try {
    const { adapter } = await connectedAdapter(t, mock);
    await assert.rejects(
      adapter.spawnAgent({ command: 'claude', resumeCommand: Array.from({ length: 65 }, (_, i) => `a${i}`) }),
      /64/,
    );
    assert.equal(mock.state.requests.filter((r) => r.route === '/v1/spawn').length, 0);
  } finally { await mock.close(); }
});

test('I3: reportState/reportResume/reportMetadata → POST /v1/report with report kind', async (t) => {
  const mock = await startMockBridge();
  try {
    const { adapter } = await connectedAdapter(t, mock);
    await adapter.reportState('pane-1', 'blocked', 'waiting on review');
    await adapter.reportResume('pane-1', { sessionRef: 'sess-1', resumeCommand: ['claude', '--resume', 'sess-1'] });
    await adapter.reportMetadata('pane-1', { lane: 'grokbot' }, { ttlMs: 60000 });
    const reports = mock.state.requests.filter((r) => r.route === '/v1/report');
    assert.equal(reports.length, 3);
    assert.deepEqual(reports.map((r) => r.body.report), ['state', 'resume', 'metadata']);
    assert.equal(reports[0].body.state, 'blocked');
    assert.equal(reports[0].body.detail, 'waiting on review');
    assert.deepEqual(reports[1].body.ref, { sessionRef: 'sess-1', resumeCommand: ['claude', '--resume', 'sess-1'] });
    assert.deepEqual(reports[2].body.meta, { lane: 'grokbot' });
    assert.equal(reports[2].body.ttlMs, 60000);
  } finally { await mock.close(); }
});

test('I4: listAgents/getAgent/closePane/readPane map to /v1/list, /v1/close, /v1/read', async (t) => {
  const mock = await startMockBridge();
  try {
    const { adapter } = await connectedAdapter(t, mock);
    const agents = await adapter.listAgents();
    assert.deepEqual(agents, []);
    const agent = await adapter.getAgent('agent-1');
    assert.equal(agent.state, 'working');
    await adapter.closePane('pane-1');
    const pt = await adapter.readPane('pane-1', 'recent', { lines: 50 });
    assert.equal(pt.lines.length, 1);
    const listReqs = mock.state.requests.filter((r) => r.route === '/v1/list');
    assert.deepEqual(listReqs.map((r) => r.body.op), ['list', 'get']);
    assert.equal(listReqs[1].body.agentId, 'agent-1');
    const readReq = mock.state.requests.find((r) => r.route === '/v1/read');
    assert.equal(readReq.body.source, 'recent');
    assert.equal(readReq.body.lines, 50);
  } finally { await mock.close(); }
});

// ---------------------------------------------------------------------------
// J. Worker safety — no Node builtins in the shipped module
// ---------------------------------------------------------------------------

test('J1: adapter module stays Worker-safe (no node: imports, no require, no process.env)', async () => {
  const src = readFileSync(new URL(ADAPTER_PATH, import.meta.url), 'utf8');
  assert.ok(!/from\s+['"]node:/.test(src), 'no node: imports');
  assert.ok(!/\brequire\s*\(/.test(src), 'no require()');
  assert.ok(!/process\.env/.test(src), 'no process.env — config is injected');
  assert.ok(!/net\.createConnection|child_process|node:http/.test(src), 'no socket/subprocess APIs');
  const imports = [...src.matchAll(/^import\s+.*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
  for (const i of imports) {
    assert.ok(i.startsWith('.') || i === '../session-adapter.mjs', `unexpected import: ${i}`);
  }
});

// K. Public wait and error contracts: real HTTP/SSE transport, no adapter internals.
test('K1: output wait preserves regex flags, repeats unmatched rounds with one key, and returns the matching line', async t => {
  let rounds = 0;
  const mock = await startMockBridge({ handlers: { '/v1/wait': ({ send }) => send(200,
    ++rounds === 1 ? { matched: false } : { matched: true, matchedLine: 'READY 42' }) } });
  try {
    const { adapter } = await connectedAdapter(t, mock);
    assert.deepEqual(await adapter.waitForOutput('pane-1', /ready \d+/i, { timeoutMs: 1000 }),
      { paneId: 'pane-1', matched: 'READY 42' });
    const requests = mock.state.requests.filter(r => r.route === '/v1/wait');
    assert.equal(requests.length, 2);
    for (const r of requests) {
      assert.equal(r.body.mode, 'output'); assert.equal(r.body.paneId, 'pane-1');
      assert.equal(r.body.pattern, 'ready \\d+'); assert.equal(r.body.flags, 'i');
      assert.ok(r.body.timeoutMs > 0 && r.body.timeoutMs <= 1000);
    }
    assert.ok(requests[0].headers['x-idempotency-key']);
    assert.equal(requests[0].headers['x-idempotency-key'], requests[1].headers['x-idempotency-key']);
    assert.deepEqual(await adapter.waitForOutput('pane-1', 'READY', { timeoutMs: 1000 }),
      { paneId: 'pane-1', matched: 'READY 42' });
    assert.equal(mock.state.requests.at(-1).body.flags, '');
  } finally { await mock.close(); }
});

test('K2: invalid waits, exhausted deadlines and already aborted calls make no bridge writes', async t => {
  const mock = await startMockBridge();
  try {
    const { adapter } = await connectedAdapter(t, mock);
    const before = mock.state.requests.length;
    for (const [call, pattern] of [
      [() => adapter.waitForOutput('', /x/, { timeoutMs: 100 }), /paneId is required/],
      [() => adapter.waitForOutput('p', /x/), /timeoutMs/],
      [() => adapter.waitForOutput('p', /x/, { timeoutMs: 0 }), /timed out/],
      [() => adapter.waitForState('a', [], { timeoutMs: 100 }), /non-empty array/],
      [() => adapter.waitForState('a', ['done']), /timeoutMs/],
      [() => adapter.waitForState('a', ['done'], { timeoutMs: 0 }), /timed out/],
      [() => adapter.waitForState('a', ['done'], { timeoutMs: 100, signal: AbortSignal.abort() }), /aborted/],
      [() => adapter.waitForEvent({ type: 'done' }), /timeoutMs/],
    ]) await assert.rejects(call(), pattern);
    assert.equal(mock.state.requests.length, before);
  } finally { await mock.close(); }
});

function heldEventFrames(frames) {
  return ({ req, res }) => new Promise(resolve => {
    res.write(sseFrames(...frames.map(data => ({ data }))));
    req.on('close', resolve);
  });
}

test('K3: event wait filters type, agent and pane, closes its dedicated subscription, and tolerates a throwing predicate', async t => {
  const frames = [
    { seq: 1, type: 'other', agentId: 'a', paneId: 'p' },
    { seq: 2, type: 'done', agentId: 'other', paneId: 'p' },
    { seq: 3, type: 'done', agentId: 'a', paneId: 'other' },
    { seq: 4, type: 'done', agentId: 'a', paneId: 'p' },
  ];
  const events = [];
  const mock = await startMockBridge({ onEvents: heldEventFrames(frames) });
  try {
    const { adapter } = await connectedAdapter(t, mock, { connectOpts: { onEvent: e => events.push(e) } });
    const result = await adapter.waitForEvent({ type: 'done', agentId: 'a', paneId: 'p' }, { timeoutMs: 1000 });
    assert.equal(result.seq, 4);
    assert.ok(events.some(e => e.type === 'subscription_closed'));
    assert.equal((await adapter.waitForEvent(e => {
      if (e.seq === 1) throw new Error('predicate failure');
      return e.seq === 2;
    }, { timeoutMs: 1000 })).seq, 2);
  } finally { await mock.close(); }
});

test('K4: event timeout and forbidden event route reject and leave no live subscription', async t => {
  const mock = await startMockBridge({ onEvents: heldEventFrames([{ seq: 1, type: 'other' }]) });
  try {
    const { adapter } = await connectedAdapter(t, mock);
    await assert.rejects(adapter.waitForEvent({ type: 'missing' }, { timeoutMs: 30 }), /timed out/);
    const limited = await connectedAdapter(t, mock, { envOpts: { methods: ['ping'] } });
    const before = mock.state.requests.length;
    await assert.rejects(limited.adapter.waitForEvent({ type: 'done' }, { timeoutMs: 100 }), /method/i);
    assert.equal(mock.state.requests.length, before);
  } finally { await mock.close(); }
});

test('K5: snapshot is authenticated and disconnect closes an active subscription', async t => {
  const mock = await startMockBridge({ onEvents: heldEventFrames([{ seq: 1, type: 'ping' }]) });
  try {
    const { adapter } = await connectedAdapter(t, mock);
    assert.equal(adapter.tenantId, 'tenant-a'); assert.equal(adapter.bridgeId, 'host-1');
    assert.deepEqual(await adapter.snapshot(), { version: 1, workspaces: [] });
    const sub = await adapter.subscribe(['*'], () => {});
    assert.equal(sub.active, true);
    await adapter.disconnect();
    assert.equal(sub.active, false);
    await assert.rejects(adapter.snapshot(), /not connected/);
  } finally { await mock.close(); }
});

test('K6: wire errors retain taxonomy and never replay a rejected write', async t => {
  const mock = await startMockBridge();
  try {
    const { adapter } = await connectedAdapter(t, mock);
    for (const [status, body, code] of [
      [200, 'not json', 'invalid_response'], [401, '', 'auth_denied'],
      [403, '', 'auth_denied'], [404, '', 'method_unsupported'],
      [429, '', 'bridge_rate_limited'], [500, '', 'bridge_server_error'],
      [400, '', 'invalid_request'],
      [200, JSON.stringify({ error: { code: 'version_mismatch', message: 'wrong version' } }), 'version_mismatch'],
      [200, JSON.stringify({ error: { code: 'method_unsupported', message: 'missing method' } }), 'method_unsupported'],
    ]) {
      mock.state.handlers['/v1/send'] = ({ res }) => { res.writeHead(status); res.end(body); };
      const before = mock.state.requests.length;
      await assert.rejects(adapter.sendText('a', 'hello'), e => e.code === code);
      const attempts = mock.state.requests.slice(before);
      assert.equal(attempts.length, status === 500 ? 2 : 1, `bounded attempts for ${status}/${code}`);
      if (status === 500) assert.equal(attempts[0].headers['x-idempotency-key'], attempts[1].headers['x-idempotency-key']);
    }
  } finally { await mock.close(); }
});
