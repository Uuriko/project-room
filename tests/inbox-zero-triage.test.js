/**
 * inbox-zero-triage.test.js — tests for the inbox-zero triage state machine.
 *
 * Covers: scoring/bucketing (recency, injected senderScore, attachment, thread
 * depth, spam-candidate override), decision + reversal, close blocked while
 * pending, pause/resume, abandon keeping decisions, inbox-zero close → done,
 * stats correctness (counts, breakdown, estimated time saved), and the
 * coded-error contract. Uses a fake clock and no network/DOM/secrets.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createInboxZeroTriage,
  SESSION_STATES,
  ITEM_STATES,
  BUCKETS,
  RECENCY_WINDOW_MS,
  SPAM_SENDER_SCORE_MAX,
  DEFAULT_DECISION_TIME_SAVED_MS,
} from '../src/inbox-zero-triage.mjs';

const HOUR_MS = 60 * 60 * 1000;

/** Controllable clock: { clock(), advance(ms) }. */
function fakeClock(start = 1_700_000_000_000) {
  const box = { now: start };
  return {
    clock: () => box.now,
    advance: (ms) => {
      box.now += ms;
    },
  };
}

/** Deterministic id generator. */
function fakeIds(prefix = 't') {
  let n = 0;
  return () => `${prefix}-${(n += 1)}`;
}

function expectIzError(fn, code) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof Error, 'expected an Error');
    assert.equal(err.code, code, `expected code ${code}, got ${err.code}`);
    return true;
  });
}

/** Base item builder: recent, neutral sender, no attachment, shallow thread. */
function item(now, over = {}) {
  return {
    id: over.id ?? `m-${Math.random().toString(36).slice(2)}`,
    sender: 'boss@example.com',
    subject: 'Quarterly plan',
    receivedAt: now - 1 * HOUR_MS,
    hasAttachment: false,
    threadDepth: 1,
    ...over,
  };
}

const senderScores = {
  'boss@example.com': 0.95,
  'teammate@example.com': 0.6,
  'newsletter@example.com': 0.3,
  'spammy@phish.invalid': 0.0,
};

function makeDeps(clock, over = {}) {
  return {
    clock: clock.clock,
    id: fakeIds(),
    senderScore: (sender) => senderScores[sender] ?? 0.5,
    ...over,
  };
}

describe('scoring and bucketing', () => {
  it('scores a fresh high-importance item into act-now', () => {
    const clock = fakeClock();
    const triage = createInboxZeroTriage(makeDeps(clock));
    triage.startSession([
      item(clock.clock(), { id: 'm1', hasAttachment: true, threadDepth: 12 }),
    ]);
    const got = triage.get('m1');
    assert.equal(got.state, 'pending');
    assert.equal(got.bucket, 'act-now');
    assert.ok(got.score >= 0.75, `score ${got.score} should clear act-now`);
  });

  it('scores an old low-importance item into archive', () => {
    const clock = fakeClock();
    const triage = createInboxZeroTriage(makeDeps(clock));
    triage.startSession([
      item(clock.clock(), {
        id: 'm1',
        sender: 'newsletter@example.com',
        receivedAt: clock.clock() - 60 * HOUR_MS,
      }),
    ]);
    const got = triage.get('m1');
    assert.equal(got.bucket, 'archive');
  });

  it('a zero-importance sender lands in spam-candidate regardless of freshness', () => {
    const clock = fakeClock();
    const triage = createInboxZeroTriage(makeDeps(clock));
    triage.startSession([
      item(clock.clock(), {
        id: 'm1',
        sender: 'spammy@phish.invalid',
        receivedAt: clock.clock(),
        hasAttachment: true,
        threadDepth: 20,
      }),
    ]);
    const got = triage.get('m1');
    assert.equal(got.bucket, 'spam-candidate');
    assert.ok(got.score >= 0.15, 'other signals still boost the score');
  });

  it('attachment and thread depth raise the score', () => {
    const clock = fakeClock();
    const plain = createInboxZeroTriage(makeDeps(clock));
    plain.startSession([item(clock.clock(), { id: 'p' })]);
    const rich = createInboxZeroTriage(makeDeps(clock));
    rich.startSession([
      item(clock.clock(), { id: 'r', hasAttachment: true, threadDepth: 8 }),
    ]);
    assert.ok(
      rich.get('r').score > plain.get('p').score,
      'attachment + thread depth should raise the score',
    );
  });

  it('recency decays with age and weights are injectable', () => {
    const clock = fakeClock();
    const old = createInboxZeroTriage(makeDeps(clock));
    old.startSession([
      item(clock.clock(), { id: 'm1', receivedAt: clock.clock() - 2 * RECENCY_WINDOW_MS }),
    ]);
    // With sender weight dominating, importance beats age.
    const heavy = createInboxZeroTriage(
      makeDeps(clock, { weights: { recency: 0.05, sender: 0.9, attachment: 0.03, thread: 0.02 } }),
    );
    heavy.startSession([
      item(clock.clock(), { id: 'm1', receivedAt: clock.clock() - 2 * RECENCY_WINDOW_MS }),
    ]);
    assert.ok(
      heavy.get('m1').score > old.get('m1').score,
      'injectable weights should change the score',
    );
  });

  it('peekNext returns the highest-scoring pending item', () => {
    const clock = fakeClock();
    const triage = createInboxZeroTriage(makeDeps(clock));
    triage.startSession([
      item(clock.clock(), { id: 'low', sender: 'newsletter@example.com' }),
      item(clock.clock(), { id: 'high' }),
    ]);
    assert.equal(triage.peekNext().id, 'high');
  });
});

