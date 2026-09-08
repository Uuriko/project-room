import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAcceptanceFixture } from '../scripts/acceptance-fixture.mjs';
import { createRoomServer } from '../server/http.mjs';
import { RoomAgentClient } from '../client/room-agent.mjs';
import { currentWorkRecord } from '../server/work-context.mjs';
import { auditRecovery } from '../server/recovery.mjs';
import { createRuntimePackage } from '../scripts/runtime-package.mjs';

async function fixture(t) {
  const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const config = { origin, roomId: 'commons', memberId: 'producer', token: f.keys.producer };
  const get = (query = '', headers = { Authorization: `Bearer ${f.keys.producer}` }) => fetch(`${origin}/api/rooms/commons${query}`, { headers });
  return { ...f, server, origin, config, get };
}

test('work snapshot is a current-only committed read without messages, historical receipts or cursor reads', async t => {
  const f = await fixture(t);
  const change = (type, data = {}) => f.store.command(f.keys.producer, 'commons', { id: crypto.randomUUID(), type,
    data: { workItemId: 'test-handoff', expectedRevision: f.store.room('commons').state.workItems['test-handoff'].revision, ...data } });
  change('work.accepted');
  const complete = summary => change('work.completed', { summary, nextAction: 'Review', producerId: 'producer',
    evidenceUrl: 'https://example.invalid/not-fetched', evidenceVersion: crypto.randomUUID() });
  complete('Historical-only summary');
  change('work.blocked', { reason: 'Correction', nextAction: 'Revise' });
  change('work.blocker_resolved', { resolution: 'Prepared' }); complete('Current-only summary');
  const full = await (await f.get()).json(), before = auditRecovery(f.store).dataSha256;
  const statements = [], prepare = f.store.db.prepare.bind(f.store.db);
  t.mock.method(f.store.db, 'prepare', sql => { statements.push(sql); return prepare(sql); });
  const response = await f.get('?view=work'), work = await response.json();
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(work.snapshotView, 'work'); assert.equal(work.snapshotVersion, 1);
  assert.deepEqual(Object.keys(work.state).sort(), ['members', 'room', 'workItems']);
  assert.equal(Object.hasOwn(work, 'cursor'), false); assert.equal(Object.hasOwn(work, 'replyRequestContractVersion'), false);
  assert.equal(work.sequence, full.sequence); assert.equal(work.viewerId, 'producer'); assert.deepEqual(work.charter, full.charter);
  assert.deepEqual(work.state.members, full.state.members);
  for (const [id, item] of Object.entries(full.state.workItems)) assert.deepEqual(work.state.workItems[id], currentWorkRecord(item));
  for (const message of full.state.messages) assert.equal(JSON.stringify(work).includes(message.body), false);
  assert.equal(JSON.stringify(work).includes('Historical-only summary'), false);
  assert.equal(work.state.workItems['test-handoff'].receipt.summary, 'Current-only summary');
  assert.equal(statements.some(sql => /FROM (events|cursors) WHERE/.test(sql)), false);
  assert.equal(auditRecovery(f.store).dataSha256, before);
  assert.deepEqual(await (await f.get()).json(), full);
});

test('view selectors are strict and keep authentication, session binding and default snapshots intact', async t => {
  const f = await fixture(t);
  for (const query of ['?view=', '?view=full', '?view=unknown', '?view=work&view=work', '?view=work&query=private']) {
    const response = await f.get(query); assert.equal(response.status, 422);
    assert.equal((await response.json()).error.code, 'invalid_snapshot_view');
  }
  assert.equal((await f.get('?view=work', {})).status, 401);
  const session = f.store.createSession(f.keys.owner), headers = { Cookie: `room_session=${session.token}`,
    'X-Session-Binding': session.session.sessionBinding };
  const owned = await (await f.get('?view=work', headers)).json();
  assert.equal(owned.viewerId, 'owner'); assert.equal(owned.viewerSessionBinding, session.session.sessionBinding);
  assert.equal((await f.get('?view=work', { ...headers, 'X-Session-Binding': '0'.repeat(64) })).status, 409);
  f.store.revoke(f.keys.producer); assert.equal((await f.get('?view=work')).status, 401);
});

