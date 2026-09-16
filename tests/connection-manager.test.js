/**
 * connection-manager.test.js — tests for the channel connection manager.
 *
 * Covers: register/connect happy path (sync + async connectors), connect
 * failure → failed state with coded error, disconnect, reconnect exponential
 * backoff + attempts counter, markFailed with/without injected scheduler,
 * status/statusAll, health roll-up, state-change notifications (incl.
 * unsubscribe), remove guards, and the coded-error contract.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createConnectionManager,
  CHANNEL_STATES,
  DEFAULT_BACKOFF_BASE_MS,
  DEFAULT_BACKOFF_CAP_MS,
} from '../src/connection-manager.mjs';

/** Controllable clock: { box, clock(), advance(ms) }. */
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

/** Fake connector whose connect() succeeds; records calls. */
function fakeConnector({ failConnect = null, failDisconnect = null } = {}) {
  const calls = [];
  return {
    calls,
    connect: async () => {
      calls.push('connect');
      if (failConnect) throw new Error(failConnect);
    },
    disconnect: async () => {
      calls.push('disconnect');
      if (failDisconnect) throw new Error(failDisconnect);
    },
  };
}

function makeManager(deps = {}) {
  const fc = fakeClock();
  return { fc, cm: createConnectionManager({ clock: fc.clock, ...deps }) };
}

/** Assert fn throws (or rejects) an Error with the given code. */
async function expectCmError(fn, code) {
  try {
    await fn();
  } catch (err) {
    assert.ok(err instanceof Error, 'expected an Error');
    assert.equal(err.code, code, `expected code ${code}, got ${err.code}`);
    return err;
  }
  assert.fail(`expected a throw with code ${code}`);
}

