import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomAgentClient } from '../client/room-agent.mjs';
import { RoomStore } from '../server/store.mjs';
import { AgentRooms } from '../server/agent-rooms.mjs';
import { createRoomServer } from '../server/http.mjs';
import { resumeAgent } from '../client/agent-resume.mjs';
import { main } from '../scripts/agent-resume.mjs';

const connection = { origin: 'http://127.0.0.1:1234', roomId: 'commons', memberId: 'worker', token: 'A'.repeat(43) };
const version = 'b'.repeat(64);
function context(extra = {}) {
  return { contractVersion: 1, roomId: 'commons', viewerId: 'worker', viewerAccountId: null, viewerAuthEpoch: null,
    viewerSessionBinding: null, viewerSessionRevision: null, context_version: version, evaluatedThrough: 10,
    cursors: { roomSequence: 10, caughtUp: 0 }, roster: [{ id: 'worker', kind: 'agent', active: true, permissions: [] }],
    focusWork: [{ id: 'task', title: 'Review change', state: 'proposed', revision: 3, nextAction: 'accept', nextMemberId: 'worker', needsAttention: true }],
    locks: [{ workItemId: 'own', holderId: 'worker', paths: ['src/a.js'] }, { workItemId: 'other', holderId: 'peer', paths: ['src/b.js'] }], ...extra };
}
const page = (extra = {}) => ({ identityId: 'worker', items: [{ kind: 'mention', roomId: 'commons', id: 'm', seq: 9,
  summary: 'SECRET TRANSCRIPT', next: { body: 'SECRET TRANSCRIPT' } }], cursor: { rooms: { commons: 10 } }, hasMore: false, ...extra });
function transport(fn = () => undefined) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    const override = await fn(String(url), options, calls.length);
    if (override instanceof Response) return override;
    const value = override ?? (String(url).includes('/needs-me') ? page() : context());
    return Response.json(value);
  };
  return { fetchImpl, calls };
}

test('resume keeps obligations/own claims and refs, never transcript or effects', async () => {
  const f = transport();
  const result = await resumeAgent({ connection, fetchImpl: f.fetchImpl });
  assert.equal(result.connection.status, 'credential_accepted');
  assert.deepEqual(result.toolProfile, { transport: 'hosted_mcp', profile: 'full' });
  assert.deepEqual(result.obligations.map(x => x.id), ['task']);
  assert.deepEqual(result.ownClaims.map(x => x.workItemId), ['own']);
  assert.deepEqual(result.attention.map(({ nextRead, ...ref }) => ref), [{ kind: 'mention', roomId: 'commons', seq: 9, id: 'm' }]);
  assert.deepEqual(result.attention[0].nextRead, { tool: 'room_list_events', arguments: { roomId: 'commons', after: 8, limit: 1 } });
  assert.equal(JSON.stringify(result).includes('SECRET TRANSCRIPT'), false);
  assert.equal(result.metrics.requests, 3);
  assert.equal(result.pendingReconciliations.status, 'not_read');
  for (const c of f.calls) {
    assert.equal(c.options.method, 'GET'); assert.equal(c.options.redirect, 'error'); assert.equal(c.options.credentials, 'omit');
    assert.equal(c.options.body, undefined);
  }
});

test('pagination retains exact source cursor and exposes capped continuation', async () => {
  const opaque = { rooms: { commons: 42 }, land: { commons: 7 }, landIds: { commons: 'tie-token' }, roomAfter: 'commons', floor: 1 };
  const f = transport(url => url.includes('/needs-me') ? page({ cursor: opaque, hasMore: true }) : undefined);
  const result = await resumeAgent({ connection, fetchImpl: f.fetchImpl, maxPages: 2 });
  assert.equal(result.metrics.attentionPages, 2);
  const second = f.calls.filter(x => x.url.includes('/needs-me'))[1];
  assert.deepEqual(JSON.parse(new URL(second.url).searchParams.get('since')), opaque);
  assert.deepEqual(result.observedThroughBySource.attention.cursor, opaque);
  assert.ok(result.incompleteSources.some(x => x.code === 'page_limit'));
  assert.ok(result.nextReads.some(x => x.action === 'continue_with_returned_cursor'));
  assert.equal(result.metrics.requests, 4);
});

