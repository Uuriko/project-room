import test from 'node:test';
import assert from 'node:assert/strict';
import { ConversationDrafts, DraftRecovery } from '../src/conversation.js';

test('file selections remain on their own thread draft', () => {
  const drafts = new ConversationDrafts(), file = { id: 'file', state: 'queued' };
  drafts.save(null, { body: 'Room', files: [file] });
  drafts.save('thread', { body: 'Thread', files: [] });
  file.state = 'ready';
  assert.equal(drafts.get(null).files[0].state, 'ready');
  assert.deepEqual(drafts.get('thread').files, []);
  drafts.clear('thread'); assert.equal(drafts.get(null).files.length, 1);
  assert.equal(new ConversationDrafts().get(null).files, undefined);
});
test('tab recovery never silently turns file-bearing drafts into text-only sends', () => {
  const memory = new Map();
  const recovery = new DraftRecovery({ getItem: key => memory.get(key), setItem: (key, value) => memory.set(key, value), removeItem: key => memory.delete(key) });
  const drafts = new ConversationDrafts();
  drafts.save(null, { body: 'With a file', files: [{ id: 'file' }] });
  drafts.save('unknown', { body: 'Uncertain send', pending: { command: { data: { attachmentIds: ['file'] } } } });
  drafts.save('text', { body: 'Text only' });
  assert.equal(recovery.write('scope', drafts, null), true);
  const stored = JSON.parse(memory.get(recovery.key));
  assert.deepEqual(stored.entries.map(([id]) => id), ['text']);
});
