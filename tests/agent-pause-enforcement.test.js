/**
 * agent-pause-enforcement.test.js — tests for the owner pause/resume engine.
 *
 * Covers: owner-only pause/resume, non-owner rejection, gate blocking while
 * paused, gate allowing when running, auto-resume at resumeAt, sweep resuming
 * due agents, append-only per-agent history, listPaused, subscriber
 * notifications (pause/resume/auto-resume), and the coded-error contract.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createPauseEnforcement, EVENT_TYPES } from '../src/agent-pause-enforcement.mjs';

/** Controllable clock: { clock(), advance(ms), now() }. */
function fakeClock(start = 1_000_000) {
  const box = { now: start };
  return {
    clock: () => box.now,
    advance: (ms) => {
      box.now += ms;
    },
    now: () => box.now,
  };
}

/** Engine with an injected owner set. */
function engineWithOwners(owners = ['john'], clockStart = 1_000_000) {
  const fake = fakeClock(clockStart);
  const engine = createPauseEnforcement({
    clock: fake.clock,
    isOwner: (id) => owners.includes(id),
  });
  return { engine, fake };
}

function expectPauseError(fn, code) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof Error, 'expected an Error');
    assert.equal(err.code, code, `expected code ${code}, got ${err.code}`);
    return true;
  });
}

