import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RoomStore} from '../server/store.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {event} from '../src/events.js';
import {readConversation} from '../server/conversation-sync.mjs';
import {operatorNormalization} from '../server/operator-normalization.mjs';

const bodies = [['ascii', 'x'.repeat(8192)], ['cjk', '界'.repeat(8192)], ['control', '\u0001'.repeat(8192)], ['astral', '😀'.repeat(4096)]];
function fixture(t, legacy = false) {
  const directory = mkdtempSync(join(tmpdir(), 'message-mitigation-')), path = join(directory, 'room.sqlite');
  let store = new RoomStore(path);
  const events = initialRoom();
  events.push(event({roomId: 'commons', actorId: 'owner', type: 'member.added', data: {memberId: 'other', displayName: 'Other', kind: 'agent', permissions: []}}));
  store.initialize(events, legacy ? {} : {representation: 'normalized-current-v1'});
  const key = store.issueAccessKey('commons', 'owner');
  t.after(() => { store.close(); rmSync(directory, {recursive: true, force: true}); });
  return {get store() { return store; }, key, reopen() { store.close(); store = new RoomStore(path); }};
}
const command = (store, key, id, type, data) => store.command(key, 'commons', {id, type, data});
const read = (f, messageId) => readConversation(f.store, f.key, 'commons', {messageId}).messages[0];

for (const [kind, body] of bodies) test(`former temporary ${kind} boundary survives cold read, reply dependency, edit and deletion`, t => {
  const f = fixture(t);
  assert.equal(body.length, 8192);
  for (const id of ['edit', 'delete']) command(f.store, f.key, 'post-' + id, 'message.posted', {messageId: id, body});
  command(f.store, f.key, 'over', 'message.posted', {messageId: 'over', body: body + 'x'});
  f.reopen();
  assert.equal(read(f, 'over').body, body + 'x', 'the full fix restores bodies above the old temporary boundary');
  assert.equal(read(f, 'edit').body, body);
  assert.equal(read(f, 'delete').body, body);
  command(f.store, f.key, 'reply', 'message.posted', {messageId: 'reply', body: 'Useful reply', replyToId: 'edit'});
  const edit = {messageId: 'edit', body: 'Short edited message', expectedMessageRevision: 0};
  command(f.store, f.key, 'edit', 'message.edited', edit);
  assert.equal(command(f.store, f.key, 'edit', 'message.edited', edit).duplicate, true);
  command(f.store, f.key, 'delete', 'message.deleted', {messageId: 'delete', expectedMessageRevision: 0});
  f.reopen();
  assert.equal(read(f, 'edit').body, 'Short edited message');
  assert.equal(read(f, 'delete').body, null);
});

test('repeated escaped edits above the former proof limit remain readable under the shared derived allowance', t => {
  const f = fixture(t), body = '\u0001'.repeat(8192);
  command(f.store, f.key, 'post', 'message.posted', {messageId: 'edit', body});
  for (let revision = 0; revision < 5; revision++) {
    command(f.store, f.key, 'edit-' + revision, 'message.edited', {messageId: 'edit', body, expectedMessageRevision: revision});
    f.reopen();
    assert.equal(read(f, 'edit').body, body);
  }
  const size = f.store.db.prepare("SELECT length(CAST(body AS BLOB))+length(CAST(record_json AS BLOB))+length(CAST(reducer_extras_json AS BLOB)) bytes FROM messages WHERE room_id='commons' AND message_id='edit'").get();
  assert.ok(size.bytes > 131072, 'the fixture genuinely exceeds the old limit');
  f.reopen();
  command(f.store, f.key, 'delete-after-refusal', 'message.deleted', {messageId: 'edit', expectedMessageRevision: read(f, 'edit').revision});
  assert.equal(read(f, 'edit').body, null);
});

test('exact retries committed before normalization remain unchanged', t => {
  const f = fixture(t, true), data = {messageId: 'old', body: 'x'.repeat(8193)};
  const saved = command(f.store, f.key, 'before-normalized', 'message.posted', data);
  const selection = {roomId: 'commons', discardLegacyAssignments: true}, plan = operatorNormalization(f.store, selection);
  operatorNormalization(f.store, {...selection, planHash: plan.planHash, requestId: 'adopt', reason: 'Synthetic mitigation retry qualification'}, true);
  f.reopen();
  const retry = command(f.store, f.key, 'before-normalized', 'message.posted', data);
  assert.equal(retry.duplicate, true);
  assert.equal(retry.sequence, saved.sequence);
  assert.equal(retry.event.data.body, data.body);
});
