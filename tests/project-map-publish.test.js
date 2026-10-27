import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishProjectMap, main } from '../scripts/project-map-publish.mjs';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { createRoomServer } from '../server/http.mjs';
import { setTier } from '../server/autonomy-tiers.mjs';

const connection = { origin: 'http://127.0.0.1:1234', roomId: 'commons', memberId: 'agent', token: 'pri_' + 'a'.repeat(43) };
const envelope = { repo: 'test/repo', revision: 'a'.repeat(40), graph: { nodes: [{ id: 'a', label: 'a', file: 'a.js', type: 'function' }], edges: [] } };
const hash = createHash('sha256').update(JSON.stringify(envelope.graph)).digest('hex');
const saved = { enabled: true, repo: envelope.repo, revision: envelope.revision, provenance: { graphSha256: hash } };
function transport(override = () => undefined) {
  const calls = []; let current = { enabled: true, found: false, repo: envelope.repo };
  return { calls, fetchImpl: async (url, options) => {
    calls.push({ url: String(url), options });
    const intercepted = await override({ url: String(url), options, setCurrent: value => { current = value; } });
    if (intercepted) return intercepted;
    if (!String(url).includes('/map')) return Response.json({ roomId: 'commons', viewerId: 'agent', state: {
      room: { ownerId: 'owner' }, members: { agent: { id: 'agent', kind: 'agent', active: true, revision: 1, permissions: ['manage_claims'] } } } });
    if (options.method === 'POST') current = saved;
    return Response.json(current);
  } };
}

test('publishes expected revision and verifies exact hash with safe bounded requests', async () => {
  const f = transport();
  const result = await publishProjectMap({ connection, envelope, fetchImpl: f.fetchImpl });
  assert.equal(result.status, 'published'); assert.equal(result.graphSha256, hash);
  assert.equal(f.calls.length, 4);
  assert.equal(JSON.parse(f.calls[2].options.body).expectedRevision, null);
  assert.equal(JSON.parse(f.calls[2].options.body).expectedGraphSha256, null);
  assert.deepEqual(JSON.parse(f.calls[2].options.body).graphify, envelope);
  for (const { options } of f.calls) { assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit'); assert.ok(options.signal); }
});

test('lost ACK reconciles exact content without repeating mutation', async () => {
  const f = transport(({ options, setCurrent }) => { if (options.method === 'POST') { setCurrent(saved); throw new Error('connection reset'); } });
  assert.equal((await publishProjectMap({ connection, envelope, fetchImpl: f.fetchImpl })).status, 'reconciled');
  assert.equal(f.calls.filter(call => call.options.method === 'POST').length, 1);
});

test('stale conflict never retries or reports reconciliation', async () => {
  const f = transport(({ options, setCurrent }) => { if (options.method === 'POST') { setCurrent(saved); return Response.json({}, { status: 409 }); } });
  await assert.rejects(publishProjectMap({ connection, envelope, fetchImpl: f.fetchImpl }), { code: 'revision_conflict' });
  assert.equal(f.calls.length, 3);
});

test('different readback hash and unknown lost ACK remain unconfirmed', async () => {
  for (const lost of [true, false]) {
    const f = transport(({ options, setCurrent }) => { if (options.method === 'POST') {
      setCurrent({ ...saved, provenance: { graphSha256: 'wrong' } });
      if (lost) throw new Error('lost');
      return Response.json(saved);
    } });
    await assert.rejects(publishProjectMap({ connection, envelope, fetchImpl: f.fetchImpl }), { code: 'publish_unconfirmed' });
  }
});

test('missing or mismatched expected member prevents map requests', async () => {
  for (const memberId of [undefined, 'other']) {
    const f = transport();
    await assert.rejects(publishProjectMap({ connection: { ...connection, memberId }, envelope, fetchImpl: f.fetchImpl }));
    assert.equal(f.calls.some(call => call.url.includes('/map')), false);
  }
});

test('oversized input, response streams, and redirects fail before mutation', async () => {
  const f = transport();
  await assert.rejects(publishProjectMap({ connection, envelope: { ...envelope, graph: { nodes: [], edges: [], large: 'x'.repeat(1_500_000) } }, fetchImpl: f.fetchImpl }), { code: 'payload_too_large' });
  assert.equal(f.calls.length, 0);
  for (const response of [new Response('x'.repeat(1_500_001)), new Response(null, { status: 302, headers: { Location: 'https://elsewhere.test' } })]) {
    let calls = 0;
    await assert.rejects(publishProjectMap({ connection, envelope, fetchImpl: async () => { calls++; return response; } }));
    assert.equal(calls, 1);
  }
});

test('CLI error output cannot print credential-bearing errors', async () => {
  const output = [];
  assert.equal(await main(['--bad', connection.token], { write: line => output.push(line) }), 1);
  assert.equal(output.join('').includes(connection.token), false);
});

test('CLI reads an envelope and sanitizes transport exceptions containing credentials', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'map-publish-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'envelope.json'); await writeFile(path, JSON.stringify(envelope));
  const env = { ROOM_AGENT_ORIGIN: connection.origin, ROOM_AGENT_ROOM: connection.roomId,
    ROOM_AGENT_MEMBER: connection.memberId, ROOM_AGENT_TOKEN: connection.token };
  const output = [], f = transport();
  assert.equal(await main(['--envelope', path], { env, write: line => output.push(line), fetchImpl: f.fetchImpl }), 0);
  assert.equal(JSON.parse(output[0]).status, 'published');
  assert.equal(await main(['--envelope', path], { env, write: line => output.push(line),
    fetchImpl: async () => { throw new Error(connection.token); } }), 1);
  assert.equal(output.join('').includes(connection.token), false);
});

