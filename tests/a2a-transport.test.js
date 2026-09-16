/**
 * a2a-transport.test.js — tests for the pure A2A message transport.
 *
 * Covers: connect/disconnect, send validation, request-response round-trip,
 * timeout via fake clock, correlation, TTL drop of stale inbound, dead-letter
 * queue, route-table local delivery, reconnect backoff, and the coded-error
 * contract. No network: the wire is always a fake channel.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createA2ATransport,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_RECONNECT_BASE_MS,
  DEFAULT_RECONNECT_MAX_MS,
} from '../src/a2a-transport.mjs';

/** Controllable clock: { now, clock(), advance(ms) }. */
function fakeClock(start = 1_000_000) {
  const box = { now: start };
  return {
    box,
    clock: () => box.now,
    advance: (ms) => {
      box.now += ms;
    },
  };
}

function fakeIds(prefix = 'msg') {
  let n = 0;
  return () => `${prefix}-${(n += 1)}`;
}

/**
 * Fake channel: records outbound envelopes; inbound is driven manually via
 * deliver(). Supports onInbound registration like the real wire would.
 */
function fakeChannel({ failSend = false } = {}) {
  const sent = [];
  let inboundCb = null;
  return {
    sent,
    send(envelope) {
      if (failSend) throw new Error('wire down');
      sent.push(envelope);
    },
    onInbound(cb) {
      inboundCb = cb;
      return () => {
        inboundCb = null;
      };
    },
    deliver(envelope) {
      assert.ok(inboundCb, 'channel inbound callback not registered (transport not connected?)');
      return inboundCb(envelope);
    },
    get hasInbound() {
      return inboundCb !== null;
    },
  };
}

function expectTransportError(fn, code) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof Error, 'expected an Error');
    assert.equal(err.code, code, `expected code ${code}, got ${err.code}`);
    return true;
  });
}

async function expectTransportRejection(promise, code) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof Error, 'expected an Error');
    assert.equal(err.code, code, `expected code ${code}, got ${err.code}`);
    return true;
  });
}

describe('connect / disconnect', () => {
  it('connects with an agent id and reports status', () => {
    const t = createA2ATransport();
    assert.equal(t.connected, false);
    const res = t.connect('quill');
    assert.deepEqual(res, { agentId: 'quill', connected: true });
    assert.equal(t.connected, true);
    assert.equal(t.agentId, 'quill');
    const status = t.status();
    assert.equal(status.connected, true);
    assert.equal(status.agentId, 'quill');
  });

  it('rejects an empty agent id with a coded error', () => {
    const t = createA2ATransport();
    expectTransportError(() => t.connect(''), 'AT_INVALID_ENVELOPE');
    expectTransportError(() => t.connect(null), 'AT_INVALID_ENVELOPE');
    assert.equal(t.connected, false);
  });

  it('disconnect resets state and audits the transition', () => {
    const t = createA2ATransport();
    t.connect('quill');
    t.disconnect();
    assert.equal(t.connected, false);
    assert.equal(t.agentId, null);
    const ops = t.audit.map((e) => e.op);
    assert.ok(ops.includes('connect'));
    assert.ok(ops.includes('disconnect'));
  });

  it('disconnect rejects pending requests with AT_NOT_CONNECTED (never hangs)', async () => {
    const fc = fakeClock();
    const channel = fakeChannel();
    const t = createA2ATransport({ clock: fc.clock, channel });
    t.connect('quill');
    const p = t.request('instinct', 'ping', {});
    assert.equal(t.pendingRequestCount, 1);
    t.disconnect();
    await expectTransportRejection(p, 'AT_NOT_CONNECTED');
    assert.equal(t.pendingRequestCount, 0);
  });

  it('unregisters the channel inbound callback on disconnect', () => {
    const channel = fakeChannel();
    const t = createA2ATransport({ channel });
    t.connect('quill');
    assert.equal(channel.hasInbound, true);
    t.disconnect();
    assert.equal(channel.hasInbound, false);
  });
});

