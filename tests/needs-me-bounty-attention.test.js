// ATT (attention plumbing, UT2-conversion charter): needs-me bounty legs.
//
// Executed defect (UT2 02-05/02-04/02-03): GET /api/needs-me returned
// items: [] for poster, worker AND decider during both adjudicating
// windows — a live ruling was owed, the worker had credits + a bond at
// stake, and after both rulings nobody's needs-me recorded the outcome.
// server/needs-me.mjs contained zero bounty references: the escrow store
// was never consulted. These tests pin the cure: a standing
// `bountyAttention` section (same pattern as myClaims — standing state,
// never moves the cursor) carrying one row per (bounty, role) for the
// three blind roles: decider (dispute awaiting YOUR ruling, with the
// window's age), poster, and worker with money/bond at stake. Rows are
// grounds-free: state, amount, parties, ages — never evidence/criteria.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomStore } from '../server/store.mjs';
import { AgentRooms } from '../server/agent-rooms.mjs';
import { collectNeedsMe, bountyAttentionOf } from '../server/needs-me.mjs';
import { linkWithProof } from "./helpers/link-with-proof.mjs";

const T0 = Date.parse('2026-10-05T00:00:00Z');
const POSTER = 'id:agent/poster';
const WORKER = 'id:agent/worker';
const DECIDER = 'id:agent/decider';

const bounty = (overrides = {}) => ({
  bountyId: 'B-1', title: 'Fix the thing', amount: 4, state: 'disputed',
  poster: POSTER, claimant: WORKER, verifier: null, disputeDecider: DECIDER,
  disputeId: 'dsp_1', disputeOpenedMs: T0 - 90 * 60000,
  stateChangedAt: new Date(T0 - 90 * 60000).toISOString(),
  evidence: { secret: 'grounds-must-never-leak' }, criteria: 'secret criteria',
  ...overrides,
});

test('decider leg: exactly one row for the seated decider, with dispute age and the ruling action', () => {
  const section = bountyAttentionOf(null, 'room', DECIDER, [bounty()], T0);
  assert.equal(section.count, 1);
  const row = section.top[0];
  assert.equal(row.role, 'decider');
  assert.equal(row.why, 'dispute_awaiting_ruling');
  assert.equal(row.id, 'B-1');
  assert.equal(row.disputeId, 'dsp_1');
  assert.equal(row.disputeAgeMinutes, 90, "the window's age rides the row");
  assert.equal(row.poster, POSTER);
  assert.equal(row.claimant, WORKER);
  assert.equal(row.amount, 4);
  assert.match(row.next, /bounties\/B-1\/dispute-decide$/);
  // Grounds-free (charter §3): no evidence, criteria, or grounds content.
  assert.equal(row.evidence, undefined);
  assert.equal(row.criteria, undefined);
  assert.ok(!JSON.stringify(row).includes('grounds-must-never-leak'));
  assert.ok(!JSON.stringify(row).includes('secret criteria'));
});

test('decider leg: only the seated decider — poster/worker get their own sides, strangers nothing', () => {
  const poster = bountyAttentionOf(null, 'room', POSTER, [bounty()], T0);
  assert.deepEqual(poster.top.map(r => [r.role, r.why]), [['poster', 'dispute_open']]);
  assert.equal(poster.top[0].disputeAgeMinutes, 90);
  const worker = bountyAttentionOf(null, 'room', WORKER, [bounty()], T0);
  assert.deepEqual(worker.top.map(r => [r.role, r.why]), [['worker', 'dispute_open']]);
  assert.equal(bountyAttentionOf(null, 'room', 'id:agent/stranger', [bounty()], T0), null);
  // A bounty whose decider seat is the verifier (no disputeDecider named).
  const viaVerifier = bounty({ disputeDecider: null, verifier: DECIDER });
  assert.equal(bountyAttentionOf(null, 'room', DECIDER, [viaVerifier], T0).top[0].role, 'decider');
  // Lane forms: colon and slash spellings name the same account.
  const colon = bounty({ disputeDecider: 'id:agent:decider' });
  assert.equal(bountyAttentionOf(null, 'room', DECIDER, [colon], T0).top[0].role, 'decider');
});

