import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { probeProd } from '../scripts/probe-prod-lib.mjs';

const run = promisify(execFile);
const { stdout } = await run('git', ['rev-parse', 'HEAD']);
const revision = stdout.trim();
const healthy = path => ({ status: 200, body: path === '/api/version'
  ? { status: 'ok', sourceRevision: revision }
  : path === '/api/health' ? { status: 'ok' }
    : path === '/api/health/jobs' ? { schema: 'room.job-health/1', status: 'ok', jobs: [] } : '<html>Room</html>' });

async function withServer(t, responseFor) {
  const server = createServer((req, res) => {
    assert.equal(req.method, 'GET', 'probes must remain read-only');
    const { status, body } = responseFor(req.url);
    res.writeHead(status);
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}

for (const [name, responseFor] of [
  ['denied public endpoints', () => ({ status: 403, body: 'Forbidden' })],
  ['authentication challenge', path => path === '/api/health' ? { status: 401, body: 'Unauthorized' } : healthy(path)],
  ['redirect', path => path === '/' ? { status: 302, body: '' } : healthy(path)],
  ['malformed version', path => path === '/api/version' ? { status: 200, body: '<html>Challenge</html>' } : healthy(path)],
  ['missing revision', path => path === '/api/version' ? { status: 200, body: { status: 'ok' } } : healthy(path)],
  ['invalid revision', path => path === '/api/version' ? { status: 200, body: { status: 'ok', sourceRevision: 'unknown' } } : healthy(path)],
  ['invalid canary', path => path === '/api/health/jobs' ? { status: 200, body: {} } : healthy(path)],
]) {
  test(`drift monitor refuses success for ${name}`, async t => {
    const base = await withServer(t, responseFor);
    let result;
    try { result = await run(process.execPath, ['scripts/watch-deploy-drift.mjs', '--base', base, '--ref', 'HEAD']); }
    catch (error) { result = error; }
    assert.equal(result.code, 1, 'incomplete public observations must fail the monitor');
    const report = JSON.parse(result.stdout);
    assert.equal(report.probe_verdict, 'unverified');
    assert.equal(report.incident_window, false, 'denial or malformed metadata does not establish a DO outage');
  });
}

test('drift monitor preserves safe per-endpoint diagnostics for a partial canary failure', async t => {
  const requests = [];
  const privateDetail = 'synthetic-private-diagnostic';
  const base = await withServer(t, path => {
    requests.push(path);
    assert.ok(['/', '/api/version', '/api/health', '/join', '/api/health/jobs', '/api/version/worker'].includes(path), 'unexpected probe path');
    if (path === '/api/health/jobs') return {
      status: 503,
      body: { schema: 'room.job-health/1', status: 'unavailable', jobs: [],
        error: privateDetail, url: `https://example.invalid/?token=${privateDetail}` },
    };
    return healthy(path === '/api/version/worker' ? '/api/version' : path);
  });
  await assert.rejects(run(process.execPath, ['scripts/watch-deploy-drift.mjs', '--base', base, '--ref', 'HEAD']), error => {
    assert.equal(error.code, 1);
    const report = JSON.parse(error.stdout);
    assert.equal(report.probe_verdict, 'partial');
    assert.equal(report.probe_note, 'mixed failures - inspect per-endpoint results');
    assert.equal(report.incident_window, false, 'a failed canary alone does not establish a DO outage');
    assert.equal(report.drift, false);
    assert.equal(report.door_split, false);
    assert.deepEqual(report.probe_endpoints.map(({ label, status, ok }) => ({ label, status, ok })), [
      { label: 'home', status: 200, ok: true },
      { label: 'version', status: 200, ok: true },
      { label: 'health', status: 200, ok: true },
      { label: 'join-page', status: 200, ok: true },
      { label: 'jobs-canary', status: 503, ok: false },
    ]);
    for (const endpoint of report.probe_endpoints) {
      assert.deepEqual(Object.keys(endpoint).sort(), ['label', 'latencyMs', 'ok', 'status']);
      assert.ok(Number.isSafeInteger(endpoint.latencyMs) && endpoint.latencyMs >= 0);
    }
    assert.ok(!`${error.stdout}${error.stderr}`.includes(privateDetail), 'response bodies and provider details must stay private');
    return true;
  });
  assert.deepEqual(requests.sort(), ['/', '/api/health', '/api/health/jobs', '/api/version', '/api/version', '/api/version/worker', '/join'], 'diagnostics must reuse the existing five probes and two version-door reads');
});

test('valid public responses permit a matching revision and detect a real mismatch', async t => {
  let liveRevision = revision;
  const base = await withServer(t, path => path === '/api/version'
    ? { status: 200, body: { status: 'ok', sourceRevision: liveRevision } } : healthy(path));
  const result = await run(process.execPath, ['scripts/watch-deploy-drift.mjs', '--base', base, '--ref', 'HEAD']);
  assert.equal(JSON.parse(result.stdout).probe_verdict, 'healthy');
  liveRevision = 'f'.repeat(40);
  await assert.rejects(run(process.execPath, ['scripts/watch-deploy-drift.mjs', '--base', base, '--ref', 'HEAD']), error => {
    assert.equal(error.code, 1);
    const report = JSON.parse(error.stdout);
    assert.equal(report.drift, true);
    assert.equal(report.lag, 'unknown');
    return true;
  });
});

test('a lag inside both budgets is healthy, and crossing either budget is drift', async t => {
  const parent = (await run('git', ['rev-parse', 'HEAD~1'])).stdout.trim();
  const count = Number((await run('git', ['rev-list', '--count', 'HEAD~1..HEAD'])).stdout.trim());
  assert.ok(count >= 1);
  const base = await withServer(t, path => path === '/api/version'
    ? { status: 200, body: { status: 'ok', sourceRevision: parent } } : healthy(path));
  const within = await run(process.execPath, ['scripts/watch-deploy-drift.mjs', '--base', base, '--ref', 'HEAD', '--max-prs', String(count), '--max-hours', '100000']);
  const ok = JSON.parse(within.stdout);
  assert.equal(ok.probe_verdict, 'healthy');
  assert.equal(ok.drift, false);
  assert.equal(ok.lag, null);
  assert.equal(ok.behind_prs, count);
  await assert.rejects(run(process.execPath, ['scripts/watch-deploy-drift.mjs', '--base', base, '--ref', 'HEAD', '--max-prs', String(count - 1), '--max-hours', '100000']), error => {
    const report = JSON.parse(error.stdout);
    assert.equal(error.code, 1);
    assert.equal(report.drift, true);
    assert.equal(report.lag, 'prs');
    assert.equal(report.probe_verdict, 'healthy');
    return true;
  });
  await assert.rejects(run(process.execPath, ['scripts/watch-deploy-drift.mjs', '--base', base, '--ref', 'HEAD', '--max-prs', String(count), '--max-hours', '0']), error => {
    const report = JSON.parse(error.stdout);
    assert.equal(error.code, 1);
    assert.equal(report.drift, true);
    assert.equal(report.lag, 'hours');
    return true;
  });
});

test('a commit that is not an ancestor of main is drift', async t => {
  const tree = (await run('git', ['rev-parse', 'HEAD^{tree}'])).stdout.trim();
  const side = (await run('git', ['commit-tree', tree, '-m', 'drift side'], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'drift-test',
      GIT_AUTHOR_EMAIL: 'drift-test@example.com',
      GIT_COMMITTER_NAME: 'drift-test',
      GIT_COMMITTER_EMAIL: 'drift-test@example.com',
    },
  })).stdout.trim();
  const base = await withServer(t, path => path === '/api/version'
    ? { status: 200, body: { status: 'ok', sourceRevision: side } } : healthy(path));
  await assert.rejects(run(process.execPath, ['scripts/watch-deploy-drift.mjs', '--base', base, '--ref', 'HEAD']), error => {
    const report = JSON.parse(error.stdout);
    assert.equal(error.code, 1);
    assert.equal(report.drift, true);
    assert.equal(report.lag, 'not-ancestor');
    return true;
  });
});

test('real 503 canary signature retains outage classification; generic proxy failure does not', async t => {
  let caught = true;
  const base = await withServer(t, path => ({ status: 503, body: path === '/api/health/jobs' && caught
    ? { schema: 'room.job-health/1', status: 'unavailable', jobs: [] } : 'Unavailable' }));
  assert.equal((await probeProd(base)).verdict, 'do-rpc-fail');
  caught = false;
  assert.equal((await probeProd(base)).verdict, 'unclassified-outage');
});
