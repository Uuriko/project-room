/**
 * sandbox-interception.test.js — tests for the agent sandbox dry-run interception planner.
 *
 * Covers: allow on allowlisted kind, deny-by-default for unknown kinds,
 * denylist target patterns, arg clamping → modify verdict, replay determinism,
 * stats accounting, ledger append-only behavior, and the coded-error contract.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createSandboxInterceptor, VERDICTS } from '../src/sandbox-interception.mjs';

/** Controllable clock: { clock(), advance(ms) }. */
function fakeClock(start = 2_000_000) {
  const box = { now: start };
  return {
    clock: () => box.now,
    advance: (ms) => {
      box.now += ms;
    },
  };
}

const POLICY = () => ({
  allowlist: {
    'agent-quill': ['read.file', 'post.draft', 'list.items'],
    'agent-other': ['read.file'],
  },
  denylist: [/\/etc\/secrets/, '^prod-db:'],
  constraints: {
    'list.items': { maxItems: 3 },
    'post.draft': { allowedChannels: ['#room-dev', '#room-ops'] },
  },
});

function action(overrides = {}) {
  return {
    id: 'a1',
    agentId: 'agent-quill',
    kind: 'read.file',
    target: 'docs/ROOM-STATE.md',
    args: {},
    proposedAt: 2_000_000,
    ...overrides,
  };
}

function expectSandboxError(fn, code) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof Error, 'expected an Error');
    assert.equal(err.code, code, `expected code ${code}, got ${err.code}`);
    return true;
  });
}

