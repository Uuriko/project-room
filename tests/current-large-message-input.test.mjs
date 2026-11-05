import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RoomStore} from '../server/store.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {event} from '../src/events.js';
import {readConversation} from '../server/conversation-sync.mjs';
import {withCurrentReadContext, withCurrentRoomWriter, CURRENT_MESSAGE_INPUT_BYTES} from '../server/current-room-repository.mjs';

function fixture(t, body, {history = false, count = 0} = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'large-message-input-')), path = join(directory, 'room.sqlite');
  let store = new RoomStore(path);
  const events = initialRoom(), add = (type, data, actorId = 'owner') => events.push(event({roomId: 'commons', actorId, type, data}));
  for (const memberId of ['party', 'other']) add('member.added', {memberId, displayName: memberId, kind: 'agent', permissions: []});
  for (let i = 0; i < count; i++) add('message.posted', {messageId: 'unrelated-' + i, body: 'Unrelated history'});
  for (const messageId of ['edit', 'delete', 'private']) {
    add('message.posted', {messageId, body: history ? '\u0001'.repeat(1250) : body, ...(messageId === 'private' ? {toMemberId: 'party'} : {})});
    if (history) {
      for (let revision = 0; revision < 26; revision++) add('message.edited', {messageId, body: '\u0001'.repeat(1250), expectedMessageRevision: revision});
      add('message.edited', {messageId, body, expectedMessageRevision: 26});
    }
  }
  store.initialize(events, {representation: 'normalized-current-v1'});
  const owner = store.issueAccessKey('commons', 'owner'), other = store.issueAccessKey('commons', 'other');
  const closed = () => { store.room = () => { throw Error('Whole-room hydration forbidden'); }; };
  closed();
  t.after(() => { store.close(); rmSync(directory, {recursive: true, force: true}); });
  return {get store() { return store; }, owner, other, reopen() { store.close(); store = new RoomStore(path); closed(); }};
}
const families = [['ascii', 'x'.repeat(65536)], ['cjk', '界'.repeat(65536)], ['control', '\u0001'.repeat(65536)], ['astral', '😀'.repeat(32768)]];
for (const [kind, body] of families) test(`historical max ${kind} remains fully readable, editable, replyable and deletable after cold reopen`, t => {
  const f = fixture(t, body); f.reopen();
  let observed;
  const page = f.store.readTransaction(() => withCurrentReadContext(f.store.db, 'commons', b => {
    const result = readConversation(f.store, f.owner, 'commons', {messageId: 'edit'});
    observed = {metadata: b.bytes, canonical: b.messageBytes};
    return result;
  }));
  assert.equal(page.messages[0].body, body);
  assert.ok(observed.metadata <= 262144 && observed.canonical <= CURRENT_MESSAGE_INPUT_BYTES);
  assert.throws(() => readConversation(f.store, f.other, 'commons', {messageId: 'private'}), error => error.status === 404);
  f.store.command(f.owner, 'commons', {id: 'reply', type: 'message.posted', data: {messageId: 'reply', body: 'Useful reply', replyToId: 'edit'}});
  const edit = {id: 'edit', type: 'message.edited', data: {messageId: 'edit', expectedMessageRevision: 0, body: 'Short replacement'}};
  f.store.command(f.owner, 'commons', edit);
  assert.equal(f.store.command(f.owner, 'commons', edit).duplicate, true);
  f.store.command(f.owner, 'commons', {id: 'delete', type: 'message.deleted', data: {messageId: 'delete', expectedMessageRevision: 0}});
  f.reopen();
  assert.equal(readConversation(f.store, f.owner, 'commons', {messageId: 'edit'}).messages[0].body, 'Short replacement');
  assert.equal(readConversation(f.store, f.owner, 'commons', {messageId: 'delete'}).messages[0].body, null);
});