describe('send validation', () => {
  it('sends a valid envelope through the channel, stamping id and sentAt', () => {
    const fc = fakeClock();
    const channel = fakeChannel();
    const t = createA2ATransport({ clock: fc.clock, channel });
    t.connect('quill');
    const sent = t.send({ from: 'quill', to: 'instinct', type: 'ping', payload: { n: 1 } });
    assert.equal(channel.sent.length, 1);
    assert.equal(channel.sent[0], sent);
    assert.ok(typeof sent.id === 'string' && sent.id.length > 0);
    assert.equal(sent.sentAt, fc.box.now);
    assert.ok(Object.isFrozen(sent));
  });

  it('rejects envelopes missing from/to/type with AT_INVALID_ENVELOPE', () => {
    const t = createA2ATransport({ channel: fakeChannel() });
    t.connect('quill');
    expectTransportError(() => t.send({ to: 'instinct', type: 'ping' }), 'AT_INVALID_ENVELOPE');
    expectTransportError(() => t.send({ from: 'quill', type: 'ping' }), 'AT_INVALID_ENVELOPE');
    expectTransportError(() => t.send({ from: 'quill', to: 'instinct' }), 'AT_INVALID_ENVELOPE');
    expectTransportError(() => t.send({ from: '', to: 'instinct', type: 'ping' }), 'AT_INVALID_ENVELOPE');
    expectTransportError(() => t.send(null), 'AT_INVALID_ENVELOPE');
    expectTransportError(() => t.send('nope'), 'AT_INVALID_ENVELOPE');
  });

  it('rejects non-positive ttlMs with AT_INVALID_ENVELOPE', () => {
    const t = createA2ATransport({ channel: fakeChannel() });
    t.connect('quill');
    for (const ttlMs of [0, -5, NaN, Infinity, '1000']) {
      expectTransportError(
        () => t.send({ from: 'quill', to: 'instinct', type: 'ping', ttlMs }),
        'AT_INVALID_ENVELOPE',
      );
    }
  });

  it('refuses to send while disconnected with AT_NOT_CONNECTED', () => {
    const t = createA2ATransport({ channel: fakeChannel() });
    expectTransportError(
      () => t.send({ from: 'quill', to: 'instinct', type: 'ping' }),
      'AT_NOT_CONNECTED',
    );
  });

  it('uses the injected id generator', () => {
    const t = createA2ATransport({ channel: fakeChannel(), id: fakeIds('env') });
    t.connect('quill');
    const sent = t.send({ from: 'quill', to: 'instinct', type: 'ping' });
    assert.equal(sent.id, 'env-1');
  });
});

describe('receive', () => {
  it('delivers inbound channel envelopes to the registered handler', () => {
    const channel = fakeChannel();
    const t = createA2ATransport({ channel });
    t.connect('quill');
    const seen = [];
    t.receive((env) => seen.push(env));
    channel.deliver({ from: 'instinct', to: 'quill', type: 'ping', payload: { n: 7 } });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].from, 'instinct');
    assert.equal(seen[0].type, 'ping');
    assert.deepEqual(seen[0].payload, { n: 7 });
  });

  it('replacing the handler is audited; unregister stops delivery (dead-letters)', () => {
    const channel = fakeChannel();
    const t = createA2ATransport({ channel });
    t.connect('quill');
    const seen = [];
    const unregisterStale = t.receive((env) => seen.push(env));
    const unregisterCurrent = t.receive(() => {});
    const ops = t.audit.map((e) => e.op);
    assert.ok(ops.filter((op) => op === 'receive-registered').length >= 2);
    unregisterStale(); // stale handle: the handler was replaced, so this is a no-op
    unregisterCurrent(); // removes the live handler
    channel.deliver({ from: 'instinct', to: 'quill', type: 'ping' });
    assert.equal(seen.length, 0);
    assert.equal(t.deadLetters.length, 1);
    assert.equal(t.deadLetters[0].reason, 'no receive handler registered');
  });

  it('requires connection and a function handler', () => {
    const t = createA2ATransport();
    expectTransportError(() => t.receive(() => {}), 'AT_NOT_CONNECTED');
    t.connect('quill');
    expectTransportError(() => t.receive('nope'), 'AT_INVALID_ENVELOPE');
  });
});