describe('decisions and reversal', () => {
  it('decide marks an item decided with decision + decidedAt', () => {
    const clock = fakeClock();
    const triage = createInboxZeroTriage(makeDeps(clock));
    triage.startSession([item(clock.clock(), { id: 'm1' })]);
    clock.advance(5_000);
    const decided = triage.decide('m1', 'act-now', 'john');
    assert.equal(decided.state, 'decided');
    assert.equal(decided.decision, 'act-now');
    assert.equal(decided.decidedAt, clock.clock());
    assert.equal(triage.stats().decided, 1);
    assert.equal(triage.stats().pending, 0);
  });

  it('deciding the same item twice throws IZ_ALREADY_TRIAGED', () => {
    const clock = fakeClock();
    const triage = createInboxZeroTriage(makeDeps(clock));
    triage.startSession([item(clock.clock(), { id: 'm1' })]);
    triage.decide('m1', 'archive');
    expectIzError(() => triage.decide('m1', 'schedule'), 'IZ_ALREADY_TRIAGED');
  });

  it('reverseDecision returns the item to pending and clears the decision', () => {
    const clock = fakeClock();
    const triage = createInboxZeroTriage(makeDeps(clock));
    triage.startSession([item(clock.clock(), { id: 'm1' })]);
    triage.decide('m1', 'delegate');
    const back = triage.reverseDecision('m1');
    assert.equal(back.state, 'pending');
    assert.equal(back.decision, null);
    assert.equal(back.decidedAt, null);
    assert.equal(triage.stats().decided, 0);
    // And it can be decided again with a different decision.
    triage.decide('m1', 'schedule');
    assert.equal(triage.get('m1').decision, 'schedule');
  });

  it('reversing a pending item throws IZ_INVALID_TRANSITION', () => {
    const clock = fakeClock();
    const triage = createInboxZeroTriage(makeDeps(clock));
    triage.startSession([item(clock.clock(), { id: 'm1' })]);
    expectIzError(() => triage.reverseDecision('m1'), 'IZ_INVALID_TRANSITION');
  });

  it('an unknown decision throws IZ_INVALID_DECISION', () => {
    const clock = fakeClock();
    const triage = createInboxZeroTriage(makeDeps(clock));
    triage.startSession([item(clock.clock(), { id: 'm1' })]);
    expectIzError(() => triage.decide('m1', 'reply-later'), 'IZ_INVALID_DECISION');
  });

  it('deciding an unknown item throws IZ_UNKNOWN_ITEM', () => {
    const clock = fakeClock();
    const triage = createInboxZeroTriage(makeDeps(clock));
    triage.startSession([item(clock.clock(), { id: 'm1' })]);
    expectIzError(() => triage.decide('nope', 'archive'), 'IZ_UNKNOWN_ITEM');
  });
});

