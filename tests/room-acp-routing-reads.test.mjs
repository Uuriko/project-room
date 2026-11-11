import test from 'node:test';
import assert from 'node:assert/strict';
import { Bridge } from '../room-acp/src/bridge.mjs';

function fixture(t, records) {
  const bridge = new Bridge({ connection: { apiBase: 'https://room.invalid', roomId: 'commons', memberId: 'agent', hostId: 'test' }, host: {}, persistSessions: false });
  t.after(() => bridge.stop());
  const reads = [], queued = [];
  bridge.readThread = async (id, options) => {
    assert.deepEqual(options, { selected: true });
    reads.push(id);
    const value = records[id];
    if (value instanceof Error) throw value;
    assert.ok(value, id);
    return structuredClone(value);
  };
  bridge.queue = { push: (...args) => { queued.push(args); return true; } };
  return { bridge, reads, queued };
}
const message = (id, replyToId = null) => ({ thread: { id, replyToId, authorId: 'owner', body: id } });
const wake = (messageId, signalId = 'signal') => ({ messageId, signalId, kind: 'reply' });

test('reply routing reads each message once and preserves the queued child', async t => {
  const { bridge, reads, queued } = fixture(t, { reply: message('reply', 'parent'), parent: message('parent', 'root'), root: message('root') });
  await bridge.accept(wake('reply'));
  assert.deepEqual(reads, ['reply', 'parent', 'root']);
  assert.equal(queued[0][0], 'root');
  assert.equal(queued[0][1].messageId, 'reply');
  assert.equal(queued[0][1].body, 'reply');
  await bridge.accept(wake('reply'));
  assert.equal(queued.length, 1, 'duplicate signal stays suppressed');
});

test('direct roots still use one read', async t => {
  const { bridge, reads, queued } = fixture(t, { root: message('root') });
  await bridge.accept(wake('root'));
  assert.deepEqual(reads, ['root']);
  assert.equal(queued[0][0], 'root');
});

test('formal request boundary stays selected even when it has a parent', async t => {
  const records = { reply: message('reply', 'request'), request: { ...message('request', 'older'), replyRequest: { recipientId: 'agent' } } };
  const { bridge, reads, queued } = fixture(t, records);
  await bridge.accept(wake('reply'));
  assert.deepEqual(reads, ['reply', 'request']);
  assert.equal(queued[0][0], 'request');
});

test('a changed ancestor is read freshly on the next signal', async t => {
  const records = { reply: message('reply', 'parent'), parent: message('parent', 'root'), root: message('root'), newer: message('newer') };
  const { bridge, reads, queued } = fixture(t, records);
  await bridge.accept(wake('reply', 'one'));
  records.parent = message('parent', 'newer');
  await bridge.accept(wake('reply', 'two'));
  assert.deepEqual(reads, ['reply', 'parent', 'root', 'reply', 'parent', 'newer']);
  assert.deepEqual(queued.map(row => row[0]), ['root', 'newer']);
});

test('failed ancestor reads queue nothing and permit a later retry', async t => {
  const records = { reply: message('reply', 'root'), root: new Error('unavailable') };
  const { bridge, queued } = fixture(t, records);
  await assert.rejects(bridge.accept(wake('reply')), /unavailable/);
  assert.equal(queued.length, 0);
  assert.equal(bridge.seen.has('signal'), false);
  records.root = message('root');
  await bridge.accept(wake('reply'));
  assert.equal(queued.length, 1);
});

test('standalone threadRoot keeps its own fresh selected read and five-hop bound', async t => {
  const records = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [String(i), message(String(i), String(i + 1))]));
  const { bridge, reads } = fixture(t, records);
  assert.equal((await bridge.threadRoot('0')).id, '5');
  assert.deepEqual(reads, ['0', '1', '2', '3', '4', '5']);
});
