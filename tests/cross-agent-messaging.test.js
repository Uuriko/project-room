/**
 * cross-agent-messaging.test.js — tests for agent-to-agent messaging.
 *
 * Covers: send happy path, field validation, transport failure → failed
 * (CAM_UNDELIVERABLE, never silent), inbound wiring, thread ordering,
 * markRead recipient-only, conversations latest-per-counterpart, retryFailed,
 * outbox state filter, delivery receipts, and the coded-error contract.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createMessaging,
  STATES,
  MIN_BODY_LENGTH,
  MAX_BODY_LENGTH,
} from '../src/cross-agent-messaging.mjs';

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

/** Deterministic id generator: msg-1, msg-2, ... */
function fakeIds(prefix = 'msg') {
  let n = 0;
  return () => `${prefix}-${(n += 1)}`;
}

/** Fake transport: send captures envelopes, receive captures inbound handlers. */
function fakeTransport({ failSend = false } = {}) {
  const sent = [];
  const inboundHandlers = [];
  let attempts = 0;
  const transport = {
    sent,
    inboundHandlers,
    get attempts() {
      return attempts;
    },
    send: (envelope) => {
      attempts += 1;
      if (typeof failSend === 'function' ? failSend() : failSend) {
        throw new Error('network down');
      }
      sent.push(envelope);
      return { ok: true };
    },
    receive: (handler) => {
      inboundHandlers.push(handler);
      return () => {};
    },
  };
  return transport;
}

function make(fc = fakeClock(), transport = fakeTransport()) {
  return {
    fc,
    transport,
    messaging: createMessaging({
      clock: fc.clock,
      id: fakeIds(),
      transport,
    }),
  };
}

function expectCamError(fn, code) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof Error, 'expected an Error');
    assert.equal(err.code, code, `expected code ${code}, got ${err.code}`);
    return true;
  });
}