describe('request-response', () => {
  it('round-trips: request resolves with the correlated response envelope', async () => {
    const fc = fakeClock();
    const channel = fakeChannel();
    const t = createA2ATransport({ clock: fc.clock, id: fakeIds('r'), channel });
    t.connect('quill');
    const p = t.request('instinct', 'ping', { n: 1 });
    assert.equal(channel.sent.length, 1);
    const req = channel.sent[0];
    assert.equal(req.id, 'r-1');
    assert.equal(req.from, 'quill');
    // Remote side answers using replyTo(); channel delivers the response.
    const responder = createA2ATransport({ clock: fc.clock });
    responder.connect('instinct');
    channel.deliver(responder.replyTo(req, { n: 2 }, 'ping.response'));
    const res = await p;
    assert.equal(res.inReplyTo, 'r-1');
    assert.equal(res.from, 'instinct');
    assert.deepEqual(res.payload, { n: 2 });
    assert.equal(t.pendingRequestCount, 0);
  });

  it('non-response inbound still reaches the handler while a request is pending', async () => {
    const channel = fakeChannel();
    const t = createA2ATransport({ channel, requestTimeoutMs: 60_000 });
    t.connect('quill');
    const seen = [];
    t.receive((env) => seen.push(env));
    const p = t.request('instinct', 'ping', {});
    const reqId = channel.sent[0].id;
    channel.deliver({ from: 'instinct', to: 'quill', type: 'chat', payload: 'hi' });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].type, 'chat');
    assert.equal(t.pendingRequestCount, 1);
    t.disconnect();
    await expectTransportRejection(p, 'AT_NOT_CONNECTED');
    assert.notEqual(reqId, undefined);
  });

  it('a response with an unknown inReplyTo falls through to the handler', () => {
    const channel = fakeChannel();
    const t = createA2ATransport({ channel });
    t.connect('quill');
    const seen = [];
    t.receive((env) => seen.push(env));
    channel.deliver({
      from: 'instinct',
      to: 'quill',
      type: 'ping.response',
      inReplyTo: 'no-such-request',
      payload: {},
    });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].inReplyTo, 'no-such-request');
  });

  it('times out via the injected clock and sweep() with AT_TIMEOUT', async () => {
    const fc = fakeClock();
    const t = createA2ATransport({ clock: fc.clock, channel: fakeChannel() });
    t.connect('quill');
    const p = t.request('instinct', 'slow', {}, { timeoutMs: 500 });
    fc.advance(499);
    assert.deepEqual(t.sweep(), []);
    fc.advance(1);
    const expired = t.sweep();
    assert.equal(expired.length, 1);
    await expectTransportRejection(p, 'AT_TIMEOUT');
    assert.equal(t.pendingRequestCount, 0);
    assert.ok(t.audit.some((e) => e.op === 'request-timeout'));
  });

  it('uses the default request timeout when none is given', async () => {
    const fc = fakeClock();
    const t = createA2ATransport({ clock: fc.clock, channel: fakeChannel() });
    t.connect('quill');
    const p = t.request('instinct', 'slow', {});
    fc.advance(DEFAULT_REQUEST_TIMEOUT_MS);
    t.sweep();
    await expectTransportRejection(p, 'AT_TIMEOUT');
  });

  it('request while disconnected rejects with AT_NOT_CONNECTED', async () => {
    const t = createA2ATransport({ channel: fakeChannel() });
    await expectTransportRejection(t.request('instinct', 'ping', {}), 'AT_NOT_CONNECTED');
  });

  it('request with bad to/type rejects with AT_INVALID_ENVELOPE', async () => {
    const t = createA2ATransport({ channel: fakeChannel() });
    t.connect('quill');
    await expectTransportRejection(t.request('', 'ping', {}), 'AT_INVALID_ENVELOPE');
    await expectTransportRejection(t.request('instinct', '', {}), 'AT_INVALID_ENVELOPE');
  });

  it('a late response after timeout is not delivered twice (falls to handler)', async () => {
    const fc = fakeClock();
    const channel = fakeChannel();
    const t = createA2ATransport({ clock: fc.clock, channel });
    t.connect('quill');
    const seen = [];
    t.receive((env) => seen.push(env));
    const p = t.request('instinct', 'ping', {}, { timeoutMs: 100 });
    const reqId = channel.sent[0].id;
    fc.advance(200);
    t.sweep();
    await expectTransportRejection(p, 'AT_TIMEOUT');
    channel.deliver({ from: 'instinct', to: 'quill', type: 'ping.response', inReplyTo: reqId, payload: {} });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].inReplyTo, reqId);
  });
});

describe('TTL expiry', () => {
  it('drops stale inbound and audits the drop (never delivered)', () => {
    const fc = fakeClock();
    const channel = fakeChannel();
    const t = createA2ATransport({ clock: fc.clock, channel });
    t.connect('quill');
    const seen = [];
    t.receive((env) => seen.push(env));
    const result = channel.deliver({
      from: 'instinct',
      to: 'quill',
      type: 'ping',
      sentAt: fc.box.now - 5_000,
      ttlMs: 1_000,
    });
    // deliver() returns the channel's inbound callback result
    assert.equal(seen.length, 0);
    assert.ok(t.audit.some((e) => e.op === 'ttl-expired'));
    assert.equal(result.delivered, false);
    assert.equal(result.reason, 'ttl-expired');
  });

  it('delivers fresh inbound inside its TTL', () => {
    const fc = fakeClock();
    const channel = fakeChannel();
    const t = createA2ATransport({ clock: fc.clock, channel });
    t.connect('quill');
    const seen = [];
    t.receive((env) => seen.push(env));
    channel.deliver({
      from: 'instinct',
      to: 'quill',
      type: 'ping',
      sentAt: fc.box.now - 500,
      ttlMs: 1_000,
    });
    assert.equal(seen.length, 1);
  });
});

