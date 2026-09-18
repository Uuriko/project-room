/**
 * telegram-connect.test.js — tests for the Telegram bot token connection state machine.
 *
 * Covers: happy path, malformed tokens, wrong-transition errors, staged-token
 * expiry (verify + sweep), verifier-failure path, fingerprint-never-raw-token
 * assertion, disconnect/re-stage, and the coded-error contract.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createTelegramConnect,
  DEFAULT_STAGE_TTL_MS,
  STATES,
  TOKEN_FORMAT,
} from '../src/telegram-connect.mjs';

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

// Obviously fake fixture token: the shape Telegram uses, never a real token.
const VALID_TOKEN = '123456789:FAKE_FAKE_FAKE_FAKE_FAKE_FAKE_FAKE_';

function expectTgError(fn, code) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof Error, 'expected an Error');
    assert.equal(err.code, code, `expected code ${code}, got ${err.code}`);
    return true;
  });
}

/** Walk snapshots + audit and fail if the raw token string appears anywhere. */
function assertNoRawTokenLeak(machine, rawToken) {
  const haystack = JSON.stringify(machine.audit);
  assert.ok(
    !haystack.includes(rawToken),
    'raw token leaked into the audit log',
  );
  for (const entry of machine.audit) {
    const detail = JSON.stringify(entry.detail);
    assert.ok(!detail.includes(rawToken), 'raw token leaked into an audit detail');
  }
}