describe('sandbox-interception', () => {
  it('exposes the verdict vocabulary', () => {
    assert.deepEqual([...VERDICTS], ['allow', 'deny', 'modify']);
  });

  it('allows a kind on the agent allowlist', () => {
    const sb = createSandboxInterceptor({ policy: POLICY() });
    const result = sb.intercept(action());
    assert.equal(result.verdict, 'allow');
    assert.equal(result.matchedRule, null);
    assert.ok(result.ledgerId);
    assert.ok(result.reason.length > 0);
  });

  it('denies an unknown kind by default (not on the agent allowlist)', () => {
    const sb = createSandboxInterceptor({ policy: POLICY() });
    const result = sb.intercept(action({ kind: 'exec.shell' }));
    assert.equal(result.verdict, 'deny');
    assert.equal(result.matchedRule.type, 'allowlist');
    assert.match(result.reason, /deny-by-default/);
  });

  it('denies a kind the agent is not allowlisted for even if another agent is', () => {
    const sb = createSandboxInterceptor({ policy: POLICY() });
    const result = sb.intercept(
      action({ agentId: 'agent-other', kind: 'post.draft', target: 'room' }),
    );
    assert.equal(result.verdict, 'deny');
    assert.equal(result.matchedRule.type, 'allowlist');
  });

  it('denies a target matching a denylist pattern even when the kind is allowlisted', () => {
    const sb = createSandboxInterceptor({ policy: POLICY() });
    const result = sb.intercept(action({ target: '/etc/secrets/api.key' }));
    assert.equal(result.verdict, 'deny');
    assert.equal(result.matchedRule.type, 'denylist');
    assert.match(result.reason, /denylist/);

    const stringPattern = sb.intercept(action({ target: 'prod-db:users' }));
    assert.equal(stringPattern.verdict, 'deny');
    assert.equal(stringPattern.matchedRule.type, 'denylist');
  });

  it('denies a channel outside allowedChannels', () => {
    const sb = createSandboxInterceptor({ policy: POLICY() });
    const result = sb.intercept(
      action({ kind: 'post.draft', target: 'room', args: { channel: '#room-random' } }),
    );
    assert.equal(result.verdict, 'deny');
    assert.equal(result.matchedRule.type, 'constraint');
    assert.equal(result.matchedRule.constraint, 'allowedChannels');
  });

  it('modify verdict: clamps items to maxItems with an audit note', () => {
    const sb = createSandboxInterceptor({ policy: POLICY() });
    const result = sb.intercept(
      action({
        kind: 'list.items',
        target: 'inbox',
        args: { items: ['a', 'b', 'c', 'd', 'e'], limit: 5 },
      }),
    );
    assert.equal(result.verdict, 'modify');
    assert.equal(result.matchedRule.type, 'constraint');
    assert.equal(result.matchedRule.constraint, 'maxItems');
    assert.deepEqual(result.modifiedAction.args.items, ['a', 'b', 'c']);
    assert.equal(result.modifiedAction.args.limit, 5);
    assert.match(result.reason, /audit note/);
    // The original action is untouched; the ledger holds the modified copy.
    const entry = sb.get(result.ledgerId);
    assert.deepEqual(entry.modifiedAction.args.items, ['a', 'b', 'c']);
  });

  it('allows when args are within constraints', () => {
    const sb = createSandboxInterceptor({ policy: POLICY() });
    const result = sb.intercept(
      action({
        kind: 'post.draft',
        target: 'room',
        args: { channel: '#room-dev', items: ['x'] },
      }),
    );
    assert.equal(result.verdict, 'allow');
  });

  it('replay re-evaluates deterministically against the current policy', () => {
    const sb = createSandboxInterceptor({ policy: POLICY() });
    const first = sb.intercept(
      action({
        id: 'replay-me',
        kind: 'list.items',
        target: 'inbox',
        args: { items: ['a', 'b', 'c', 'd'] },
      }),
    );
    assert.equal(first.verdict, 'modify');

    const replayed = sb.replay(first.ledgerId);
    assert.equal(replayed.verdict, 'modify');
    assert.equal(replayed.replayOf, first.ledgerId);
    assert.notEqual(replayed.ledgerId, first.ledgerId);
    assert.deepEqual(replayed.modifiedAction.args.items, ['a', 'b', 'c']);
    // Same policy → same verdict: replay is deterministic.
    const replayedAgain = sb.replay(first.ledgerId);
    assert.equal(replayedAgain.verdict, replayed.verdict);
    assert.deepEqual(replayedAgain.modifiedAction, replayed.modifiedAction);
  });

  it('stats account allowed/denied/modified per agent', () => {
    const sb = createSandboxInterceptor({ policy: POLICY() });
    sb.intercept(action({ id: 's1', kind: 'read.file' })); // allow
    sb.intercept(action({ id: 's2', kind: 'exec.shell' })); // deny
    sb.intercept(
      action({ id: 's3', kind: 'list.items', target: 'inbox', args: { items: [1, 2, 3, 4] } }),
    ); // modify
    sb.intercept(action({ id: 's4', agentId: 'agent-other', kind: 'read.file' })); // allow

    const stats = sb.stats();
    assert.deepEqual(stats['agent-quill'], { allowed: 1, denied: 1, modified: 1 });
    assert.deepEqual(stats['agent-other'], { allowed: 1, denied: 0, modified: 0 });
    assert.deepEqual(sb.statsFor('agent-unknown'), { allowed: 0, denied: 0, modified: 0 });
  });

  it('ledger is append-only: frozen entries, copies on read, replay adds entries', () => {
    const { clock } = fakeClock();
    const sb = createSandboxInterceptor({ clock, policy: POLICY() });
    const first = sb.intercept(action({ id: 'L1' }));
    assert.equal(sb.ledger.length, 1);
    const entry = sb.get(first.ledgerId);
    assert.equal(entry.verdict, 'allow');
    assert.ok(Object.isFrozen(entry));
    assert.ok(Object.isFrozen(entry.action));

    // Mutating a returned copy does not touch the ledger.
    const snapshot = sb.ledger;
    assert.notEqual(snapshot, sb.ledger); // defensive copy
    snapshot.length = 0;
    assert.equal(sb.ledger.length, 1);

    sb.replay(first.ledgerId);
    assert.equal(sb.ledger.length, 2);
    assert.equal(sb.ledger[1].replayOf, first.ledgerId);
    assert.ok(sb.ledger[1].at >= sb.ledger[0].at);
  });

  it('uses the injected clock and id generator', () => {
    const { clock, advance } = fakeClock();
    let n = 0;
    const sb = createSandboxInterceptor({
      clock,
      id: () => `custom-${(n += 1)}`,
      policy: POLICY(),
    });
    const first = sb.intercept(action({ id: 't1' }));
    assert.equal(first.ledgerId, 'custom-1');
    assert.equal(sb.get(first.ledgerId).at, 2_000_000);
    advance(500);
    const second = sb.intercept(action({ id: 't2' }));
    assert.equal(second.ledgerId, 'custom-2');
    assert.equal(sb.get(second.ledgerId).at, 2_000_500);
  });

  it('default policy denies everything (empty allowlist)', () => {
    const sb = createSandboxInterceptor();
    const result = sb.intercept(action());
    assert.equal(result.verdict, 'deny');
    assert.equal(result.matchedRule.type, 'allowlist');
  });

  it('coded-error contract: SB_INVALID_ACTION on malformed actions', () => {
    const sb = createSandboxInterceptor({ policy: POLICY() });
    expectSandboxError(() => sb.intercept(null), 'SB_INVALID_ACTION');
    expectSandboxError(() => sb.intercept({}), 'SB_INVALID_ACTION');
    expectSandboxError(() => sb.intercept(action({ kind: '' })), 'SB_INVALID_ACTION');
    expectSandboxError(() => sb.intercept(action({ args: 'nope' })), 'SB_INVALID_ACTION');
  });

  it('coded-error contract: SB_NOT_FOUND on replay of an unknown ledger id', () => {
    const sb = createSandboxInterceptor({ policy: POLICY() });
    expectSandboxError(() => sb.replay('nope'), 'SB_NOT_FOUND');
  });

  it('coded-error contract: SB_ACTION_DENIED from interceptStrict on deny', () => {
    const sb = createSandboxInterceptor({ policy: POLICY() });
    expectSandboxError(() => sb.interceptStrict(action({ kind: 'exec.shell' })), 'SB_ACTION_DENIED');
    // Non-denied verdicts pass through unchanged.
    const allowed = sb.interceptStrict(action());
    assert.equal(allowed.verdict, 'allow');
    const modified = sb.interceptStrict(
      action({ kind: 'list.items', target: 'inbox', args: { items: [1, 2, 3, 4, 5] } }),
    );
    assert.equal(modified.verdict, 'modify');
  });

  it('errors are never silent: failed calls do not touch the ledger or stats', () => {
    const sb = createSandboxInterceptor({ policy: POLICY() });
    assert.throws(() => sb.intercept({}), (err) => err.code === 'SB_INVALID_ACTION');
    assert.throws(() => sb.replay('missing'), (err) => err.code === 'SB_NOT_FOUND');
    assert.equal(sb.ledger.length, 0);
    assert.deepEqual(sb.stats(), {});
  });
});