test('worst escaped current body and bounded edit history keep full proof checks but omit history from conversation output', t => {
  const body = '\u0001'.repeat(65536), f = fixture(t, body, {history: true});
  f.reopen();
  const result = readConversation(f.store, f.owner, 'commons', {messageId: 'edit'});
  assert.equal(result.messages[0].body, body);
  assert.equal(result.messages[0].editHistory, undefined);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 524288);
  f.store.command(f.owner, 'commons', {id: 'short-edit', type: 'message.edited', data: {messageId: 'edit', expectedMessageRevision: 27, body: 'Short replacement'}});
  f.reopen();
  assert.equal(readConversation(f.store, f.owner, 'commons', {messageId: 'edit'}).messages[0].body, 'Short replacement');
});

test('large canonical pages stop at the shared pool and continue without omitting or duplicating messages', t => {
  const f = fixture(t, '\u0001'.repeat(65536));
  const ids = []; let cursor;
  for (let calls = 0; calls < 10; calls++) {
    const result = readConversation(f.store, f.owner, 'commons', {limit: 50, ...(cursor ? {cursor} : {})});
    ids.push(...result.messages.map(message => message.id));
    cursor = result.nextCursor;
    if (!cursor) break;
  }
  assert.equal(cursor, null);
  assert.deepEqual(ids.sort(), ['delete', 'edit', 'private']);
});

test('independent canonical hash and membership witness remain mandatory for a large selected record', t => {
  const f = fixture(t, '界'.repeat(65536));
  const original = f.store.db.prepare("SELECT entity_hash FROM messages WHERE room_id='commons' AND message_id='edit'").get().entity_hash;
  f.store.transaction(() => withCurrentRoomWriter(f.store.db, 'commons', () => f.store.db.prepare("UPDATE messages SET entity_hash=? WHERE room_id='commons' AND message_id='edit'").run('0'.repeat(64))));
  assert.throws(() => readConversation(f.store, f.owner, 'commons', {messageId: 'edit'}), /message field proof changed/);
  f.store.transaction(() => withCurrentRoomWriter(f.store.db, 'commons', () => {
    f.store.db.prepare("UPDATE messages SET entity_hash=? WHERE room_id='commons' AND message_id='edit'").run(original);
    f.store.db.prepare("DELETE FROM current_room_records WHERE room_id='commons' AND domain='messageWitness' AND record_key='edit'").run();
  }));
  assert.throws(() => readConversation(f.store, f.owner, 'commons', {messageId: 'edit'}), /proof|record|witness/);
});

for (const [kind, body] of families) test(`new max ${kind} writes stay readable through repeated full edits, cold retries and deletion`, t => {
  const f = fixture(t, 'Small source');
  const post = {id: 'new-max', type: 'message.posted', data: {messageId: 'new-max', body}};
  f.store.command(f.owner, 'commons', post);
  f.reopen();
  assert.equal(f.store.command(f.owner, 'commons', post).duplicate, true);
  for (let revision = 0; revision < 3; revision++) {
    assert.equal(readConversation(f.store, f.owner, 'commons', {messageId: 'new-max'}).messages[0].body, body);
    f.store.command(f.owner, 'commons', {id: 'max-edit-' + revision, type: 'message.edited', data: {messageId: 'new-max', expectedMessageRevision: revision, body}});
    f.reopen();
  }
  const before = f.store.db.prepare("SELECT sequence FROM rooms WHERE id='commons'").get();
  assert.throws(() => f.store.transaction(() => {
    f.store.command(f.owner, 'commons', {id: 'rolled-back-edit', type: 'message.edited', data: {messageId: 'new-max', expectedMessageRevision: 3, body: 'Would be rolled back'}});
    throw Error('Injected commit failure');
  }), /Injected commit failure/);
  assert.deepEqual(f.store.db.prepare("SELECT sequence FROM rooms WHERE id='commons'").get(), before);
  assert.equal(readConversation(f.store, f.owner, 'commons', {messageId: 'new-max'}).messages[0].body, body);
  f.store.command(f.owner, 'commons', {id: 'max-delete', type: 'message.deleted', data: {messageId: 'new-max', expectedMessageRevision: 3}});
  f.reopen();
  assert.equal(readConversation(f.store, f.owner, 'commons', {messageId: 'new-max'}).messages[0].body, null);
});