describe('connection-manager', () => {
  it('registers channels starting disconnected', () => {
    const { cm } = makeManager();
    const snap = cm.register('telegram', fakeConnector());
    assert.equal(snap.channel, 'telegram');
    assert.equal(snap.state, 'disconnected');
    assert.equal(snap.reconnectAttempts, 0);
    assert.equal(cm.status('telegram').state, 'disconnected');
  });

  it('rejects duplicate registration with CM_ALREADY_REGISTERED', async () => {
    const { cm } = makeManager();
    cm.register('email', fakeConnector());
    await expectCmError(() => cm.register('email', fakeConnector()), 'CM_ALREADY_REGISTERED');
  });

  it('connect happy path: disconnected → connecting → connected', async () => {
    const { fc, cm } = makeManager();
    const connector = fakeConnector();
    cm.register('telegram', connector);
    const snap = await cm.connect('telegram');
    assert.equal(snap.state, 'connected');
    assert.equal(snap.connectedAt, fc.box.now);
    assert.deepEqual(connector.calls, ['connect']);
    assert.equal(cm.status('telegram').reconnectAttempts, 0);
  });

  it('connect works with sync (non-promise) connectors', async () => {
    const { cm } = makeManager();
    let ran = false;
    cm.register('sms', {
      connect: () => {
        ran = true;
      },
      disconnect: () => {},
    });
    const snap = await cm.connect('sms');
    assert.ok(ran);
    assert.equal(snap.state, 'connected');
  });

  it('connect failure → failed state, lastError recorded, CM_CONNECT_FAILED', async () => {
    const { cm } = makeManager();
    cm.register('whatsapp', fakeConnector({ failConnect: 'boom: auth denied' }));
    await expectCmError(() => cm.connect('whatsapp'), 'CM_CONNECT_FAILED');
    const snap = cm.status('whatsapp');
    assert.equal(snap.state, 'failed');
    assert.equal(snap.lastError, 'boom: auth denied');
  });

  it('connect on unknown channel throws CM_NOT_FOUND', async () => {
    const { cm } = makeManager();
    await expectCmError(() => cm.connect('nope'), 'CM_NOT_FOUND');
  });

  it('connect while already connected throws CM_ALREADY_CONNECTED', async () => {
    const { cm } = makeManager();
    cm.register('email', fakeConnector());
    await cm.connect('email');
    await expectCmError(() => cm.connect('email'), 'CM_ALREADY_CONNECTED');
  });

  it('disconnect moves connected → disconnected and calls connector', async () => {
    const { cm } = makeManager();
    const connector = fakeConnector();
    cm.register('telegram', connector);
    await cm.connect('telegram');
    const snap = await cm.disconnect('telegram');
    assert.equal(snap.state, 'disconnected');
    assert.equal(snap.connectedAt, null);
    assert.deepEqual(connector.calls, ['connect', 'disconnect']);
  });

  it('disconnect on disconnected throws CM_INVALID_STATE', async () => {
    const { cm } = makeManager();
    cm.register('email', fakeConnector());
    await expectCmError(() => cm.disconnect('email'), 'CM_INVALID_STATE');
  });

  it('disconnect failure → failed state with CM_DISCONNECT_FAILED', async () => {
    const { cm } = makeManager();
    cm.register('sms', fakeConnector({ failDisconnect: 'socket hung up' }));
    await cm.connect('sms');
    await expectCmError(() => cm.disconnect('sms'), 'CM_DISCONNECT_FAILED');
    assert.equal(cm.status('sms').state, 'failed');
    assert.equal(cm.status('sms').lastError, 'socket hung up');
  });

  it('reconnect uses exponential backoff with injected base/cap', async () => {
    const { fc, cm } = makeManager({ backoffBaseMs: 1000, backoffCapMs: 4000 });
    const connector = fakeConnector({ failConnect: 'down' });
    cm.register('telegram', connector);

    await expectCmError(() => cm.reconnect('telegram'), 'CM_RECONNECT_FAILED');
    assert.equal(cm.status('telegram').reconnectAttempts, 1);
    assert.equal(cm.status('telegram').lastReconnectDelayMs, 1000);
    assert.equal(cm.status('telegram').nextReconnectAt, fc.box.now + 1000);

    await expectCmError(() => cm.reconnect('telegram'), 'CM_RECONNECT_FAILED');
    assert.equal(cm.status('telegram').reconnectAttempts, 2);
    assert.equal(cm.status('telegram').lastReconnectDelayMs, 2000);

    await expectCmError(() => cm.reconnect('telegram'), 'CM_RECONNECT_FAILED');
    assert.equal(cm.status('telegram').reconnectAttempts, 3);
    assert.equal(cm.status('telegram').lastReconnectDelayMs, 4000); // capped

    // A success resets the attempts counter and clears retry bookkeeping.
    let fails = true;
    connector.connect = async () => {
      if (fails) throw new Error('down');
    };
    fails = false;
    const snap = await cm.reconnect('telegram');
    assert.equal(snap.state, 'connected');
    assert.equal(snap.reconnectAttempts, 0);
    assert.equal(snap.lastReconnectDelayMs, null);
    assert.equal(snap.nextReconnectAt, null);
  });

  it('reconnect from connected works (re-establishes)', async () => {
    const { cm } = makeManager();
    const connector = fakeConnector();
    cm.register('email', connector);
    await cm.connect('email');
    const snap = await cm.reconnect('email');
    assert.equal(snap.state, 'connected');
    assert.equal(snap.reconnectAttempts, 0);
    assert.deepEqual(connector.calls, ['connect', 'connect']);
  });

  it('markFailed marks failed and, with a scheduler, schedules reconnect', async () => {
    const scheduled = [];
    const { cm } = makeManager({
      backoffBaseMs: 500,
      scheduler: (fn, delayMs) => scheduled.push({ fn, delayMs }),
    });
    const connector = fakeConnector();
    cm.register('whatsapp', connector);
    await cm.connect('whatsapp');

    const snap = cm.markFailed('whatsapp', new Error('socket reset'));
    assert.equal(snap.state, 'failed');
    assert.equal(snap.lastError, 'socket reset');
    assert.equal(snap.connectedAt, null);
    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0].delayMs, 500); // attempt 1 backoff

    // Drive the scheduled retry explicitly (no real timers in tests).
    await scheduled[0].fn();
    assert.equal(cm.status('whatsapp').state, 'connected');
  });

  it('markFailed without a scheduler performs no timers (explicit reconnect)', async () => {
    const { cm } = makeManager({ backoffBaseMs: 250 });
    cm.register('sms', fakeConnector());
    await cm.connect('sms');
    cm.markFailed('sms', new Error('ping timeout'));
    assert.equal(cm.status('sms').state, 'failed');
    // nextReconnectAt tells the caller when the explicit retry is due.
    assert.ok(cm.status('sms').nextReconnectAt != null);
    const snap = await cm.reconnect('sms');
    assert.equal(snap.state, 'connected');
  });

  it('statusAll returns a snapshot per registered channel', async () => {
    const { cm } = makeManager();
    cm.register('telegram', fakeConnector());
    cm.register('email', fakeConnector({ failConnect: 'no' }));
    await cm.connect('telegram');
    await expectCmError(() => cm.connect('email'), 'CM_CONNECT_FAILED');
    const all = cm.statusAll();
    assert.equal(all.length, 2);
    const byChannel = Object.fromEntries(all.map((s) => [s.channel, s.state]));
    assert.deepEqual(byChannel, { telegram: 'connected', email: 'failed' });
  });

  it('health reports state, uptimeMs only when connected, and lastError', async () => {
    const { fc, cm } = makeManager();
    cm.register('telegram', fakeConnector());
    cm.register('email', fakeConnector({ failConnect: 'auth' }));
    await cm.connect('telegram');
    await expectCmError(() => cm.connect('email'), 'CM_CONNECT_FAILED');
    fc.advance(5_000);
    const rows = cm.health();
    const byChannel = Object.fromEntries(rows.map((r) => [r.channel, r]));
    assert.equal(byChannel.telegram.state, 'connected');
    assert.equal(byChannel.telegram.uptimeMs, 5_000);
    assert.ok(!('lastError' in byChannel.telegram));
    assert.equal(byChannel.email.state, 'failed');
    assert.equal(byChannel.email.lastError, 'auth');
    assert.ok(!('uptimeMs' in byChannel.email));
  });

  it('onStateChange notifies on transitions; unsubscribe stops them', async () => {
    const { cm } = makeManager();
    cm.register('telegram', fakeConnector());
    const seen = [];
    const off = cm.onStateChange('telegram', (evt) => seen.push(evt));
    await cm.connect('telegram');
    await cm.disconnect('telegram');
    assert.deepEqual(
      seen.map((e) => [e.from, e.to]),
      [
        ['disconnected', 'connecting'],
        ['connecting', 'connected'],
        ['connected', 'disconnected'],
      ],
    );
    assert.ok(seen.every((e) => e.channel === 'telegram'));
    off();
    await cm.connect('telegram');
    assert.equal(seen.length, 3);
  });

  it('onStateChange on unknown channel throws CM_NOT_FOUND', async () => {
    const { cm } = makeManager();
    await expectCmError(() => cm.onStateChange('nope', () => {}), 'CM_NOT_FOUND');
  });

  it('remove only works from disconnected; active channels are guarded', async () => {
    const { cm } = makeManager();
    cm.register('email', fakeConnector());
    await cm.connect('email');
    await expectCmError(() => cm.remove('email'), 'CM_REMOVE_WHILE_ACTIVE');
    await cm.disconnect('email');
    assert.equal(cm.remove('email'), true);
    await expectCmError(() => cm.status('email'), 'CM_NOT_FOUND');
    await expectCmError(() => cm.remove('email'), 'CM_NOT_FOUND');
  });

  it('coded-error contract: every failure throws Error with a code', async () => {
    const { cm } = makeManager();
    const cases = [
      [() => cm.register('', fakeConnector()), 'CM_INVALID_STATE'],
      [() => cm.status('ghost'), 'CM_NOT_FOUND'],
      [() => cm.disconnect('ghost'), 'CM_NOT_FOUND'],
      [() => cm.reconnect('ghost'), 'CM_NOT_FOUND'],
      [() => cm.markFailed('ghost', new Error('x')), 'CM_NOT_FOUND'],
      [() => cm.remove('ghost'), 'CM_NOT_FOUND'],
    ];
    for (const [fn, code] of cases) {
      await expectCmError(fn, code);
    }
  });

  it('exposes channel states and backoff defaults', () => {
    const { cm } = makeManager();
    assert.deepEqual([...CHANNEL_STATES], [
      'disconnected',
      'connecting',
      'connected',
      'reconnecting',
      'failed',
    ]);
    assert.equal(cm.backoffBaseMs, DEFAULT_BACKOFF_BASE_MS);
    assert.equal(cm.backoffCapMs, DEFAULT_BACKOFF_CAP_MS);
  });

  it('events log records the full transition history', async () => {
    const { cm } = makeManager();
    cm.register('sms', fakeConnector());
    await cm.connect('sms');
    const transitions = cm.events.map((e) => [e.from, e.to]);
    assert.deepEqual(transitions, [
      [null, 'disconnected'],
      ['disconnected', 'connecting'],
      ['connecting', 'connected'],
    ]);
  });
});
