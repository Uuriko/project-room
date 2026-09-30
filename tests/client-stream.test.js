import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomClient } from '../src/client.js';

function fixture(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(Math, 'random', () => 0);
  const streams = [], statuses = [], streamRequests = [];
  class Events extends EventTarget {
    constructor(url) { super(); this.url = url; this.readyState = 0; streams.push(this); }
    close() { this.readyState = 2; }
    emit(type, readyState) { this.readyState = readyState; this.dispatchEvent(new Event(type)); }
  }
  const session = { roomId: 'commons', member: { id: 'human' }, account: { id: 'account-human', authEpoch: 0 }, sessionBinding: 'binding-one' };
  const fetcher = async (url, options) => {
    if (typeof url === 'string' && url.includes('/stream')) {
      streamRequests.push({ url, headers: options?.headers ?? {} });
      // Never resolve the body: the stream stays connecting in tests.
      return { ok: true, body: null };
    }
    return {
      ok: true, json: async () => ({ sequence: 7, roomId: 'commons', viewerId: 'human',
        viewerAccountId: session.account.id, viewerAuthEpoch: 0, viewerSessionBinding: session.sessionBinding,
        viewerSessionRevision: session.sessionRevision })
    };
  };
  const client = new RoomClient({ events: Events, onStatus: status => statuses.push(status), fetcher });
  client.session = session;
  t.after(() => client.disconnect());
  const emit = async (type, state) => { streams.at(-1).emit(type, state); await client.flight?.promise; };
  return { client, streams, statuses, emit, streamRequests };
}

test('native reconnect is preserved; closed streams retry once with bounded backoff and the current cursor', async t => {
  const { client, streams, statuses, emit } = fixture(t);
  client.connect();
  await emit('error', 0);
  t.mock.timers.tick(60000);
  assert.equal(streams.length, 1, 'CONNECTING remains owned by the browser');
  for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
    const before = streams.length;
    await emit('error', 2); await emit('error', 2);
    t.mock.timers.tick(delay - 1);
    assert.equal(streams.length, before, 'duplicate errors cannot accelerate the retry');
    t.mock.timers.tick(1);
    assert.equal(streams.length, before + 1);
    assert.match(streams.at(-1).url, /after=7$/);
    assert.ok(!statuses.some(status => status.startsWith('Connected')));
  }
  await emit('open', 1);
  assert.match(statuses.at(-1), /^Connected/);
  await emit('error', 2);
  const before = streams.length;
  t.mock.timers.tick(1000);
  assert.equal(streams.length, before + 1, 'a real open resets backoff');
});

test('disconnect, access end, manual reconnect, and identity replacement invalidate pending stream retries', async t => {
  const { client, streams, emit } = fixture(t);
  for (const change of [
    () => client.disconnect(), () => client.endAccess(), () => client.connect(),
    () => { client.session = { ...client.session, sessionBinding: 'replacement' }; }
  ]) {
    client.session = { roomId: 'commons', member: { id: 'human' }, account: { id: 'account-human', authEpoch: 0 }, sessionBinding: 'binding-one' };
    client.connect(); await emit('error', 2);
    const obsolete = streams.at(-1);
    change();
    const before = streams.length;
    t.mock.timers.tick(60000);
    obsolete.emit('error', 2);
    t.mock.timers.tick(60000);
    assert.equal(streams.length, before, 'obsolete work cannot reopen another identity');
    client.disconnect();
  }
});

test('expired authorization ends access and cancels a queued closed-stream retry', async t => {
  const { client, streams } = fixture(t);
  client.connect();
  client.fetcher = async () => ({ ok: false, status: 401, json: async () => ({ error: { message: 'Session ended' } }) });
  streams[0].emit('error', 2);
  await client.flight.promise.catch(() => {});
  await Promise.resolve();
  t.mock.timers.tick(60000);
  assert.equal(client.session, null);
  assert.equal(streams.length, 1);
});

