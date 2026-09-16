import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createRateLimitTracker } from '../src/rate-limit-tracker.mjs';

/** Deterministic fake clock injected as `deps.clock`. */
function fakeClock(start = 0) {
  let now = start;
  return {
    clock: () => now,
    advance: (ms) => {
      now += ms;
    },
  };
}

function codedErrorCode(fn) {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof Error, 'thrown value must be an Error');
    return err.code;
  }
  assert.fail('expected a coded error to be thrown');
}

describe('rate-limit-tracker', () => {
  it('allows consumes under capacity and reports remaining', () => {
    const { clock } = fakeClock();
    const rl = createRateLimitTracker({ clock });
    rl.configure('agent-a', 'chat', { capacity: 3, refillPerSec: 1 });

    const r1 = rl.tryConsume('agent-a', 'chat');
    assert.deepEqual(r1, { allowed: true, remaining: 2, retryAfterMs: 0 });
    const r2 = rl.tryConsume('agent-a', 'chat');
    assert.deepEqual(r2, { allowed: true, remaining: 1, retryAfterMs: 0 });
    const r3 = rl.tryConsume('agent-a', 'chat');
    assert.deepEqual(r3, { allowed: true, remaining: 0, retryAfterMs: 0 });
  });

  it('denies at capacity with a retryAfterMs and audits the denial', () => {
    const { clock } = fakeClock();
    const rl = createRateLimitTracker({ clock });
    rl.configure('agent-a', 'chat', { capacity: 3, refillPerSec: 1 });

    rl.tryConsume('agent-a', 'chat');
    rl.tryConsume('agent-a', 'chat');
    rl.tryConsume('agent-a', 'chat');
    const denied = rl.tryConsume('agent-a', 'chat');
    assert.equal(denied.allowed, false);
    assert.equal(denied.remaining, 0);
    assert.equal(denied.retryAfterMs, 1000); // 1 token deficit at 1 token/sec

    // tryConsume never throws for normal limiting; denials land in the audit log.
    const audit = rl.audit;
    assert.equal(audit.length, 1);
    assert.equal(audit[0].agentId, 'agent-a');
    assert.equal(audit[0].action, 'chat');
    assert.equal(audit[0].retryAfterMs, 1000);
    assert.equal(audit.length, 1, 'allowed consumes are not audited');
  });

  it('refills the bucket over time using the injected clock', () => {
    const { clock, advance } = fakeClock();
    const rl = createRateLimitTracker({ clock });
    rl.configure('agent-a', 'chat', { capacity: 3, refillPerSec: 1 });

    rl.tryConsume('agent-a', 'chat');
    rl.tryConsume('agent-a', 'chat');
    rl.tryConsume('agent-a', 'chat');
    assert.equal(rl.tryConsume('agent-a', 'chat').allowed, false);

    advance(2000); // 2 tokens refill at 1 token/sec
    const after = rl.tryConsume('agent-a', 'chat');
    assert.deepEqual(after, { allowed: true, remaining: 1, retryAfterMs: 0 });
  });

  it('supports fractional tokens and fractional refill', () => {
    const { clock, advance } = fakeClock();
    const rl = createRateLimitTracker({ clock });
    rl.configure('agent-a', 'slow', { capacity: 1, refillPerSec: 0.5 });

    assert.deepEqual(rl.tryConsume('agent-a', 'slow'), {
      allowed: true,
      remaining: 0,
      retryAfterMs: 0,
    });

    advance(1000); // half a token: 0.5
    const denied = rl.tryConsume('agent-a', 'slow');
    assert.equal(denied.allowed, false);
    assert.equal(denied.remaining, 0.5);
    assert.equal(denied.retryAfterMs, 1000); // (1 - 0.5) / 0.5 * 1000

    advance(1000); // full token again
    assert.deepEqual(rl.tryConsume('agent-a', 'slow'), {
      allowed: true,
      remaining: 0,
      retryAfterMs: 0,
    });
  });

  it('supports burst headroom above capacity', () => {
    const { clock } = fakeClock();
    const rl = createRateLimitTracker({ clock });
    rl.configure('agent-a', 'burst', { capacity: 2, refillPerSec: 1, burst: 3 });

    for (let i = 0; i < 5; i += 1) {
      assert.equal(rl.tryConsume('agent-a', 'burst').allowed, true, `consume ${i + 1} allowed`);
    }
    assert.equal(rl.tryConsume('agent-a', 'burst').allowed, false);
  });

  it('isolates buckets per agent', () => {
    const { clock } = fakeClock();
    const rl = createRateLimitTracker({ clock });
    rl.configure('agent-a', 'chat', { capacity: 1, refillPerSec: 0 });
    rl.configure('agent-b', 'chat', { capacity: 1, refillPerSec: 0 });

    rl.tryConsume('agent-a', 'chat');
    assert.equal(rl.tryConsume('agent-a', 'chat').allowed, false);
    assert.deepEqual(rl.tryConsume('agent-b', 'chat'), {
      allowed: true,
      remaining: 0,
      retryAfterMs: 0,
    });
  });

  it('isolates buckets per action', () => {
    const { clock } = fakeClock();
    const rl = createRateLimitTracker({ clock });
    rl.configure('agent-a', 'chat', { capacity: 1, refillPerSec: 0 });
    rl.configure('agent-a', 'search', { capacity: 1, refillPerSec: 0 });

    rl.tryConsume('agent-a', 'chat');
    assert.equal(rl.tryConsume('agent-a', 'chat').allowed, false);
    assert.equal(rl.tryConsume('agent-a', 'search').allowed, true);
  });

  it('reset() clears one action or every action for an agent', () => {
    const { clock } = fakeClock();
    const rl = createRateLimitTracker({ clock });
    rl.configure('agent-a', 'chat', { capacity: 1, refillPerSec: 0 });
    rl.configure('agent-a', 'search', { capacity: 1, refillPerSec: 0 });

    rl.tryConsume('agent-a', 'chat');
    rl.tryConsume('agent-a', 'search');
    assert.equal(rl.tryConsume('agent-a', 'chat').allowed, false);
    assert.equal(rl.tryConsume('agent-a', 'search').allowed, false);

    rl.reset('agent-a', 'chat');
    assert.equal(rl.tryConsume('agent-a', 'chat').allowed, true);
    assert.equal(rl.tryConsume('agent-a', 'search').allowed, false, 'other action untouched');

    rl.tryConsume('agent-a', 'chat');
    rl.reset('agent-a'); // no action: clear everything for the agent
    assert.equal(rl.tryConsume('agent-a', 'chat').allowed, true);
    assert.equal(rl.tryConsume('agent-a', 'search').allowed, true);
  });

  it('falls back to the injected default policy when unconfigured', () => {
    const { clock } = fakeClock();
    const rl = createRateLimitTracker({
      clock,
      defaultPolicy: { capacity: 2, refillPerSec: 60 },
    });

    assert.deepEqual(rl.tryConsume('nobody', 'anything'), {
      allowed: true,
      remaining: 1,
      retryAfterMs: 0,
    });
    assert.deepEqual(rl.tryConsume('nobody', 'anything'), {
      allowed: true,
      remaining: 0,
      retryAfterMs: 0,
    });
    const denied = rl.tryConsume('nobody', 'anything');
    assert.equal(denied.allowed, false);
    assert.equal(denied.retryAfterMs, 17); // ceil((1/60) * 1000)
    assert.deepEqual(rl.status('nobody', 'anything'), {
      remaining: 0,
      capacity: 2,
      retryAfterMs: 17,
    });
  });

  it('status() reports remaining, capacity, and retryAfterMs', () => {
    const { clock, advance } = fakeClock();
    const rl = createRateLimitTracker({ clock });
    rl.configure('agent-a', 'chat', { capacity: 4, refillPerSec: 2 });

    assert.deepEqual(rl.status('agent-a', 'chat'), {
      remaining: 4,
      capacity: 4,
      retryAfterMs: 0,
    });
    rl.tryConsume('agent-a', 'chat', { tokens: 4 });
    assert.deepEqual(rl.status('agent-a', 'chat'), {
      remaining: 0,
      capacity: 4,
      retryAfterMs: 500, // 1 token at 2 tokens/sec
    });
    advance(250); // half a token refilled
    assert.deepEqual(rl.status('agent-a', 'chat'), {
      remaining: 0.5,
      capacity: 4,
      retryAfterMs: 250,
    });
  });

  it('consumeOrThrow returns on success and throws a coded error on denial', () => {
    const { clock } = fakeClock();
    const rl = createRateLimitTracker({ clock });
    rl.configure('agent-a', 'chat', { capacity: 1, refillPerSec: 1 });

    const ok = rl.consumeOrThrow('agent-a', 'chat');
    assert.equal(ok.allowed, true);

    try {
      rl.consumeOrThrow('agent-a', 'chat');
      assert.fail('expected RL_RATE_LIMITED');
    } catch (err) {
      assert.ok(err instanceof Error);
      assert.equal(err.code, 'RL_RATE_LIMITED');
      assert.equal(err.detail.agentId, 'agent-a');
      assert.equal(err.detail.action, 'chat');
      assert.equal(err.detail.retryAfterMs, 1000);
    }
  });

  it('coded-error contract: every failure throws an Error with a code', () => {
    const { clock } = fakeClock();
    const rl = createRateLimitTracker({ clock });
    const policy = { capacity: 2, refillPerSec: 1 };

    assert.equal(codedErrorCode(() => rl.configure('a', 'x', null)), 'RL_INVALID_POLICY');
    assert.equal(
      codedErrorCode(() => rl.configure('a', 'x', { capacity: 0, refillPerSec: 1 })),
      'RL_INVALID_POLICY',
    );
    assert.equal(
      codedErrorCode(() => rl.configure('a', 'x', { capacity: 2, refillPerSec: -1 })),
      'RL_INVALID_POLICY',
    );
    assert.equal(
      codedErrorCode(() => rl.configure('a', 'x', { capacity: 2, refillPerSec: 1, burst: -1 })),
      'RL_INVALID_POLICY',
    );
    assert.equal(codedErrorCode(() => rl.configure('', 'x', policy)), 'RL_INVALID_KEY');
    assert.equal(codedErrorCode(() => rl.configure('a', '', policy)), 'RL_INVALID_KEY');
    assert.equal(
      codedErrorCode(() => rl.tryConsume('a', 'x', { tokens: 0 })),
      'RL_INVALID_TOKENS',
    );
    assert.equal(
      codedErrorCode(() => rl.tryConsume('a', 'x', { tokens: Number.NaN })),
      'RL_INVALID_TOKENS',
    );
    assert.equal(codedErrorCode(() => rl.tryConsume('', 'x')), 'RL_INVALID_KEY');
    assert.equal(codedErrorCode(() => rl.status('a', '')), 'RL_INVALID_KEY');
    assert.equal(codedErrorCode(() => rl.reset('')), 'RL_INVALID_KEY');

    // Failures are never silent: a bad default policy fails at construction.
    assert.equal(
      codedErrorCode(() => createRateLimitTracker({ defaultPolicy: { capacity: -1 } })),
      'RL_INVALID_POLICY',
    );
  });
});
