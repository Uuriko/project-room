import test from 'node:test';
import assert from 'node:assert/strict';
import {RoomStore} from '../server/store.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {event} from '../src/events.js';
import {readEventTail} from '../server/updates.mjs';
import {createRoomServer} from '../server/http.mjs';

// W3200 R-07/R-08: a current-format event read must scan past the old fixed
// 16-sequence candidate window (bounded by the byte/record budgets instead),
// so catch-up and filtered search take a bounded, reasonable number of calls,
// and ?tail=N must deliver N visible events in one call when they exist.

function fixture(t, posts = 300, sparseAlice = 0) {
  const store = new RoomStore(':memory:'); t.after(() => store.close());
  const events = initialRoom();
  const add = (type, data, actorId = 'owner') => events.push(event({roomId: 'commons', actorId, type, data}));
  for (const memberId of ['alice', 'reader']) add('member.added', {memberId, displayName: memberId, kind: 'agent', permissions: []});
  for (let i = 0; i < posts; i++) add('message.posted', {messageId: 'm-' + i, body: 'msg ' + i});
  for (let i = 0; i < sparseAlice; i++) add('message.posted', {messageId: 'sparse-' + i, body: 'SPARSE-' + i}, 'alice');
  store.initialize(events, {representation: 'normalized-current-v1'});
  const key = store.issueAccessKey('commons', 'reader');
  return {store, key, total: events.length};
}

function walk(store, key, opts = null, limit = 100) {
  let after = 0, calls = 0; const all = [];
  while (true) {
    const page = store.eventsAfter(key, 'commons', after, limit, opts);
    calls++; all.push(...page.events);
    if (!page.hasMore) break;
    assert.ok(page.next > after, 'cursor must advance on a hasMore page');
    after = page.next;
    assert.ok(calls < 1000, 'walk must terminate');
  }
  return {calls, all};
}

test('R-07: unfiltered catch-up of a 300-post current room takes a bounded number of calls', t => {
  const {store, key, total} = fixture(t, 300);
  const {calls, all} = walk(store, key);
  assert.equal(all.length, total, 'every visible event is delivered exactly once across the walk');
  // Old shape: ceil(304/16) = 19 calls at exactly 16 events per call.
  assert.ok(calls <= 6, `catch-up took ${calls} calls for ${total} events; expected <= 6 (was 19 at the 16-window shape)`);
});

test('R-07: filtered search for sparse late matches does not pay a call per 16 sequences', t => {
  const {store, key} = fixture(t, 300, 3);
  const {calls, all} = walk(store, key, {actor: 'alice'});
  assert.deepEqual(all.map(x => x.event.data.messageId), ['sparse-0', 'sparse-1', 'sparse-2']);
  // Old shape: 20 calls, 19 of them empty pages while matches exist later.
  assert.ok(calls <= 6, `filtered walk took ${calls} calls; expected <= 6 (was 20 at the 16-window shape)`);
});

test('R-07: an empty page with hasMore still occurs when a bounded scan finds no visible event', t => {
  // 20 large private posts (alice -> bob, ~4.2 KB each) exceed the 64 KiB
  // per-call source ledger before any visible event: the reader's first page
  // from after the member events must be empty with hasMore=true and an
  // advanced cursor — the bounded-scan honesty the old window shape relied on.
  const store = new RoomStore(':memory:'); t.after(() => store.close());
  const events = initialRoom();
  const add = (type, data, actorId = 'owner') => events.push(event({roomId: 'commons', actorId, type, data}));
  for (const memberId of ['alice', 'bob', 'reader']) add('member.added', {memberId, displayName: memberId, kind: 'agent', permissions: []});
  for (let i = 0; i < 20; i++) add('message.posted', {messageId: 'big-' + i, body: 'PRIVATE-BIG-' + 'x'.repeat(4000), toMemberId: 'bob'}, 'alice');
  add('message.posted', {messageId: 'public', body: 'VISIBLE-AFTER-BACKLOG'});
  store.initialize(events, {representation: 'normalized-current-v1'});
  const key = store.issueAccessKey('commons', 'reader');
  const first = store.eventsAfter(key, 'commons', 5, 100);
  assert.equal(first.events.length, 0, 'first bounded scan over the invisible backlog yields no visible event');
  assert.equal(first.hasMore, true);
  assert.ok(first.next > 5, 'cursor advances by the scanned source, not by delivered events');
  const {all} = walk(store, key);
  assert.ok(all.some(x => x.event.data?.messageId === 'public'), 'walk still reaches the visible post past the backlog');
  assert.equal(JSON.stringify(all).includes('PRIVATE-BIG-'), false);
});

test('R-08: readEventTail(tail=50) returns a full 50 visible events in one call', t => {
  const {store, key} = fixture(t, 60);
  const page = readEventTail(store, key, 'commons', 50);
  assert.equal(page.events.length, 50, `tail=50 returned ${page.events.length} events (16 at the old shape)`);
  assert.equal(page.hasMore, false);
});

test('R-08: HTTP ?tail=50 returns a full 50 visible events in one response', async t => {
  const {store, key} = fixture(t, 60);
  const server = createRoomServer({store});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const res = await fetch('http://127.0.0.1:' + server.address().port + '/api/rooms/commons/events?tail=50',
    {headers: {authorization: 'Bearer ' + key}});
  const page = await res.json();
  assert.equal(res.status, 200, JSON.stringify(page));
  assert.equal(page.events.length, 50, `HTTP tail=50 returned ${page.events.length} events (16 at the old shape)`);
  assert.equal(page.hasMore, false);
});