describe('session lifecycle', () => {
  it('session moves idle → triaging on startSession', () => {
    const clock = fakeClock();
    const triage = createInboxZeroTriage(makeDeps(clock));
    assert.equal(triage.session(), null);
    const s = triage.startSession([item(clock.clock(), { id: 'm1' })]);
    assert.equal(s.state, 'triaging');
    assert.equal(s.stats.total, 1);
    assert.ok(s.startedAt > 0);
    assert.equal(s.closedAt, null);
  });

  it('starting a second session while active throws IZ_SESSION_ACTIVE', () => {
    const clock = fakeClock();
    const triage = createInboxZeroTriage(makeDeps(clock));
    triage.startSession([item(clock.clock(), { id: 'm1' })]);
    expectIzError(
      () => triage.startSession([item(clock.clock(), { id: 'm2' })]),
      'IZ_SESSION_ACTIVE',
    );
  });

  it('starting with an empty snapshot throws IZ_EMPTY_SNAPSHOT', () => {
    const clock = fakeClock();
    const triage = createInboxZeroTriage(makeDeps(clock));
    expectIzError(() => triage.startSession([]), 'IZ_EMPTY_SNAPSHOT');
  });

  it('close is blocked while items are pending (IZ_PENDING_ITEMS)', () => {
    const clock = fakeClock();
    const triage = createInboxZeroTriage(makeDeps(clock));
    triage.startSession([item(clock.clock(), { id: 'm1' })]);
    expectIzError(() => triage.close(), 'IZ_PENDING_ITEMS');
    assert.equal(triage.session().state, 'triaging');
  });

  it('pause/resume round-trips triaging ⇄ paused and blocks decisions while paused', () => {
    const clock = fakeClock();
    const triage = createInboxZeroTriage(makeDeps(clock));
    triage.startSession([item(clock.clock(), { id: 'm1' })]);
    assert.equal(triage.pause().state, 'paused');
    expectIzError(() => triage.decide('m1', 'archive'), 'IZ_INVALID_TRANSITION');
    expectIzError(() => triage.pause(), 'IZ_INVALID_TRANSITION');
    assert.equal(triage.resume().state, 'triaging');
    triage.decide('m1', 'archive');
    assert.equal(triage.get('m1').state, 'decided');
  });

  it('abandon keeps decisions but the session can never close', () => {
    const clock = fakeClock();
    const triage = createInboxZeroTriage(makeDeps(clock));
    triage.startSession([
      item(clock.clock(), { id: 'm1' }),
      item(clock.clock(), { id: 'm2' }),
    ]);
    triage.decide('m1', 'act-now');
    const s = triage.abandon('john');
    assert.equal(s.state, 'abandoned');
    assert.equal(triage.get('m1').state, 'decided');
    assert.equal(triage.get('m1').decision, 'act-now');
    assert.equal(triage.get('m2').state, 'pending');
    expectIzError(() => triage.close(), 'IZ_INVALID_TRANSITION');
    expectIzError(() => triage.decide('m2', 'archive'), 'IZ_INVALID_TRANSITION');
    expectIzError(() => triage.pause(), 'IZ_INVALID_TRANSITION');
  });

  it('inbox-zero close → done; everything is locked afterwards', () => {
    const clock = fakeClock();
    const triage = createInboxZeroTriage(makeDeps(clock));
    triage.startSession([
      item(clock.clock(), { id: 'm1' }),
      item(clock.clock(), { id: 'm2' }),
    ]);
    triage.decide('m1', 'act-now');
    triage.decide('m2', 'spam-candidate');
    const s = triage.close('john');
    assert.equal(s.state, 'done');
    assert.ok(s.closedAt >= s.startedAt);
    // Decisions are no longer reversible once closed.
    expectIzError(() => triage.reverseDecision('m1'), 'IZ_INVALID_TRANSITION');
    expectIzError(() => triage.decide('m1', 'archive'), 'IZ_INVALID_TRANSITION');
    expectIzError(() => triage.close(), 'IZ_INVALID_TRANSITION');
    expectIzError(() => triage.abandon(), 'IZ_INVALID_TRANSITION');
  });

  it('a new session may start after done/abandoned', () => {
    const clock = fakeClock();
    const triage = createInboxZeroTriage(makeDeps(clock));
    triage.startSession([item(clock.clock(), { id: 'm1' })]);
    triage.decide('m1', 'archive');
    triage.close();
    const s2 = triage.startSession([item(clock.clock(), { id: 'm2' })]);
    assert.equal(s2.state, 'triaging');
    assert.equal(s2.stats.total, 1);
    assert.equal(triage.get('m1'), null);
  });
});