describe('agent-pause-enforcement', () => {
  it('owner can pause; record carries agentId, pausedBy, pausedAt, reason, resumeAt', () => {
    const { engine, fake } = engineWithOwners();
    const rec = engine.pause('agent-1', 'john', 'maintenance', fake.now() + 60_000);
    assert.equal(rec.agentId, 'agent-1');
    assert.equal(rec.pausedBy, 'john');
    assert.equal(rec.pausedAt, fake.now());
    assert.equal(rec.reason, 'maintenance');
    assert.equal(rec.resumeAt, fake.now() + 60_000);
    assert.ok(rec.id, 'pause record has an id');
    assert.ok(Object.isFrozen(rec), 'snapshot is frozen');
  });

  it('non-owner cannot pause: PE_NOT_OWNER, and no pause takes effect', () => {
    const { engine } = engineWithOwners();
    expectPauseError(() => engine.pause('agent-1', 'mallory', 'hijack'), 'PE_NOT_OWNER');
    assert.equal(engine.isPaused('agent-1'), false);
    assert.deepEqual(engine.listPaused(), []);
  });

  it('default engine is fail-closed: nobody is owner', () => {
    const engine = createPauseEnforcement();
    expectPauseError(() => engine.pause('agent-1', 'anyone'), 'PE_NOT_OWNER');
  });

  it('owner can resume; receipt names the resumer and the ended pause', () => {
    const { engine, fake } = engineWithOwners();
    const rec = engine.pause('agent-1', 'john', 'break');
    fake.advance(5_000);
    const receipt = engine.resume('agent-1', 'john');
    assert.equal(receipt.agentId, 'agent-1');
    assert.equal(receipt.resumedBy, 'john');
    assert.equal(receipt.resumedAt, fake.now());
    assert.equal(receipt.pause.id, rec.id);
    assert.equal(engine.isPaused('agent-1'), false);
  });

  it('non-owner cannot resume: PE_NOT_OWNER, pause stays active', () => {
    const { engine } = engineWithOwners();
    engine.pause('agent-1', 'john');
    expectPauseError(() => engine.resume('agent-1', 'mallory'), 'PE_NOT_OWNER');
    assert.equal(engine.isPaused('agent-1'), true);
  });

  it('resume of a running agent throws PE_NOT_PAUSED', () => {
    const { engine } = engineWithOwners();
    expectPauseError(() => engine.resume('ghost', 'john'), 'PE_NOT_PAUSED');
  });

  it('pausing an already-paused agent throws PE_ALREADY_PAUSED', () => {
    const { engine } = engineWithOwners();
    engine.pause('agent-1', 'john', 'first');
    expectPauseError(() => engine.pause('agent-1', 'john', 'second'), 'PE_ALREADY_PAUSED');
    // The original pause is untouched.
    assert.equal(engine.get('agent-1').reason, 'first');
  });

  it('gate blocks while paused: PE_PAUSED with action detail', () => {
    const { engine } = engineWithOwners();
    engine.pause('agent-1', 'john', 'maintenance');
    assert.throws(
      () => engine.gate('send-email', 'agent-1'),
      (err) => {
        assert.equal(err.code, 'PE_PAUSED');
        assert.equal(err.detail.action, 'send-email');
        assert.equal(err.detail.agentId, 'agent-1');
        assert.equal(err.detail.pausedBy, 'john');
        return true;
      },
    );
  });

  it('gate allows when the agent is not paused', () => {
    const { engine } = engineWithOwners();
    assert.equal(engine.gate('send-email', 'agent-1'), true);
  });

  it('auto-resume: isPaused flips false once resumeAt passes', () => {
    const { engine, fake } = engineWithOwners();
    engine.pause('agent-1', 'john', 'timed', fake.now() + 10_000);
    assert.equal(engine.isPaused('agent-1'), true);
    fake.advance(10_001);
    assert.equal(engine.isPaused('agent-1'), false);
    // Gate lets actions through again.
    assert.equal(engine.gate('work', 'agent-1'), true);
  });

  it('auto-resume is recorded in audit and history as an auto-resume event', () => {
    const { engine, fake } = engineWithOwners();
    engine.pause('agent-1', 'john', 'timed', fake.now() + 10_000);
    fake.advance(10_001);
    engine.isPaused('agent-1'); // triggers lazy auto-resume
    const history = engine.history('agent-1');
    assert.deepEqual(
      history.map((e) => e.type),
      ['pause', 'auto-resume'],
    );
    const auto = history[1];
    assert.equal(auto.by, 'system');
    assert.equal(auto.resumedAt, fake.now());
    assert.equal(engine.audit.length, 2);
  });

  it('sweep resumes every due agent and returns their ids', () => {
    const { engine, fake } = engineWithOwners();
    engine.pause('agent-1', 'john', 'timed', fake.now() + 5_000);
    engine.pause('agent-2', 'john', 'timed', fake.now() + 60_000);
    engine.pause('agent-3', 'john', 'indefinite');
    fake.advance(6_000);
    const resumed = engine.sweep();
    assert.deepEqual(resumed, ['agent-1']);
    assert.equal(engine.isPaused('agent-1'), false);
    assert.equal(engine.isPaused('agent-2'), true);
    assert.equal(engine.isPaused('agent-3'), true);
    // Auto-resume reached the audit log.
    assert.ok(engine.audit.some((e) => e.type === 'auto-resume' && e.agentId === 'agent-1'));
  });

  it('sweep with nothing due returns [] and writes nothing', () => {
    const { engine } = engineWithOwners();
    engine.pause('agent-1', 'john');
    const auditBefore = engine.audit.length;
    assert.deepEqual(engine.sweep(), []);
    assert.equal(engine.audit.length, auditBefore);
  });

  it('listPaused returns only effectively-paused agents as frozen snapshots', () => {
    const { engine, fake } = engineWithOwners();
    engine.pause('agent-1', 'john', 'timed', fake.now() + 5_000);
    engine.pause('agent-2', 'john', 'indefinite');
    fake.advance(6_000);
    const paused = engine.listPaused();
    assert.equal(paused.length, 1);
    assert.equal(paused[0].agentId, 'agent-2');
    assert.ok(Object.isFrozen(paused[0]));
  });

  it('history is append-only per agent and throws PE_NOT_FOUND when unknown', () => {
    const { engine, fake } = engineWithOwners();
    expectPauseError(() => engine.history('ghost'), 'PE_NOT_FOUND');
    engine.pause('agent-1', 'john', 'first');
    engine.resume('agent-1', 'john');
    fake.advance(1_000);
    engine.pause('agent-1', 'john', 'second', fake.now() + 60_000);
    const history = engine.history('agent-1');
    assert.deepEqual(
      history.map((e) => e.type),
      ['pause', 'resume', 'pause'],
    );
    assert.ok(history.every((e) => Object.isFrozen(e)), 'history entries are frozen');
    // Chronological.
    assert.ok(history[0].at <= history[1].at && history[1].at <= history[2].at);
    // Resuming again does not rewrite history.
    engine.resume('agent-1', 'john');
    assert.equal(engine.history('agent-1').length, 4);
  });

  it('subscribers are notified on pause, resume, and auto-resume', () => {
    const { engine, fake } = engineWithOwners();
    const seen = [];
    const unsubscribe = engine.subscribe((event) => seen.push(event));
    engine.pause('agent-1', 'john', 'timed', fake.now() + 10_000);
    engine.resume('agent-1', 'john');
    engine.pause('agent-2', 'john', 'timed', fake.now() + 10_000);
    fake.advance(10_001);
    engine.sweep();
    assert.deepEqual(
      seen.map((e) => `${e.type}:${e.agentId}`),
      ['pause:agent-1', 'resume:agent-1', 'pause:agent-2', 'auto-resume:agent-2'],
    );
    assert.ok(seen.every((e) => Object.isFrozen(e)), 'events are frozen');
    assert.equal(seen[0].by, 'john');
    assert.equal(seen[0].reason, 'timed');
    assert.equal(seen[3].by, 'system');
    unsubscribe();
    engine.pause('agent-3', 'john');
    assert.equal(seen.length, 4, 'unsubscribed listener gets nothing more');
  });

  it('a second pause after resume works and reuses the same history', () => {
    const { engine } = engineWithOwners();
    engine.pause('agent-1', 'john', 'one');
    engine.resume('agent-1', 'john');
    const rec = engine.pause('agent-1', 'john', 'two');
    assert.equal(rec.reason, 'two');
    assert.notEqual(rec.id, engine.history('agent-1')[0].recordId);
    assert.equal(engine.isPaused('agent-1'), true);
  });

  it('isPaused accepts an explicit now without touching the clock', () => {
    const { engine, fake } = engineWithOwners();
    engine.pause('agent-1', 'john', 'timed', fake.now() + 10_000);
    assert.equal(engine.isPaused('agent-1', fake.now() + 5_000), true);
    assert.equal(engine.isPaused('agent-1', fake.now() + 10_001), false);
  });

  it('coded-error contract: bad arguments throw PE_INVALID', () => {
    const { engine } = engineWithOwners();
    expectPauseError(() => engine.pause('', 'john'), 'PE_INVALID');
    expectPauseError(() => engine.pause('agent-1', ''), 'PE_INVALID');
    expectPauseError(() => engine.isPaused(''), 'PE_INVALID');
    expectPauseError(() => engine.gate('work', ''), 'PE_INVALID');
    // resumeAt must be a future timestamp.
    expectPauseError(() => engine.pause('agent-1', 'john', 'x', 1_000_000 - 1), 'PE_INVALID');
    expectPauseError(() => engine.pause('agent-1', 'john', 'x', Number.NaN), 'PE_INVALID');
    expectPauseError(() => engine.subscribe('not-a-function'), 'PE_INVALID');
  });

  it('every failure carries an Error with a code; never silent', () => {
    const { engine } = engineWithOwners();
    const failures = [
      () => engine.pause('a', 'mallory'),
      () => engine.pause('a', 'john') && engine.pause('a', 'john'),
      () => engine.resume('b', 'john'),
      () => engine.gate('work', 'a'),
      () => engine.history('b'),
    ];
    for (const fn of failures) {
      assert.throws(fn, (err) => {
        assert.ok(err instanceof Error, 'expected an Error');
        assert.match(err.code, /^PE_[A-Z_]+$/, 'code is a PE_* constant');
        assert.ok(err.message.length > 0, 'message is never empty');
        return true;
      });
    }
  });

  it('EVENT_TYPES documents the event model', () => {
    assert.deepEqual([...EVENT_TYPES], ['pause', 'resume', 'auto-resume']);
    assert.ok(Object.isFrozen(EVENT_TYPES));
  });
});
