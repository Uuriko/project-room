import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { searchMessages } from '../src/conversation.js';

test('browser and service find committed filenames, never staged bytes or deleted records', t => {
  const store = new RoomStore(':memory:'); t.after(() => store.close());
  store.initialize(initialRoom('files')); store.initialize(initialRoom('other'));
  const token = store.issueAccessKey('files', 'owner'), other = store.issueAccessKey('other', 'owner');
  const input = { id: 'file', filename: 'Budget [review].txt', mediaType: 'text/plain', bytes: new TextEncoder().encode('not-indexed-content') };
  store.attachments.stage(token, 'files', input);
  assert.equal(store.search(token, 'files', 'Budget').messages.length, 0);
  store.command(token, 'files', { id: 'post-file', type: 'message.posted', data: { messageId: 'message', body: '', attachmentIds: ['file'] } });
  const before = JSON.stringify(store.room('files'));
  for (const query of ['BUDGET', '[review]']) {
    const server = store.search(token, 'files', query, 'messages').messages;
    const browser = searchMessages(store.room('files').state, query).messages;
    assert.deepEqual(server.map(message => message.id), ['message']);
    assert.deepEqual(browser.map(message => message.id), ['message']);
    assert.equal(server[0].attachments[0].filename, input.filename);
    assert.equal(Object.hasOwn(server[0].attachments[0], 'bytes'), false);
  }
  assert.equal(store.search(token, 'files', 'not-indexed-content').messages.length, 0);
  assert.equal(searchMessages(store.room('files').state, '.*').total, 0);
  assert.equal(store.search(other, 'other', 'Budget').messages.length, 0);
  assert.throws(() => store.search(other, 'files', 'Budget'), { status: 403 });
  assert.equal(JSON.stringify(store.room('files')), before, 'search is read-only');
  store.command(token, 'files', { id: 'delete-message', type: 'message.deleted', data: { messageId: 'message', expectedMessageRevision: 0 } });
  assert.equal(store.search(token, 'files', 'Budget').messages.length, 0);
  assert.equal(searchMessages(store.room('files').state, 'Budget').total, 0);
  assert.equal(searchMessages(store.room('files').state, 'Room owner').total, 0);
});
