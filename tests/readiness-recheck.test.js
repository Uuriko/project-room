import test from 'node:test';
import assert from 'node:assert/strict';
import { readinessRetry, pollReadiness } from '../scripts/prod-smoke-retry.mjs';
const options = { sha: 'a'.repeat(40), origin: 'https://canonical.example', entry: 'https://entry.example/room' };
const timeout = { status: 'degraded', do: { status: 'timeout', timeoutMs: 1000 } };
const ready = { status: 'ready', do: { status: 'ok' }, emailVerification: 'enforced', emailVerificationScope: 'durable-object' };
const fixture = () => ({ ok: false, ...options, checks: [options.origin, options.entry].flatMap(door => [
  ...['/api/version', '/api/version/worker'].map(path => ({ name: `version ${door}${path}`, pass: true, status: 200, got: options.sha })),
  { name: `health ${door}/api/health`, pass: true, status: 200, body: 'ok' },
  ...['/terms', '/privacy', '/'].map(path => ({ name: `page ${door}${path}`, pass: true, status: 200 })),
  { name: `agent-card ${door}/.well-known/agent-card.json`, pass: true, converged: true, fetches: 10, attempts: 10, failures: [], failureCount: 0 },
  { name: `ready ${door}/api/ready`, pass: false, status: 503, body: 'degraded', emailVerification: 'unknown', emailVerificationScope: 'unknown', do: timeout.do },
]) });
test('only complete matching timeout-only failure permits readiness observation', () => {
  assert.equal(readinessRetry(fixture(), options), true);
  for (const mutate of [r => r.checks.pop(), r => r.sha = 'b'.repeat(40), r => r.checks[0].got = 'b'.repeat(40),
    r => r.checks[0].status = 503, r => r.checks[6].failureCount = 1, r => r.checks[7].do = { status: 'error' },
    r => r.checks[7].emailVerification = 'relaxed-no-mailer']) {
    const report = fixture(); mutate(report); assert.equal(readinessRetry(report, options), false);
  }
  assert.equal(readinessRetry(null, options), false);
});
function harness(overrides = {}) {
  let clock = 0, rounds = 0;
  const calls = [], progress = [];
  const deps = { ...options, waitMs: 35000, now: () => clock, sleep: async ms => { clock += ms; }, progress: text => progress.push(text),
    fetchImpl: async (url, init) => {
      calls.push(url); assert.ok(init.signal); assert.equal(init.redirect, 'error');
      if (!url.endsWith('/api/ready')) return { status: 200, json: async () => ({ sourceRevision: options.sha }) };
      rounds++; const pass = rounds > 2;
      return { status: pass ? 200 : 503, json: async () => pass ? ready : timeout };
    }, ...overrides };
  return { deps, calls, progress, clock: () => clock, advance: ms => { clock += ms; } };
}
test('all four target checks precede both readiness checks; fixed cadence then strict retry permission only', async () => {
  const h = harness(); assert.equal(await pollReadiness(h.deps), true);
  assert.equal(h.clock(), 20000); assert.equal(h.calls.length, 12);
  for (let i = 0; i < 12; i += 6) {
    assert.ok(h.calls.slice(i, i + 4).every(url => url.includes('/api/version')));
    assert.ok(h.calls.slice(i + 4, i + 6).every(url => url.endsWith('/api/ready')));
  }
  assert.equal(h.progress.length, 2);
});
test('target drift or invalid version stops before readiness requests', async () => {
  for (const status of [200, 503]) {
    let calls = 0;
    const h = harness({ fetchImpl: async () => { calls++; return { status, json: async () => ({ sourceRevision: status === 200 ? 'b'.repeat(40) : options.sha }) }; } });
    assert.equal(await pollReadiness(h.deps), false); assert.equal(calls, 4);
  }
});
test('error, malformed readiness and relaxed policy fail closed', async () => {
  for (const [status, body] of [[503, { ...timeout, do: { status: 'error' } }], [200, {}], [200, { ...ready, emailVerification: 'relaxed-no-mailer' }]]) {
    const h = harness(); const normal = h.deps.fetchImpl;
    h.deps.fetchImpl = (url, init) => url.endsWith('/api/ready') ? Promise.resolve({ status, json: async () => body }) : normal(url, init);
    assert.equal(await pollReadiness(h.deps), false);
  }
});
test('one total budget includes slow fetches and persistent timeouts; no fresh budget per round', async () => {
  const h = harness({ waitMs: 25000 }); const normal = h.deps.fetchImpl;
  h.deps.fetchImpl = (url, init) => url.endsWith('/api/ready') ? Promise.resolve({ status: 503, json: async () => timeout }) : normal(url, init);
  assert.equal(await pollReadiness(h.deps), false); assert.equal(h.clock(), 25000); assert.equal(h.calls.length, 8);
  const slow = harness({ waitMs: 11000 }); const original = slow.deps.fetchImpl;
  slow.deps.fetchImpl = async (url, init) => { const r = await original(url, init); if (url.endsWith('/api/version/worker')) slow.advance(1000); return r; };
  assert.equal(await pollReadiness(slow.deps), false); assert.equal(slow.calls.length, 4);
});