describe('telegram-connect', () => {
  it('happy path: disconnected → token-staged → verifying → connected', () => {
    const machine = createTelegramConnect({
      verifier: (botId) => ({ botId, username: 'dasha_bot', ok: true }),
    });
    const created = machine.createConnection('dasha alerts', 'agent');
    assert.equal(created.state, 'disconnected');
    assert.equal(created.tokenFingerprint, null);

    const staged = machine.stageToken(created.id, VALID_TOKEN, 'agent');
    assert.equal(staged.state, 'token-staged');
    assert.equal(staged.botId, '123456789');
    assert.ok(staged.tokenFingerprint);
    assert.ok(staged.tokenFingerprint.includes(VALID_TOKEN.slice(-4)));
    assert.ok(!staged.tokenFingerprint.includes(VALID_TOKEN));

    const connected = machine.verify(created.id, 'agent');
    assert.equal(connected.state, 'connected');
    assert.deepEqual(connected.botProfile, {
      botId: '123456789',
      username: 'dasha_bot',
      ok: true,
    });
    assert.ok(connected.verifiedAt);

    assertNoRawTokenLeak(machine, VALID_TOKEN);
  });

  it('fingerprint is stored; the raw token never appears in snapshots or audit', () => {
    const machine = createTelegramConnect();
    const created = machine.createConnection('x', 'agent');
    const staged = machine.stageToken(created.id, VALID_TOKEN, 'agent');

    const snapJson = JSON.stringify(machine.get(created.id));
    assert.ok(!snapJson.includes(VALID_TOKEN), 'raw token in snapshot');
    assert.ok(snapJson.includes(staged.tokenFingerprint), 'fingerprint missing from snapshot');

    machine.verify(created.id, 'agent');
    const afterJson = JSON.stringify(machine.get(created.id));
    assert.ok(!afterJson.includes(VALID_TOKEN), 'raw token leaked after verify');

    assertNoRawTokenLeak(machine, VALID_TOKEN);
  });

  it('malformed tokens throw TG_TOKEN_MALFORMED and stay disconnected', () => {
    const machine = createTelegramConnect();
    const { id } = machine.createConnection('x', 'agent');
    for (const bad of [
      '',
      'not-a-token',
      '123456789', // no colon
      ':AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw', // no bot id
      'abc:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw', // non-digit bot id
      '123456789:AAHdq cv', // space
      '123 456:secret', // space in bot id
      123456789, // not a string
      null,
    ]) {
      expectTgError(() => machine.stageToken(id, bad, 'agent'), 'TG_TOKEN_MALFORMED');
      assert.equal(machine.get(id).state, 'disconnected');
    }
  });

  it('wrong-transition errors throw TG_INVALID_TRANSITION', () => {
    const machine = createTelegramConnect();
    const { id } = machine.createConnection('x', 'agent');

    // verify with no staged token
    expectTgError(() => machine.verify(id, 'agent'), 'TG_INVALID_TRANSITION');
    // disconnect while already disconnected
    expectTgError(() => machine.disconnect(id, 'agent'), 'TG_INVALID_TRANSITION');

    machine.stageToken(id, VALID_TOKEN, 'agent');
    machine.verify(id, 'agent');
    assert.equal(machine.get(id).state, 'connected');

    // stage over a live connection
    expectTgError(() => machine.stageToken(id, VALID_TOKEN, 'agent'), 'TG_INVALID_TRANSITION');
    // verify twice
    expectTgError(() => machine.verify(id, 'agent'), 'TG_INVALID_TRANSITION');
  });

  it('staged token expiry: verify throws TG_VERIFY_EXPIRED and moves to expired', () => {
    const fc = fakeClock();
    const machine = createTelegramConnect({ clock: fc.clock });
    const { id } = machine.createConnection('x', 'agent');
    machine.stageToken(id, VALID_TOKEN, 'agent');

    fc.advance(DEFAULT_STAGE_TTL_MS + 1);
    expectTgError(() => machine.verify(id, 'agent'), 'TG_VERIFY_EXPIRED');
    assert.equal(machine.get(id).state, 'expired');

    assertNoRawTokenLeak(machine, VALID_TOKEN);
  });

  it('sweep() expires stale staged tokens and returns their ids', () => {
    const fc = fakeClock();
    const machine = createTelegramConnect({ clock: fc.clock });
    const a = machine.createConnection('a', 'agent');
    machine.stageToken(a.id, VALID_TOKEN, 'agent');
    const b = machine.createConnection('b', 'agent');
    machine.stageToken(b.id, '987654321:another-secret_123', 'agent');

    fc.advance(DEFAULT_STAGE_TTL_MS + 1);
    const expired = machine.sweep('system');
    assert.deepEqual(expired.sort(), [a.id, b.id].sort());
    assert.equal(machine.get(a.id).state, 'expired');
    assert.equal(machine.get(b.id).state, 'expired');

    // re-stage after expiry works
    const restaged = machine.stageToken(a.id, VALID_TOKEN, 'agent');
    assert.equal(restaged.state, 'token-staged');
  });

  it('verifier failure throws TG_VERIFY_FAILED and moves to failed', () => {
    const machine = createTelegramConnect({
      verifier: () => {
        throw new Error('401 Unauthorized: bot token revoked');
      },
    });
    const { id } = machine.createConnection('x', 'agent');
    machine.stageToken(id, VALID_TOKEN, 'agent');

    expectTgError(() => machine.verify(id, 'agent'), 'TG_VERIFY_FAILED');
    const snap = machine.get(id);
    assert.equal(snap.state, 'failed');
    assert.ok(snap.failReason.includes('401 Unauthorized'));

    assertNoRawTokenLeak(machine, VALID_TOKEN);
  });

  it('verifier returning no profile throws TG_VERIFY_FAILED', () => {
    const machine = createTelegramConnect({ verifier: () => null });
    const { id } = machine.createConnection('x', 'agent');
    machine.stageToken(id, VALID_TOKEN, 'agent');
    expectTgError(() => machine.verify(id, 'agent'), 'TG_VERIFY_FAILED');
    assert.equal(machine.get(id).state, 'failed');
  });

  it('disconnect wipes the staged token and returns to disconnected; re-stage works', () => {
    const machine = createTelegramConnect();
    const { id } = machine.createConnection('x', 'agent');
    const staged = machine.stageToken(id, VALID_TOKEN, 'agent');
    const disc = machine.disconnect(id, 'agent');
    assert.equal(disc.state, 'disconnected');
    assert.equal(disc.botProfile, null);
    // fingerprint is retained for auditability; raw token is gone
    assert.equal(disc.tokenFingerprint, staged.tokenFingerprint);

    const restaged = machine.stageToken(id, '555:brand-new-secret', 'agent');
    assert.equal(restaged.state, 'token-staged');
    assert.equal(restaged.botId, '555');
    machine.verify(id, 'agent');
    assert.equal(machine.get(id).state, 'connected');

    assertNoRawTokenLeak(machine, VALID_TOKEN);
  });

  it('unknown connection id throws TG_NOT_FOUND', () => {
    const machine = createTelegramConnect();
    expectTgError(() => machine.stageToken('nope', VALID_TOKEN, 'agent'), 'TG_NOT_FOUND');
    expectTgError(() => machine.verify('nope', 'agent'), 'TG_NOT_FOUND');
    expectTgError(() => machine.disconnect('nope', 'agent'), 'TG_NOT_FOUND');
    assert.equal(machine.get('nope'), null);
  });

  it('coded-error contract: every failure is an Error with a TG_ code', () => {
    const machine = createTelegramConnect();
    const failures = [
      () => machine.stageToken('missing', VALID_TOKEN),
      () => machine.verify('missing'),
      () => machine.disconnect('missing'),
      () => {
        const c = machine.createConnection();
        machine.stageToken(c.id, 'bad token!');
      },
      () => {
        const c = machine.createConnection();
        machine.verify(c.id);
      },
    ];
    for (const fn of failures) {
      assert.throws(fn, (err) => {
        assert.ok(err instanceof Error, 'must be an Error');
        assert.match(String(err.code), /^TG_[A-Z_]+$/, `code ${err.code} must be TG_*`);
        assert.ok(err.message.length > 0, 'message must be non-empty');
        return true;
      });
    }
  });

  it('STATES lists every state and TOKEN_FORMAT matches the suggested pattern', () => {
    assert.deepEqual([...STATES].sort(), [
      'connected',
      'disconnected',
      'expired',
      'failed',
      'token-staged',
      'verifying',
    ].sort());
    assert.ok(TOKEN_FORMAT.test(VALID_TOKEN));
    assert.ok(!TOKEN_FORMAT.test('abc:def'));
  });
});