describe('dead-letter queue', () => {
  it('dead-letters when there is no local route and no channel', () => {
    const t = createA2ATransport(); // no channel
    t.connect('quill');
    expectTransportError(
      () => t.send({ from: 'quill', to: 'ghost', type: 'ping' }),
      'AT_ROUTE_FAILED',
    );
    assert.equal(t.deadLetters.length, 1);
    assert.match(t.deadLetters[0].reason, /no local route/);
    assert.equal(t.deadLetters[0].code, 'AT_ROUTE_FAILED');
  });

  it('dead-letters when channel.send throws, with backoff recorded', () => {
    const channel = fakeChannel({ failSend: true });
    const t = createA2ATransport({ channel });
    t.connect('quill');
    expectTransportError(
      () => t.send({ from: 'quill', to: 'instinct', type: 'ping' }),
      'AT_ROUTE_FAILED',
    );
    assert.equal(t.deadLetters.length, 1);
    assert.match(t.deadLetters[0].reason, /wire down/);
    assert.equal(t.reconnectAttempts, 1);
    assert.equal(t.reconnectDelayMs, DEFAULT_RECONNECT_BASE_MS);
  });

  it('dead-letters invalid inbound envelopes (audited, never delivered)', () => {
    const channel = fakeChannel();
    const t = createA2ATransport({ channel });
    t.connect('quill');
    const seen = [];
    t.receive((env) => seen.push(env));
    channel.deliver({ from: 'instinct', type: 'ping' }); // missing `to`
    assert.equal(seen.length, 0);
    assert.equal(t.deadLetters.length, 1);
    assert.equal(t.deadLetters[0].reason, 'invalid inbound envelope');
    assert.ok(t.audit.some((e) => e.op === 'inbound-invalid'));
  });

  it('clearDeadLetters empties the queue and returns the entries', () => {
    const t = createA2ATransport();
    t.connect('quill');
    expectTransportError(() => t.send({ from: 'quill', to: 'ghost', type: 'ping' }), 'AT_ROUTE_FAILED');
    const cleared = t.clearDeadLetters();
    assert.equal(cleared.length, 1);
    assert.equal(t.deadLetters.length, 0);
    assert.ok(Object.isFrozen(cleared[0]));
  });
});

describe('route table local delivery', () => {
  it('delivers locally to a registered transport without touching the channel', async () => {
    const fc = fakeClock();
    const chanA = fakeChannel();
    const chanB = fakeChannel();
    const a = createA2ATransport({ clock: fc.clock, channel: chanA, id: fakeIds('a') });
    const b = createA2ATransport({ clock: fc.clock, channel: chanB, id: fakeIds('b') });
    a.connect('quill');
    b.connect('instinct');
    const seenB = [];
    b.receive((env) => seenB.push(env));
    a.registerRoute('instinct', b); // pass the transport; ingest is used
    const sent = a.send({ from: 'quill', to: 'instinct', type: 'ping', payload: { n: 3 } });
    assert.equal(chanA.sent.length, 0, 'channel must not be used for local routes');
    assert.equal(seenB.length, 1);
    assert.equal(seenB[0].id, sent.id);
  });

  it('request/response works across two locally-linked transports', async () => {
    const fc = fakeClock();
    const a = createA2ATransport({ clock: fc.clock, channel: fakeChannel() });
    const b = createA2ATransport({ clock: fc.clock, channel: fakeChannel() });
    a.connect('quill');
    b.connect('instinct');
    a.registerRoute('instinct', b);
    b.registerRoute('quill', a);
    b.receive((req) => {
      b.send(b.replyTo(req, { pong: true }));
    });
    const res = await a.request('instinct', 'ping', {}, { timeoutMs: 1_000 });
    assert.equal(res.from, 'instinct');
    assert.deepEqual(res.payload, { pong: true });
    assert.ok(res.inReplyTo);
  });

  it('accepts a plain deliver function as the route target', () => {
    const t = createA2ATransport({ channel: fakeChannel() });
    t.connect('quill');
    const got = [];
    t.registerRoute('local-echo', (env) => got.push(env));
    t.send({ from: 'quill', to: 'local-echo', type: 'ping' });
    assert.equal(got.length, 1);
  });

  it('unregister removes the route; status lists registered routes', () => {
    const t = createA2ATransport({ channel: fakeChannel() });
    t.connect('quill');
    const unregister = t.registerRoute('instinct', () => {});
    assert.deepEqual(t.status().routes, ['instinct']);
    unregister();
    assert.deepEqual(t.status().routes, []);
  });

  it('rejects bad route registrations with coded errors', () => {
    const t = createA2ATransport({ channel: fakeChannel() });
    t.connect('quill');
    expectTransportError(() => t.registerRoute('', () => {}), 'AT_INVALID_ENVELOPE');
    expectTransportError(() => t.registerRoute('x', null), 'AT_INVALID_ENVELOPE');
    expectTransportError(() => t.registerRoute('x', {}), 'AT_INVALID_ENVELOPE');
  });
});