test('actual CLI permits strict retry only after ready observations and preserves original bytes', async t => {
  const { createServer } = await import('node:http');
  const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFile } = await import('node:child_process');
  const calls = [];
  const server = createServer((request, response) => {
    calls.push(request.url); response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(request.url.endsWith('/api/ready') ? ready : { sourceRevision: options.sha }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`, entry = origin + '/room';
  const report = fixture(); report.origin = origin; report.entry = entry;
  report.checks = report.checks.map(c => ({ ...c, name: c.name.replace(options.origin, origin).replace(options.entry, entry) }));
  const directory = mkdtempSync(join(tmpdir(), 'readiness-recheck-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'failed.json'), raw = JSON.stringify(report) + '\n'; writeFileSync(file, raw);
  const result = await new Promise(resolve => execFile(process.execPath, ['scripts/prod-smoke-retry.mjs', file,
    '--sha', options.sha, '--origin', origin, '--entry', entry], { timeout: 20000 }, (error, stdout, stderr) => resolve({ error, stdout, stderr })));
  assert.equal(result.error, null, result.stderr);
  assert.match(result.stderr, /original failure retained/);
  assert.match(result.stderr, /ready, ready/);
  assert.equal(calls.length, 6); assert.equal(readFileSync(file, 'utf8'), raw);
  assert.deepEqual(calls.slice(0, 4).sort(), ['/api/version', '/api/version/worker', '/room/api/version', '/room/api/version/worker'].sort());
});


test('real Worker timeout body and explicit unknown markers remain retryable, never relaxed policy', async () => {
  const { healthLivenessResponse } = await import('../cloudflare/health-probe.mjs');
  const body = await healthLivenessResponse(new Request(options.origin + '/api/ready'), { readiness: 'timeout', elapsedMs: 1000, timeoutMs: 1000 }).json();
  for (const response of [body, { ...body, emailVerification: 'unknown', emailVerificationScope: 'unknown' }]) {
    const h = harness(); let readyCalls = 0; const normal = h.deps.fetchImpl;
    h.deps.fetchImpl = (url, init) => {
      if (!url.endsWith('/api/ready')) return normal(url, init);
      const pass = ++readyCalls > 2;
      return Promise.resolve({ status: pass ? 200 : 503, json: async () => pass ? ready : response });
    };
    assert.equal(await pollReadiness(h.deps), true); assert.equal(readyCalls, 4);
  }
});
test('one drifting entry Worker and readiness completing after deadline cannot authorize retry', async () => {
  const h = harness(); const normal = h.deps.fetchImpl;
  h.deps.fetchImpl = (url, init) => url === options.entry + '/api/version/worker'
    ? Promise.resolve({ status: 200, json: async () => ({ sourceRevision: 'b'.repeat(40) }) }) : normal(url, init);
  assert.equal(await pollReadiness(h.deps), false);
  assert.ok(h.calls.every(url => !url.endsWith('/api/ready')));
  const slow = harness({ waitMs: 11000 }); const original = slow.deps.fetchImpl;
  slow.deps.fetchImpl = (url, init) => {
    if (!url.endsWith('/api/ready')) return original(url, init);
    slow.advance(1000); return Promise.resolve({ status: 200, json: async () => ready });
  };
  assert.equal(await pollReadiness(slow.deps), false);
});