describe('stats', () => {
  it('stats report counts, decisions breakdown, and estimated time saved', () => {
    const clock = fakeClock();
    const triage = createInboxZeroTriage(makeDeps(clock));
    triage.startSession([
      item(clock.clock(), { id: 'm1' }),
      item(clock.clock(), { id: 'm2' }),
      item(clock.clock(), { id: 'm3' }),
    ]);
    triage.decide('m1', 'act-now');
    triage.decide('m2', 'delegate');
    const stats = triage.stats();
    assert.equal(stats.total, 3);
    assert.equal(stats.decided, 2);
    assert.equal(stats.pending, 1);
    assert.deepEqual(stats.decisions, {
      'act-now': 1,
      schedule: 0,
      delegate: 1,
      archive: 0,
      'spam-candidate': 0,
    });
    assert.equal(stats.estimatedTimeSavedMs, 2 * DEFAULT_DECISION_TIME_SAVED_MS);
  });

  it('reversal updates stats and time saved', () => {
    const clock = fakeClock();
    const triage = createInboxZeroTriage(
      makeDeps(clock, { decisionTimeSavedMs: 60_000 }),
    );
    triage.startSession([item(clock.clock(), { id: 'm1' })]);
    triage.decide('m1', 'schedule');
    assert.equal(triage.stats().estimatedTimeSavedMs, 60_000);
    triage.reverseDecision('m1');
    const stats = triage.stats();
    assert.equal(stats.decided, 0);
    assert.equal(stats.estimatedTimeSavedMs, 0);
    assert.equal(stats.decisions.schedule, 0);
  });
});

describe('coded-error contract', () => {
  it('operations before a session exist throw IZ_NO_ACTIVE_SESSION', () => {
    const clock = fakeClock();
    const triage = createInboxZeroTriage(makeDeps(clock));
    expectIzError(() => triage.decide('m1', 'archive'), 'IZ_NO_ACTIVE_SESSION');
    expectIzError(() => triage.close(), 'IZ_NO_ACTIVE_SESSION');
    expectIzError(() => triage.pause(), 'IZ_NO_ACTIVE_SESSION');
    expectIzError(() => triage.peekNext(), 'IZ_NO_ACTIVE_SESSION');
  });

  it('every thrown error is an Error with a string code', () => {
    const clock = fakeClock();
    const triage = createInboxZeroTriage(makeDeps(clock));
    const cases = [
      () => triage.decide('x', 'archive'),
      () => triage.startSession('not-an-array'),
      () => triage.startSession([]),
    ];
    for (const fn of cases) {
      assert.throws(fn, (err) => {
        assert.ok(err instanceof Error);
        assert.equal(typeof err.code, 'string');
        assert.ok(err.code.startsWith('IZ_'), `code ${err.code} should be IZ_*`);
        return true;
      });
    }
  });

  it('audit logs every session and item transition in order', () => {
    const clock = fakeClock();
    const triage = createInboxZeroTriage(makeDeps(clock));
    triage.startSession([item(clock.clock(), { id: 'm1' })], 'john');
    triage.pause('john');
    triage.resume('john');
    triage.decide('m1', 'archive', 'john');
    triage.close('john');
    const audit = triage.audit;
    assert.equal(audit.length, 5);
    assert.deepEqual(
      audit.map((e) => [e.from, e.to]),
      [
        ['idle', 'triaging'],
        ['triaging', 'paused'],
        ['paused', 'triaging'],
        ['item:pending', 'item:decided'],
        ['triaging', 'done'],
      ],
    );
    assert.ok(audit.every((e) => e.actor === 'john'));
    assert.ok(audit.every((e) => typeof e.at === 'number'));
  });
});

describe('exports', () => {
  it('exposes the state, bucket, and constant vocabulary', () => {
    assert.deepEqual([...SESSION_STATES], [
      'idle',
      'triaging',
      'paused',
      'done',
      'abandoned',
    ]);
    assert.deepEqual([...ITEM_STATES], ['pending', 'decided']);
    assert.deepEqual([...BUCKETS], [
      'act-now',
      'schedule',
      'delegate',
      'archive',
      'spam-candidate',
    ]);
    assert.equal(RECENCY_WINDOW_MS, 72 * 60 * 60 * 1000);
    assert.equal(SPAM_SENDER_SCORE_MAX, 0.1);
    assert.equal(DEFAULT_DECISION_TIME_SAVED_MS, 2 * 60 * 1000);
  });
});
