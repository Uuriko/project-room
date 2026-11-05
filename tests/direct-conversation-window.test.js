import test from 'node:test';
import assert from 'node:assert/strict';
import { createDirectConversationWindow } from '../src/direct-conversation-window.js';
const page = (ids, nextCursor = null) => ({ mode: 'replace', messages: ids.map(id => ({ id })), nextCursor, checkpoint: 'head' });
const tick = () => new Promise(resolve => setImmediate(resolve));
test('selected pair pages explicitly; replacements invalidate older records', async () => {
  const requests = [], answers = [page(['3','4'], 'older'), page(['1','2']), page(['4','5'])];
  const window = createDirectConversationWindow({ read: async query => { requests.push(query); return answers.shift(); } });
  window.select('alice', 'account-one'); window.sync(1); await tick();
  assert.equal(requests.length, 1); assert.deepEqual(window.view().messages.map(m => m.id), ['3','4']);
  await window.older(); assert.deepEqual(window.view().messages.map(m => m.id), ['1','2','3','4']);
  window.sync(2); await tick(); assert.deepEqual(window.view().messages.map(m => m.id), ['4','5']);
  assert.equal(requests[1].cursor, 'older'); assert.equal(requests[2].since, 'head');
});
test('late responses cannot cross conversation or identity boundaries', async () => {
  const pending = [];
  const window = createDirectConversationWindow({ read: query => new Promise(resolve => pending.push({ query, resolve })) });
  window.select('alice', 'one'); window.sync(1);
  window.select('bob', 'one'); window.sync(1);
  pending[0].resolve(page(['alice-secret'])); await tick(); assert.deepEqual(window.view().messages, []);
  pending[1].resolve(page(['bob-secret'])); await tick(); assert.equal(window.view().messages[0].id, 'bob-secret');
  window.select('bob', 'two'); assert.deepEqual(window.view().messages, []);
  window.sync(1); window.clear(); pending[2].resolve(page(['old-account'])); await tick();
  assert.deepEqual(window.view().messages, []);
});
test('snapshot bursts coalesce and reset handling is bounded with explicit retry', async () => {
  let resolve, calls = 0;
  const window = createDirectConversationWindow({ read: () => { calls++; return calls === 1 ? new Promise(r => resolve = r) : Promise.resolve({ mode: 'reset' }); } });
  window.select('alice', 'one'); window.sync(1); window.sync(2); window.sync(3);
  assert.equal(calls, 1); resolve(page(['first'])); await tick(); await tick();
  assert.equal(calls, 3); assert.match(window.view().error.message, /changed again/);
  window.sync(3); await tick(); assert.equal(calls, 3, 'no automatic retry loop');
});

test('an older selected thread root is reauthorized separately when latest pages replace history', async () => {
  const requests = [];
  let unavailable = false;
  const window = createDirectConversationWindow({ read: async query => {
    requests.push(query);
    if (query.messageId) {
      if (unavailable) throw Object.assign(new Error('missing'), { status: 404 });
      return page([query.messageId]);
    }
    return page(['recent']);
  } });
  window.select('alice', 'one'); window.pin('old-root'); window.sync(1); await tick();
  assert.equal(window.view().anchorMessage.id, 'old-root');
  assert.deepEqual(requests[1], { peerMemberId: 'alice', messageId: 'old-root', limit: 1 });
  unavailable = true; window.sync(2); await tick();
  assert.equal(window.view().anchorMessage, null, 'inaccessible roots are not retained as authority');
});

test('message selection reads only target ancestry and rejects mixed revisions', async () => {
  const { createMessageSelection } = await import('../src/direct-conversation-window.js');
  const requests = []; let moved = false;
  const selection = createMessageSelection({ read: async query => {
    requests.push(query);
    return { mode: 'replace', sequence: moved && query.messageId === 'root' ? 2 : 1,
      messages: [{ id: query.messageId, replyToId: query.messageId === 'reply' ? 'root' : null }] };
  } });
  selection.select('reply', 'one'); selection.sync(1); await tick();
  assert.deepEqual(requests, [{ messageId: 'reply', limit: 1 }, { messageId: 'root', limit: 1 }]);
  assert.deepEqual(selection.view().messages.map(m => m.id), ['root', 'reply']);
  moved = true; selection.sync(2); await tick();
  assert.deepEqual(selection.view().messages, []);
  assert.ok(selection.view().error);
});

