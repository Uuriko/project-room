import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { ReadPositionOrder } from '../src/read-position-order.js';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// Exercise the actual app handlers with controlled transport completion order.
const app = fs.readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
const handlers = app.slice(app.indexOf('async function applyHorizonAnchor()'), app.indexOf('async function toggleSaved('));
function appHarness(client) {
  const context = vm.createContext({
    client: { generation: 1, ...client }, state: {}, session: {},
    conversation: { byId: new Map([['message', {}]]) },
    horizonOrder: new ReadPositionOrder(), horizonCache: new Map(),
    horizonAnchorId: null, horizonAdvanceTimer: null, clearTimeout,
    view: 'alice', notices: [], renders: 0,
    readPositionScope: () => ({ threadId: '', peerMemberId: 'alice', cacheKey: 'alice' }),
    visibleConversationMessages: () => [{ id: 'message' }],
    horizonAnchorFor: (_messages, lastRead) => lastRead === null ? 'message' : null,
  });
  vm.runInContext('function conversationViewKey() { return view; } function notice(text) { notices.push(text); } function renderMessages() { renders++; }\n' + handlers, context);
  return context;
}

test('actual unread handler suppresses a delayed error after changing conversations', async () => {
  const response = deferred();
  const app = appHarness({ setReadHorizon: () => response.promise });
  const pending = app.markMessageUnread('message');
  await Promise.resolve();
  app.view = 'public';
  response.reject(new Error('Delayed private marker failure'));
  await pending;
  assert.equal(app.notices.length, 0);
  assert.equal(app.renders, 0);
});

test('actual anchor handler cannot erase the unread divider with an older GET', async () => {
  const response = deferred();
  const app = appHarness({ readHorizon: () => response.promise, setReadHorizon: async () => ({}) });
  const pending = app.applyHorizonAnchor();
  await app.markMessageUnread('message');
  assert.equal(app.horizonAnchorId, 'message');
  response.resolve({ lastReadMessageId: 'message' });
  await pending;
  assert.equal(app.horizonAnchorId, 'message');
  assert.equal(app.horizonCache.get('alice'), null);
});

test('delayed read cannot overwrite a later explicit rewind', async () => {
  const order = new ReadPositionOrder(), oldRead = deferred();
  let displayed = 'latest';
  const read = order.read('alice', () => oldRead.promise);
  const rewind = order.write('alice', async () => null);
  const value = await rewind.result;
  if (rewind.current()) displayed = value;
  oldRead.resolve('latest');
  const oldValue = await read.result;
  if (read.current()) displayed = oldValue;
  assert.equal(displayed, null);
});

test('explicit rewind is sent after an in-flight automatic advance finishes', async () => {
  const order = new ReadPositionOrder(), advanceResponse = deferred(), sent = [];
  let server = null;
  const advance = order.write('alice', async () => {
    sent.push('advance');
    await advanceResponse.promise;
    server = 'latest';
  });
  const rewind = order.write('alice', async () => { sent.push('rewind'); server = null; });
  await Promise.resolve();
  assert.deepEqual(sent, ['advance']);
  advanceResponse.resolve();
  await Promise.all([advance.result, rewind.result]);
  assert.deepEqual(sent, ['advance', 'rewind']);
  assert.equal(server, null);
  assert.equal(advance.current(), false);
  assert.equal(rewind.current(), true);
});

test('a read opened during a pending write waits for that write', async () => {
  const order = new ReadPositionOrder(), response = deferred();
  let server = 'old', fetched = false;
  const write = order.write('alice', async () => { await response.promise; server = null; });
  const read = order.read('alice', async () => { fetched = true; return server; });
  await Promise.resolve();
  assert.equal(fetched, false);
  response.resolve();
  await write.result;
  assert.equal(await read.result, null);
  assert.equal(read.current(), true);
});

test('failed writes do not poison the queue or block another conversation', async () => {
  const order = new ReadPositionOrder(), response = deferred();
  const first = order.write('alice', () => response.promise);
  const failure = assert.rejects(first.result, /offline/);
  const next = order.write('alice', async () => 'rewound');
  const other = order.write('bob', async () => 'independent');
  assert.equal(await other.result, 'independent');
  response.reject(new Error('offline'));
  await failure;
  assert.equal(await next.result, 'rewound');
  assert.equal(other.current(), true);
});

test('newer reads win even when older responses arrive last', async () => {
  const order = new ReadPositionOrder(), response = deferred();
  const first = order.read('room', () => response.promise);
  const second = order.read('room', async () => 'new');
  assert.equal(await second.result, 'new');
  response.resolve('old');
  await first.result;
  assert.equal(first.current(), false);
  assert.equal(second.current(), true);
});
