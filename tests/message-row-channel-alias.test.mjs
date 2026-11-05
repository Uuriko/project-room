import test from 'node:test';
import assert from 'node:assert/strict';
import { messageRowForWrite, messageRowParityFields, messageRecordParityDetail } from '../server/messages-store.mjs';
const message = { id: 'message', authorId: 'owner', body: 'Synthetic', createdAt: '2026-09-01T00:00:00Z' };
const context = { sequence: 1, pinned: false, threadMessages: new Map([[message.id,message]]) };
const raw = () => messageRowForWrite(message, context);
const aliased = () => messageRowForWrite({ ...message, channelId: 'general' }, context);
test('reader-defaulted complete row is valid for an absent channel property', () => {
  assert.deepEqual(messageRowParityFields(aliased(),message,context), []);
  assert.deepEqual(messageRecordParityDetail(aliased(),message), { keys: [], legacyShapeOnly: false });
});
test('literal old absent-channel record and null index remain valid', () => {
  assert.deepEqual(messageRowParityFields(raw(),message,context), []);
  assert.deepEqual(messageRecordParityDetail(raw(),message), { keys: [], legacyShapeOnly: false });
});
for (const row of [{ ...raw(), channel_id: 'general' }, { ...aliased(), channel_id: null }]) test('mixed index and record channel representations refuse', () => {
  assert.ok(messageRowParityFields(row,message,context).length > 0);
});
for (const value of [null, '', 0, false, 'other']) test(`present channel property remains literal: ${JSON.stringify(value)}`, () => {
  const explicit = { ...message, channelId: value };
  assert.ok(messageRowParityFields(aliased(),explicit,context).length > 0);
  assert.ok(messageRecordParityDetail(aliased(),explicit).keys.includes('channelId'));
});
test('alias never hides any unrelated row or JSON key mismatch', () => {
  for (const changed of [{ body: 'changed' }, { author_id: 'other' }, { seq: 2 }, { pinned: 1 },
    { record_json: JSON.stringify({ ...message, channelId: 'general', untrusted: true }) },
    { reducer_extras_json: '{"untrusted":true}' }]) {
    const row = { ...aliased(), ...changed };
    assert.ok(messageRowParityFields(row,message,context).length > 0);
  }
  const row = aliased(); row.record_json = JSON.stringify({ ...message, channelId: 'general', untrusted: true });
  assert.deepEqual(messageRecordParityDetail(row,message), { keys: ['channelId','other_fields'], legacyShapeOnly: false });
});
test('alias does not expand legacy shape correction to combined channel and reaction/receipt differences', () => {
  const current = { ...message, kind: 'receipt_card', claimId: 'claim', receiptId: 'rc_claim' };
  const row = messageRowForWrite({ ...current, channelId: 'general' },context);
  const record = JSON.parse(row.record_json); delete record.receiptId; record.reactions = {}; row.record_json = JSON.stringify(record);
  assert.equal(messageRecordParityDetail(row,current).legacyShapeOnly, false);
  assert.ok(messageRowParityFields(row,current,context).length > 0);
});