test('last fresh authority denial drops all gathered private content and cursors', async () => {
  const f = transport((url, options, n) => n === 3 ? Response.json({ error: { message: connection.token } }, { status: 403 }) : undefined);
  const result = await resumeAgent({ connection, fetchImpl: f.fetchImpl });
  assert.deepEqual(result.obligations, []); assert.deepEqual(result.attention, []); assert.deepEqual(result.ownClaims, []);
  assert.deepEqual(result.observedThroughBySource, {});
  assert.equal(JSON.stringify(result).includes(connection.token), false);
  assert.equal(result.connection.status, 'unconfirmed');
});

test('identity mismatch refuses before attention read; no weaker fallback', async () => {
  const f = transport(() => context({ viewerId: 'other' }));
  const result = await resumeAgent({ connection, fetchImpl: f.fetchImpl });
  assert.equal(f.calls.length, 1); assert.equal(result.connection.status, 'unconfirmed');
});

test('partial unavailable attention is explicit and current obligations survive', async () => {
  const f = transport(url => url.includes('/needs-me') ? Response.json({ message: connection.token }, { status: 503 }) : undefined);
  const result = await resumeAgent({ connection, fetchImpl: f.fetchImpl });
  assert.equal(result.obligations.length, 1);
  assert.equal(result.incompleteSources[0].source, 'attention');
  assert.equal(JSON.stringify(result).includes(connection.token), false);
});

test('final changed projection replaces stale obligations', async () => {
  const f = transport((url, options, n) => n === 3 ? context({ context_version: 'c'.repeat(64), focusWork: [] }) : undefined);
  const result = await resumeAgent({ connection, fetchImpl: f.fetchImpl });
  assert.deepEqual(result.obligations, []);
  assert.equal(result.contextVersion, 'c'.repeat(64));
});

test('unchanged context keeps fresh cursors and directs reuse rather than inventing an empty queue', async () => {
  const f = transport(url => url.includes('since_version=') ? context({ not_modified: true, contractVersion: undefined, focusWork: undefined, locks: undefined, roster: undefined }) : undefined);
  const result = await resumeAgent({ connection, fetchImpl: f.fetchImpl, sinceVersion: version });
  assert.ok(result.nextReads.some(x => x.action === 'reuse_same_version_local_context'));
  assert.equal(result.observedThroughBySource.context.evaluatedThrough, 10);
  assert.equal(result.contextVersion, version);
});

test('oversized responses and never-settling transport are bounded', async () => {
  const large = transport(() => new Response('x'.repeat(4096)));
  const result = await resumeAgent({ connection, fetchImpl: large.fetchImpl, maxResponseBytes: 1024 });
  assert.equal(result.connection.status, 'unconfirmed');
  const keepAlive = setInterval(() => {}, 10);
  try {
    const timed = await resumeAgent({ connection, fetchImpl: () => new Promise(() => {}), timeoutMs: 20 });
    assert.equal(timed.incompleteSources[0].code, 'request_timeout');
  } finally { clearInterval(keepAlive); }
});

test('cross-room attention content is excluded and secret in any output field is refused', async () => {
  const f = transport(url => url.includes('/needs-me') ? page({ items: [{ kind: 'dm', roomId: 'elsewhere', id: 'private', seq: 2 }] }) : undefined);
  assert.deepEqual((await resumeAgent({ connection, fetchImpl: f.fetchImpl })).attention, []);
  const leak = transport(() => context({ focusWork: [{ id: 'x', title: connection.token }] }));
  await assert.rejects(resumeAgent({ connection, fetchImpl: leak.fetchImpl }), error => error.code === 'invalid_response');
});

