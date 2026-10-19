/**
 * Regression tests for issue #2867.
 *
 * Unknown herdr socket error codes are application errors from a live
 * server (socket-client sets gotResponse=true for them), not transport
 * failures. Mapping them to the retryable `transport_error` made
 * invoke() retry idempotent reads 3x against a deterministic error and
 * counted them toward the circuit breaker (5 logical calls -> open 60s).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';

import { fromSocketError } from '../bridge/lib/errors.mjs';
import { deriveToken } from '../bridge/lib/auth.mjs';
import { createBridge } from '../bridge/lib/bridge.mjs';

const UNKNOWN_CODE = 'some_unrecognised_app_error';

test('fromSocketError maps an unknown socket code to a non-retryable server error, not transport_error', () => {
  const err = fromSocketError({ code: UNKNOWN_CODE, message: 'deterministic app failure' });
  assert.notEqual(err.code, 'transport_error');
  assert.equal(err.code, 'server_error');
  assert.equal(err.retryable, false);
  assert.ok(err.message.includes(UNKNOWN_CODE), 'original socket code is preserved in the message');
});

test('fromSocketError maps a missing socket code to a non-retryable server error, not transport_error', () => {
  for (const sockErr of [{}, null, undefined]) {
    const err = fromSocketError(sockErr);
    assert.equal(err.code, 'server_error');
    assert.equal(err.retryable, false);
  }
});

test('fromSocketError keeps the known socket-code mappings unchanged', () => {
  assert.equal(fromSocketError({ code: 'occupant_changed' }).code, 'occupant_changed');
  assert.equal(fromSocketError({ code: 'pane_not_found' }).code, 'pane_not_found');
  assert.equal(fromSocketError({ code: 'not_found' }).code, 'pane_not_found');
  assert.equal(fromSocketError({ code: 'method_unsupported' }).code, 'method_unsupported');
  assert.equal(fromSocketError({ code: 'unknown_method' }).code, 'method_unsupported');
});

// ---------------------------------------------------------------------------
// Integration: a live fake herdr that always answers with an unknown error
// code. Its application errors must neither be retried nor trip the breaker.
// ---------------------------------------------------------------------------
const MASTER = 'test-master-secret-0123456789abcdef';
const KEY_ID = '2026-10-test';
const TENANT = 'tenant-a';
let dir; let bridge; let base; let fake; let calls;

function startFakeHerdr(socketPath) {
  calls = 0;
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
        calls += 1;
        sock.write(JSON.stringify({
          id: req.id,
          error: { code: UNKNOWN_CODE, message: 'deterministic app failure' },
        }) + '\n');
      }
    });
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(socketPath, () => resolve(server));
  });
}

before(async () => {
  // A unix socket path is capped near 104-108 bytes (sun_path). Under a deep TMPDIR (a long worktree path) the
  // socket below would fail to listen with EINVAL, so fall back to /tmp when the full path would not fit.
  const shortEnough = Buffer.byteLength(join(tmpdir(), 'herdr-bridge-unknown-err-XXXXXX', 'sockets', 'a.sock')) <= 100;
  dir = mkdtempSync(join(shortEnough ? tmpdir() : '/tmp', 'herdr-bridge-unknown-err-'));
  mkdirSync(join(dir, 'sockets'), { recursive: true });
  const socketPath = join(dir, 'sockets', 'a.sock');
  const tenantsFile = join(dir, 'tenants.json');
  writeFileSync(tenantsFile, JSON.stringify({
    tenants: {
      [TENANT]: {
        socketPath,
        uid: process.getuid?.() ?? 1000,
        workspaceRoot: dir,
      },
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
    timeouts: { ping: 120 },
    circuitOpenMs: 60_000,
  });
  await bridge.start();
  base = `http://127.0.0.1:${bridge.port}`;
});

after(async () => {
  await bridge?.stop();
  fake?.close();
});

async function postPing() {
  const res = await fetch(`${base}/v1/ping`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${deriveToken(MASTER, TENANT)}`,
      'X-Bridge-Key-Id': KEY_ID,
      'Content-Type': 'application/json',
    },
    body: '{}',
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

test('unknown socket errors are not retried and do not trip the circuit breaker', async () => {
  const results = [];
  for (let i = 0; i < 6; i++) results.push(await postPing());
  for (const [i, r] of results.entries()) {
    assert.equal(r.json.error?.code, 'server_error', `call ${i + 1} must surface the server error, got ${JSON.stringify(r.json)}`);
    assert.notEqual(r.json.error?.code, 'bridge_circuit_open', `call ${i + 1} must not be circuit-open`);
    assert.equal(r.status, 502, `call ${i + 1} status`);
  }
  // ping is an idempotent read (3 attempts on a transport failure) and the
  // breaker opens after 5 logical transport failures: on the old mapping
  // this would be 15 socket calls for the first 5 pings and a 503
  // bridge_circuit_open for the 6th, which never reaches the server.
  assert.equal(calls, 6, 'exactly one socket attempt per logical call: no retries, breaker stayed closed');
});
