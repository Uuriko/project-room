import test from 'node:test';
import assert from 'node:assert/strict';
import { opaqueReadCursor } from '../server/opaque-read-cursor.mjs';

test('read cursors preserve private continuation data only for the original store lifetime', () => {
  const store = {}, cursor = opaqueReadCursor(store);
  const value = { room: 'private-room', viewer: 'guest', offset: 83, revision: 12 };
  const token = cursor.encode(value);
  assert.deepEqual(opaqueReadCursor(store).decode(token), value);
  assert.equal(opaqueReadCursor({}).decode(token), null, 'restart or another store cannot reuse a continuation');
  assert.equal(Buffer.from(token, 'base64url').includes(Buffer.from('private-room')), false);
  assert.notEqual(cursor.encode(value), token, 'equal pages do not expose equal continuation tokens');
});

test('modified, truncated, oversized and noncanonical continuations are refused', () => {
  const cursor = opaqueReadCursor({}), token = cursor.encode({ offset: 9 });
  const bytes = Buffer.from(token, 'base64url');
  for (const index of [0, 12, bytes.length - 1]) {
    const changed = Buffer.from(bytes); changed[index] ^= 1;
    assert.equal(cursor.decode(changed.toString('base64url')), null);
  }
  for (const invalid of [null, {}, '', '!', 'a'.repeat(4097), token + '=', token.slice(0, 20)])
    assert.equal(cursor.decode(invalid), null);
});
