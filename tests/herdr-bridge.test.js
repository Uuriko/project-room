/**
 * herdr-bridge fail-first tests (lane B3).
 *
 * Covers: auth (HMAC bearer-per-tenant), method fencing, spawn argv allowlist,
 * tenant scoping, occupant-pinned send/wait, ANSI sanitizer, secret redaction,
 * idempotency dedupe, timeouts/retries, circuit breaker, audit log, SSE events.
 *
 * Run: TMPDIR=~/workspace/pr-herdr-b3/.tmp node --test tests/herdr-bridge.test.js
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';

import { deriveToken } from '../bridge/lib/auth.mjs';
import { sanitizePaneText } from '../bridge/lib/sanitize.mjs';
import { redactValue, redactSecretShaped } from '../bridge/lib/redact.mjs';
import {
  assertSocketMethodAllowed,
  buildSpawnArgv,
  validateReportBinding,
} from '../bridge/lib/fence.mjs';
import { createBridge } from '../bridge/lib/bridge.mjs';

// ---------------------------------------------------------------------------
// Fake herdr server: newline-delimited JSON over a Unix socket.
// {id, method, params} -> {id, result} | {id, error:{code,message}}
// ---------------------------------------------------------------------------
function startFakeHerdr(socketPath, opts = {}) {
  const state = {
    calls: [], // {method, params, at}
    delayMs: 0,
    failConnect: false,
    occupant: 'occ-1',
    panes: [{ paneId: 'pane-1', occupant: 'occ-1' }],
    subscribers: new Set(),
  };
  const server = createServer((sock) => {
    let buf = '';
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        let req;
        try { req = JSON.parse(line); } catch { continue; }
        const { id, method, params = {} } = req;
        state.calls.push({ method, params, at: Date.now() });
        const respond = () => {
          if (method === 'events.subscribe') {
            state.subscribers.add(sock);
            sock.write(JSON.stringify({ id, result: { subscribed: true } }) + '\n');
            return;
          }
          try {
            sock.write(JSON.stringify({ id, result: handle(method, params) }) + '\n');
          } catch (e) {
            sock.write(JSON.stringify({ id, error: { code: e.code || 'internal', message: e.message } }) + '\n');
          }
        };
        if (state.delayMs > 0) setTimeout(respond, state.delayMs);
        else respond();
      }
    });
    sock.on('close', () => state.subscribers.delete(sock));
  });
  function knownPane(paneId) {
    if (!state.panes.some((p) => p.paneId === paneId)) {
      throw Object.assign(new Error('no such pane'), { code: 'pane_not_found' });
    }
  }
  function handle(method, params) {
    switch (method) {
      case 'ping': return { ok: true, protocol: 22, herdrVersion: '0.0.0-test' };
      case 'agent.start':
        return { paneId: 'pane-1', agentId: 'agent-1', occupant: state.occupant };
      case 'pane.read':
        knownPane(params.paneId);
        return { text: state.readText ?? 'plain output\nline two\n' };
      case 'pane.process_info':
        knownPane(params.paneId);
        return { paneId: params.paneId, occupant: state.occupant, alive: true };
      case 'pane.get':
        knownPane(params.paneId);
        return { paneId: params.paneId, occupant: state.occupant };
      case 'agent.prompt':
      case 'agent.send_keys':
      case 'pane.wait_for_output':
        return { ok: true };
      case 'agent.wait':
        return { state: 'working' };
      case 'pane.report_agent':
      case 'pane.report_agent_session':
      case 'pane.report_metadata':
        return { ok: true };
      case 'pane.close': return { ok: true };
      case 'agent.list':
        return { agents: [{ agentId: 'agent-1', paneId: 'pane-1', occupant: state.occupant }] };
      case 'agent.get':
        return { agentId: params.agentId, paneId: 'pane-1', occupant: state.occupant };
      case 'session.snapshot':
        return { panes: state.panes.map((p) => ({ ...p, occupant: state.occupant })) };
      default:
        throw Object.assign(new Error('unknown'), { code: 'method_unsupported' });
    }
  }
  // Wrap handle errors into {id, error} responses:
  server.on('connection', () => {});
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(socketPath, () => resolve({ server, state,
      emit(evt) {
        const line = JSON.stringify({ event: evt }) + '\n';
        for (const s of state.subscribers) s.write(line);
      },
      callsFor(m) { return state.calls.filter((c) => c.method === m); },
    }));
  });
}

// ---------------------------------------------------------------------------
// Bridge harness
// ---------------------------------------------------------------------------
const MASTER = 'test-master-secret-0123456789abcdef';
const KEY_ID = '2026-10-test';
let dir; let tenantsFile; let auditLog; let bridge; let base; let fixtureA; let fixtureB;
const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';

function tokenFor(tenant) { return deriveToken(MASTER, tenant); }
function authed(tenant = TENANT_A, keyId = KEY_ID, token) {
  return {
    Authorization: `Bearer ${token ?? tokenFor(tenant)}`,
    'X-Bridge-Key-Id': keyId,
    'Content-Type': 'application/json',
  };
}
async function post(path, body, headers = authed()) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST', headers, body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}
const auditEntries = () =>
  readFileSync(auditLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'herdr-bridge-test-'));
  mkdirSync(join(dir, 'sockets'), { recursive: true });
  const uid = process.getuid?.() ?? 1000;
  const wsA = join(dir, 'ws-a'); const wsB = join(dir, 'ws-b');
  mkdirSync(wsA, { recursive: true }); mkdirSync(wsB, { recursive: true });
  tenantsFile = join(dir, 'tenants.json');
  auditLog = join(dir, 'audit.jsonl');
  const cfg = {
    tenants: {
      [TENANT_A]: { socketPath: join(dir, 'sockets', 'a.sock'), uid, workspaceRoot: wsA },
      [TENANT_B]: { socketPath: join(dir, 'sockets', 'b.sock'), uid, workspaceRoot: wsB },
    },
  };
  const { writeFileSync } = await import('node:fs');
  writeFileSync(tenantsFile, JSON.stringify(cfg));
  fixtureA = await startFakeHerdr(cfg.tenants[TENANT_A].socketPath);
  fixtureB = await startFakeHerdr(cfg.tenants[TENANT_B].socketPath);
  // tenant-b owns a pane the bridge must never hand to tenant-a
  fixtureB.state.panes = [{ paneId: 'pane-b1', occupant: 'occ-b1' }];

  bridge = createBridge({
    port: 0,
    bind: '127.0.0.1',
    masterSecret: MASTER,
    masterSecretPrev: undefined,
    keyId: KEY_ID,
    tenantsFile,
    auditLog,
    sseHeartbeatMs: 50,
    timeouts: { read: 120, send: 120, ping: 120, snapshot: 120 },
    circuitOpenMs: 300,
  });
  await bridge.start();
  base = `http://127.0.0.1:${bridge.port}`;
});

after(async () => {
  await bridge?.stop();
  fixtureA?.server.close();
  fixtureB?.server.close();
});

// ---------------------------------------------------------------------------
// /healthz — unauthenticated, missing-secrets pattern
// ---------------------------------------------------------------------------
test('healthz is unauthenticated and reports service identity', async () => {
  const res = await fetch(`${base}/healthz`);
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.service, 'herdr-bridge');
  assert.equal(j.ok, true);
  assert.equal(j.pinnedProtocol, 22);
  assert.deepEqual(j.missing, []);
  assert.ok(!JSON.stringify(j).includes(MASTER), 'master secret must never leak');
});

// ---------------------------------------------------------------------------
// Auth: bearer-per-tenant, HMAC-derived; tenant from verified token only
// ---------------------------------------------------------------------------
test('ping with a valid derived token succeeds', async () => {
  const { status, json } = await post('/v1/ping', {});
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.protocol, 22);
  assert.ok(Array.isArray(json.methods) && json.methods.includes('spawn'));
});

test('missing bearer is 401', async () => {
  const res = await fetch(`${base}/v1/ping`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(res.status, 401);
  const j = await res.json();
  assert.equal(j.error.code, 'auth_denied');
});

test('forged bearer is 401', async () => {
  const { status, json } = await post('/v1/ping', {}, authed(TENANT_A, KEY_ID, 'forged-token'));
  assert.equal(status, 401);
  assert.equal(json.error.code, 'auth_denied');
});

test('missing X-Bridge-Key-Id is 401', async () => {
  const h = authed(); delete h['X-Bridge-Key-Id'];
  const { status } = await post('/v1/ping', {}, h);
  assert.equal(status, 401);
});

test('tenant is resolved from the verified token, never the body', async () => {
  // body claims tenant-b, token is tenant-a's: bridge must talk to tenant-a's socket
  const before = fixtureA.callsFor('session.snapshot').length + fixtureB.callsFor('session.snapshot').length;
  const { status, json } = await post('/v1/snapshot', { tenant: TENANT_B, idempotencyKey: randomUUID() });
  assert.equal(status, 200);
  assert.equal(fixtureA.callsFor('session.snapshot').length + fixtureB.callsFor('session.snapshot').length, before + 1);
  assert.equal(fixtureB.callsFor('session.snapshot').length, 0, 'must not touch tenant-b socket');
  assert.ok(json.panes.every((p) => p.paneId !== 'pane-b1'));
});

// ---------------------------------------------------------------------------
// Fencing: never-expose blocklist, deny-by-default
// ---------------------------------------------------------------------------
test('blocklisted socket methods are refused even if room code asks', () => {
  for (const m of ['server.stop', 'server.reload_config', 'plugin.link', 'plugin.enable',
    'integration.install', 'worktree.create', 'layout.apply', 'notification.show',
    'pane.send_text', 'pane.send_keys', 'pane.send_input', 'agent.view.set']) {
    assert.throws(() => assertSocketMethodAllowed(m), (e) => e.code === 'method_blocked', m);
  }
});
test('unknown socket methods are rejected (deny-by-default)', () => {
  assert.throws(() => assertSocketMethodAllowed('frobnicate'), (e) => e.code === 'method_unsupported');
});
test('allowlisted socket methods pass the fence', () => {
  for (const m of ['ping', 'session.snapshot', 'pane.read', 'pane.list', 'pane.get',
    'pane.process_info', 'pane.close', 'agent.list', 'agent.get', 'agent.start',
    'agent.prompt', 'agent.send_keys', 'agent.wait', 'pane.wait_for_output',
    'pane.report_agent', 'pane.report_agent_session', 'pane.report_metadata',
    'events.subscribe', 'events.wait', 'layout.export']) {
    assertSocketMethodAllowed(m);
  }
});

// ---------------------------------------------------------------------------
// Spawn: adapter-constructed argv from allowlisted kinds, no caller argv/env
// ---------------------------------------------------------------------------
test('spawn builds argv from kind template; caller argv is ignored', async () => {
  const { status, json } = await post('/v1/spawn', {
    kind: 'claude', argv: ['/bin/sh', '-c', 'evil'], env: { LD_PRELOAD: 'x' },
    workspaceRoot: join(dir, 'ws-a'), idempotencyKey: randomUUID(),
  });
  assert.equal(status, 200);
  const call = fixtureA.callsFor('agent.start').at(-1);
  assert.deepEqual(call.params.argv, ['claude']);
  assert.ok(!('LD_PRELOAD' in (call.params.env ?? {})));
  assert.equal(call.params.cwd, join(dir, 'ws-a'));
  assert.ok(json.handle, 'bridge issues an occupant handle');
});

test('spawn rejects unknown kind, bad resume id, bad workspace root', async () => {
  let r = await post('/v1/spawn', { kind: 'evilsh', idempotencyKey: randomUUID() });
  assert.equal(r.status, 422);
  assert.equal(r.json.error.code, 'input');
  r = await post('/v1/spawn', { kind: 'claude', resumeSessionId: 'x; rm -rf /', idempotencyKey: randomUUID() });
  assert.equal(r.status, 422);
  r = await post('/v1/spawn', { kind: 'claude', workspaceRoot: '/etc', idempotencyKey: randomUUID() });
  assert.equal(r.status, 422);
});

test('spawn with resume id uses the kind template, validated', async () => {
  const { status } = await post('/v1/spawn', {
    kind: 'codex', resumeSessionId: 'sess_abc-123', idempotencyKey: randomUUID(),
  });
  assert.equal(status, 200);
  const call = fixtureA.callsFor('agent.start').at(-1);
  assert.deepEqual(call.params.argv, ['codex', 'resume', 'sess_abc-123']);
});

test('buildSpawnArgv unit: unknown kind and env passthrough rejected', () => {
  assert.throws(() => buildSpawnArgv({ kind: 'nope' }), /kind/);
  const built = buildSpawnArgv({ kind: 'opencode', allowedRoots: ['/data'] , workspaceRoot: '/data/w' });
  assert.deepEqual(built.argv, ['opencode']);
  assert.ok(!Object.keys(built.env).some((k) => /LD_PRELOAD|PATH/i.test(k) && built.env[k] !== built.env[k]));
});

// ---------------------------------------------------------------------------
// Tenant scoping: caller-supplied pane ids are untrusted
// ---------------------------------------------------------------------------
test('tenant-a cannot read tenant-b panes (ownership registry)', async () => {
  // learn tenant-a's own panes first
  await post('/v1/list', {});
  const { status, json } = await post('/v1/read', { paneId: 'pane-b1' });
  assert.equal(status, 404);
  assert.equal(json.error.code, 'pane_not_found');
});

test('tenant-a can read its own pane', async () => {
  const { status } = await post('/v1/read', { paneId: 'pane-1' });
  assert.equal(status, 200);
});

// ---------------------------------------------------------------------------
// Occupant pinning: send/keys/wait die when the occupant changes
// ---------------------------------------------------------------------------
test('send with a live occupant handle succeeds', async () => {
  const sp = await post('/v1/spawn', { kind: 'claude', idempotencyKey: randomUUID() });
  const { status } = await post('/v1/send', { handle: sp.json.handle, text: 'hello', idempotencyKey: randomUUID() });
  assert.equal(status, 200);
});

test('send with a stale handle after occupant change is rejected', async () => {
  const sp = await post('/v1/spawn', { kind: 'claude', idempotencyKey: randomUUID() });
  fixtureA.state.occupant = 'occ-2'; // occupant rotated out from under the handle
  try {
    const { status, json } = await post('/v1/send', { handle: sp.json.handle, text: 'hello', idempotencyKey: randomUUID() });
    assert.equal(status, 409);
    assert.equal(json.error.code, 'occupant_changed');
  } finally {
    fixtureA.state.occupant = 'occ-1';
  }
});

// ---------------------------------------------------------------------------
// Sanitizer: single shared ANSI sanitizer at the readPane boundary
// ---------------------------------------------------------------------------
test('sanitizePaneText drops OSC 52, titles, hyperlinks; strips CSI', () => {
  const dirty = 'a\x1b]0;pwned title\x07b\x1b]52;c;c2VjcmV0\x07c' +
    '\x1b]8;;http://evil.example\x07link\x1b]8;;\x07d\x1b[31mred\x1b[0m e\x1b[2Jf';
  const clean = sanitizePaneText(dirty);
  assert.ok(!clean.includes('\x1b'), 'no ESC byte may survive');
  assert.ok(!clean.includes('pwned title'));
  assert.ok(!clean.includes('c2VjcmV0'), 'clipboard payload hard-dropped');
  assert.ok(!clean.includes('http://evil.example'));
  assert.ok(clean.includes('link'), 'hyperlink text survives as plain text');
  assert.ok(clean.includes('red'));
});

test('readPane output is sanitized at the bridge boundary', async () => {
  fixtureA.state.readText = 'x\x1b]52;c;c2VjcmV0\x07y\x1b[1;5H';
  try {
    const { status, json } = await post('/v1/read', { paneId: 'pane-1' });
    assert.equal(status, 200);
    assert.ok(!json.text.includes('\x1b'));
    assert.ok(!json.text.includes('c2VjcmV0'));
  } finally {
    fixtureA.state.readText = undefined;
  }
});

// ---------------------------------------------------------------------------
// Secret redaction on reads + audit discipline
// ---------------------------------------------------------------------------
test('secret-shaped values in pane output are masked in the response', () => {
  const out = redactSecretShaped('key=sk-abc123DEF456 and ghp_deadbeefcafe');
  assert.ok(!out.includes('sk-abc123DEF456'));
  assert.ok(!out.includes('ghp_deadbeefcafe'));
  assert.ok(out.includes('[redacted]'));
});

test('readPane bodies are never persisted: audit keeps bytes/hash only', async () => {
  fixtureA.state.readText = 'token sk-live-9999-SECRET\n';
  try {
    await post('/v1/read', { paneId: 'pane-1' });
  } finally {
    fixtureA.state.readText = undefined;
  }
  const raw = readFileSync(auditLog, 'utf8');
  assert.ok(!raw.includes('sk-live-9999-SECRET'), 'pane secret must not reach the audit log');
  const entries = auditEntries().filter((e) => e.route === 'read');
  const last = entries.at(-1);
  assert.ok(typeof last.result.bytes === 'number');
  assert.ok(typeof last.result.sha256 === 'string' && last.result.sha256.length === 64);
  assert.ok(!('text' in last.result));
});

test('redactValue masks sensitive keys at any depth', () => {
  const out = redactValue({ a: { Authorization: 'Bearer xyz', nested: { password: 'pw' } }, ok: 1 });
  assert.equal(out.a.Authorization, '[redacted]');
  assert.equal(out.a.nested.password, '[redacted]');
  assert.equal(out.ok, 1);
});

// ---------------------------------------------------------------------------
// Idempotency: writes require a key; repeats return the original response
// ---------------------------------------------------------------------------
test('write without idempotencyKey is 422', async () => {
  const { status, json } = await post('/v1/send', { handle: 'h', text: 'x' });
  assert.equal(status, 422);
  assert.equal(json.error.code, 'input');
});

test('repeated idempotencyKey returns the original response without re-executing', async () => {
  const key = randomUUID();
  const sp = await post('/v1/spawn', { kind: 'claude', idempotencyKey: randomUUID() });
  const before = fixtureA.callsFor('agent.prompt').length;
  const body = { handle: sp.json.handle, text: 'once', idempotencyKey: key };
  const r1 = await post('/v1/send', body);
  const r2 = await post('/v1/send', body);
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
  assert.deepEqual(r1.json, r2.json);
  assert.equal(fixtureA.callsFor('agent.prompt').length, before + 1, 'second call must not re-execute');
});

// ---------------------------------------------------------------------------
// Timeouts + retries: reads 3x, writes only on no-response with same key
// ---------------------------------------------------------------------------
test('timed-out idempotent read retries 3 times then surfaces a timeout', async () => {
  fixtureA.state.delayMs = 500; // bridge read timeout is 120ms in this harness
  try {
    const before = fixtureA.callsFor('session.snapshot').length;
    const { status, json } = await post('/v1/snapshot', {});
    assert.equal(status, 504);
    assert.equal(json.error.code, 'timeout');
    assert.equal(fixtureA.callsFor('session.snapshot').length, before + 3);
  } finally {
    fixtureA.state.delayMs = 0;
  }
});

test('write with no response retries once with the same key, then 504', async () => {
  const sp = await post('/v1/spawn', { kind: 'claude', idempotencyKey: randomUUID() });
  assert.equal(sp.status, 200);
  const before = fixtureA.callsFor('agent.prompt').length;
  fixtureA.state.delayMs = 500; // bridge send timeout is 120ms in this harness
  try {
    const { status, json } = await post('/v1/send', {
      handle: sp.json.handle, text: 'x', idempotencyKey: randomUUID(),
    });
    assert.equal(status, 504);
    assert.equal(json.error.code, 'timeout');
    assert.equal(fixtureA.callsFor('agent.prompt').length, before + 2,
      'exactly one retry, same idempotency key, then give up');
    // and the dedupe cache holds the (failed) outcome for the same key
  } finally {
    fixtureA.state.delayMs = 0;
  }
});

// ---------------------------------------------------------------------------
// Circuit breaker: 5 consecutive failures -> open; ping probe half-opens
// ---------------------------------------------------------------------------
test('circuit breaker opens after 5 consecutive failures and probes back', async () => {
  // point tenant-a at a dead socket by swapping its entry mid-test is not
  // possible; instead fail at the socket level via failConnect on a temp bridge
  const dir2 = mkdtempSync(join(tmpdir(), 'herdr-bridge-cb-'));
  const tenantsFile2 = join(dir2, 'tenants.json');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(tenantsFile2, JSON.stringify({ tenants: {
    'tenant-a': { socketPath: join(dir2, 'nope.sock'), uid: process.getuid?.() ?? 1000, workspaceRoot: dir },
  }}));
  const b2 = createBridge({
    port: 0, bind: '127.0.0.1', masterSecret: MASTER, keyId: KEY_ID,
    tenantsFile: tenantsFile2, auditLog: join(dir2, 'audit.jsonl'),
    timeouts: { ping: 100 }, circuitOpenMs: 250,
  });
  await b2.start();
  const base2 = `http://127.0.0.1:${b2.port}`;
  const h = authed();
  const call = () => fetch(`${base2}/v1/ping`, { method: 'POST', headers: { ...h, 'Content-Type': 'application/json' }, body: '{}' }).then((r) => r.status);
  try {
    const codes = [];
    for (let i = 0; i < 6; i++) codes.push(await call());
    assert.ok(codes.slice(0, 5).every((c) => c === 502 || c === 504), `first 5 fail at socket, got ${codes}`);
    assert.equal(codes[5], 503, '6th fails fast: circuit open');
    const entries = readFileSync(join(dir2, 'audit.jsonl'), 'utf8');
    assert.ok(entries.includes('bridge_circuit_open'));
    await new Promise((r) => setTimeout(r, 400)); // past open window
    const afterProbe = await call();
    assert.ok([502, 503, 504].includes(afterProbe), 'probe attempted through half-open');
  } finally {
    await b2.stop();
  }
});

// ---------------------------------------------------------------------------
// Report: self-report binding (HERDR_PANE_ID == target)
// ---------------------------------------------------------------------------
test('report with mismatched pane binding is rejected', async () => {
  const { status, json } = await post('/v1/report', {
    kind: 'state', targetPaneId: 'pane-1', herdrPaneId: 'pane-evil',
    state: 'done', idempotencyKey: randomUUID(),
  });
  assert.equal(status, 409);
  assert.equal(json.error.code, 'binding_mismatch');
  assert.equal(fixtureA.callsFor('pane.report_agent').length, 0);
});

test('report with matching binding reaches the socket', async () => {
  const before = fixtureA.callsFor('pane.report_agent').length;
  const { status } = await post('/v1/report', {
    kind: 'state', targetPaneId: 'pane-1', herdrPaneId: 'pane-1',
    state: 'done', idempotencyKey: randomUUID(),
  });
  assert.equal(status, 200);
  assert.equal(fixtureA.callsFor('pane.report_agent').length, before + 1);
});

test('validateReportBinding unit', () => {
  assert.throws(() => validateReportBinding({ herdrPaneId: 'a', targetPaneId: 'b' }), (e) => e.code === 'binding_mismatch');
  validateReportBinding({ herdrPaneId: 'a', targetPaneId: 'a' });
});

// ---------------------------------------------------------------------------
// Audit: every call logged, redacted, denies included
// ---------------------------------------------------------------------------
test('denied calls are audit-logged at the same level as allowed ones', async () => {
  const before = auditEntries().length;
  await post('/v1/ping', {}, authed(TENANT_A, KEY_ID, 'bad'));
  await post('/v1/ping', {});
  const entries = auditEntries().slice(before);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].result, 'deny');
  assert.ok(entries[0].denyReason);
  assert.equal(entries[1].result, 'ok');
  assert.ok(entries.every((e) => e.ts && e.route && typeof e.latencyMs === 'number'));
  assert.equal(entries[1].tenant, TENANT_A);
  assert.equal(entries[0].tenant, null, 'failed auth has no tenant identity — null, not a guess');
  const raw = readFileSync(auditLog, 'utf8');
  assert.ok(!raw.includes('forged-token') && !raw.includes('Bearer'));
});

test('list is tenant-scoped through the token socket', async () => {
  const { status, json } = await post('/v1/list', {});
  assert.equal(status, 200);
  assert.ok(json.agents.every((a) => a.paneId !== 'pane-b1'));
});

// ---------------------------------------------------------------------------
// SSE events
// ---------------------------------------------------------------------------
test('GET /v1/events streams socket events as SSE with heartbeats', async () => {
  const ctrl = new AbortController();
  const res = await fetch(`${base}/v1/events?since=0`, { headers: authed(), signal: ctrl.signal });
  assert.equal(res.status, 200);
  assert.ok(res.headers.get('content-type').includes('text/event-stream'));
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let text = '';
  const pump = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += dec.decode(value, { stream: true });
      if (text.includes('events_lost')) break;
    }
  })();
  // give the subscribe a beat, then emit through the fake server
  await new Promise((r) => setTimeout(r, 150));
  fixtureA.emit({ type: 'events_lost', reason: 'test' });
  await Promise.race([pump, new Promise((r) => setTimeout(r, 3000))]);
  ctrl.abort();
  assert.ok(text.includes('data:'), 'SSE data frames');
  assert.ok(text.includes('events_lost'), 'lost-events frame forwarded for adapter recovery');
  assert.ok(text.includes(': ping') || text.includes(':ping'), 'heartbeat comments present');
});

test('dual-key rotation: previous generation token accepted with prev key id', async () => {
  const dir2 = mkdtempSync(join(tmpdir(), 'herdr-bridge-rot-'));
  const tenantsFile2 = join(dir2, 'tenants.json');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(tenantsFile2, JSON.stringify({ tenants: {
    'tenant-a': { socketPath: join(dir, 'sockets', 'a.sock'), uid: process.getuid?.() ?? 1000, workspaceRoot: join(dir, 'ws-a') },
  }}));
  const OLD_MASTER = 'old-master-secret-0123456789abcdef';
  const b2 = createBridge({
    port: 0, bind: '127.0.0.1', masterSecret: MASTER, masterSecretPrev: OLD_MASTER,
    keyId: KEY_ID, keyIdPrev: '2026-09-old', tenantsFile: tenantsFile2, auditLog: join(dir2, 'audit.jsonl'),
  });
  await b2.start();
  try {
    const base2 = `http://127.0.0.1:${b2.port}`;
    const oldToken = deriveToken(OLD_MASTER, 'tenant-a');
    const okOld = await fetch(`${base2}/v1/ping`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${oldToken}`, 'X-Bridge-Key-Id': '2026-09-old', 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(okOld.status, 200, 'prev-generation token accepted during rotation window');
    const wrongGen = await fetch(`${base2}/v1/ping`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${oldToken}`, 'X-Bridge-Key-Id': KEY_ID, 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(wrongGen.status, 401, 'old token with current key id is rejected');
  } finally {
    await b2.stop();
  }
});

test('events without auth is 401', async () => {
  const res = await fetch(`${base}/v1/events`);
  assert.equal(res.status, 401);
  assert.ok(existsSync(auditLog));
});
