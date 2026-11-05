import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createConnectFunnel, connectFunnelEnabled, isReadTool, isPostTool } from '../server/connect-funnel.mjs';
import { robotsTxt } from '../server/agent-discovery.mjs';
import { downloadPageHtml } from '../server/download-page.mjs';

const ok = { jsonrpc: '2.0', id: 1, result: {} };
const call = name => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name } });

test('flag is off by default', () => {
  assert.equal(connectFunnelEnabled({}), false);
  assert.equal(connectFunnelEnabled({ ROOM_CONNECT_FUNNEL: '1' }), true);
});

test('tool classification', () => {
  assert.ok(isReadTool('room_check_access') && isReadTool('room_read_messages') && isReadTool('room_list_work'));
  assert.ok(!isReadTool('room_post_message') && !isReadTool('room_claim_work') && !isReadTool('room_join'));
  assert.ok(isPostTool('room_post_message'));
});

test('completion rates and medians; no tokens stored; failures ignored', () => {
  const db = new DatabaseSync(':memory:');
  let t = 1000; const f = createConnectFunnel({ db, now: () => t });
  const A = 'Bearer secret-token-aaaaaaaa', B = 'Bearer secret-token-bbbbbbbb', C = 'Bearer secret-token-cccccccc';
  for (const auth of [A, B, C]) f.observe({ authorization: auth, message: { method: 'initialize' }, reply: ok });
  f.observe({ authorization: undefined, message: { method: 'initialize' }, reply: ok }); // anonymous: not counted
  t = 3000; f.observe({ authorization: A, message: call('room_check_access'), reply: ok });
  t = 5000; f.observe({ authorization: B, message: call('room_read_messages'), reply: ok });
  f.observe({ authorization: C, message: call('room_read_messages'), reply: { error: { code: -32001 } } }); // failed: ignored
  t = 6000; f.observe({ authorization: A, message: call('room_post_message'), reply: ok });
  t = 9000; f.observe({ authorization: A, message: call('room_read_messages'), reply: ok });
  t = 9500; f.observe({ authorization: B, message: call('room_post_message'), reply: { jsonrpc: '2.0', id: 1, result: { isError: true } } });
  f.observe({ authorization: B, message: call('room_read_messages'), reply: ok });
  assert.deepEqual(f.summary(), {
    connections: 3,
    firstAuthenticatedRead: { reached: 2, completionRate: 0.667, medianMs: 3000 },
    firstPostRoundTrip: { reached: 1, completionRate: 0.333, medianMs: 8000 },
  });
  const dump = JSON.stringify(db.prepare('SELECT * FROM connect_funnel').all());
  assert.doesNotMatch(dump, /secret-token|Bearer/);
  assert.deepEqual(Object.keys(db.prepare('SELECT * FROM connect_funnel LIMIT 1').get()).sort(),
    ['connected_at', 'first_post_at', 'first_read_at', 'key', 'round_trip_at']);
});

test('/api/health shows the funnel only when the flag is on', async t => {
  const { RoomStore } = await import('../server/store.mjs');
  const { createRoomServer } = await import('../server/http.mjs');
  const health = async on => {
    if (on) process.env.ROOM_CONNECT_FUNNEL = '1'; else delete process.env.ROOM_CONNECT_FUNNEL;
    const store = new RoomStore(':memory:'); const server = createRoomServer({ store });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    try {
      return await new Promise((resolve, reject) => request(`http://127.0.0.1:${server.address().port}/api/health`, res => {
        const c = []; res.on('data', d => c.push(d)); res.on('end', () => resolve(JSON.parse(Buffer.concat(c))));
      }).on('error', reject).end());
    } finally { server.closeStreams(); server.closeAllConnections(); await new Promise(r => server.close(r)); store.close(); delete process.env.ROOM_CONNECT_FUNNEL; }
  };
  assert.equal((await health(false)).connectFunnel, undefined);
  assert.deepEqual((await health(true)).connectFunnel, { connections: 0,
    firstAuthenticatedRead: { reached: 0, completionRate: null, medianMs: null },
    firstPostRoundTrip: { reached: 0, completionRate: null, medianMs: null } });
});

test('robots.txt and public pages point at /llms.txt', () => {
  const robots = robotsTxt();
  assert.match(robots, /User-agent: \*\nAllow: \/llms\.txt\nDisallow:\n/);
  assert.match(robots, /# LLM instructions: https:\/\/room\.trydemigod\.com\/llms\.txt/);
  assert.match(downloadPageHtml(), /<link rel="help" type="text\/plain" href="\/llms\.txt"/);
  for (const f of ['public-rooms', 'store-pages', 'legal-pages', 'receipts-page', 'proof-page', 'public-face', 'public-search', 'public-agent-page', 'routes/public-lobby'])
    assert.match(readFileSync(new URL(`../server/${f}.mjs`, import.meta.url), 'utf8'), /<link rel="help" type="text\/plain" href="\/llms\.txt"/, f);
});

test('prepared registry metadata: under 4 KB, same server otherwise, server.json untouched', () => {
  const live = JSON.parse(readFileSync(new URL('../server.json', import.meta.url)));
  const next = JSON.parse(readFileSync(new URL('../docs/registry/server.next.json', import.meta.url)));
  const meta = next._meta['io.modelcontextprotocol.registry/publisher-provided'];
  assert.ok(Buffer.byteLength(JSON.stringify(next._meta)) < 4096);
  assert.equal(live._meta, undefined, 'not published: server.json has no _meta yet');
  const { _meta, ...rest } = next; assert.deepEqual(rest, live);
  assert.equal(meta.auth.resourceMetadata, 'https://room.trydemigod.com/.well-known/oauth-protected-resource/mcp');
  assert.doesNotMatch(JSON.stringify(next), /Bearer [A-Za-z0-9]|secret"\s*:/);
});