test('malformed work views fail after the original read without a weaker fallback or query disclosure', async t => {
  const f = await fixture(t), original = await (await f.get('?view=work')).json();
  const mutations = [value => { value.snapshotVersion = 2; }, value => { delete value.snapshotView; },
    value => { value.state.messages = []; }, value => { value.sequence = -1; }, value => { value.state.room.id = 'other'; },
    value => { value.viewerId = 'reviewer'; }, value => { value.viewerSessionBinding = '0'.repeat(64); },
    value => { value.state.members.producer.kind = 'human'; }, value => { value.state.members.producer.active = false; },
    value => { value.state.members.producer.permissions = ['not-a-permission']; },
    value => { value.state.workItems['test-handoff'].revision = -1; }, value => { value.state.workItems['test-handoff'].receipt = {}; },
    value => { value.state.workItems['test-handoff'].receiptHistory = []; }, value => { value.charter.revision = 99; }];
  for (const mutate of mutations) {
    const corrupted = structuredClone(original); mutate(corrupted); const requests = [];
    const client = new RoomAgentClient({ ...f.config, fetchImpl: async (url, options) => {
      requests.push(url); if (new URL(url).pathname === '/api/session') return fetch(url, options);
      return Response.json(corrupted);
    } });
    await assert.rejects(client.orient({ query: 'synthetic-private-phrase' }), error => ['identity_mismatch', 'invalid_response'].includes(error.code));
    assert.equal(requests.length, 2); assert.equal(new URL(requests[1]).search, '?view=work');
    assert.equal(requests.some(url => url.includes('synthetic-private-phrase')), false);
  }
  const legacy = await (await f.get()).json(); delete legacy.state.eventLog;
  const client = new RoomAgentClient({ ...f.config, fetchImpl: (url, options) => new URL(url).pathname === '/api/session'
    ? fetch(url, options) : Promise.resolve(Response.json(legacy)) });
  await assert.rejects(client.orient({ focus: 'needs_me' }), { code: 'invalid_response' });
});

test('focused/search results match a legacy full response and never retry transport failure as a snapshot', async t => {
  const f = await fixture(t), plain = new RoomAgentClient(f.config);
  const legacy = new RoomAgentClient({ ...f.config, fetchImpl: (url, options) => {
    const target = new URL(url); target.searchParams.delete('view'); return fetch(target, options);
  } });
  const normalize = value => { delete value.evaluatedAt; return value; };
  for (const options of [{ focus: 'needs_me' }, { query: 'agenda' }, { query: 'agenda', focus: 'needs_me' }]) {
    assert.deepEqual(normalize(await plain.orient(options)), normalize(await legacy.orient(options)));
  }
  let reads = 0;
  const failed = new RoomAgentClient({ ...f.config, fetchImpl: (url, options) => {
    if (new URL(url).pathname === '/api/session') return fetch(url, options);
    reads++; throw new TypeError('Synthetic disconnected read');
  } });
  await assert.rejects(failed.orient({ query: 'agenda' }), /Synthetic disconnected/); assert.equal(reads, 1);
});

test('new discovery client reads exact schema12 fallback without upgrading or mutating it', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'work-snapshot-fallback-')), root = join(directory, 'runtime');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  createRuntimePackage({ repository: resolve('.'), commit: '4d22189ccdebc56db23397e6cc75b07eff0e3c2c', destination: root });
  const { RoomStore } = await import(pathToFileURL(join(root, 'server/store.mjs')));
  const { createRoomServer: fallbackServer } = await import(pathToFileURL(join(root, 'server/http.mjs')));
  const f = createAcceptanceFixture(); f.store.close(); const store = new RoomStore(join(f.directory, 'room.sqlite'));
  const server = fallbackServer({ store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`, responses = [], before = auditRecovery(store).dataSha256;
  const client = new RoomAgentClient({ origin, roomId: 'commons', memberId: 'producer', token: f.keys.producer,
    fetchImpl: async (...args) => { const response = await fetch(...args); responses.push(await response.clone().json()); return response; } });
  const result = await client.orient({ query: 'agenda', focus: 'needs_me' });
  assert.equal(result.work[0].id, 'test-handoff'); assert.equal(result.selection.shown, 1);
  assert.equal(responses.length, 2); assert.equal(responses[1].snapshotView, undefined); assert.ok(Array.isArray(responses[1].state.messages));
  assert.equal(auditRecovery(store).dataSha256, before);
});
