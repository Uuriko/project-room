import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { event } from '../src/events.js';
import { readConversation } from '../server/conversation-sync.mjs';

// R-33: in a current-format room, a page cursor must survive head changes.
// Pages are keyset pages over (seq, message_id); appends carry higher
// sequences and can never enter an in-progress backward walk.
function fixture(t, { publics = 0, channel = 0, pair = 0 } = {}) {
  const store = new RoomStore(':memory:');
  t.after(() => store.close());
  const events = initialRoom(), add = (type, data, actorId = 'owner') => events.push(event({ roomId: 'commons', actorId, type, data }));
  add('member.added', { memberId: 'party', displayName: 'party', kind: 'agent', permissions: [] });
  if (channel) add('channel.created', { channelId: 'design', name: 'design' });
  for (let i = 1; i <= publics; i++) add('message.posted', { messageId: `pub-${String(i).padStart(2, '0')}`, body: `public ${i}` });
  for (let i = 1; i <= channel; i++) add('message.posted', { messageId: `des-${String(i).padStart(2, '0')}`, body: `design ${i}`, channelId: 'design' });
  for (let i = 1; i <= pair; i++) add('message.posted', { messageId: `dm-${String(i).padStart(2, '0')}`, body: `pair ${i}`, toMemberId: i % 2 ? 'party' : 'owner' }, i % 2 ? 'owner' : 'party');
  store.initialize(events, { representation: 'normalized-current-v1' });
  const owner = store.issueAccessKey('commons', 'owner');
  const post = (messageId, body, extra = {}) => store.command(owner, 'commons', { id: `cmd-${messageId}`, type: 'message.posted', data: { messageId, body, ...extra } });
  return { store, owner, post };
}
const ids = page => page.messages.map(m => m.id);

test('R-33 falsifier: page 2 with a page-1 cursor succeeds after one append (public view)', t => {
  const f = fixture(t, { publics: 12 });
  const page1 = readConversation(f.store, f.owner, 'commons', { limit: 5 });
  assert.equal(page1.mode, 'replace');
  assert.deepEqual(ids(page1), ['pub-08', 'pub-09', 'pub-10', 'pub-11', 'pub-12']);
  assert.ok(page1.nextCursor);
  f.post('pub-13', 'public 13');
  const page2 = readConversation(f.store, f.owner, 'commons', { limit: 5, cursor: page1.nextCursor });
  assert.equal(page2.mode, 'replace', 'append must not reset an in-progress keyset walk');
  assert.deepEqual(ids(page2), ['pub-03', 'pub-04', 'pub-05', 'pub-06', 'pub-07']);
  assert.ok(page2.nextCursor);
  const page3 = readConversation(f.store, f.owner, 'commons', { limit: 5, cursor: page2.nextCursor });
  assert.deepEqual(ids(page3), ['pub-01', 'pub-02']);
  assert.equal(page3.nextCursor, null);
});

test('R-33: several appends during a multi-page drain still complete the original walk exactly once', t => {
  const f = fixture(t, { publics: 20 });
  const seen = [];
  let cursor = null, appended = 0;
  for (let page = 0; page < 12; page++) {
    const result = readConversation(f.store, f.owner, 'commons', { limit: 4, ...(cursor ? { cursor } : {}) });
    assert.equal(result.mode, 'replace');
    seen.push(...ids(result));
    cursor = result.nextCursor;
    if (!cursor) break;
    f.post(`live-${++appended}`, `live ${appended}`);
    f.post(`live-b-${appended}`, `live b ${appended}`);
  }
  assert.equal(cursor, null, 'drain must terminate');
  assert.equal(appended > 0, true);
  assert.deepEqual([...seen].sort(), Array.from({ length: 20 }, (_, i) => `pub-${String(i + 1).padStart(2, '0')}`).sort());
  assert.equal(new Set(seen).size, 20, 'no duplicates and no appended messages enter the walk');
});

test('R-33: channel view cursor survives an append in that channel', t => {
  const f = fixture(t, { channel: 9 });
  const page1 = readConversation(f.store, f.owner, 'commons', { limit: 4, channelId: 'design' });
  assert.deepEqual(ids(page1), ['des-06', 'des-07', 'des-08', 'des-09']);
  f.post('des-10', 'design 10', { channelId: 'design' });
  const page2 = readConversation(f.store, f.owner, 'commons', { limit: 4, channelId: 'design', cursor: page1.nextCursor });
  assert.equal(page2.mode, 'replace');
  assert.deepEqual(ids(page2), ['des-02', 'des-03', 'des-04', 'des-05']);
});

