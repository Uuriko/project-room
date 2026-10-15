/**
 * Regression tests for issue #2868.
 *
 * invoke() retries a write once when the socket call reports no response
 * (err.gotResponse === false) — including the timeout path, where herdr
 * may already have executed the write and only the response was lost.
 * The old code made each attempt through callOnce(), which minted a
 * fresh randomUUID socket request id per attempt and carried no dedupe
 * key, so the retry was indistinguishable from a brand-new write and
 * re-executed it (duplicate spawn, duplicate prompt, ...).
 *
 * The fix: one socket request id per logical write — the caller's HTTP
 * idempotencyKey — reused on every attempt, so a retry is a
 * retransmission of the same request that a deduping server collapses.
 *
 * The fake herdr below models exactly that server contract: it dedupes
 * by request id (a repeated id returns the cached result without
 * re-executing) and can be armed to execute a write but lose its first
 * response, which is the failure scenario from the issue.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';

import { deriveToken } from '../bridge/lib/auth.mjs';
import { createBridge } from '../bridge/lib/bridge.mjs';
import { HerdrSocketClient } from '../bridge/lib/socket-client.mjs';

const MASTER = 'test-master-secret-0123456789abcdef';
const KEY_ID = '2026-10-test';
const TENANT = 'tenant-a';
let dir; let bridge; let base; let fake;

// ---------------------------------------------------------------------------
// Fake herdr: dedupes by request id; `loseFirstFor` arms a method so its
// next new request executes but its response is never sent.
// ---------------------------------------------------------------------------
function startFakeHerdr(socketPath) {
  const state = {
    requests: [], // every wire request: {id, method, params}
    executions: new Map(), // method -> number of actual executions
    seen: new Map(), // request id -> cached result
    loseFirstFor: new Set(),
  };
  const execute = (method, params) => {
    state.executions.set(method, (state.executions.get(method) ?? 0) + 1);
    switch (method) {
      case 'ping': return { ok: true, protocol: 22, herdrVersion: '0.0.0-test' };
      case 'agent.start': return { paneId: 'pane-1', agentId: 'agent-1', occupant: 'occ-1' };
      case 'pane.process_info': return { paneId: params.paneId, occupant: 'occ-1', alive: true };
      case 'agent.prompt': return { ok: true };
      default: throw Object.assign(new Error('unknown'), { code: 'method_unsupported' });
    }
  };
  const server = createServer((sock) => {
    sock.on('error', () => {});
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
        state.requests.push({ id, method, params });
        if (state.seen.has(id)) {
          // Dedupe: a retransmitted request id returns the original
          // result and is NOT executed again.
          sock.write(JSON.stringify({ id, result: state.seen.get(id) }) + '\n');
          continue;
        }
        let result;
        try { result = execute(method, params); } catch (e) {
          sock.write(JSON.stringify({ id, error: { code: e.code || 'internal', message: e.message } }) + '\n');
          continue;
        }
        state.seen.set(id, result);
        if (state.loseFirstFor.delete(method)) continue; // executed, response lost
        sock.write(JSON.stringify({ id, result }) + '\n');
      }
    });
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(socketPath, () => resolve({ server, state }));
  });
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'herdr-bridge-2868-'));
  mkdirSync(join(dir, 'sockets'), { recursive: true });
  const socketPath = join(dir, 'sockets', 'a.sock');
  const tenantsFile = join(dir, 'tenants.json');
  writeFileSync(tenantsFile, JSON.stringify({
    tenants: {
      [TENANT]: { socketPath, uid: process.getuid?.() ?? 1000, workspaceRoot: dir },
    },
  }));
  fake = await startFakeHerdr(socketPath);
  bridge = createBridge({
    port: 0,
    bind: '127.0.0.1',
    masterSecret: MASTER,
    keyId: KEY_ID,
    tenantsFile,
    auditLog: join(dir, 'audit.jsonl'),
    timeouts: { spawn: 150, send: 150, ping: 150 },
  });
  await bridge.start();
  base = `http://127.0.0.1:${bridge.port}`;
});

after(async () => {
  await bridge?.stop();
  fake?.server.close();
});

async function post(path, body) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${deriveToken(MASTER, TENANT)}`,
      'X-Bridge-Key-Id': KEY_ID,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

const requestsFor = (m) => fake.state.requests.filter((r) => r.method === m);
const executionsOf = (m) => fake.state.executions.get(m) ?? 0;

test('callOnce sends a caller-supplied requestId on the wire instead of minting a fresh one', async () => {
  const socketPath = join(dir, 'sockets', 'a.sock');
  const beforeCount = requestsFor('ping').length;
  const requestId = randomUUID();
  const client = new HerdrSocketClient();
  const result = await client.callOnce(socketPath, 'ping', {}, 2_000, { requestId });
  assert.equal(result.ok, true);
  const seen = requestsFor('ping').slice(beforeCount);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].id, requestId, 'the wire request id must be the supplied dedupe key');
});

test('spawn whose first response is lost is retried as the same request and executed once', async () => {
  const key = randomUUID();
  fake.state.loseFirstFor.add('agent.start');
  const execBefore = executionsOf('agent.start');
  const reqBefore = requestsFor('agent.start').length;
  const { status, json } = await post('/v1/spawn', { kind: 'claude', idempotencyKey: key });
  assert.equal(status, 200, `spawn must succeed via the deduped retry, got ${status} ${JSON.stringify(json)}`);
  assert.equal(json.paneId, 'pane-1');
  const attempts = requestsFor('agent.start').slice(reqBefore);
  assert.equal(attempts.length, 2, 'exactly one internal retry after the lost response');
  assert.ok(attempts.every((a) => a.id === key),
    `both attempts must carry the write's idempotency key as the socket request id, got ${attempts.map((a) => a.id).join(', ')} vs key ${key}`);
  assert.equal(executionsOf('agent.start'), execBefore + 1,
    'the retry must not re-execute agent.start on the server');
});

test('send whose first response is lost is retried as the same request and executed once', async () => {
  const sp = await post('/v1/spawn', { kind: 'claude', idempotencyKey: randomUUID() });
  assert.equal(sp.status, 200);
  const key = randomUUID();
  fake.state.loseFirstFor.add('agent.prompt');
  const execBefore = executionsOf('agent.prompt');
  const reqBefore = requestsFor('agent.prompt').length;
  const { status, json } = await post('/v1/send', { handle: sp.json.handle, text: 'hello once', idempotencyKey: key });
  assert.equal(status, 200, `send must succeed via the deduped retry, got ${status} ${JSON.stringify(json)}`);
  const attempts = requestsFor('agent.prompt').slice(reqBefore);
  assert.equal(attempts.length, 2, 'exactly one internal retry after the lost response');
  assert.ok(attempts.every((a) => a.id === key),
    `both attempts must carry the write's idempotency key as the socket request id, got ${attempts.map((a) => a.id).join(', ')} vs key ${key}`);
  assert.equal(executionsOf('agent.prompt'), execBefore + 1,
    'the retry must not re-execute agent.prompt on the server (no duplicate prompt)');
});