test('malformed attention identity/cursor and unsolicited not-modified are refused', async () => {
  for (const malformed of [page({ identityId: '' }), page({ cursor: { rooms: { commons: -1 } } }), page({ cursor: { rooms: {}, extra: 'unknown' } })]) {
    const f = transport(url => url.includes('/needs-me') ? malformed : undefined);
    const result = await resumeAgent({ connection, fetchImpl: f.fetchImpl });
    assert.equal(result.incompleteSources[0].source, 'attention'); assert.deepEqual(result.attention, []);
  }
  const f = transport(() => context({ not_modified: true }));
  assert.equal((await resumeAgent({ connection, fetchImpl: f.fetchImpl })).connection.status, 'unconfirmed');
});

test('attention completion is never inferred from missing or nonboolean hasMore', async () => {
  for (const hasMore of [undefined, null, 'false', 0]) {
    const f = transport(url => url.includes('/needs-me') ? page({ hasMore }) : undefined);
    const result = await resumeAgent({ connection, fetchImpl: f.fetchImpl });
    assert.ok(result.incompleteSources.some(source => source.source === 'attention' && source.code === 'invalid_response'));
    assert.equal(result.observedThroughBySource.attention, undefined);
  }
});

test('failed continuation returns no fabricated progress and exact input cursor retries safely', async () => {
  const start = { rooms: { commons: 2 } }, next = { rooms: { commons: 5 } };
  let needs = 0;
  const f = transport(url => {
    if (!url.includes('/needs-me')) return undefined;
    needs++;
    if (needs === 2) return Response.json({}, { status: 503 });
    return page({ cursor: next, hasMore: needs === 1 || needs === 3 });
  });
  const first = await resumeAgent({ connection, fetchImpl: f.fetchImpl, attentionCursor: start });
  assert.ok(first.incompleteSources.some(source => source.source === 'attention'));
  assert.equal(first.observedThroughBySource.attention, undefined);
  assert.deepEqual(first.attention, []);
  const retry = await resumeAgent({ connection, fetchImpl: f.fetchImpl, attentionCursor: start });
  assert.deepEqual(retry.incompleteSources, []);
  const calls = f.calls.filter(call => call.url.includes('/needs-me'));
  assert.deepEqual(calls.map(call => JSON.parse(new URL(call.url).searchParams.get('since'))), [start, next, start, next]);
  assert.deepEqual(retry.observedThroughBySource.attention.cursor, next);
  assert.equal(retry.observedThroughBySource.attention.hasMore, false);
});

test('CLI help/invalid arguments never touch config or network and errors are sanitized', async () => {
  const printed = []; const fetchImpl = () => { throw new Error('network should not run'); };
  assert.equal(await main(['--help'], { env: {}, write: x => printed.push(x), fetchImpl }), 0);
  assert.equal(await main(['--bad'], { env: {}, write: x => printed.push(x), fetchImpl }), 1);
  assert.equal(await main(['--since-version', connection.token], { env: {}, write: x => printed.push(x), fetchImpl }), 1);
  let requests = 0;
  assert.equal(await main([], { env: { ROOM_AGENT_ORIGIN: connection.origin, ROOM_AGENT_ROOM: connection.roomId, ROOM_AGENT_MEMBER: connection.memberId }, write: x => printed.push(x), fetchImpl: () => { requests++; } }), 1);
  assert.equal(requests, 0);
  assert.equal(JSON.parse(printed.at(-1)).code, 'invalid_config');
  assert.equal(printed.join('').includes(connection.token), false);
  assert.equal(JSON.parse(printed[1]).code, 'usage_error');
});

