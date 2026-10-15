// Test gate: actual HTTP + SQLite protects viewer privacy, current-record
// reconstruction and reset semantics. Existing full snapshot tests cannot
// exercise signed bounded continuations. No production test seam.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomStore } from '../server/store.mjs';
import { createRoomServer } from '../server/http.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { constants as sqlite } from 'node:sqlite';
import { setTier } from '../server/autonomy-tiers.mjs';

async function setup(t, indexed = false) {
  const directory = mkdtempSync(join(tmpdir(), 'conversation-sync-'));
  let store = new RoomStore(join(directory, 'room.sqlite'));
  store.initialize(initialRoom('commons'));
  const owner = store.issueAccessKey('commons', 'owner');
  const command = (token, type, data) => store.command(token, 'commons', { id: randomUUID(), type, data });
  for (const id of ['alice', 'bob']) {
    command(owner, 'member.added', { memberId: id, displayName: id, kind: 'agent', permissions: ['steer', 'accept_work'] });
    setTier(store.db, 'commons', id, 't2_standard', { updatedBy: 'owner', nowMs: Date.now() });
  }
  const alice = store.issueAccessKey('commons', 'alice'), bob = store.issueAccessKey('commons', 'bob');
  let server, origin;
  const start = async () => { server = createRoomServer({ store }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${server.address().port}`; };
  const stop = async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); };
  await start();
  t.after(async () => { await stop(); rmSync(directory, { recursive: true, force: true }); });
  return { owner, alice, bob, command, get store() { return store; },
    post: (id, body, extra = {}, token = owner) => command(token, 'message.posted', { messageId: id, body, ...extra }),
    get: async (query = {}, token = owner, path = '/conversation') => {
      if (indexed) {
        while (!store.backfillMessages({ limit: 1000 }).done) { /* budgeted test replay */ }
        store.checkMessagesParity();
      }
      const response = await fetch(`${origin}/api/rooms/commons${path}?${new URLSearchParams(query)}`, { headers: { Authorization: `Bearer ${token}` } });
      return { status: response.status, value: await response.json() };
    },
    restart: async () => { await stop(); store = new RoomStore(join(directory, 'room.sqlite')); await start(); }
  };
}

for (const indexed of [false, true]) {
test(`${indexed ? 'certified index' : 'projection fallback'}: bounded HTTP conversation filters before paging and resets instead of mixing stale current records`, async t => {
  const f = await setup(t, indexed);
  for (let i = 0; i < 7; i++) f.post(`public-${i}`, `text ${i}`, i === 6 ? { replyToId: 'public-0' } : {});
  for (let i = 0; i < 5; i++) f.post(`private-${i}`, `secret ${i}`, { toMemberId: 'bob' }, f.alice);
  const first = await f.get({ limit: 3 });
  assert.equal(first.status, 200, JSON.stringify(first.value));
  assert.equal(first.value.mode, 'replace');
  assert.deepEqual(first.value.messages.map(m => m.id), ['public-4', 'public-5', 'public-6']);
  assert.equal(first.value.messages.at(-1).replyToId, 'public-0');
  assert.equal(JSON.stringify(first.value).includes('secret'), false);
  const next = await f.get({ limit: 3, cursor: first.value.nextCursor });
  assert.deepEqual(next.value.messages.map(m => m.id), ['public-1', 'public-2', 'public-3']);
  const last = await f.get({ limit: 3, cursor: next.value.nextCursor });
  assert.deepEqual(last.value.messages.map(m => m.id), ['public-0']);
  assert.equal(last.value.nextCursor, null);
  const unchanged = await f.get({ limit: 3, since: first.value.checkpoint });
  assert.equal(unchanged.value.mode, 'not_modified');
  assert.equal(Object.hasOwn(unchanged.value, 'messages'), false);
  assert.equal((await f.get({ messageId: 'public-0' })).value.messages[0].body, 'text 0');
  assert.equal((await f.get({ messageId: 'private-0' })).status, 404);
  assert.equal((await f.get({ messageId: 'private-0' }, f.bob)).value.messages[0].body, 'secret 0');
  assert.equal((await f.get({ limit: 3, cursor: first.value.nextCursor }, f.bob)).value.mode, 'reset');
  assert.equal((await f.get({ limit: 3, cursor: first.value.nextCursor + 'x' })).value.mode, 'reset');
  assert.equal((await f.get({ limit: 2, since: first.value.checkpoint })).value.mode, 'reset');
  f.command(f.owner, 'message.edited', { messageId: 'public-0', body: 'edited root', expectedMessageRevision: 0 });
  const invalidated = await f.get({ limit: 3, since: first.value.checkpoint });
  assert.equal(invalidated.value.mode, 'replace', 'an older loaded page changed; invalidate the whole cached history');
  assert.equal((await f.get({ limit: 3, cursor: first.value.nextCursor })).value.mode, 'reset');
  const edited = (await f.get({ messageId: 'public-0' })).value.messages[0];
  assert.equal(edited.body, 'edited root');
  assert.equal(Object.hasOwn(edited, 'editHistory'), false);
  f.command(f.owner, 'message.deleted', { messageId: 'public-0', expectedMessageRevision: 1 });
  assert.equal((await f.get({ messageId: 'public-0' })).value.messages[0].body, null);
  const checkpoint = (await f.get({ limit: 3 })).value.checkpoint;
  await f.restart();
  assert.equal((await f.get({ limit: 3, since: checkpoint })).value.mode, 'reset');
  assert.equal((await f.get({ messageId: 'public-0' })).value.messages[0].body, null);
  const bobCheckpoint = (await f.get({}, f.bob)).value.checkpoint;
  f.command(f.owner, 'member.access_changed', { memberId: 'bob', expectedMemberRevision: 0, active: false, permissions: ['steer', 'accept_work'] });
  assert.equal((await f.get({ since: bobCheckpoint }, f.bob)).status, 401, 'conditional reads reauthorize revoked credentials');
});

test(`${indexed ? 'certified index' : 'projection fallback'}: conversation payload stays bounded and malformed selections cannot widen it`, async t => {
  const f = await setup(t, indexed);
  for (let i = 0; i < 24; i++) f.post(`large-${i}`, 'x'.repeat(60000));
  const full = await f.get({}, f.owner, '');
  const page = await f.get({ limit: 100 });
  assert.equal(page.status, 200, JSON.stringify(page.value));
  assert.ok(page.value.messages.length < 24 && page.value.messages.length > 0);
  assert.ok(page.value.messageBytes <= 512 * 1024);
  assert.ok(JSON.stringify(page.value).length < JSON.stringify(full.value).length / 3);
  const seen = [...page.value.messages.map(m => m.id)];
  let cursor = page.value.nextCursor;
  while (cursor) {
    const older = await f.get({ limit: 100, cursor });
    assert.equal(older.value.mode, 'replace');
    seen.push(...older.value.messages.map(m => m.id)); cursor = older.value.nextCursor;
  }
  assert.equal(new Set(seen).size, 24);
  assert.equal(seen.length, 24);
  for (const query of [{ limit: 101 }, { limit: 0 }, { limit: 'NaN' }, { extra: 1 }, { cursor: 'x', since: 'x' }])
    assert.equal((await f.get(query)).status, 422);
  t.diagnostic(`full snapshot ${JSON.stringify(full.value).length} bytes; bounded response ${JSON.stringify(page.value).length} bytes`);
});

// Authoring gate: extend the real HTTP/SQLite owner for channel selection,
// pre-limit DM exclusion and credential/channel-bound continuations. Existing
// cases cannot select a channel. No production seam or duplicate fixture.
test(`${indexed ? 'certified index' : 'projection fallback'}: channel conversation pages isolate public history and bind continuations to the channel`, async t => {
  const f = await setup(t, indexed);
  f.command(f.owner, 'channel.created', { channelId: 'design', name: 'design' });
  for (let i = 0; i < 5; i++) {
    f.post(`general-${i}`, `general ${i}`);
    f.post(`design-${i}`, `design ${i}`, { channelId: 'design' });
  }
  f.post('design-reply', 'reply in design', { replyToId: 'design-0' });
  // Even the addressed viewer must not get a DM mixed into a public channel.
  for (let i = 0; i < 3; i++) f.post(`dm-${i}`, `private ${i}`, { channelId: 'design', toMemberId: 'bob' }, f.alice);
  const first = await f.get({ channelId: 'design', limit: 2 }, f.bob);
  assert.equal(first.status, 200, JSON.stringify(first.value));
  assert.equal(first.value.channelId, 'design');
  assert.deepEqual(first.value.messages.map(m => m.id), ['design-4', 'design-reply']);
  const next = await f.get({ channelId: 'design', limit: 2, cursor: first.value.nextCursor }, f.bob);
  assert.deepEqual(next.value.messages.map(m => m.id), ['design-2', 'design-3']);
  const last = await f.get({ channelId: 'design', limit: 2, cursor: next.value.nextCursor }, f.bob);
  assert.deepEqual(last.value.messages.map(m => m.id), ['design-0', 'design-1']);
  assert.equal(last.value.nextCursor, null);
  assert.equal((await f.get({ channelId: 'design', limit: 2, since: first.value.checkpoint }, f.bob)).value.mode, 'not_modified');
  for (const channelId of ['general', undefined]) {
    const selection = channelId ? { channelId } : {};
    assert.equal((await f.get({ ...selection, limit: 2, cursor: first.value.nextCursor }, f.bob)).value.mode, 'reset');
    assert.equal((await f.get({ ...selection, limit: 2, since: first.value.checkpoint }, f.bob)).value.mode, 'reset');
  }
  assert.equal((await f.get({ channelId: 'design', messageId: 'general-0' })).status, 404);
  assert.equal((await f.get({ channelId: 'design', messageId: 'dm-0' }, f.bob)).status, 404);
  assert.equal((await f.get({ channelId: 'design', messageId: 'design-reply' })).value.messages[0].replyToId, 'design-0');
  assert.equal((await f.get({ messageId: 'dm-0' }, f.bob)).value.messages[0].body, 'private 0', 'unscoped viewer read retains its DM contract');
  assert.equal((await f.get({ channelId: 'missing' })).status, 404);
  for (const channelId of ['', 'bad/channel', 'x'.repeat(201)]) assert.equal((await f.get({ channelId })).status, 422);
  const repeated = await f.get(new URLSearchParams([['channelId', 'design'], ['channelId', 'general']]));
  assert.equal(repeated.status, 422);
  f.command(f.owner, 'channel.archived', { channelId: 'design' });
  assert.equal((await f.get({ channelId: 'design', messageId: 'design-0' })).value.messages[0].body, 'design 0', 'archiving does not erase history');
});

}

// Authoring gate: storage-read architecture contract at real HTTP/SQLite.
// Counts observer-visible table reads rather than matching SQL source. Existing
// response assertions cannot distinguish a JSON scan from indexed records.
// Losing the cutover, or using uncertified/stale records, fails this owner.
// Native SQLite authorization observation introduces no production seam.
test('conversation uses only exact-head certified rows and resets on cursor domain changes', async t => {
  const f = await setup(t);
  f.post('root', 'root');
  f.post('reply', 'reply', { replyToId: 'root', alsoSendToChannel: true });
  const reads = new Set();
  f.store.db.setAuthorizer((operation, table) => {
    if (operation === sqlite.SQLITE_READ) reads.add(table);
    return sqlite.SQLITE_OK;
  });
  const before = await f.get({ limit: 1 });
  assert.equal(reads.has('messages'), false, 'uncertified rows must not serve reads');
  while (!f.store.backfillMessages({ limit: 1000 }).done) {}
  f.store.checkMessagesParity();
  reads.clear();
  const indexed = await f.get({ limit: 1 });
  assert.equal(reads.has('messages'), true, 'certified HTTP reads must reach the indexed records');
  assert.equal((await f.get({ limit: 1, cursor: before.value.nextCursor })).value.mode, 'reset');
  assert.equal(indexed.value.messages[0].id, 'reply:channel');
  const older = await f.get({ limit: 1, cursor: indexed.value.nextCursor });
  assert.equal(older.value.messages[0].id, 'reply', 'same-event channel copy keeps projection order');
  f.command(f.owner, 'message.edited', { messageId: 'root', body: 'changed', expectedMessageRevision: 0 });
  reads.clear();
  assert.equal((await f.get({ messageId: 'root' })).value.messages[0].body, 'changed');
  assert.equal(reads.has('messages'), false, 'a changed head falls back without synchronous replay');
  while (!f.store.backfillMessages({ limit: 1000 }).done) {}
  f.store.checkMessagesParity();
  f.command(f.owner, 'message.deleted', { messageId: 'root', expectedMessageRevision: 1 });
  reads.clear();
  assert.equal((await f.get({ messageId: 'root' })).value.messages[0].body, null);
  assert.equal(reads.has('messages'), false, 'redaction invalidates certification');
  f.store.db.setAuthorizer(null);
  while (!f.store.backfillMessages({ limit: 1000 }).done) {}
  f.store.checkMessagesParity();
  const replacement = [...f.store.exportEvents(f.owner, 'commons')].map(line => {
    const event = line.event;
    if (event.type === 'message.posted' && event.data.messageId === 'reply') event.data.body = 'import replacement';
    return { ...line, event };
  });
  f.store.importEvents(f.owner, 'commons', replacement);
  reads.clear();
  f.store.db.setAuthorizer((operation, table) => {
    if (operation === sqlite.SQLITE_READ) reads.add(table);
    return sqlite.SQLITE_OK;
  });
  assert.equal((await f.get({ messageId: 'reply' })).value.messages[0].body, 'import replacement');
  assert.equal(reads.has('messages'), false, 'replacement invalidates certified records even with the same head');
  f.store.db.setAuthorizer(null);
});

// Distinct indexed-query risk: same-millisecond exclusion must run before
// LIMIT so hidden pre-join records do not consume a bounded visible page.
test('certified conversation applies the same-instant history floor before paging', async t => {
  const f = await setup(t, true);
  f.store.now = () => Date.parse('2026-10-05T12:00:00.000Z');
  f.post('before', 'hidden before join');
  f.command(f.owner, 'room.history_visibility_set', { historyVisibility: 'since_join' });
  f.command(f.owner, 'member.added', { memberId: 'late', displayName: 'Late', kind: 'agent', permissions: [] });
  const late = f.store.issueAccessKey('commons', 'late');
  f.post('after', 'visible after join');
  const page = await f.get({ limit: 1 }, late);
  assert.deepEqual(page.value.messages.map(m => m.id), ['after']);
  assert.equal(page.value.nextCursor, null);
  assert.equal((await f.get({ messageId: 'before' }, late)).status, 404);
});

// Authoring gate: excluded records cannot truncate an otherwise visible page.
// Clock rollback/imported timestamps can put visible rows behind excluded ones;
// existing monotonic histories cannot expose this post-LIMIT regression.
test('history exclusions precede LIMIT for fallback and certified nonmonotonic history', async t => {
  const f = await setup(t);
  const at = Date.now();
  f.store.now = () => at + 1000;
  f.post('future-time-earlier-position', 'visible under the existing timestamp policy');
  f.store.now = () => at;
  for (let i = 0; i < 4; i++) f.post(`prejoin-${i}`, 'hidden before join');
  f.command(f.owner, 'room.history_visibility_set', { historyVisibility: 'since_join' });
  f.command(f.owner, 'member.added', { memberId: 'late', displayName: 'Late', kind: 'agent', permissions: [] });
  const late = f.store.issueAccessKey('commons', 'late');
  f.post('after', 'after join');
  for (const indexed of [false, true]) {
    if (indexed) {
      while (!f.store.backfillMessages({ limit: 1000 }).done) {}
      f.store.checkMessagesParity();
    }
    const page = await f.get({ limit: 2 }, late);
    assert.deepEqual(page.value.messages.map(m => m.id), ['future-time-earlier-position', 'after']);
    assert.equal(page.value.nextCursor, null);
  }
});