test('poster/worker legs: lifecycle transitions are rows within one poll', () => {
  for (const [state, posterWhy, workerWhy] of [
    ['claimed', 'bounty_claimed', 'bounty_claimed'],
    ['submitted', 'submission_awaiting_review', 'submission_in_review'],
    ['accepted', 'accepted_challenge_window', 'accepted_challenge_window'],
    ['approved', 'bounty_approved', 'bounty_approved'],
  ]) {
    const live = bounty({ state, disputeId: null, disputeOpenedMs: null });
    assert.deepEqual(bountyAttentionOf(null, 'room', POSTER, [live], T0).top.map(r => r.why), [posterWhy], `poster ${state}`);
    assert.deepEqual(bountyAttentionOf(null, 'room', WORKER, [live], T0).top.map(r => r.why), [workerWhy], `worker ${state}`);
  }
  // Proposed/funded bounties are not yet anyone's obligation.
  for (const state of ['proposed', 'funded']) {
    const idle = bounty({ state, claimant: null, disputeId: null, disputeOpenedMs: null });
    assert.equal(bountyAttentionOf(null, 'room', POSTER, [idle], T0), null, `poster ${state}`);
  }
  // The poster reviewing a submission gets the actionable next step.
  const submitted = bounty({ state: 'submitted', disputeId: null, disputeOpenedMs: null });
  assert.match(bountyAttentionOf(null, 'room', POSTER, [submitted], T0).top[0].next, /bounties\/B-1\/accept$/);
});

test('outcome leg: after ruling, poster and worker record the outcome once; stale outcomes retire', () => {
  const paid = bounty({ state: 'paid', stateChangedAt: new Date(T0 - 3600000).toISOString() });
  for (const member of [POSTER, WORKER]) {
    const section = bountyAttentionOf(null, 'room', member, [paid], T0);
    assert.equal(section.count, 1, `${member} sees exactly one outcome row`);
    assert.equal(section.top[0].why, 'bounty_paid');
  }
  const refunded = bounty({ state: 'refunded', stateChangedAt: new Date(T0 - 3600000).toISOString() });
  assert.equal(bountyAttentionOf(null, 'room', WORKER, [refunded], T0).top[0].why, 'bounty_refunded');
  // A week later the outcome is history (the bounty list read owns it).
  const stale = bounty({ state: 'paid', stateChangedAt: new Date(T0 - 8 * 24 * 3600000).toISOString() });
  assert.equal(bountyAttentionOf(null, 'room', POSTER, [stale], T0), null);
});

test('decider outcome leg: after ruling, the decider records the outcome once on approved, paid and refunded', () => {
  // Charter §6: "After ruling, all three parties' needs-me records the
  // outcome once" — the decider's dispute_awaiting_ruling row must not
  // simply vanish when the bounty leaves `disputed` (critic D1).
  for (const [state, why] of [
    ['approved', 'bounty_approved'],
    ['paid', 'bounty_paid'],
    ['refunded', 'bounty_refunded'],
  ]) {
    const ruled = bounty({ state, stateChangedAt: new Date(T0 - 3600000).toISOString() });
    const section = bountyAttentionOf(null, 'room', DECIDER, [ruled], T0);
    assert.equal(section.count, 1, `decider sees exactly one outcome row on ${state}`);
    const row = section.top[0];
    assert.equal(row.role, 'decider');
    assert.equal(row.why, why);
    assert.equal(row.id, 'B-1');
    assert.equal(row.poster, POSTER);
    assert.equal(row.claimant, WORKER);
    assert.equal(row.amount, 4);
    // Same fields discipline as the poster/worker outcome rows:
    // grounds-free, explicit picks only — no dispute or evidence content.
    assert.equal(row.evidence, undefined);
    assert.equal(row.criteria, undefined);
    assert.ok(!JSON.stringify(row).includes('grounds-must-never-leak'));
    assert.ok(!JSON.stringify(row).includes('secret criteria'));
  }
  // The seat fallback agrees with the disputed row: a verifier seated as
  // decider (no disputeDecider named) also records the outcome.
  const viaVerifier = bounty({ state: 'paid', disputeDecider: null, verifier: DECIDER,
    stateChangedAt: new Date(T0 - 3600000).toISOString() });
  assert.deepEqual(bountyAttentionOf(null, 'room', DECIDER, [viaVerifier], T0).top.map(r => [r.role, r.why]),
    [['decider', 'bounty_paid']]);
});

