import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import * as messages from '../server/messages-store.mjs';
import { MESSAGE_PROOF_FIELDS, messageProofMatches } from '../server/write-integrity.mjs';

const parent = { id: 'parent', authorId: 'owner', body: 'Parent', createdAt: '2026-09-01T00:00:00Z' };
for (const [name, fields, pinned] of [
  ['ordinary', {}, false],
  ['reply and channel', { replyToId: 'parent', channelId: 'general' }, false],
  ['direct and work link', { toMemberId: 'peer', workItemId: 'task' }, false],
  ['edited with reducer history', { editedAt: '2026-09-01T01:00:00Z', editHistory: [{ body: 'Prior', at: '2026-09-01T00:30:00Z' }] }, false],
  ['deleted', { deletedAt: '2026-09-01T02:00:00Z' }, true],
  ['nonstring nullable inputs', { channelId: '', replyToId: null, toMemberId: 7, workItemId: false, editedAt: '', body: 8 }, false],
  ['full unknown reducer record fields', { kind: 'receipt_card', receiptId: 'receipt', customSynthetic: { value: 1 } }, true]
]) test(`shared row codec exactly reproduces existing persisted writer fields: ${name}`, t => {
  const s = new RoomStore(':memory:'); t.after(() => s.close()); s.initialize(initialRoom());
  const message = { id: 'child', authorId: 'owner', body: 'Current', createdAt: '2026-09-01T00:01:00Z', ...fields };
  const state = { messages: [parent, message], pins: pinned ? [{ messageId: message.id }] : [] };
  s.transaction(() => messages.syncMessageRows(s.db, { roomId: 'commons', sequence: 11,
    event: { type: 'message.posted', data: { messageId: message.id } }, state }));
  const row = s.db.prepare('SELECT * FROM messages WHERE room_id=? AND message_id=?').get('commons', message.id);
  assert.equal(messageProofMatches(row), true);
  const before = structuredClone(message);
  assert.equal(typeof messages.messageRowForWrite, 'function');
  const encoded = messages.messageRowForWrite(message, { sequence: 11, pinned, threadMessages: new Map(state.messages.map(item => [item.id, item])) });
  assert.deepEqual(Object.keys(encoded), MESSAGE_PROOF_FIELDS);
  assert.deepEqual(encoded, Object.fromEntries(MESSAGE_PROOF_FIELDS.map(key => [key, row[key]])));
  assert.deepEqual(message, before, 'encoding never mutates reducer state');
});