test('message selection discards stale identity replies and bounds malformed ancestry', async () => {
  const { createMessageSelection } = await import('../src/direct-conversation-window.js');
  let resolve;
  const selection = createMessageSelection({ read: () => new Promise(r => resolve = r) });
  selection.select('private', 'one'); selection.sync(1); selection.clear();
  resolve({ mode: 'replace', sequence: 1, messages: [{ id: 'private' }] }); await tick();
  assert.deepEqual(selection.view().messages, []);
  let calls = 0;
  const cyclic = createMessageSelection({ read: async ({ messageId }) => {
    calls++; return { mode: 'replace', sequence: 1, messages: [{ id: messageId, replyToId: messageId }] };
  } });
  cyclic.select('cycle', 'one'); cyclic.sync(1); await tick();
  assert.equal(calls, 1); assert.ok(cyclic.view().error);
  cyclic.sync(1); await tick(); assert.equal(calls, 1, 'no retry loop on corrupt ancestry');
});


test('selected-message ancestry has a hard request bound and drops denied records', async () => {
  const { createMessageSelection } = await import('../src/direct-conversation-window.js');
  let count = 0;
  const deep = createMessageSelection({ read: async ({ messageId }) => {
    count++; return { mode: 'replace', sequence: 1, messages: [{ id: messageId, replyToId: String(Number(messageId) + 1) }] };
  } });
  deep.select('1', 'one'); deep.sync(1); await tick();
  assert.equal(count, 32); assert.deepEqual(deep.view().messages, []); assert.ok(deep.view().error);
  let denied = false;
  const selection = createMessageSelection({ read: async ({ messageId }) => {
    if (denied) throw Object.assign(new Error('denied'), { status: 403 });
    return { mode: 'replace', sequence: 1, messages: [{ id: messageId }] };
  } });
  selection.select('private', 'one'); selection.sync(1); await tick();
  assert.equal(selection.view().messages.length, 1);
  denied = true; selection.sync(2); await tick();
  assert.deepEqual(selection.view().messages, []);
});

test('conversation directory pages explicitly and replaces stale pages on a new room head', async () => {
  const { createConversationDirectory } = await import('../src/direct-conversation-window.js');
  const answers = [
    { mode: 'replace', peers: [{ memberId: 'alice' }], nextCursor: 'next' },
    { mode: 'replace', peers: [{ memberId: 'bob' }], nextCursor: null },
    { mode: 'replace', peers: [{ memberId: 'carol' }], nextCursor: null },
  ], requests = [];
  const directory = createConversationDirectory({ read: async query => { requests.push(query); return answers.shift(); } });
  directory.sync('one', 1); await tick();
  assert.equal(requests.length, 1, 'no background full-directory walk');
  await directory.more(); assert.deepEqual(directory.view().peers.map(p => p.memberId), ['alice', 'bob']);
  directory.sync('one', 2); await tick(); assert.deepEqual(directory.view().peers.map(p => p.memberId), ['carol']);
});

test('directory resets are bounded and stale identity responses cannot repopulate it', async () => {
  const { createConversationDirectory } = await import('../src/direct-conversation-window.js');
  let calls = 0;
  const directory = createConversationDirectory({ read: async () => { calls++; return { mode: 'reset' }; } });
  directory.sync('one', 1); await tick(); assert.equal(calls, 2); assert.ok(directory.view().error);
  directory.sync('one', 1); await tick(); assert.equal(calls, 2);
  let resolve;
  const late = createConversationDirectory({ read: () => new Promise(r => resolve = r) });
  late.sync('one', 1); late.clear(); resolve({ mode: 'replace', peers: [{ memberId: 'private' }], nextCursor: null });
  await tick(); assert.deepEqual(late.view().peers, []);
});
