// Seat ask (John, 2026-10-31): "If an agent isn't signed in but wants to work
// it should be able to." A custom MCP connector with no sign-in (Claude) can
// mint an identity, but cannot add an Authorization header mid-session, so the
// minted identity never reaches public_work_claim. The server-issued
// Mcp-Session-Id carries the minted identity for public work only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { createRoomServer } from '../server/http.mjs';
import { createAnonMcpSessions } from '../server/mcp-anon-session.mjs';

async function fixture(t) {
  const store = new RoomStore(':memory:'); store.initialize(initialRoom());
  store.projectOffers.create('commons', 'owner', { requestId: 'create', offerId: 'anon:task', reviewerMemberIds: ['owner'], terms: { kind: 'task', title: 'JavaScript volunteer task', summary: 'Synthetic public work', acceptanceCriteria: ['Return exact bytes'], repositoryUrl: 'https://github.com/example/project', reward: { kind: 'unpaid' }, approvalPolicy: { mode: 'human' } } });
  store.projectOffers.transition('commons', 'owner', 'anon:task', 'publish', { requestId: 'publish', expectedRevision: 1 });
  store.publicWorkClaims.enable('commons', 'owner', 'anon:task', { requestId: 'enable', expectedRevision: 2, expectedTermsVersion: 1, repositoryRef: 'main', files: ['result.js'] });
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const origin = 'http://127.0.0.1:' + server.address().port;
  const rpc = async (method, params, { session, accept = 'application/json, text/event-stream' } = {}) => {
    const response = await fetch(origin + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept, ...(session ? { 'mcp-session-id': session } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 'x', method, ...(params ? { params } : {}) }) });
    const text = await response.text();
    const type = response.headers.get('content-type') || '';
    const frames = type.startsWith('text/event-stream') ? text.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6))) : [JSON.parse(text)];
    return { status: response.status, session: response.headers.get('mcp-session-id'), frames, body: frames.at(-1) };
  };
  return { store, rpc };
}
const init = { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-connector', version: '1' } };
const names = reply => reply.body.result.tools.map(tool => tool.name);

test('anonymous initialize issues a session id and advertises tools.listChanged', async t => {
  const f = await fixture(t);
  const reply = await f.rpc('initialize', init);
  assert.match(reply.session ?? '', /^mcps_[A-Za-z0-9_-]{43}$/);
  assert.equal(reply.body.result.capabilities.tools.listChanged, true);
});

test('mint in the same session unlocks claim and finish with no Authorization header', async t => {
  const f = await fixture(t);
  const { session } = await f.rpc('initialize', init);
  assert.ok(!names(await f.rpc('tools/list', undefined, { session })).includes('public_work_claim'));
  const mint = await f.rpc('tools/call', { name: 'room_identity_mint', arguments: { displayName: 'Anon session worker' } }, { session });
  assert.deepEqual(mint.frames[0], { jsonrpc: '2.0', method: 'notifications/tools/list_changed' }, 'mint pushes list_changed before the result');
  const minted = mint.body.result.structuredContent;
  assert.ok(minted.secret && minted.identityId);
  assert.equal(minted.session.upgraded, true);
  assert.ok(!mint.body.result.content[0].text.includes(session), 'the session id is never echoed in host-visible text');
  const listed = names(await f.rpc('tools/list', undefined, { session }));
  for (const name of ['public_work_claim', 'public_work_renew', 'public_work_release', 'public_work_finish', 'public_work_my_review']) assert.ok(listed.includes(name), name);
  const claimed = await f.rpc('tools/call', { name: 'public_work_claim', arguments: { taskId: 'anon:task', requestId: 'c1', expectedTermsVersion: 1 } }, { session });
  assert.equal(claimed.body.result.structuredContent.action, 'claimed', JSON.stringify(claimed.body));
  assert.equal(f.store.db.prepare('SELECT actor_id FROM public_work_requests WHERE request_id=?').get('c1').actor_id, minted.identityId);
  const finished = await f.rpc('tools/call', { name: 'public_work_finish', arguments: { taskId: 'anon:task', requestId: 'f1', expectedTermsVersion: 1, generation: claimed.body.result.structuredContent.task.claim.generation, artifactText: 'done', checksReported: [] } }, { session });
  assert.ok(!finished.body.result.isError, JSON.stringify(finished.body));
});

test('the session grants public work only, and unknown or unissued sessions stay anonymous', async t => {
  const f = await fixture(t);
  const { session } = await f.rpc('initialize', init);
  await f.rpc('tools/call', { name: 'room_identity_mint', arguments: { displayName: 'Scoped worker' } }, { session, accept: 'application/json' });
  const listed = names(await f.rpc('tools/list', undefined, { session }));
  assert.ok(!listed.includes('room_post_message') && !listed.includes('room_needs_me'), listed.join());
  const room = await f.rpc('tools/call', { name: 'room_post_message', arguments: { roomId: 'commons', body: 'hi' } }, { session });
  assert.equal(room.status, 401); assert.equal(room.body.error.code, -32001);
  const forged = 'mcps_' + 'A'.repeat(43);
  await f.rpc('tools/call', { name: 'room_identity_mint', arguments: { displayName: 'Forged worker' } }, { session: forged });
  assert.ok(!names(await f.rpc('tools/list', undefined, { session: forged })).includes('public_work_claim'), 'a client-chosen session id is never bound');
});

test('session bindings expire and stay bounded', () => {
  let now = 0;
  const sessions = createAnonMcpSessions({ ttlMs: 1000, max: 2, now: () => now });
  const a = sessions.issue(), b = sessions.issue(), c = sessions.issue();
  assert.equal(sessions.bind(a, 'pri_a'), false, 'oldest issued id was evicted');
  assert.equal(sessions.bind(b, 'pri_b'), true); assert.equal(sessions.bind(c, 'pri_c'), true);
  assert.equal(sessions.resolve(b), 'pri_b');
  assert.equal(sessions.bind(b, 'pri_other'), false, 'a bound session is never rebound');
  now = 1001; assert.equal(sessions.resolve(b), null);
  assert.equal(sessions.size(), 0);
});
