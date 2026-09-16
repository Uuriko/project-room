import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  createWebhookHmacVerifier,
  DEFAULT_MAX_SKEW_MS,
} from '../src/webhook-hmac-verification.mjs';

const here = dirname(fileURLToPath(import.meta.url));

const SECRET = 'test-webhook-signing-secret-abc123';
const OTHER_SECRET = 'a-different-secret-xyz789';

function sign(body, secret = SECRET) {
  return `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;
}

/** Fake clock starting at a fixed epoch ms. */
function makeClock(start = 1_700_000_000_000) {
  let now = start;
  const clock = () => now;
  clock.advance = (ms) => {
    now += ms;
  };
  clock.set = (ms) => {
    now = ms;
  };
  return clock;
}

/** Fake secretProvider backed by a plain map. */
function makeSecretProvider(secrets = { default: SECRET }) {
  const provider = (secretId) => secrets[secretId] ?? null;
  provider.secrets = secrets;
  return provider;
}

describe('webhook HMAC verification', () => {
  let clock;
  let verifier;

  beforeEach(() => {
    clock = makeClock();
    verifier = createWebhookHmacVerifier({
      clock,
      secretProvider: makeSecretProvider(),
    });
  });

  it('accepts a valid signature and reports secretId + timestamp', () => {
    const rawBody = JSON.stringify({ event: 'ping', id: 42 });
    const result = verifier.verify({
      rawBody,
      headers: {
        'x-room-signature': sign(rawBody),
        'x-room-timestamp': String(clock()),
      },
    });
    assert.deepEqual(result, { ok: true, secretId: 'default', timestamp: clock() });
  });

  it('accepts epoch-seconds timestamps and Buffer bodies', () => {
    const rawBody = Buffer.from('raw-bytes-body', 'utf8');
    const result = verifier.verify({
      rawBody,
      headers: {
        'x-room-signature': `sha256=${createHmac('sha256', SECRET).update(rawBody).digest('hex')}`,
        'x-room-timestamp': String(Math.floor(clock() / 1000)),
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.timestamp, Math.floor(clock() / 1000) * 1000);
  });

  it('timestamp is optional (null when no timestamp header)', () => {
    const rawBody = 'hello';
    const result = verifier.verify({ rawBody, headers: { 'x-room-signature': sign(rawBody) } });
    assert.deepEqual(result, { ok: true, secretId: 'default', timestamp: null });
  });

  it('header lookup is case-insensitive', () => {
    const rawBody = 'hello';
    const result = verifier.verify({
      rawBody,
      headers: { 'X-Room-Signature': sign(rawBody) },
    });
    assert.equal(result.ok, true);
  });

  it('rejects a bad signature with HV_BAD_SIGNATURE', () => {
    const rawBody = 'hello';
    const good = sign(rawBody);
    // Flip the last hex digit.
    const bad = `${good.slice(0, -1)}${good.endsWith('0') ? '1' : '0'}`;
    assert.throws(
      () => verifier.verify({ rawBody, headers: { 'x-room-signature': bad } }),
      (err) => err.code === 'HV_BAD_SIGNATURE',
    );
  });

  it('rejects a signature made with the wrong secret with HV_BAD_SIGNATURE', () => {
    const rawBody = 'hello';
    assert.throws(
      () =>
        verifier.verify({
          rawBody,
          headers: { 'x-room-signature': sign(rawBody, OTHER_SECRET) },
        }),
      (err) => err.code === 'HV_BAD_SIGNATURE',
    );
  });

  it('rejects a missing signature header with HV_MISSING_HEADER', () => {
    assert.throws(
      () => verifier.verify({ rawBody: 'hello', headers: {} }),
      (err) => err.code === 'HV_MISSING_HEADER',
    );
  });

  it('rejects malformed signature headers with HV_MALFORMED_SIGNATURE', () => {
    const rawBody = 'hello';
    for (const bad of ['nope', 'sha256=', 'md5=abc123', 'sha256=zz-top-not-hex']) {
      assert.throws(
        () => verifier.verify({ rawBody, headers: { 'x-room-signature': bad } }),
        (err) => err.code === 'HV_MALFORMED_SIGNATURE',
        `expected HV_MALFORMED_SIGNATURE for ${JSON.stringify(bad)}`,
      );
    }
  });

  it('resolves the secret id from args and from the secret-id header', () => {
    const clock2 = makeClock();
    const v = createWebhookHmacVerifier({
      clock: clock2,
      secretProvider: makeSecretProvider({ default: SECRET, rotate: OTHER_SECRET }),
    });
    const rawBody = 'hello';
    const rawBody2 = 'hello-again';
    // via explicit arg
    assert.equal(
      v.verify({ rawBody, headers: { 'x-room-signature': sign(rawBody, OTHER_SECRET) }, secretId: 'rotate' }).secretId,
      'rotate',
    );
    // via header (different body so the replay guard does not fire)
    assert.equal(
      v.verify({
        rawBody: rawBody2,
        headers: {
          'x-room-signature': sign(rawBody2, OTHER_SECRET),
          'x-room-secret-id': 'rotate',
        },
      }).secretId,
      'rotate',
    );
  });

  it('rejects an unknown secret id with HV_UNKNOWN_SECRET', () => {
    const rawBody = 'hello';
    assert.throws(
      () =>
        verifier.verify({
          rawBody,
          headers: { 'x-room-signature': sign(rawBody), 'x-room-secret-id': 'nope' },
        }),
      (err) => err.code === 'HV_UNKNOWN_SECRET',
    );
  });

  it('rejects a stale timestamp with HV_STALE_TIMESTAMP', () => {
    const rawBody = 'hello';
    assert.throws(
      () =>
        verifier.verify({
          rawBody,
          headers: {
            'x-room-signature': sign(rawBody),
            'x-room-timestamp': String(clock() - DEFAULT_MAX_SKEW_MS - 1),
          },
        }),
      (err) => err.code === 'HV_STALE_TIMESTAMP',
    );
  });

  it('rejects a future timestamp with HV_FUTURE_TIMESTAMP', () => {
    const rawBody = 'hello';
    assert.throws(
      () =>
        verifier.verify({
          rawBody,
          headers: {
            'x-room-signature': sign(rawBody),
            'x-room-timestamp': String(clock() + DEFAULT_MAX_SKEW_MS + 1),
          },
        }),
      (err) => err.code === 'HV_FUTURE_TIMESTAMP',
    );
  });

  it('rejects a non-numeric timestamp with HV_MALFORMED_TIMESTAMP', () => {
    const rawBody = 'hello';
    assert.throws(
      () =>
        verifier.verify({
          rawBody,
          headers: { 'x-room-signature': sign(rawBody), 'x-room-timestamp': 'not-a-time' },
        }),
      (err) => err.code === 'HV_MALFORMED_TIMESTAMP',
    );
  });

  it('honors a custom skew window and custom signature header name', () => {
    const clock2 = makeClock();
    const v = createWebhookHmacVerifier({
      clock: clock2,
      secretProvider: makeSecretProvider(),
      signatureHeader: 'x-custom-sig',
      maxSkewMs: 60_000,
    });
    const rawBody = 'hello';
    const atEdge = clock2() - 60_000;
    const ok = v.verify({
      rawBody,
      headers: { 'x-custom-sig': sign(rawBody), 'x-room-timestamp': String(atEdge) },
    });
    assert.equal(ok.ok, true);
    assert.throws(
      () =>
        v.verify({
          rawBody,
          headers: { 'x-custom-sig': sign(rawBody), 'x-room-timestamp': String(atEdge - 1) },
        }),
      (err) => err.code === 'HV_STALE_TIMESTAMP',
    );
  });

  it('rejects replays with HV_REPLAY and lets the same signature pass again after the window', () => {
    const rawBody = 'hello';
    const sig = sign(rawBody);
    const headers = { 'x-room-signature': sig, 'x-room-timestamp': String(clock()) };
    assert.equal(verifier.verify({ rawBody, headers }).ok, true);
    assert.throws(
      () => verifier.verify({ rawBody, headers }),
      (err) => err.code === 'HV_REPLAY',
    );
    // After the skew window the seen entry expires: the same authentic
    // signature is acceptable again (clock advanced, fresh timestamp).
    clock.advance(DEFAULT_MAX_SKEW_MS + 1);
    const fresh = { 'x-room-signature': sig, 'x-room-timestamp': String(clock()) };
    assert.equal(verifier.verify({ rawBody, headers: fresh }).ok, true);
  });

  it('does not poison the replay store on failed verification', () => {
    const rawBody = 'hello';
    const badSig = `sha256=${'0'.repeat(64)}`;
    assert.throws(
      () => verifier.verify({ rawBody, headers: { 'x-room-signature': badSig } }),
      (err) => err.code === 'HV_BAD_SIGNATURE',
    );
    // The authentic signature is a different value and must still verify.
    assert.equal(verifier.verify({ rawBody, headers: { 'x-room-signature': sign(rawBody) } }).ok, true);
  });

  it('accepts an injected seen-store', () => {
    const seen = new Set();
    const seenStore = {
      has: (h) => seen.has(h),
      add: (h) => seen.add(h),
    };
    const v = createWebhookHmacVerifier({
      clock,
      secretProvider: makeSecretProvider(),
      seenStore,
    });
    const rawBody = 'hello';
    const headers = { 'x-room-signature': sign(rawBody) };
    assert.equal(v.verify({ rawBody, headers }).ok, true);
    assert.equal(seen.size, 1);
    assert.throws(() => v.verify({ rawBody, headers }), (err) => err.code === 'HV_REPLAY');
  });

  it('rejects a missing/non-string body with HV_MISSING_BODY', () => {
    for (const rawBody of [undefined, null, 42, { a: 1 }]) {
      assert.throws(
        () => verifier.verify({ rawBody, headers: { 'x-room-signature': sign('x') } }),
        (err) => err.code === 'HV_MISSING_BODY',
      );
    }
  });

  it('every failure carries a coded error (never silent, never uncoded)', () => {
    const cases = [
      () => verifier.verify({ rawBody: 'x', headers: {} }),
      () => verifier.verify({ rawBody: 'x', headers: { 'x-room-signature': 'bad' } }),
      () => verifier.verify({ rawBody: 'x', headers: { 'x-room-signature': sign('x', OTHER_SECRET) } }),
      () =>
        verifier.verify({
          rawBody: 'x',
          headers: { 'x-room-signature': sign('x'), 'x-room-secret-id': 'ghost' },
        }),
      () =>
        verifier.verify({
          rawBody: 'x',
          headers: { 'x-room-signature': sign('x'), 'x-room-timestamp': 'soon' },
        }),
    ];
    // Add a replay case.
    const rawBody = 'replay-case';
    const headers = { 'x-room-signature': sign(rawBody) };
    verifier.verify({ rawBody, headers });
    cases.push(() => verifier.verify({ rawBody, headers }));

    for (const run of cases) {
      let threw = null;
      try {
        run();
      } catch (err) {
        threw = err;
      }
      assert.ok(threw instanceof Error, 'expected a throw');
      assert.match(threw.code, /^HV_[A-Z_]+$/, `code must be HV_* (got ${threw.code})`);
    }
  });

  it('never includes the secret in error messages or details', () => {
    const failing = [
      () => verifier.verify({ rawBody: 'x', headers: { 'x-room-signature': sign('x', OTHER_SECRET) } }),
      () =>
        verifier.verify({
          rawBody: 'x',
          headers: { 'x-room-signature': sign('x'), 'x-room-secret-id': 'ghost' },
        }),
      () => verifier.verify({ rawBody: 'x', headers: {} }),
    ];
    for (const run of failing) {
      let err = null;
      try {
        run();
      } catch (e) {
        err = e;
      }
      assert.ok(err, 'expected a throw');
      const serialized = `${err.message} ${JSON.stringify(err.detail ?? null)}`;
      assert.ok(!serialized.includes(SECRET), `secret leaked in error: ${serialized}`);
      assert.ok(!serialized.includes(OTHER_SECRET), `secret leaked in error: ${serialized}`);
    }
  });

  it('requires secretProvider at construction (coded error)', () => {
    assert.throws(
      () => createWebhookHmacVerifier({}),
      (err) => err instanceof Error && typeof err.code === 'string',
    );
  });

  it('uses node:crypto timingSafeEqual structurally (constant-time compare)', () => {
    const src = readFileSync(join(here, '..', 'src', 'webhook-hmac-verification.mjs'), 'utf8');
    assert.match(src, /from 'node:crypto'/, 'imports node:crypto');
    assert.match(src, /timingSafeEqual/, 'uses timingSafeEqual');
    // Length-mismatch path must not return before comparing (no early exit
    // that skips the constant-time primitive).
    assert.match(src, /timingSafeEqual\(a, a\)/, 'dummy compare on length mismatch');
  });
});