test('a queued reconnect rechecks account ownership without signing out the replacement account', async t => {
  const { client, streams, emit, streamRequests } = fixture(t);
  const session = client.session;
  session.authMode = 'account'; session.sessionRevision = 1;
  const account = { generation: 1, session: { ...session } };
  client.accountClient = account;
  client.accountOwnership = { client: account, generation: 1, session: account.session };
  client.connect();
  // L-P2-14: the binding travels as a request header, never in the URL.
  assert.equal(streamRequests.length, 1);
  assert.match(streamRequests[0].url, /\/stream\?after=\d+&auth=account$/);
  assert.ok(!streamRequests[0].url.includes('binding='), 'no binding in the stream URL');
  assert.equal(streamRequests[0].headers['x-session-binding'], 'binding-one');
  client.stream.readyState = 2;
  client.stream.dispatchEvent(new Event('error'));
  await client.flight?.promise;
  assert.equal(client.session, session);
  assert.ok(client.streamRetry, 'the original account owns a pending retry');
  const replacement = { account: { id: 'other', authEpoch: 0 }, sessionBinding: 'other-binding' };
  account.session = replacement; account.generation++;
  t.mock.timers.tick(1000);
  assert.equal(client.session, null);
  assert.equal(streams.length, 0, 'account mode no longer uses the EventSource mock');
  assert.equal(account.session, replacement);
});

test('a late stream-refresh rejection cannot clear a replacement session', async t => {
  const { client, streams } = fixture(t);
  client.fetcher = async () => ({ ok: false, status: 401, json: async () => ({ error: { message: 'Old session ended' } }) });
  client.connect(); streams[0].emit('error', 0);
  const oldFlight = client.flight.promise;
  // Let request/refresh reject, but switch identity before the stream's outer catch.
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  client.disconnect();
  const replacement = { roomId: 'commons', member: { id: 'replacement' },
    account: { id: 'replacement-account', authEpoch: 0 }, sessionBinding: 'replacement-binding' };
  client.session = replacement; client.connect();
  await oldFlight.catch(() => {}); await Promise.resolve();
  assert.equal(client.session, replacement);
  assert.equal(streams.length, 2);
});

test('a transient unavailable stream and failed refresh preserve identity and reconnect without ending access', async t => {
  const { client, streams, emit } = fixture(t);
  const session = client.session, healthyFetch = client.fetcher;
  let ended = 0;
  client.onAccessEnded = () => ended++;
  client.connect(); await emit('open', 1);
  client.fetcher = async () => ({ ok: false, status: 503, json: async () => ({ error: { code: 'storage_unavailable', message: 'Temporarily unavailable' } }) });
  streams[0].emit('unavailable', 1);
  await emit('error', 2).catch(() => {});
  await Promise.resolve();
  assert.equal(client.session, session);
  assert.equal(ended, 0);
  client.fetcher = healthyFetch;
  t.mock.timers.tick(1000);
  assert.equal(streams.length, 2);
  assert.match(streams[1].url, /after=7$/);
  await emit('open', 1);
  assert.equal(client.session, session);
  assert.equal(ended, 0);
});

test('FetchEventSource sends the session binding as a header and parses SSE frames (L-P2-14)', async t => {
  const { FetchEventSource } = await import('../src/client.js');
  const seen = [];
  const chunks = [
    ': heartbeat\n',
    'event: room-event\ndata: {"seq":1}\n\n',
    'event: access-ended\ndata: {"message":"Access ended; sign in again"}\n\n',
  ];
  const stream = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
      controller.close();
    }
  });
  const fetcher = async (url, options) => {
    seen.push({ url, headers: options.headers });
    return { ok: true, body: stream };
  };
  const source = new FetchEventSource('https://example.com/api/rooms/r/stream?after=0&auth=account',
    { headers: { 'x-session-binding': 'secret-binding' }, fetcher });
  const events = [];
  source.addEventListener('open', () => events.push(['open', null]));
  source.addEventListener('room-event', e => events.push(['room-event', e.data]));
  source.addEventListener('access-ended', e => events.push(['access-ended', e.data]));
  await new Promise(resolve => {
    source.addEventListener('error', () => resolve(), { once: true });
    setTimeout(resolve, 1000);
  });
  assert.equal(seen.length, 1);
  assert.ok(!seen[0].url.includes('binding'), 'binding must not appear in the URL');
  assert.equal(seen[0].headers['x-session-binding'], 'secret-binding');
  assert.equal(seen[0].headers['Accept'], 'text/event-stream');
  assert.deepEqual(events, [
    ['open', null],
    ['room-event', '{"seq":1}'],
    ['access-ended', '{"message":"Access ended; sign in again"}'],
  ]);
  source.close();
  assert.equal(source.readyState, 2);
});