test('decider outcome leg: absent before ruling, absent without a dispute, and a non-decider verifier gets nothing', () => {
  // Before any ruling the decider has no outcome row: live states give
  // the decider nothing, and `disputed` gives the awaiting row, never an
  // outcome row.
  for (const state of ['claimed', 'submitted', 'accepted']) {
    const live = bounty({ state, disputeId: null, disputeOpenedMs: null });
    assert.equal(bountyAttentionOf(null, 'room', DECIDER, [live], T0), null, `decider ${state}`);
  }
  const awaiting = bountyAttentionOf(null, 'room', DECIDER, [bounty()], T0);
  assert.deepEqual(awaiting.top.map(r => r.why), ['dispute_awaiting_ruling']);
  // An outcome that was never disputed (approved on challenge expiry,
  // paid/refunded with no dispute on the bounty) is not the designated
  // decider's outcome to record — they never held a ruling.
  for (const state of ['approved', 'paid', 'refunded']) {
    const undisputed = bounty({ state, disputeId: null, disputeOpenedMs: null,
      stateChangedAt: new Date(T0 - 3600000).toISOString() });
    assert.equal(bountyAttentionOf(null, 'room', DECIDER, [undisputed], T0), null, `decider undisputed ${state}`);
  }
  // A verifier who is not the designated decider gets nothing, in the
  // outcome states just as in `disputed`.
  const VERIFIER = 'id:agent/verifier';
  for (const state of ['approved', 'paid', 'refunded']) {
    const ruled = bounty({ state, verifier: VERIFIER,
      stateChangedAt: new Date(T0 - 3600000).toISOString() });
    assert.equal(bountyAttentionOf(null, 'room', VERIFIER, [ruled], T0), null, `verifier ${state}`);
    assert.equal(bountyAttentionOf(null, 'room', 'id:agent/stranger', [ruled], T0), null, `stranger ${state}`);
  }
});

test('decider outcome leg: the outcome row retires at the same 7-day window as poster/worker outcomes', () => {
  const WEEK = 7 * 24 * 3600000;
  for (const state of ['approved', 'paid', 'refunded']) {
    const atWindow = bounty({ state, stateChangedAt: new Date(T0 - WEEK).toISOString() });
    assert.equal(bountyAttentionOf(null, 'room', DECIDER, [atWindow], T0).top[0].role, 'decider',
      `${state} outcome still shown at exactly 7 days`);
    const pastWindow = bounty({ state, stateChangedAt: new Date(T0 - WEEK - 1).toISOString() });
    assert.equal(bountyAttentionOf(null, 'room', DECIDER, [pastWindow], T0), null,
      `${state} outcome retired at 7 days + 1ms`);
  }
});

test('no duplicates: one row per (bounty, role); a member with two roles gets both obligations', () => {
  const both = bountyAttentionOf(null, 'room', POSTER, [bounty({ disputeDecider: POSTER })], T0);
  assert.deepEqual(both.top.map(r => r.role).sort(), ['decider', 'poster']);
  assert.equal(both.count, 2);
  const again = bountyAttentionOf(null, 'room', DECIDER, [bounty(), bounty()], T0);
  assert.equal(again.count, 1, 'a duplicated bounty read still yields exactly one row per (bounty, role)');
});

// --- integration: the UT2 adjudication window, executed end to end -----

function setup(t) {
  let nowMs = T0;
  const store = new RoomStore(':memory:', { now: () => nowMs });
  t.after(() => store.close());
  const rooms = new AgentRooms(store);
  const owner = store.identities.create('Owen');
  const poster = store.identities.create('Poster');
  const worker = store.identities.create('Worker');
  const decider = store.identities.create('Decider');
  rooms.create(owner.secret, { roomId: 'board', title: 'board', purpose: 'ATT', kind: 'personal' });
  for (const identity of [poster, worker, decider]) {
    linkWithProof(store, owner.secret, 'board', identity,
      { displayName: identity.displayName, permissions: ['steer', 'accept_work', 'complete_work', 'verify'] });
  }
  const memberOf = identity => store.db.prepare('SELECT member_id AS m FROM identity_links WHERE identity_id=? AND room_id=?')
    .get(identity.identityId, 'board').m;
  return { store, poster, worker, decider, memberOf, setNow: ms => { nowMs = ms; } };
}

const attest = () => ({ at: new Date(T0).toISOString(), note: 'ok', citations: [{ criterionId: 'c1', verdict: 'pass' }] });

