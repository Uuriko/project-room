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
  const side = (await run('git', ['commit-tree', tree, '-m', 'drift side'])).stdout.trim();
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
