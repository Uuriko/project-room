/**
 * contact-merge.test.js — tests for the contact identity-resolution + merge planner.
 *
 * Covers: strong-link detection (email/phone), weak-link thresholding,
 * no false positive on common names alone, deterministic field resolution,
 * conflict surfacing + explicit resolution, approve/reject flow, dry-run
 * preview purity, and the coded-error contract.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createContactMerge, DEFAULT_WEIGHTS, MERGE_STATES } from '../src/contact-merge.mjs';

/** Controllable clock + deterministic ids: { planner(weights), advance(ms) }. */
function harness() {
  const box = { now: 1_000_000 };
  let n = 0;
  return {
    advance: (ms) => {
      box.now += ms;
    },
    planner: (weights) =>
      createContactMerge({
        clock: () => box.now,
        id: () => `t-${(n += 1)}`,
        weights,
      }),
  };
}

function expectCode(fn, code) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof Error, 'expected an Error');
    assert.equal(err.code, code, `expected code ${code}, got ${err.code}`);
    return true;
  });
}

const ALICE = () => ({
  id: 'a',
  names: ['Alice Adams'],
  emails: [{ address: 'alice@example.com', verified: true, seenAt: 100 }],
  phones: ['+1 415 555 0100'],
  channels: { x: '@alice' },
});

const ALICE_DUP = () => ({
  id: 'b',
  names: ['Al'],
  emails: ['ALICE@Example.COM'], // case-insensitive match → strong link
  phones: [],
  channels: { x: '@alice' },
});

