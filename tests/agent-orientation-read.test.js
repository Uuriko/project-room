import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomStore } from '../server/store.mjs';
import { createRoomServer } from '../server/http.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { RoomAgentClient } from '../client/room-agent.mjs';
import { sortWorkByCuriosity, viewerHistory } from '../src/curiosity-rank.mjs';
import { createAcceptanceFixture } from '../scripts/acceptance-fixture.mjs';

for (const bodiesAtRest of [false, true]) test(`orientation preserves handoffs without cold conversation hydration (at-rest ${bodiesAtRest})`, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'orientation-')), path = join(dir, 'room.sqlite');
  let now = Date.now(), store = new RoomStore(path, { bodiesAtRest, now: () => now });
  store.initialize(initialRoom());
  const token = store.issueAccessKey('commons', 'owner');
  const command = (type, data) => { now += 2000; return store.command(token, 'commons', { id: crypto.randomUUID(), type, data }); };
  for (let i = 0; i < 100; i++) command('message.posted', { messageId: `m-${i}`, body: `unrelated-sentinel-${i} ` + 'x'.repeat(2000) });
  command('work.proposed', { workItemId: 'one', title: 'Inspect storage', definitionOfDone: 'Prove bounded reads', mode: 'read', accountableMemberId: 'owner' });
  const change = (type, data = {}) => command(type, { workItemId: 'one', expectedRevision: store.room('commons').state.workItems.one.revision, ...data });
  change('work.accepted');
  for (let i = 0; i < 2; i++) change('work.handoff_recorded', { doneSummary: `Progress ${i}`, nextAction: 'Review', limitReason: 'Review requested', haltAll: true });
  const full = store.snapshot(token, 'commons');
  store.close();
  store = new RoomStore(path, { bodiesAtRest, now: () => now });
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`, paths = [];
  const config = { origin, roomId: 'commons', token, fetchImpl: (url, options) => { paths.push(new URL(url).pathname + new URL(url).search); return fetch(url, options); } };
  const client = new RoomAgentClient(config);
  const guard = t.mock.method(store, 'room', () => { throw Error('orientation hydrated full room'); });
  const get = (suffix = '?view=orientation', extra = {}) => fetch(origin + '/api/rooms/commons' + suffix,
    { headers: { authorization: `Bearer ${token}`, ...extra } });
  const response = await get(), packet = await response.json();
  assert.equal(response.status, 200, JSON.stringify(packet));
  assert.equal(packet.snapshotView, 'orientation');
  assert.deepEqual(Object.keys(packet.state).sort(), ['members', 'room', 'workItems']);
  assert.deepEqual(packet.state.members, full.state.members);
  assert.deepEqual(packet.charter, full.charter);
  assert.equal(JSON.stringify(packet).includes('unrelated-sentinel'), false);
  assert.equal(Object.hasOwn(packet, 'cursor'), false);
  for (const key of ['claim', 'receipt', 'verification', 'decision', 'blocker', 'handoff', 'handoffHistory']) {
    assert.deepEqual(packet.state.workItems.one[key], full.state.workItems.one[key], key);
  }
  const oriented = await client.orient();
  assert.deepEqual(oriented.work[0].handoffHistory, full.state.workItems.one.handoffHistory);
  assert.equal(oriented.work[0].handoffHistory.length, 1);
  assert.equal(oriented.work[0].next.action, 'triaged_handoff');
  const ranked = await client.orient({ sort: 'curiosity' });
  const expected = sortWorkByCuriosity(Object.values(full.state.workItems), viewerHistory(full.state, 'owner'));
  assert.deepEqual(ranked.work.map(w => [w.id, w.curiosity]), expected.map(w => [w.item.id, w.curiosity]));
  assert.equal(paths.some(p => p === '/api/rooms/commons'), false);
  assert.equal(guard.mock.callCount(), 0);
  for (const header of ['x-project-room-help-context', 'x-project-room-offer-context', 'x-project-room-audit-view']) {
    assert.equal((await get('?view=orientation', { [header]: header.endsWith('audit-view') ? 'activity-v1' : '1' })).status, 422);
  }
  for (const suffix of ['?view=orientation&view=work', '?view=orientation&messages=recent', '?view=orientation&unknown=1']) assert.equal((await get(suffix)).status, 422);
  for (const mutate of [p => { p.snapshotView = 'work'; }, p => { p.snapshotVersion = 2; },
    p => { p.state.messages = []; }, p => { p.viewerId = 'other'; }, p => { p.state.workItems.one.receiptHistory = []; }]) {
    const invalid = structuredClone(packet); mutate(invalid); const reads = [];
    const broken = new RoomAgentClient({ ...config, fetchImpl: (url, options) => {
      reads.push(new URL(url).pathname + new URL(url).search);
      return new URL(url).search === '?view=orientation' ? Promise.resolve(Response.json(invalid)) : fetch(url, options);
    } });
    await assert.rejects(broken.orient(), error => ['invalid_response', 'identity_mismatch'].includes(error.code));
    assert.equal(reads.filter(p => p.endsWith('?view=orientation')).length, 1);
    assert.equal(reads.some(p => p === '/api/rooms/commons'), false);
  }
  guard.mock.restore();
  const legacyWindow = await (await get('')).text();
  assert.equal(store.room('commons').state.messages.length, 100, 'partial reads never poison the full-room cache');
  store.revoke(token);
  await assert.rejects(client.orient(), error => error.status === 401);
  t.diagnostic(`100 messages; HTTP message window ${Buffer.byteLength(legacyWindow)}; orientation ${Buffer.byteLength(JSON.stringify(packet))}; full hydration calls 0`);
});

test('orientation retains configured-agent identity and session fences after preflight', async t => {
  const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(origin + '/api/rooms/commons?view=orientation', { headers: { authorization: `Bearer ${f.keys.producer}` } });
  const packet = await response.json();
  assert.equal(response.status, 200);
  const mutations = [p => { p.viewerId = 'owner'; }, p => { p.state.members.producer.kind = 'human'; },
    p => { p.state.members.producer.active = false; },
    ...['viewerAccountId', 'viewerAuthEpoch', 'viewerSessionBinding', 'viewerSessionRevision'].map(key => p => { p[key] = 'unexpected'; })];
  for (const mutate of mutations) {
    const value = structuredClone(packet); mutate(value); const paths = [];
    const client = new RoomAgentClient({ origin, roomId: 'commons', memberId: 'producer', token: f.keys.producer,
      fetchImpl: (url, options) => {
        paths.push(new URL(url).pathname + new URL(url).search);
        return new URL(url).search === '?view=orientation' ? Promise.resolve(Response.json(value)) : fetch(url, options);
      } });
    await assert.rejects(client.orient(), { code: 'identity_mismatch' });
    assert.deepEqual(paths, ['/api/session', '/api/rooms/commons?view=orientation']);
  }
});