for (const action of ['reply', 'edit', 'delete']) test(`maximum-message reply ancestry admits a later ${action} after cold reopen`, t => {
  const f = fixture(t, 'Small source'), body = '\u0001'.repeat(65536);
  f.store.command(f.owner, 'commons', {id: 'chain-a', type: 'message.posted', data: {messageId: 'chain-a', body}});
  f.store.command(f.owner, 'commons', {id: 'chain-b', type: 'message.posted', data: {messageId: 'chain-b', replyToId: 'chain-a', body}});
  f.reopen();
  if (action === 'reply') {
    const command = {id: 'chain-c', type: 'message.posted', data: {messageId: 'chain-c', replyToId: 'chain-b', body: 'Useful follow-up'}};
    f.store.command(f.owner, 'commons', command);
    assert.equal(f.store.command(f.owner, 'commons', command).duplicate, true);
    assert.equal(readConversation(f.store, f.owner, 'commons', {messageId: 'chain-c'}).messages[0].body, 'Useful follow-up');
  } else {
    f.store.command(f.owner, 'commons', {id: 'chain-' + action, type: action === 'edit' ? 'message.edited' : 'message.deleted', data: {messageId: 'chain-b', expectedMessageRevision: 0, ...(action === 'edit' ? {body: 'Short edited reply'} : {})}});
    f.reopen();
    assert.equal(readConversation(f.store, f.owner, 'commons', {messageId: 'chain-b'}).messages[0].body, action === 'edit' ? 'Short edited reply' : null);
  }
});

test('protected ancestry headers preserve root channel and DM parties without rewriting ancestor bodies', t => {
  const f = fixture(t, 'Small source'), body = '\u0001'.repeat(65536);
  f.store.command(f.owner, 'commons', {id: 'science', type: 'channel.created', data: {channelId: 'science', name: 'Science'}});
  f.store.command(f.owner, 'commons', {id: 'private-root', type: 'message.posted', data: {messageId: 'private-root', body, toMemberId: 'party', channelId: 'science'}});
  f.store.command(f.owner, 'commons', {id: 'private-child', type: 'message.posted', data: {messageId: 'private-child', replyToId: 'private-root', body}});
  const ancestorRows = () => f.store.db.prepare("SELECT * FROM messages WHERE room_id='commons' AND message_id IN ('private-root','private-child') ORDER BY message_id").all();
  const before = ancestorRows();
  f.reopen();
  assert.throws(() => f.store.command(f.other, 'commons', {id: 'bystander', type: 'message.posted', data: {messageId: 'bystander', replyToId: 'private-child', body: 'Must not enter DM'}}), e => e.code === 'command_rejected');
  f.store.command(f.owner, 'commons', {id: 'private-grandchild', type: 'message.posted', data: {messageId: 'private-grandchild', replyToId: 'private-child', channelId: 'general', body: 'Useful private follow-up'}});
  const message = readConversation(f.store, f.owner, 'commons', {messageId: 'private-grandchild'}).messages[0];
  assert.equal(message.channelId, 'science'); assert.equal(message.toMemberId, 'party');
  assert.deepEqual(ancestorRows(), before);
  f.store.transaction(() => withCurrentRoomWriter(f.store.db, 'commons', () => f.store.db.prepare("UPDATE messages SET channel_id='general' WHERE room_id='commons' AND message_id='private-root'").run()));
  assert.throws(() => f.store.command(f.owner, 'commons', {id: 'tampered-header', type: 'message.posted', data: {messageId: 'tampered-header', replyToId: 'private-child', body: 'Must not save'}}), /message header proof changed/);
  assert.throws(() => readConversation(f.store, f.owner, 'commons', {messageId: 'private-root'}), /message field proof changed/);
});