describe('reconnect backoff', () => {
  it('doubles per failure and caps at the max', () => {
    const t = createA2ATransport({
      reconnectBaseMs: 1_000,
      reconnectMaxMs: 8_000,
    });
    t.connect('quill');
    assert.equal(t.reconnectDelayMs, 0);
    assert.equal(t.reconnect(), 1_000);
    assert.equal(t.reconnect(), 2_000);
    assert.equal(t.reconnect(), 4_000);
    assert.equal(t.reconnect(), 8_000);
    assert.equal(t.reconnect(), 8_000, 'capped at max');
    assert.equal(t.reconnectAttempts, 5);
    assert.ok(t.audit.some((e) => e.op === 'channel-failed'));
  });

  it('connect() resets the backoff', () => {
    const t = createA2ATransport({ reconnectBaseMs: 1_000, reconnectMaxMs: 8_000 });
    t.connect('quill');
    t.reconnect();
    t.reconnect();
    assert.equal(t.reconnectDelayMs, 2_000);
    t.disconnect();
    t.connect('quill');
    assert.equal(t.reconnectAttempts, 0);
    assert.equal(t.reconnectDelayMs, 0);
  });

  it('channel failures during send feed the same backoff', () => {
    const channel = fakeChannel({ failSend: true });
    const t = createA2ATransport({ channel, reconnectBaseMs: 500, reconnectMaxMs: 10_000 });
    t.connect('quill');
    expectTransportError(() => t.send({ from: 'quill', to: 'x', type: 'ping' }), 'AT_ROUTE_FAILED');
    expectTransportError(() => t.send({ from: 'quill', to: 'x', type: 'ping' }), 'AT_ROUTE_FAILED');
    assert.equal(t.reconnectDelayMs, 1_000);
  });
});

describe('coded-error contract', () => {
  it('every failure carries a code property and audit entries are frozen', () => {
    const codes = new Set();
    const t = createA2ATransport({ channel: fakeChannel() });
    const capture = (fn) => {
      try {
        fn();
      } catch (err) {
        assert.ok(err instanceof Error);
        assert.ok(typeof err.code === 'string', 'error must carry a code');
        codes.add(err.code);
      }
    };
    capture(() => t.send({ from: 'a', to: 'b', type: 'c' })); // not connected
    capture(() => t.connect('')); // invalid agent id
    t.connect('quill');
    capture(() => t.send({ from: 'quill', to: 'b' })); // invalid envelope
    capture(() => t.send({ from: 'quill', to: 'ghost', type: 'ping' })); // no route... has channel though
    assert.ok(codes.has('AT_NOT_CONNECTED'));
    assert.ok(codes.has('AT_INVALID_ENVELOPE'));
    for (const entry of t.audit) {
      assert.ok(Object.isFrozen(entry));
    }
    assert.ok(codes.size >= 2);
  });

  it('failures are never silent: timeouts reject, drops audit, undeliverables dead-letter', async () => {
    const fc = fakeClock();
    const channel = fakeChannel();
    const t = createA2ATransport({ clock: fc.clock, channel });
    t.connect('quill');
    const p = t.request('instinct', 'ping', {}, { timeoutMs: 10 });
    fc.advance(50);
    const expired = t.sweep();
    assert.equal(expired.length, 1);
    await expectTransportRejection(p, 'AT_TIMEOUT');
    // Nothing pending, everything accounted for in the audit.
    assert.equal(t.pendingRequestCount, 0);
    const ops = new Set(t.audit.map((e) => e.op));
    assert.ok(ops.has('request'));
    assert.ok(ops.has('request-timeout'));
  });
});