describe('cross-agent-messaging', () => {
  it('send happy path: validates, records queued, delivers to sent', () => {
    const { fc, transport, messaging } = make();
    const sent = messaging.sendMessage({
      from: 'quill',
      to: 'instinct',
      body: 'Ready for review',
      threadId: 't-1',
    });
    assert.equal(sent.id, 'msg-1');
    assert.equal(sent.from, 'quill');
    assert.equal(sent.to, 'instinct');
    assert.equal(sent.threadId, 't-1');
    assert.equal(sent.body, 'Ready for review');
    assert.equal(sent.sentAt, fc.box.now);
    assert.equal(sent.state, 'sent');
    assert.equal(transport.sent.length, 1);
    assert.equal(transport.sent[0].id, 'msg-1');
    assert.equal(transport.sent[0].state, 'queued');
  });

  it('validation: empty body, oversized body, missing/self from/to', () => {
    const { messaging } = make();
    expectCamError(
      () => messaging.sendMessage({ from: 'quill', to: 'instinct', body: '' }),
      'CAM_INVALID_MSG',
    );
    expectCamError(
      () => messaging.sendMessage({ from: 'quill', to: 'instinct', body: 'x'.repeat(MAX_BODY_LENGTH + 1) }),
      'CAM_INVALID_MSG',
    );
    expectCamError(
      () => messaging.sendMessage({ from: '', to: 'instinct', body: 'hi' }),
      'CAM_INVALID_MSG',
    );
    expectCamError(
      () => messaging.sendMessage({ from: 'quill', to: '', body: 'hi' }),
      'CAM_INVALID_MSG',
    );
    expectCamError(
      () => messaging.sendMessage({ from: 'quill', to: 'quill', body: 'self ping' }),
      'CAM_INVALID_MSG',
    );
    expectCamError(
      () => messaging.sendMessage({ from: 'quill', to: 'instinct', body: 'hi', threadId: '' }),
      'CAM_INVALID_MSG',
    );
    expectCamError(() => messaging.sendMessage(), 'CAM_INVALID_MSG');
  });

  it('boundary bodies: 1 char ok, 5000 chars ok', () => {
    const { messaging } = make();
    const one = messaging.sendMessage({ from: 'a', to: 'b', body: 'x'.repeat(MIN_BODY_LENGTH) });
    assert.equal(one.state, 'sent');
    const max = messaging.sendMessage({ from: 'a', to: 'b', body: 'x'.repeat(MAX_BODY_LENGTH) });
    assert.equal(max.state, 'sent');
  });

  it('transport failure → failed + CAM_UNDELIVERABLE (never silent)', () => {
    const { messaging } = make(fakeClock(), fakeTransport({ failSend: true }));
    expectCamError(
      () =>
        messaging.sendMessage({ from: 'quill', to: 'instinct', body: 'will fail' }),
      'CAM_UNDELIVERABLE',
    );
    const failed = messaging.get('msg-1');
    assert.equal(failed.state, 'failed');
    assert.equal(failed.body, 'will fail');
  });

  it('sending without a usable transport throws CAM_NO_TRANSPORT', () => {
    const fc = fakeClock();
    const messaging = createMessaging({ clock: fc.clock, id: fakeIds() });
    expectCamError(
      () => messaging.sendMessage({ from: 'quill', to: 'instinct', body: 'no transport' }),
      'CAM_NO_TRANSPORT',
    );
  });

  it('onInbound wires transport.receive; inbound lands delivered + handler fires', () => {
    const { fc, transport, messaging } = make();
    const seen = [];
    const unsub = messaging.onInbound((msg) => seen.push(msg));
    assert.equal(transport.inboundHandlers.length, 1);
    assert.equal(typeof unsub, 'function');

    fc.advance(5_000);
    transport.inboundHandlers[0]({
      from: 'instinct',
      to: 'quill',
      body: 'Ack, on it',
      threadId: 't-9',
    });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].from, 'instinct');
    assert.equal(seen[0].to, 'quill');
    assert.equal(seen[0].state, 'delivered');
    assert.equal(seen[0].sentAt, fc.box.now);
    const stored = messaging.get(seen[0].id);
    assert.equal(stored.state, 'delivered');

    // Malformed inbound envelope is never silently swallowed.
    expectCamError(
      () => transport.inboundHandlers[0]({ from: 'instinct', to: 'quill', body: '' }),
      'CAM_INVALID_MSG',
    );
  });

  it('onInbound without transport.receive throws CAM_NO_TRANSPORT; bad handler CAM_INVALID_ARG', () => {
    const { messaging } = make();
    const noReceive = createMessaging({
      clock: fakeClock().clock,
      transport: { send: () => {} },
    });
    expectCamError(() => noReceive.onInbound(() => {}), 'CAM_NO_TRANSPORT');
    expectCamError(() => messaging.onInbound('not-a-function'), 'CAM_INVALID_ARG');
  });

  it('thread() returns ordered messages; unknown thread throws CAM_NOT_FOUND', () => {
    const { fc, messaging } = make();
    messaging.sendMessage({ from: 'quill', to: 'instinct', body: 'first', threadId: 't-a' });
    fc.advance(1_000);
    messaging.sendMessage({ from: 'instinct', to: 'quill', body: 'second', threadId: 't-a' });
    fc.advance(1_000);
    messaging.sendMessage({ from: 'quill', to: 'instinct', body: 'other thread', threadId: 't-b' });

    const thread = messaging.thread('t-a');
    assert.deepEqual(thread.map((m) => m.body), ['first', 'second']);
    assert.ok(thread[0].sentAt < thread[1].sentAt);
    expectCamError(() => messaging.thread('nope'), 'CAM_NOT_FOUND');
  });

  it('markRead is recipient-only, delivered → read, idempotent', () => {
    const { messaging } = make();
    const sent = messaging.sendMessage({ from: 'quill', to: 'instinct', body: 'ping' });
    messaging.receipt(sent.id, { status: 'delivered' });

    // Sender may not mark read.
    expectCamError(() => messaging.markRead(sent.id, 'quill'), 'CAM_NOT_RECIPIENT');
    // Unknown id.
    expectCamError(() => messaging.markRead('msg-999', 'instinct'), 'CAM_NOT_FOUND');

    const read = messaging.markRead(sent.id, 'instinct');
    assert.equal(read.state, 'read');
    // Idempotent second call.
    const again = messaging.markRead(sent.id, 'instinct');
    assert.equal(again.state, 'read');

    // Cannot mark a queued/failed message read.
    const queued = messaging.sendMessage({ from: 'a', to: 'b', body: 'fresh' });
    // sent state (not delivered yet) — allowed to move straight? No: only delivered→read.
    expectCamError(() => messaging.markRead(queued.id, 'b'), 'CAM_INVALID_TRANSITION');
  });

  it('conversations() returns latest per counterpart, newest first', () => {
    const { fc, messaging } = make();
    messaging.sendMessage({ from: 'quill', to: 'instinct', body: 'q→i #1' });
    fc.advance(1_000);
    messaging.sendMessage({ from: 'quill', to: 'codex', body: 'q→c #1' });
    fc.advance(1_000);
    messaging.sendMessage({ from: 'instinct', to: 'quill', body: 'i→q #2' });
    fc.advance(1_000);
    messaging.sendMessage({ from: 'codex', to: 'quill', body: 'c→q #2' });
    fc.advance(1_000);
    messaging.sendMessage({ from: 'quill', to: 'instinct', body: 'q→i #3 latest' });

    const convos = messaging.conversations('quill');
    assert.equal(convos.length, 2);
    assert.deepEqual(
      convos.map((c) => [c.counterpart, c.message.body]),
      [
        ['instinct', 'q→i #3 latest'],
        ['codex', 'c→q #2'],
      ],
    );
    // Empty for an agent with no messages.
    assert.deepEqual(messaging.conversations('grokbot'), []);
  });

  it('retryFailed: failed → queued → sent; non-failed retry rejected', () => {
    const failOnce = { fail: true };
    const { messaging, transport } = make(
      fakeClock(),
      fakeTransport({ failSend: () => failOnce.fail }),
    );
    expectCamError(
      () => messaging.sendMessage({ from: 'quill', to: 'instinct', body: 'flaky' }),
      'CAM_UNDELIVERABLE',
    );
    assert.equal(messaging.get('msg-1').state, 'failed');

    failOnce.fail = false;
    const retried = messaging.retryFailed('msg-1');
    assert.equal(retried.state, 'sent');
    assert.equal(transport.attempts, 2);

    // Retrying a non-failed message is rejected.
    expectCamError(() => messaging.retryFailed('msg-1'), 'CAM_INVALID_TRANSITION');
    expectCamError(() => messaging.retryFailed('msg-999'), 'CAM_NOT_FOUND');
  });

  it('retryFailed re-fails on a second transport failure (never silent)', () => {
    const { messaging } = make(fakeClock(), fakeTransport({ failSend: true }));
    expectCamError(
      () => messaging.sendMessage({ from: 'quill', to: 'instinct', body: 'down' }),
      'CAM_UNDELIVERABLE',
    );
    expectCamError(() => messaging.retryFailed('msg-1'), 'CAM_UNDELIVERABLE');
    assert.equal(messaging.get('msg-1').state, 'failed');
  });

  it('outbox() lists own outbound, filters by state, rejects bad state', () => {
    const failOnce = { fail: true };
    const { messaging } = make(
      fakeClock(),
      fakeTransport({ failSend: () => failOnce.fail }),
    );
    failOnce.fail = false;
    messaging.sendMessage({ from: 'quill', to: 'instinct', body: 'ok #1' });
    failOnce.fail = true;
    expectCamError(
      () => messaging.sendMessage({ from: 'quill', to: 'instinct', body: 'boom' }),
      'CAM_UNDELIVERABLE',
    );
    failOnce.fail = false;
    messaging.sendMessage({ from: 'instinct', to: 'quill', body: 'not mine' });
    messaging.sendMessage({ from: 'quill', to: 'codex', body: 'ok #2' });

    const all = messaging.outbox('quill');
    assert.deepEqual(all.map((m) => m.body), ['ok #1', 'boom', 'ok #2']);

    const sentOnly = messaging.outbox('quill', { state: 'sent' });
    assert.deepEqual(sentOnly.map((m) => m.body), ['ok #1', 'ok #2']);
    const failedOnly = messaging.outbox('quill', { state: 'failed' });
    assert.deepEqual(failedOnly.map((m) => m.body), ['boom']);

    expectCamError(() => messaging.outbox('quill', { state: 'bogus' }), 'CAM_INVALID_STATE');
  });

  it('delivery receipts: sent → delivered → read; bad status rejected', () => {
    const { messaging } = make();
    const sent = messaging.sendMessage({ from: 'quill', to: 'instinct', body: 'ping' });

    // read-receipt before delivered is rejected.
    expectCamError(
      () => messaging.receipt(sent.id, { status: 'read', actor: 'instinct' }),
      'CAM_INVALID_TRANSITION',
    );

    const delivered = messaging.receipt(sent.id, { status: 'delivered', actor: 'instinct' });
    assert.equal(delivered.state, 'delivered');

    // Non-recipient read receipt rejected.
    expectCamError(
      () => messaging.receipt(sent.id, { status: 'read', actor: 'quill' }),
      'CAM_NOT_RECIPIENT',
    );
    const read = messaging.receipt(sent.id, { status: 'read', actor: 'instinct' });
    assert.equal(read.state, 'read');

    expectCamError(
      () => messaging.receipt(sent.id, { status: 'bogus', actor: 'instinct' }),
      'CAM_INVALID_RECEIPT',
    );
    expectCamError(() => messaging.receipt('msg-999', { status: 'delivered' }), 'CAM_NOT_FOUND');
  });

  it('coded-error contract: every failure is an Error with a code', () => {
    const { messaging } = make();
    const cases = [
      [() => messaging.sendMessage({ from: 'x', to: 'x', body: 'self' }), 'CAM_INVALID_MSG'],
      [() => messaging.sendMessage({ from: 'x', to: 'y', body: '' }), 'CAM_INVALID_MSG'],
      [() => messaging.thread('missing'), 'CAM_NOT_FOUND'],
      [() => messaging.markRead('msg-1', 'y'), 'CAM_NOT_FOUND'],
      [() => messaging.outbox('x', { state: 'wat' }), 'CAM_INVALID_STATE'],
      [() => messaging.receipt('msg-1', { status: 'wat' }), 'CAM_NOT_FOUND'],
    ];
    for (const [fn, code] of cases) {
      expectCamError(fn, code);
    }
  });

  it('snapshots are frozen and audit records every transition', () => {
    const { messaging } = make();
    const sent = messaging.sendMessage({ from: 'quill', to: 'instinct', body: 'ping' });
    assert.ok(Object.isFrozen(sent));
    messaging.receipt(sent.id, { status: 'delivered' });
    messaging.markRead(sent.id, 'instinct');

    const kinds = messaging.audit.map((e) => e.to);
    assert.deepEqual(kinds, ['queued', 'sent', 'delivered', 'read']);
    assert.ok(Object.isFrozen(messaging.audit[0]));
  });

  it('exports STATES and body limits', () => {
    assert.deepEqual([...STATES], ['queued', 'sent', 'delivered', 'read', 'failed']);
    assert.equal(MIN_BODY_LENGTH, 1);
    assert.equal(MAX_BODY_LENGTH, 5000);
  });
});