describe('contact-merge', () => {
  it('strong link: shared email surfaces a candidate pair', () => {
    const { planner } = harness();
    const p = planner();
    p.addContact(ALICE());
    p.addContact(ALICE_DUP());
    const cands = p.findCandidates();
    assert.equal(cands.length, 1);
    assert.equal(cands[0].contactA, 'a');
    assert.equal(cands[0].contactB, 'b');
    assert.equal(cands[0].score, DEFAULT_WEIGHTS.emailMatch);
    assert.deepEqual(cands[0].links, [
      { kind: 'email', value: 'alice@example.com', weight: DEFAULT_WEIGHTS.emailMatch },
    ]);
  });

  it('strong link: shared phone (digits-normalized) surfaces a candidate pair', () => {
    const { planner } = harness();
    const p = planner();
    p.addContact({ id: 'a', names: ['Ann'], emails: [], phones: ['+1 (415) 555-0100'], channels: {} });
    p.addContact({ id: 'b', names: ['Ann Other'], emails: [], phones: ['14155550100'], channels: {} });
    const cands = p.findCandidates();
    assert.equal(cands.length, 1);
    assert.equal(cands[0].links[0].kind, 'phone');
    assert.equal(cands[0].links[0].value, '14155550100');
  });

  it('weak link: normalized name + shared channel scores at nameChannelMatch weight', () => {
    const { planner } = harness();
    const p = planner();
    p.addContact({ id: 'c', names: ['  BOB Jones '], emails: [], phones: [], channels: { Telegram: 'bobj' } });
    p.addContact({ id: 'd', names: ['bob  jones'], emails: [], phones: [], channels: { telegram: 'BobJ' } });
    const cands = p.findCandidates();
    assert.equal(cands.length, 1);
    assert.equal(cands[0].score, DEFAULT_WEIGHTS.nameChannelMatch);
    assert.equal(cands[0].links[0].kind, 'name+channel');
  });

  it('weak-link thresholding: raising the threshold drops the weak pair, strong links still surface', () => {
    const { planner } = harness();
    const p = planner({ ...DEFAULT_WEIGHTS, threshold: 0.9 });
    p.addContact({ id: 'c', names: ['Bob Jones'], emails: [], phones: [], channels: { telegram: 'bobj' } });
    p.addContact({ id: 'd', names: ['bob jones'], emails: [], phones: [], channels: { telegram: 'bobj' } });
    assert.equal(p.findCandidates().length, 0, 'weak link below raised threshold');

    p.addContact(ALICE());
    p.addContact(ALICE_DUP());
    const cands = p.findCandidates();
    assert.equal(cands.length, 1, 'strong link still above threshold');
    assert.equal(cands[0].score, 1.0);
  });

  it('no false positive: common name alone never proposes a merge', () => {
    const { planner } = harness();
    const p = planner();
    p.addContact({ id: 'e', names: ['John Smith'], emails: ['john.smith.1@x.com'], phones: [], channels: {} });
    p.addContact({ id: 'f', names: ['john smith'], emails: ['totally.different@y.com'], phones: [], channels: {} });
    assert.equal(p.findCandidates().length, 0);
    expectCode(() => p.proposeMerge('e', 'f'), 'CM_INVALID_TRANSITION');
  });

  it('field resolution is deterministic: proposeMerge(a,b) ≡ proposeMerge(b,a)', () => {
    const h1 = harness();
    const h2 = harness();
    const p1 = h1.planner();
    const p2 = h2.planner();
    for (const p of [p1, p2]) {
      p.addContact(ALICE());
      p.addContact(ALICE_DUP());
    }
    const planAB = p1.proposeMerge('a', 'b');
    const planBA = p2.proposeMerge('b', 'a');
    assert.equal(planAB.state, 'proposed');
    assert.deepEqual(
      { ...planAB, id: 'X', mergedId: 'Y' },
      { ...planBA, id: 'X', mergedId: 'Y' },
    );
  });

  it('field resolution: union everywhere, primaryEmail = most-recently-seen verified (not longest name)', () => {
    const { planner } = harness();
    // shared email forces candidacy; the field-plan rules below are the focus
    const p2 = planner();
    p2.addContact({
      id: 'a',
      names: ['Al'],
      emails: [
        { address: 'old@x.com', verified: true, seenAt: 100 },
        { address: 'shared@x.com', verified: true, seenAt: 50 },
      ],
      phones: ['111'],
      channels: { x: '@al' },
    });
    p2.addContact({
      id: 'b',
      names: ['Alexandria Adamsington the Third'],
      emails: [
        { address: 'new@x.com', verified: true, seenAt: 200 },
        { address: 'shared@x.com', verified: false, seenAt: 300 },
      ],
      phones: ['222'],
      channels: { telegram: 'alex' },
    });
    const plan = p2.proposeMerge('a', 'b');
    assert.equal(plan.state, 'proposed');
    const fp = plan.fieldPlan;
    // names union — both kept, longest-name-wins would have dropped 'Al'
    assert.deepEqual(fp.names.value, ['Al', 'Alexandria Adamsington the Third']);
    assert.equal(fp.names.strategy, 'union');
    // primary = most-recently-seen VERIFIED (new@x.com @200 beats shared@x.com unverified @300)
    assert.equal(fp.primaryEmail.value, 'new@x.com');
    assert.equal(fp.primaryEmail.strategy, 'most-recently-seen-verified');
    // phones + channels union
    assert.deepEqual(
      fp.phones.value.map((x) => x.number).sort(),
      ['111', '222'],
    );
    assert.deepEqual(fp.channels.value, { x: '@al', telegram: 'alex' });
    // emails union dedupes the shared address (first-seen entry kept)
    assert.equal(fp.emails.value.filter((e) => e.address === 'shared@x.com').length, 1);
  });

  it('conflict: same channel key with different handles → conflict state, explicit resolution required', () => {
    const { planner } = harness();
    const p = planner();
    p.addContact(ALICE());
    p.addContact({ ...ALICE_DUP(), channels: { x: '@alice2' } });
    const plan = p.proposeMerge('a', 'b');
    assert.equal(plan.state, 'conflict');
    assert.deepEqual(plan.conflicts, [
      {
        field: 'channels.x',
        options: ['@alice', '@alice2'],
        reason: "channel 'x' has different handles in the two contacts",
      },
    ]);
    expectCode(() => p.dryRun(plan.id), 'CM_MERGE_CONFLICT');
    expectCode(() => p.approve(plan.id), 'CM_INVALID_TRANSITION');
    expectCode(() => p.resolveConflict(plan.id, 'channels.x', '@nobody'), 'CM_INVALID_RESOLUTION');
    const resolved = p.resolveConflict(plan.id, 'channels.x', '@alice2');
    assert.equal(resolved.state, 'proposed');
    assert.equal(resolved.fieldPlan.channels.value.x, '@alice2');
    assert.equal(resolved.fieldPlan.channels.strategy, 'explicit-choice');
    const preview = p.dryRun(plan.id);
    assert.equal(preview.channels.x, '@alice2');
  });

  it('conflict: tied most-recently-seen verified emails → conflict on primaryEmail', () => {
    const { planner } = harness();
    const p = planner();
    p.addContact({
      id: 'a',
      names: ['Zed'],
      emails: [{ address: 'a1@x.com', verified: true, seenAt: 500 }],
      phones: ['999'],
      channels: {},
    });
    p.addContact({
      id: 'b',
      names: ['Zed Zee'],
      emails: [{ address: 'b1@x.com', verified: true, seenAt: 500 }],
      phones: ['999'], // shared phone → candidacy
      channels: {},
    });
    const plan = p.proposeMerge('a', 'b');
    assert.equal(plan.state, 'conflict');
    const conflict = plan.conflicts.find((c) => c.field === 'primaryEmail');
    assert.ok(conflict);
    assert.deepEqual(conflict.options, ['a1@x.com', 'b1@x.com']);
    expectCode(() => p.dryRun(plan.id), 'CM_MERGE_CONFLICT');
    const resolved = p.resolveConflict(plan.id, 'primaryEmail', 'b1@x.com');
    assert.equal(resolved.state, 'proposed');
    assert.equal(resolved.fieldPlan.primaryEmail.value, 'b1@x.com');
    assert.equal(resolved.fieldPlan.primaryEmail.strategy, 'explicit-choice');
  });

  it('conflict: plan stays in conflict until EVERY collision is resolved', () => {
    const { planner } = harness();
    const p = planner();
    p.addContact({
      id: 'a',
      names: ['Zed'],
      emails: [{ address: 'a1@x.com', verified: true, seenAt: 500 }],
      phones: ['999'],
      channels: { x: '@zed' },
    });
    p.addContact({
      id: 'b',
      names: ['Zed Zee'],
      emails: [{ address: 'b1@x.com', verified: true, seenAt: 500 }],
      phones: ['999'],
      channels: { x: '@zed2' },
    });
    const plan = p.proposeMerge('a', 'b');
    assert.equal(plan.state, 'conflict');
    assert.equal(plan.conflicts.length, 2);
    const mid = p.resolveConflict(plan.id, 'channels.x', '@zed');
    assert.equal(mid.state, 'conflict', 'one collision left');
    const done = p.resolveConflict(plan.id, 'primaryEmail', 'a1@x.com');
    assert.equal(done.state, 'proposed');
  });

  it('approve/reject flow: proposed → approved → merged; reject is terminal', () => {
    const { planner } = harness();
    const p = planner();
    p.addContact(ALICE());
    p.addContact(ALICE_DUP());
    const plan = p.proposeMerge('a', 'b');

    const preview = p.dryRun(plan.id);
    assert.ok(preview.names.includes('Alice Adams'));
    assert.ok(preview.names.includes('Al'));
    assert.equal(preview.primaryEmail, 'alice@example.com');
    assert.deepEqual(preview.mergedFrom, ['a', 'b']);

    const approved = p.approve(plan.id);
    assert.equal(approved.state, 'approved');
    const merged = p.execute(plan.id);
    assert.deepEqual(merged.names, preview.names);
    assert.equal(merged.primaryEmail, preview.primaryEmail);
    assert.equal(merged.mergedAt, preview.mergedAt);
    assert.equal(p.getPlan(plan.id).state, 'merged');

    const ca = p.getContact('a');
    assert.equal(ca.status, 'merged');
    assert.equal(ca.mergedInto, merged.id);
    // retired contacts no longer surface candidates
    assert.equal(p.findCandidates().length, 0);
    expectCode(() => p.execute(plan.id), 'CM_INVALID_TRANSITION');

    // reject path on a fresh pair
    p.addContact({ id: 'g', names: ['Gail'], emails: ['gail@x.com'], phones: [], channels: {} });
    p.addContact({ id: 'h', names: ['Gail H'], emails: ['gail@x.com'], phones: [], channels: {} });
    const plan2 = p.proposeMerge('g', 'h');
    const rejected = p.reject(plan2.id, 'different people, shared family inbox');
    assert.equal(rejected.state, 'rejected');
    assert.equal(rejected.rejectReason, 'different people, shared family inbox');
    expectCode(() => p.approve(plan2.id), 'CM_INVALID_TRANSITION');
    expectCode(() => p.execute(plan2.id), 'CM_INVALID_TRANSITION');
    // rejected plans are not "active": the pair can be proposed again
    const plan3 = p.proposeMerge('g', 'h');
    assert.equal(plan3.state, 'proposed');
  });

  it('dry-run preview is pure: no state, audit, or contact mutation', () => {
    const { planner } = harness();
    const p = planner();
    p.addContact(ALICE());
    p.addContact(ALICE_DUP());
    const plan = p.proposeMerge('a', 'b');
    const before = {
      plan: p.getPlan(plan.id),
      auditLen: p.audit.length,
      a: p.getContact('a'),
      b: p.getContact('b'),
    };
    const first = p.dryRun(plan.id);
    const second = p.dryRun(plan.id);
    assert.deepEqual(first, second, 'dry run is repeatable');
    assert.deepEqual(p.getPlan(plan.id), before.plan, 'plan untouched');
    assert.equal(p.audit.length, before.auditLen, 'audit untouched');
    assert.deepEqual(p.getContact('a'), before.a, 'contact a untouched');
    assert.deepEqual(p.getContact('b'), before.b, 'contact b untouched');
    // dry run also allowed after approval, still pure
    p.approve(plan.id);
    const auditLen = p.audit.length;
    const third = p.dryRun(plan.id);
    assert.deepEqual(third, first);
    assert.equal(p.audit.length, auditLen);
    assert.equal(p.getPlan(plan.id).state, 'approved');
  });

  it('coded-error contract: invalid contacts, unknown ids, bad weights, duplicates, self-merge', () => {
    const { planner } = harness();
    expectCode(() => planner({ threshold: -1 }), 'CM_INVALID_WEIGHTS');
    expectCode(() => planner({ emailMatch: 'lots' }), 'CM_INVALID_WEIGHTS');
    expectCode(() => planner({ threshold: Number.NaN }), 'CM_INVALID_WEIGHTS');

    const p = planner();
    expectCode(() => p.addContact(null), 'CM_INVALID_CONTACT');
    expectCode(() => p.addContact('nope'), 'CM_INVALID_CONTACT');
    expectCode(() => p.addContact({ id: 'x', names: 'not-an-array' }), 'CM_INVALID_CONTACT');
    expectCode(() => p.addContact({ id: 'x', names: ['Ok'], emails: 'nope' }), 'CM_INVALID_CONTACT');
    expectCode(() => p.addContact({ id: 'x', names: ['Ok'], channels: ['nope'] }), 'CM_INVALID_CONTACT');
    expectCode(
      () => p.addContact({ id: 'x', names: ['Ok'], emails: [{ verified: true }] }),
      'CM_INVALID_CONTACT',
    );
    expectCode(() => p.addContact({ id: 'x', names: ['Ok'], phones: ['!!!'] }), 'CM_INVALID_CONTACT');

    p.addContact({ id: 'x', names: ['Xena'] });
    expectCode(() => p.addContact({ id: 'x', names: ['Xena again'] }), 'CM_INVALID_CONTACT');
    expectCode(() => p.proposeMerge('x', 'x'), 'CM_INVALID_TRANSITION');
    expectCode(() => p.proposeMerge('x', 'ghost'), 'CM_NOT_FOUND');
    expectCode(() => p.proposeMerge('ghost', 'x'), 'CM_NOT_FOUND');
    expectCode(() => p.dryRun('ghost'), 'CM_NOT_FOUND');
    expectCode(() => p.approve('ghost'), 'CM_NOT_FOUND');
    expectCode(() => p.reject('ghost', 'r'), 'CM_NOT_FOUND');
    expectCode(() => p.execute('ghost'), 'CM_NOT_FOUND');
    expectCode(() => p.resolveConflict('ghost', 'f', 'c'), 'CM_NOT_FOUND');
    assert.equal(p.getPlan('ghost'), null);
    assert.equal(p.getContact('ghost'), null);

    // duplicate active proposal
    p.addContact(ALICE());
    p.addContact(ALICE_DUP());
    const plan = p.proposeMerge('a', 'b');
    expectCode(() => p.proposeMerge('a', 'b'), 'CM_DUPLICATE_PROPOSAL');
    expectCode(() => p.proposeMerge('b', 'a'), 'CM_DUPLICATE_PROPOSAL');
    // resolveConflict on a non-conflict plan
    expectCode(() => p.resolveConflict(plan.id, 'primaryEmail', 'alice@example.com'), 'CM_INVALID_TRANSITION');
    // execute before approval
    expectCode(() => p.execute(plan.id), 'CM_INVALID_TRANSITION');
  });

  it('MERGE_STATES lists the full lifecycle', () => {
    assert.deepEqual([...MERGE_STATES], ['proposed', 'approved', 'merged', 'rejected', 'conflict']);
  });
});
