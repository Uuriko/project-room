import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { probeProd } from '../scripts/probe-prod-lib.mjs';

const run = promisify(execFile);
const { stdout } = await run('git', ['rev-parse', 'HEAD']);
const revision = stdout.trim();
const healthy = path => path === '/mcp' ? {status:401,headers:base=>({'WWW-Authenticate':`Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`}),body:{error:'unauthorized'}} : path === '/.well-known/oauth-protected-resource/mcp' ? {status:200,body:base=>({resource:base+'/mcp',authorization_servers:[base],bearer_methods_supported:['header']})} : path === '/.well-known/oauth-authorization-server' ? {status:200,body:base=>({issuer:base,authorization_endpoint:base+'/oauth/authorize',token_endpoint:base+'/oauth/token',registration_endpoint:base+'/oauth/register',response_types_supported:['code'],grant_types_supported:['authorization_code','refresh_token'],code_challenge_methods_supported:['S256']})} : ({ status: 200, body: path === '/api/version'
  ? { status: 'ok', sourceRevision: revision }
  : path === '/api/health' ? { status: 'ok' }
    : path === '/api/health/jobs' ? { schema: 'room.job-health/1', status: 'ok', jobs: [] } : '<html>Room</html>' });

async function withServer(t, responseFor) {
  const server = createServer(async (req, res) => {
    if(req.method==='POST'){const chunks=[];for await(const chunk of req)chunks.push(chunk);req.bodyText=Buffer.concat(chunks).toString('utf8');}
    const base=`http://${req.headers.host}`;const value=responseFor(req.url,req),body=typeof value.body==='function'?value.body(base):value.body;
    res.writeHead(value.status,typeof value.headers==='function'?value.headers(base):value.headers);
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

test('failing job health is reported separately and does not fail the drift verdict (#3531)', async t => {
  let liveRevision = revision;
  // Production's shape: the canary answers 503 carrying the job-health
  // document whenever the aggregate job status is not ok.
  const failingJobs = path => path === '/api/health/jobs'
    ? { status: 503, body: { schema: 'room.job-health/1', status: 'failing', jobs: [{ name: 'integrity', status: 'failing' }, { name: 'webhook-dispatch', status: 'ok' }, { name: 'gmail-sync', status: 'disabled' }] } }
    : healthy(path);
  const base = await withServer(t, path => path === '/api/version'
    ? { status: 200, body: { status: 'ok', sourceRevision: liveRevision } } : failingJobs(path));
  const result = await run(process.execPath, ['scripts/watch-deploy-drift.mjs', '--base', base, '--ref', 'HEAD']);
  const report = JSON.parse(result.stdout);
  assert.equal(report.probe_verdict, 'healthy');
  assert.equal(report.drift, false);
  assert.equal(report.jobs_health.status, 'failing');
  assert.deepEqual(report.jobs_health.failing, ['integrity']);
  liveRevision = 'f'.repeat(40);
  await assert.rejects(run(process.execPath, ['scripts/watch-deploy-drift.mjs', '--base', base, '--ref', 'HEAD']), error => {
    assert.equal(error.code, 1);
    const drifted = JSON.parse(error.stdout);
    assert.equal(drifted.drift, true);
    assert.equal(drifted.jobs_health.status, 'failing');
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

for(const [name,replace] of [
 ['missing challenge',()=>({status:401,body:{error:'unauthorized'}})],
 ['wrong challenge',()=>({status:401,headers:{'WWW-Authenticate':'Bearer resource_metadata="https://wrong.test/metadata"'},body:{}})],
 ['unexpected MCP success',()=>({status:200,body:{jsonrpc:'2.0',result:{}}})],
 ['MCP denied',()=>({status:403,body:{}})],
])test(`OAuth probe refuses ${name}`,async t=>{const base=await withServer(t,path=>path==='/mcp'?replace():healthy(path));assert.equal((await probeProd(base)).verdict,'unverified');});
for(const path of ['/.well-known/oauth-protected-resource/mcp','/.well-known/oauth-authorization-server']) {
 test(`OAuth probe refuses malformed metadata at ${path}`,async t=>{const base=await withServer(t,p=>p===path?{status:200,body:{}}:healthy(p));assert.equal((await probeProd(base)).verdict,'unverified');});
 test(`OAuth probe reports discovery outage at ${path}`,async t=>{const base=await withServer(t,p=>p===path?{status:503,body:'Unavailable'}:healthy(p));assert.equal((await probeProd(base)).verdict,'partial');});
}
test('OAuth health sends a bounded anonymous canonical initialize and accepts only its valid challenge',async t=>{let seen=false;const base=await withServer(t,(path,req)=>{if(path==='/mcp'){seen=true;assert.equal(req.method,'POST');assert.equal(req.headers.authorization,undefined);assert.match(req.headers['content-type'],/application\/json/);const message=JSON.parse(req.bodyText);assert.equal(message.method,'initialize');assert.equal(message.params.protocolVersion,'2025-03-26');assert.equal(message.jsonrpc,'2.0');assert.deepEqual(message.params.capabilities,{});}return healthy(path);});const result=await probeProd(base);assert.equal(seen,true);assert.equal(result.verdict,'healthy');assert.equal(result.endpoints.find(e=>e.label==='mcp-initialize').ok,true);});

for(const [name,path,body] of [
 ['wrong resource','/.well-known/oauth-protected-resource/mcp',base=>({resource:'https://wrong.test/mcp',authorization_servers:[base],bearer_methods_supported:['header']})],
 ['wrong issuer','/.well-known/oauth-authorization-server',base=>({...healthy('/.well-known/oauth-authorization-server').body(base),issuer:'https://wrong.test'})],
 ['wrong token endpoint','/.well-known/oauth-authorization-server',base=>({...healthy('/.well-known/oauth-authorization-server').body(base),token_endpoint:'https://wrong.test/token'})],
 ['invalid array shape','/.well-known/oauth-authorization-server',base=>({...healthy('/.well-known/oauth-authorization-server').body(base),grant_types_supported:{}})],
 ['oversized response','/.well-known/oauth-protected-resource/mcp',' '.repeat(65537)+'{}'],
])test(`OAuth probe rejects ${name}`,async t=>{const base=await withServer(t,p=>p===path?{status:200,body}:healthy(p));assert.equal((await probeProd(base)).verdict,'unverified');});
test('MCP503 remains a partial outage rather than a healthy challenge',async t=>{const base=await withServer(t,p=>p==='/mcp'?{status:503,body:'Unavailable'}:healthy(p));assert.equal((await probeProd(base)).verdict,'partial');});