test('real HTTP compact resume measures bytes against existing full snapshot and conditional repeat', async t => {
  const store = new RoomStore(':memory:');
  const rooms = new AgentRooms(store); const owner = store.identities.create('Owner'); const worker = store.identities.create('Worker');
  rooms.create(owner.secret, { roomId: 'commons', title: 'Test', purpose: 'Resume fixture', kind: 'personal' });
  store.identities.link(owner.secret, 'commons', { identityId: worker.identityId, displayName: 'Worker', permissions: [] });
  for (let i = 0; i < 30; i++) store.command(owner.secret, 'commons', { id: `post${i}`, type: 'message.posted', data: { messageId: `msg${i}`, body: 'private-body-sentinel-' + 'x'.repeat(1000) } });
  store.command(owner.secret, 'commons', { id: 'task', type: 'work.proposed', data: { workItemId: 'task', title: 'Review', definitionOfDone: 'Do review', accountableMemberId: worker.identityId, mode: 'read' } });
  const server = createRoomServer({ store }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const config = { origin, roomId: 'commons', memberId: worker.identityId, token: worker.secret };
  let baselineBytes = 0, baselineRequests = 0;
  const baselineClient = new RoomAgentClient({ ...config, fetchImpl: async (url, options) => {
    const response = await fetch(url, options); baselineRequests++; baselineBytes += Buffer.byteLength(await response.clone().text()); return response;
  } });
  await baselineClient.roomContext();
  const first = await resumeAgent({ connection: config });
  assert.equal(first.connection.status, 'credential_accepted'); assert.deepEqual(first.incompleteSources, []);
  assert.ok(first.obligations.some(x => x.id === 'task'));
  assert.equal(JSON.stringify(first).includes('private-body-sentinel'), false);
  assert.equal(first.metrics.requests, 3);
  const rpc = async (method, params) => {
    const response = await fetch(origin + '/room/mcp?profile=full', { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${worker.secret}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'resume', method, params }) });
    return response.json();
  };
  const listed = await rpc('tools/list', {});
  const hint = first.nextReads.find(read => read.source === 'work');
  const tool = listed.result.tools.find(tool => tool.name === hint.tool);
  assert.ok(tool); assert.ok(tool.inputSchema.required.includes('roomId'));
  for (const key of Object.keys(hint.arguments)) assert.ok(Object.hasOwn(tool.inputSchema.properties, key));
  const transported = await rpc('tools/call', { name: hint.tool, arguments: hint.arguments });
  assert.equal(transported.error, undefined); assert.notEqual(transported.result.isError, true);
  assert.equal(transported.result.structuredContent.work.id, 'task');
  const repeat = await resumeAgent({ connection: config, sinceVersion: first.contextVersion, attentionCursor: first.observedThroughBySource.attention.cursor });
  assert.ok(Buffer.byteLength(JSON.stringify(repeat)) < Buffer.byteLength(JSON.stringify(first)));
  assert.ok(first.metrics.responseBytes < baselineBytes);
  const mismatch = await resumeAgent({ connection: { ...config, memberId: owner.identityId } });
  assert.equal(mismatch.connection.status, 'unconfirmed'); assert.equal(mismatch.metrics.requests, 1);
  const aliasIdentity = store.identities.create('Alias');
  store.identities.link(owner.secret, 'commons', { identityId: aliasIdentity.identityId, memberId: 'custom-linked-member', displayName: 'Alias', permissions: [] });
  const alias = await resumeAgent({ connection: { ...config, token: aliasIdentity.secret, memberId: 'custom-linked-member' } });
  assert.equal(alias.connection.status, 'credential_accepted'); assert.deepEqual(alias.incompleteSources, []);
  assert.equal(alias.authoritySummary.id, 'custom-linked-member');
  let revoked = false;
  const ended = await resumeAgent({ connection: config, fetchImpl: async (url, options) => {
    const response = await fetch(url, options);
    if (String(url).includes('/needs-me') && !revoked) {
      await response.clone().text(); store.identities.unlink(owner.secret, 'commons', worker.identityId); revoked = true;
    }
    return response;
  } });
  assert.equal(ended.connection.status, 'unconfirmed');
  assert.deepEqual(ended.attention, []); assert.deepEqual(ended.obligations, []); assert.deepEqual(ended.observedThroughBySource, {});
  console.log(JSON.stringify({ benchmark: 'synthetic30messages1000chars', baselineRequests, baselineBytes, first: first.metrics, repeat: repeat.metrics }));
});