test('UT2 window: decider/poster/worker needs-me during and after a live ruling', t => {
  const { store, poster, worker, decider, memberOf, setNow } = setup(t);
  const escrow = store.bountyEscrow;
  escrow.ensureGenesis('board');
  const { bounty: posted } = escrow.postBounty('board', {
    poster: memberOf(poster), title: 'UT2 bounty', criteria: 'do it', amount: 4,
    deadline: new Date(T0 + 3 * 24 * 3600000).toISOString(), disputeDeciderId: memberOf(decider),
  });
  escrow.fundBounty('board', posted.bountyId, { funder: memberOf(poster) });
  escrow.claimBounty('board', posted.bountyId, { claimant: memberOf(worker) });

  // Claimed: poster and worker see the claim; the decider has nothing yet.
  assert.equal(collectNeedsMe(store, poster.secret, {}).bountyAttention?.[0].top[0].why, 'bounty_claimed');
  assert.equal(collectNeedsMe(store, worker.secret, {}).bountyAttention?.[0].top[0].why, 'bounty_claimed');
  assert.equal(collectNeedsMe(store, decider.secret, {}).bountyAttention, undefined);

  escrow.submitWork('board', posted.bountyId, { claimant: memberOf(worker),
    evidence: { evidenceUrl: 'https://example.com/1', summary: 'done' } });
  assert.equal(collectNeedsMe(store, poster.secret, {}).bountyAttention?.[0].top[0].why, 'submission_awaiting_review');

  escrow.acceptWork('board', posted.bountyId, { acceptor: memberOf(poster), verifierAttestation: attest() });
  escrow.disputeBounty('board', posted.bountyId, { challenger: memberOf(poster), grounds: 'not complete', bond: 1 });
  setNow(T0 + 90 * 60000);

  // The adjudicating window (UT2's empty baseline): all three roles served.
  const deciderPage = collectNeedsMe(store, decider.secret, {});
  const deciderRows = deciderPage.bountyAttention?.flatMap(s => s.top) ?? [];
  assert.equal(deciderRows.length, 1, 'exactly one dispute item for the seated decider');
  assert.equal(deciderRows[0].why, 'dispute_awaiting_ruling');
  assert.equal(deciderRows[0].disputeAgeMinutes, 90);
  assert.equal(deciderRows[0].poster, memberOf(poster));
  assert.equal(deciderRows[0].claimant, memberOf(worker));
  const posterRows = collectNeedsMe(store, poster.secret, {}).bountyAttention?.flatMap(s => s.top) ?? [];
  assert.deepEqual(posterRows.map(r => r.why), ['dispute_open']);
  const workerRows = collectNeedsMe(store, worker.secret, {}).bountyAttention?.flatMap(s => s.top) ?? [];
  assert.deepEqual(workerRows.map(r => r.why), ['dispute_open']);
  // No bounty row leaks into any other needs-me section.
  for (const page of [deciderPage]) {
    assert.equal(page.myClaims, undefined);
    assert.equal(page.actionsNeeded, undefined);
  }

  // Ruling lands: the decider's awaiting row is replaced by the outcome
  // record (charter §6 — all three parties record the outcome once);
  // poster + worker record the same outcome.
  escrow.decideDispute('board', posted.bountyId, { decider: memberOf(decider), outcome: 'upheld', reasonCodes: ['receipt-incomplete'] });
  const settled = escrow.getBounty('board', posted.bountyId);
  assert.ok(['paid', 'refunded'].includes(settled.state), `terminal state, got ${settled.state}`);
  const deciderOutcome = collectNeedsMe(store, decider.secret, {}).bountyAttention?.flatMap(s => s.top) ?? [];
  assert.deepEqual(deciderOutcome.map(r => [r.role, r.why]), [['decider', `bounty_${settled.state}`]],
    'decider records the outcome once, not silence');
  for (const identity of [poster, worker]) {
    const rows = collectNeedsMe(store, identity.secret, {}).bountyAttention?.flatMap(s => s.top) ?? [];
    assert.deepEqual(rows.map(r => r.why), [`bounty_${settled.state}`], 'outcome recorded once');
  }
});

test('bountyAttention never moves the needs-me cursor', t => {
  const { store, poster, worker, memberOf } = setup(t);
  const before = collectNeedsMe(store, poster.secret, {});
  const escrow = store.bountyEscrow;
  escrow.ensureGenesis('board');
  const { bounty: posted } = escrow.postBounty('board', {
    poster: memberOf(poster), title: 'Cursor bounty', criteria: 'do it', amount: 4,
    deadline: new Date(T0 + 3 * 24 * 3600000).toISOString(),
  });
  escrow.fundBounty('board', posted.bountyId, { funder: memberOf(poster) });
  escrow.claimBounty('board', posted.bountyId, { claimant: memberOf(worker) });
  const after = collectNeedsMe(store, poster.secret, {});
  assert.ok(after.bountyAttention?.length, 'section present after the claim');
  assert.deepEqual(after.cursor, before.cursor);
});
