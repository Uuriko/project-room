/**
 * whatsapp-connect.test.js — tests for the WhatsApp connection state machine.
 *
 * Covers: happy path (disconnected → code-staged → linking → connected),
 * invalid phone numbers, wrong code, too many attempts invalidating the code,
 * code expiry via fake clock, link-failure path, phone fingerprint-not-raw
 * assertion, and the coded-error contract.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createWhatsAppConnect,
  DEFAULT_CODE_TTL_MS,
  DEFAULT_MAX_CODE_ATTEMPTS,
  E164_RE,
  PAIRING_CODE_RE,
  STATES,
} from '../src/whatsapp-connect.mjs';

/** Controllable clock: { now, clock(), advance(ms) }. */
function fakeClock(start = 2_000_000) {
  const box = { now: start };
  return {
    box,
    clock: () => box.now,
    advance: (ms) => {
      box.now += ms;
    },
  };
}

/** Fixed pairing-code generator for deterministic tests. */
function fixedCode(value = '1234-5678') {
  return () => value;
}

/** Success linker: always succeeds. */
function okLinker() {
  return () => ({ ok: true, sessionToken: 'mock-token' });
}

function expectWaError(fn, code) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof Error, 'expected an Error');
    assert.equal(err.code, code, `expected code ${code}, got ${err.code}`);
    return true;
  });
}

const PHONE = '+14155550123';