test('R-33: any head change carries the keyset; mid-walk edits/deletes serve current form', t => {
  const f = fixture(t, { publics: 10 });
  const page1 = readConversation(f.store, f.owner, 'commons', { limit: 4 });
  assert.deepEqual(ids(page1), ['pub-07', 'pub-08', 'pub-09', 'pub-10']);
  // Non-append head change (member event) must not reset the walk either.
  f.store.command(f.owner, 'commons', { id: 'cmd-member', type: 'member.added', data: { memberId: 'late', displayName: 'late', kind: 'agent', permissions: [] } });
  // Edit + delete messages the walk has not reached yet.
  f.store.command(f.owner, 'commons', { id: 'cmd-edit', type: 'message.edited', data: { messageId: 'pub-05', body: 'public 5 edited', expectedMessageRevision: 0 } });
  f.store.command(f.owner, 'commons', { id: 'cmd-delete', type: 'message.deleted', data: { messageId: 'pub-03', expectedMessageRevision: 0 } });
  const page2 = readConversation(f.store, f.owner, 'commons', { limit: 4, cursor: page1.nextCursor });
  assert.equal(page2.mode, 'replace');
  assert.deepEqual(ids(page2), ['pub-03', 'pub-04', 'pub-05', 'pub-06']);
  assert.equal(page2.messages.find(m => m.id === 'pub-05').body, 'public 5 edited', 'not-yet-read edit is served in current form');
  assert.equal(page2.messages.find(m => m.id === 'pub-03').body, null, 'not-yet-read delete is served as a tombstone');
  const page3 = readConversation(f.store, f.owner, 'commons', { limit: 4, cursor: page2.nextCursor });
  assert.deepEqual(ids(page3), ['pub-01', 'pub-02']);
  assert.equal(page3.nextCursor, null);
});

test('R-33: DM peer view is no worse than main (public append carries, pair append resets)', t => {
  const f = fixture(t, { pair: 6, publics: 2 });
  const page1 = readConversation(f.store, f.owner, 'commons', { limit: 2, peerMemberId: 'party' });
  assert.deepEqual(ids(page1), ['dm-05', 'dm-06']);
  f.post('pub-live', 'public during dm walk');
  const page2 = readConversation(f.store, f.owner, 'commons', { limit: 2, peerMemberId: 'party', cursor: page1.nextCursor });
  assert.equal(page2.mode, 'replace', 'proven public-only append already carries on main');
  assert.deepEqual(ids(page2), ['dm-03', 'dm-04']);
  f.post('dm-07', 'pair 7', { toMemberId: 'party' });
  const page3 = readConversation(f.store, f.owner, 'commons', { limit: 2, peerMemberId: 'party', cursor: page2.nextCursor });
  assert.equal(page3.mode, 'reset', 'DM walks keep the conservative reset on pair changes');
});

test('R-33: forged or garbage page cursors still fail closed as reset', t => {
  const f = fixture(t, { publics: 3 });
  assert.equal(readConversation(f.store, f.owner, 'commons', { limit: 2, cursor: 'not-a-token' }).mode, 'reset');
  const page1 = readConversation(f.store, f.owner, 'commons', { limit: 2 });
  assert.equal(readConversation(f.store, f.owner, 'commons', { limit: 2, cursor: page1.nextCursor + 'x' }).mode, 'reset');
});

test('R-33 sub-item: not_modified carries an empty messages array', t => {
  const f = fixture(t, { publics: 3 });
  const first = readConversation(f.store, f.owner, 'commons', { limit: 2 });
  assert.ok(first.checkpoint);
  const again = readConversation(f.store, f.owner, 'commons', { limit: 2, since: first.checkpoint });
  assert.equal(again.mode, 'not_modified');
  assert.deepEqual(again.messages, [], 'clients reading response.messages.length must not throw');
});

test('R-33 sub-item: an ISO timestamp passed as since is a clear 422, not an empty reset', t => {
  const f = fixture(t, { publics: 3 });
  assert.throws(
    () => readConversation(f.store, f.owner, 'commons', { limit: 2, since: '2026-11-04T12:00:00.000Z' }),
    error => error.status === 422 && error.code === 'invalid_conversation_since');
  // A non-timestamp garbage checkpoint keeps the existing fail-closed reset.
  assert.equal(readConversation(f.store, f.owner, 'commons', { limit: 2, since: 'garbage' }).mode, 'reset');
});