test('real HTTP publication obeys fresh admin policy and checks stored hash', async t => {
  const store = new RoomStore(':memory:'); store.initialize(initialRoom('commons'));
  store.featureEnv = { ROOM_PROJECT_MAP_GRAPHIFY: 'on', ROOM_PROJECT_MAP_REPO: envelope.repo };
  const owner = store.issueAccessKey('commons', 'owner');
  const identity = store.identities.create('Agent');
  store.identities.link(owner, 'commons', { identityId: identity.identityId, memberId: 'agent', displayName: 'Agent', permissions: ['manage_claims'] });
  setTier(store.db, 'commons', 'agent', 't2_standard', { updatedBy: 'owner', nowMs: store.now() });
  const server = createRoomServer({ store }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const config = { ...connection, origin: `http://127.0.0.1:${server.address().port}`, token: identity.secret };
  assert.equal((await publishProjectMap({ connection: config, envelope })).graphSha256, hash);
  assert.equal((await publishProjectMap({ connection: config, envelope })).status, 'published');
  setTier(store.db, 'commons', 'agent', 't1_readonly', { updatedBy: 'owner', nowMs: store.now() });
  await assert.rejects(publishProjectMap({ connection: config, envelope }), { code: 'publish_http_error' });
});


test('malformed graph envelopes are refused before credentials leave the machine', async () => {
  for (const graph of [{ unexpected: 'object' }, { nodes: [] }, { nodes: [], edges: {} }, { nodes: [null], edges: [] }]) {
    const f = transport();
    await assert.rejects(publishProjectMap({ connection, envelope: { ...envelope, graph }, fetchImpl: f.fetchImpl }), { code: 'invalid_envelope' });
    assert.equal(f.calls.length, 0);
  }
});


test('publisher sends previous content digest even when Git revision is unchanged', async () => {
  const oldHash = 'b'.repeat(64);
  const f = transport(({ url, options }) => {
    if (url.includes('/map/') && options.method === 'GET') return Response.json({ ...saved, provenance: { graphSha256: oldHash } });
    if (options.method === 'POST') {
      const body = JSON.parse(options.body);
      assert.equal(body.expectedRevision, envelope.revision); assert.equal(body.expectedGraphSha256, oldHash);
      return Response.json({}, { status: 409 });
    }
  });
  await assert.rejects(publishProjectMap({ connection, envelope, fetchImpl: f.fetchImpl }), { code: 'revision_conflict' });
  assert.equal(f.calls.filter(call => call.options.method === 'POST').length, 1);
});