describe('whatsapp-connect', () => {
  it('exposes the documented states and defaults', () => {
    assert.deepEqual(STATES, [
      'disconnected',
      'code-staged',
      'linking',
      'connected',
      'failed',
      'expired',
    ]);
    assert.equal(DEFAULT_CODE_TTL_MS, 10 * 60 * 1000);
    assert.equal(DEFAULT_MAX_CODE_ATTEMPTS, 5);
  });

  it('happy path: disconnected → code-staged → linking → connected', () => {
    const fc = fakeClock();
    const wa = createWhatsAppConnect({ clock: fc.clock, code: fixedCode(), linker: okLinker() });

    const created = wa.createConnection();
    assert.equal(created.state, 'disconnected');

    const staged = wa.stageCode(created.id, PHONE);
    assert.equal(staged.state, 'code-staged');
    assert.equal(staged.phoneFingerprint, '0123');
    assert.equal(staged.codeAttempts, 0);

    const linking = wa.confirmCode(created.id, '1234-5678');
    assert.equal(linking.state, 'linking');

    const connected = wa.link(created.id);
    assert.equal(connected.state, 'connected');
    assert.equal(connected.linkedAt, fc.box.now);

    assert.equal(wa.get(created.id).state, 'connected');
  });

  it('rejects invalid phone numbers with WA_PHONE_INVALID', () => {
    const wa = createWhatsAppConnect({ code: fixedCode() });
    const { id } = wa.createConnection();
    for (const bad of ['4155550123', '+', '+04155550123', '++14155550123', '+1415', '', null, 4155550123, '+14155550123456789']) {
      expectWaError(() => wa.stageCode(id, bad), 'WA_PHONE_INVALID');
    }
    // Connection stays disconnected after rejected staging attempts.
    assert.equal(wa.get(id).state, 'disconnected');
  });

  it('accepts valid E.164 numbers', () => {
    assert.ok(E164_RE.test('+14155550123'));
    assert.ok(E164_RE.test('+447911123456'));
    assert.ok(E164_RE.test('+100000000'));
    assert.ok(!E164_RE.test('14155550123'));
  });

  it('wrong code throws WA_CODE_MISMATCH and counts attempts', () => {
    const wa = createWhatsAppConnect({ code: fixedCode(), linker: okLinker() });
    const { id } = wa.createConnection();
    wa.stageCode(id, PHONE);
    expectWaError(() => wa.confirmCode(id, '0000-0000'), 'WA_CODE_MISMATCH');
    assert.equal(wa.get(id).state, 'code-staged');
    assert.equal(wa.get(id).codeAttempts, 1);
    // Right code still works after a wrong attempt.
    assert.equal(wa.confirmCode(id, '1234-5678').state, 'linking');
  });

  it('too many attempts invalidates the code → failed + WA_ATTEMPTS_EXCEEDED', () => {
    const wa = createWhatsAppConnect({
      code: fixedCode(),
      linker: okLinker(),
      maxCodeAttempts: 3,
    });
    const { id } = wa.createConnection();
    wa.stageCode(id, PHONE);
    expectWaError(() => wa.confirmCode(id, '0000-0000'), 'WA_CODE_MISMATCH');
    expectWaError(() => wa.confirmCode(id, '1111-1111'), 'WA_CODE_MISMATCH');
    expectWaError(() => wa.confirmCode(id, '2222-2222'), 'WA_ATTEMPTS_EXCEEDED');
    const snap = wa.get(id);
    assert.equal(snap.state, 'failed');
    assert.equal(snap.failReason, 'too many wrong attempts');
    // Invalidated code: even the correct code is rejected afterwards.
    expectWaError(() => wa.confirmCode(id, '1234-5678'), 'WA_INVALID_TRANSITION');
  });

  it('defaults to 5 attempts before invalidation', () => {
    const wa = createWhatsAppConnect({ code: fixedCode() });
    const { id } = wa.createConnection();
    wa.stageCode(id, PHONE);
    for (let i = 0; i < 4; i += 1) {
      expectWaError(() => wa.confirmCode(id, '9999-9999'), 'WA_CODE_MISMATCH');
    }
    expectWaError(() => wa.confirmCode(id, '9999-9999'), 'WA_ATTEMPTS_EXCEEDED');
  });

  it('code expiry via fake clock → expired + WA_CODE_EXPIRED', () => {
    const fc = fakeClock();
    const wa = createWhatsAppConnect({ clock: fc.clock, code: fixedCode(), codeTtlMs: 1000 });
    const { id } = wa.createConnection();
    wa.stageCode(id, PHONE);
    fc.advance(1001);
    expectWaError(() => wa.confirmCode(id, '1234-5678'), 'WA_CODE_EXPIRED');
    assert.equal(wa.get(id).state, 'expired');
    // Restaging is allowed from expired.
    const restaged = wa.stageCode(id, PHONE);
    assert.equal(restaged.state, 'code-staged');
  });

  it('sweep() expires stale codes without throwing', () => {
    const fc = fakeClock();
    const wa = createWhatsAppConnect({ clock: fc.clock, code: fixedCode(), codeTtlMs: 500 });
    const { id } = wa.createConnection();
    wa.stageCode(id, PHONE);
    fc.advance(600);
    assert.deepEqual(wa.sweep(), [id]);
    assert.equal(wa.get(id).state, 'expired');
  });

  it('linker throwing → failed + WA_LINK_FAILED', () => {
    const linker = () => {
      throw new Error('transport exploded');
    };
    const wa = createWhatsAppConnect({ code: fixedCode(), linker });
    const { id } = wa.createConnection();
    wa.stageCode(id, PHONE);
    wa.confirmCode(id, '1234-5678');
    expectWaError(() => wa.link(id), 'WA_LINK_FAILED');
    const snap = wa.get(id);
    assert.equal(snap.state, 'failed');
    assert.equal(snap.failReason, 'transport exploded');
  });

  it('never stores the raw phone number — only the last-4 fingerprint', () => {
    const wa = createWhatsAppConnect({ code: fixedCode(), linker: okLinker() });
    const { id } = wa.createConnection();
    wa.stageCode(id, '+491711234567');
    const snap = wa.get(id);
    assert.equal(snap.phoneFingerprint, '4567');
    const serialized = JSON.stringify(snap);
    assert.ok(!serialized.includes('491711234567'), 'raw phone number must not appear in the snapshot');
    const auditJson = JSON.stringify(wa.audit);
    assert.ok(!auditJson.includes('491711234567'), 'raw phone number must not appear in the audit log');
  });

  it('staged code is never exposed in snapshots', () => {
    const wa = createWhatsAppConnect({ code: fixedCode('9999-0000') });
    const { id } = wa.createConnection();
    wa.stageCode(id, PHONE);
    const serialized = JSON.stringify(wa.get(id));
    assert.ok(!serialized.includes('9999-0000'), 'staged code must not appear in snapshots');
  });

  it('injected code generator output is validated against XXXX-XXXX', () => {
    assert.ok(PAIRING_CODE_RE.test('1234-5678'));
    assert.ok(!PAIRING_CODE_RE.test('12345678'));
    assert.ok(!PAIRING_CODE_RE.test('bad'));
    const wa = createWhatsAppConnect({ code: () => 'bad' });
    const { id } = wa.createConnection();
    expectWaError(() => wa.stageCode(id, PHONE), 'WA_INVALID_TRANSITION');
    assert.equal(wa.get(id).state, 'disconnected');
  });

  it('coded-error contract: unknown ids raise WA_NOT_FOUND (get returns null)', () => {
    const wa = createWhatsAppConnect();
    assert.equal(wa.get('nope'), null);
    expectWaError(() => wa.stageCode('nope', PHONE), 'WA_NOT_FOUND');
    expectWaError(() => wa.confirmCode('nope', '0000-0000'), 'WA_NOT_FOUND');
    expectWaError(() => wa.link('nope'), 'WA_NOT_FOUND');
  });

  it('invalid transitions raise WA_INVALID_TRANSITION', () => {
    const wa = createWhatsAppConnect({ code: fixedCode(), linker: okLinker() });
    const { id } = wa.createConnection();
    expectWaError(() => wa.confirmCode(id, '1234-5678'), 'WA_INVALID_TRANSITION');
    expectWaError(() => wa.link(id), 'WA_INVALID_TRANSITION');
    wa.stageCode(id, PHONE);
    expectWaError(() => wa.stageCode(id, PHONE), 'WA_INVALID_TRANSITION');
    expectWaError(() => wa.link(id), 'WA_INVALID_TRANSITION');
  });

  it('audit log records every transition', () => {
    const wa = createWhatsAppConnect({ code: fixedCode(), linker: okLinker() });
    const { id } = wa.createConnection();
    wa.stageCode(id, PHONE);
    wa.confirmCode(id, '1234-5678');
    wa.link(id);
    const states = wa.audit.map((e) => e.to);
    assert.deepEqual(states, ['disconnected', 'code-staged', 'linking', 'connected']);
  });
});
