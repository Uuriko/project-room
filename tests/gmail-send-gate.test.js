/**
 * gmail-send-gate.test.js — tests for the Gmail send approval gate.
 *
 * Covers: happy path, edit-after-approval voiding, hash mismatch, send without
 * approval, expiry via fake clock, reject path, audit completeness, and the
 * coded-error contract.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createGmailSendGate,
  DEFAULT_APPROVAL_TTL_MS,
  STATES,
} from '../src/gmail-send-gate.mjs';

/** Controllable clock: { now, clock() , advance(ms) }. */
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

const DRAFT = () => ({
  to: 'chris@alphacompute.ai',
  subject: 'Intro: Damian Marcinczyk',
  body: 'Hi Chris — quick intro…',
});

function expectGateError(fn, code) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof Error, 'expected an Error');
    assert.equal(err.code, code, `expected code ${code}, got ${err.code}`);
    return true;
  });
}

describe('gmail-send-gate', () => {
  it('happy path: draft → pending-approval → approved → sending → sent', () => {
    const gate = createGmailSendGate();
    const created = gate.createDraft(DRAFT(), 'agent');
    assert.equal(created.state, 'draft');
    assert.ok(created.contentHash);

    const pending = gate.requestApproval(created.id, 'john');
    assert.equal(pending.state, 'pending-approval');

    const approved = gate.approve(created.id, pending.contentHash, 'john');
    assert.equal(approved.state, 'approved');
    assert.equal(approved.approvedHash, approved.contentHash);
    assert.equal(approved.approvalConsumed, false);

    const sent = gate.send(created.id, 'agent');
    assert.equal(sent.state, 'sent');
    assert.equal(sent.approvalConsumed, true);

    // Sending twice is impossible (invalid transition from sent).
    expectGateError(() => gate.send(created.id, 'agent'), 'GATE_INVALID_TRANSITION');
  });

  it('records the approval hash bound at requestApproval time', () => {
    const seen = [];
    const gate = createGmailSendGate({ hash: (s) => `h:${s}` });
    const created = gate.createDraft(DRAFT(), 'agent');
    gate.requestApproval(created.id, 'john');
    const entry = gate.audit.find((e) => e.to === 'pending-approval');
    assert.ok(entry, 'expected a pending-approval audit entry');
    assert.equal(entry.detail.contentHash, created.contentHash);
    assert.ok(created.contentHash.startsWith('h:'), 'injected hash is used');
    void seen;
  });

  it('edit while pending voids the approval and returns to draft', () => {
    const gate = createGmailSendGate();
    const created = gate.createDraft(DRAFT(), 'agent');
    gate.requestApproval(created.id, 'john');
    const oldHash = created.contentHash;

    const edited = gate.editDraft(created.id, { subject: 'Intro: Damian (updated)' }, 'agent');
    assert.equal(edited.state, 'draft');
    assert.notEqual(edited.contentHash, oldHash);

    // The old pending approval no longer exists: approving the old hash fails.
    expectGateError(
      () => gate.approve(created.id, oldHash, 'john'),
      'GATE_INVALID_TRANSITION',
    );

    const entry = gate.audit.at(-1);
    assert.equal(entry.from, 'pending-approval');
    assert.equal(entry.to, 'draft');
    assert.equal(entry.detail.approvalVoided, true);
  });

  it('edit after approval voids the approval too', () => {
    const gate = createGmailSendGate();
    const created = gate.createDraft(DRAFT(), 'agent');
    const pending = gate.requestApproval(created.id, 'john');
    gate.approve(created.id, pending.contentHash, 'john');

    gate.editDraft(created.id, { body: 'Hi Chris — changed body…' }, 'agent');
    assert.equal(gate.get(created.id).state, 'draft');

    // Send is now blocked: no live approval.
    expectGateError(() => gate.send(created.id, 'agent'), 'GATE_INVALID_TRANSITION');
  });

  it('approve with the wrong hash throws GATE_HASH_MISMATCH and stays pending', () => {
    const gate = createGmailSendGate();
    const created = gate.createDraft(DRAFT(), 'agent');
    gate.requestApproval(created.id, 'john');

    expectGateError(
      () => gate.approve(created.id, 'bogus-hash', 'john'),
      'GATE_HASH_MISMATCH',
    );
    assert.equal(gate.get(created.id).state, 'pending-approval');

    // The right hash still works afterwards.
    gate.approve(created.id, created.contentHash, 'john');
    assert.equal(gate.get(created.id).state, 'approved');
  });

  it('send without approval throws GATE_INVALID_TRANSITION', () => {
    const gate = createGmailSendGate();
    const created = gate.createDraft(DRAFT(), 'agent');
    expectGateError(() => gate.send(created.id, 'agent'), 'GATE_INVALID_TRANSITION');

    gate.requestApproval(created.id, 'john');
    expectGateError(() => gate.send(created.id, 'agent'), 'GATE_INVALID_TRANSITION');
  });

  it('pending approval expires after the TTL (fake clock) via sweep()', () => {
    const { clock, advance } = fakeClock();
    const gate = createGmailSendGate({ clock });
    const created = gate.createDraft(DRAFT(), 'agent');
    gate.requestApproval(created.id, 'john');
    assert.equal(gate.get(created.id).state, 'pending-approval');

    advance(DEFAULT_APPROVAL_TTL_MS + 1);
    const expired = gate.sweep('system');
    assert.deepEqual(expired, [created.id]);
    assert.equal(gate.get(created.id).state, 'expired');

    // Expired approvals cannot be sent or re-approved without a new request.
    expectGateError(() => gate.send(created.id, 'agent'), 'GATE_INVALID_TRANSITION');
    expectGateError(
      () => gate.approve(created.id, created.contentHash, 'john'),
      'GATE_INVALID_TRANSITION',
    );

    // Re-requesting approval works after expiry.
    const re = gate.requestApproval(created.id, 'john');
    assert.equal(re.state, 'pending-approval');
    gate.approve(created.id, re.contentHash, 'john');
    assert.equal(gate.get(created.id).state, 'approved');
  });

  it('approve() on a stale pending approval expires it and throws GATE_APPROVAL_EXPIRED', () => {
    const { clock, advance } = fakeClock();
    const gate = createGmailSendGate({ clock });
    const created = gate.createDraft(DRAFT(), 'agent');
    gate.requestApproval(created.id, 'john');
    advance(DEFAULT_APPROVAL_TTL_MS + 60_000);

    expectGateError(
      () => gate.approve(created.id, created.contentHash, 'john'),
      'GATE_APPROVAL_EXPIRED',
    );
    assert.equal(gate.get(created.id).state, 'expired');

    const last = gate.audit.at(-1);
    assert.equal(last.from, 'pending-approval');
    assert.equal(last.to, 'expired');
  });

  it('respects a custom approvalTtlMs', () => {
    const { clock, advance } = fakeClock();
    const gate = createGmailSendGate({ clock, approvalTtlMs: 1_000 });
    assert.equal(gate.approvalTtlMs, 1_000);
    const created = gate.createDraft(DRAFT(), 'agent');
    gate.requestApproval(created.id, 'john');
    advance(999);
    assert.deepEqual(gate.sweep(), []);
    assert.equal(gate.get(created.id).state, 'pending-approval');
    advance(2);
    assert.deepEqual(gate.sweep(), [created.id]);
    assert.equal(gate.get(created.id).state, 'expired');
  });

  it('reject path records the reason', () => {
    const gate = createGmailSendGate();
    const created = gate.createDraft(DRAFT(), 'agent');
    gate.requestApproval(created.id, 'john');
    const rejected = gate.reject(created.id, 'Not the right time', 'john');
    assert.equal(rejected.state, 'rejected');
    assert.equal(rejected.rejectReason, 'Not the right time');

    expectGateError(() => gate.send(created.id, 'agent'), 'GATE_INVALID_TRANSITION');

    // Rework after rejection is possible: edit back to draft, re-request.
    gate.editDraft(created.id, { subject: 'Intro: Damian (reworked)' }, 'agent');
    assert.equal(gate.get(created.id).state, 'draft');
    gate.requestApproval(created.id, 'john');
    assert.equal(gate.get(created.id).state, 'pending-approval');
  });

  it('edit is blocked from terminal/sending states', () => {
    const gate = createGmailSendGate();
    const created = gate.createDraft(DRAFT(), 'agent');
    const pending = gate.requestApproval(created.id, 'john');
    gate.approve(created.id, pending.contentHash, 'john');
    gate.send(created.id, 'agent');
    assert.equal(gate.get(created.id).state, 'sent');
    expectGateError(() => gate.editDraft(created.id, { body: 'x' }, 'agent'), 'GATE_INVALID_TRANSITION');
  });

  it('unknown draft ids throw GATE_NOT_FOUND', () => {
    const gate = createGmailSendGate();
    for (const fn of [
      () => gate.editDraft('nope', {}, 'agent'),
      () => gate.requestApproval('nope', 'john'),
      () => gate.approve('nope', 'h', 'john'),
      () => gate.reject('nope', 'r', 'john'),
      () => gate.send('nope', 'agent'),
    ]) {
      expectGateError(fn, 'GATE_NOT_FOUND');
    }
    assert.equal(gate.get('nope'), null);
  });

  it('audit log is append-only and complete for a full lifecycle', () => {
    const { clock, advance } = fakeClock();
    const gate = createGmailSendGate({ clock });
    const created = gate.createDraft(DRAFT(), 'agent');
    advance(5);
    gate.requestApproval(created.id, 'john');
    advance(5);
    gate.approve(created.id, created.contentHash, 'john');
    advance(5);
    gate.send(created.id, 'agent');

    const log = gate.audit;
    const transitions = log.map((e) => `${e.from}->${e.to}`);
    assert.deepEqual(transitions, [
      'null->draft',
      'draft->pending-approval',
      'pending-approval->approved',
      'approved->sending',
      'sending->sent',
    ]);

    // Every entry carries the required shape.
    for (const entry of log) {
      assert.ok(typeof entry.at === 'number', 'at is a number');
      assert.ok('from' in entry && 'to' in entry && 'actor' in entry && 'detail' in entry);
      assert.equal(entry.detail.draftId, created.id);
    }
    assert.deepEqual(
      log.map((e) => e.actor),
      ['agent', 'john', 'john', 'agent', 'agent'],
    );

    // Append-only: the log only grows; a second draft adds entries without
    // disturbing the first draft's history.
    const before = gate.audit.length;
    const other = gate.createDraft(DRAFT(), 'agent');
    gate.requestApproval(other.id, 'john');
    gate.reject(other.id, 'nope', 'john');
    assert.equal(gate.audit.length, before + 3);
    assert.deepEqual(
      gate.audit.slice(0, before).map((e) => `${e.from}->${e.to}`),
      transitions,
    );
  });

  it('reject entries land in the audit log with the reason', () => {
    const gate = createGmailSendGate();
    const created = gate.createDraft(DRAFT(), 'agent');
    gate.requestApproval(created.id, 'john');
    gate.reject(created.id, 'Wrong recipient', 'john');
    const last = gate.audit.at(-1);
    assert.equal(last.from, 'pending-approval');
    assert.equal(last.to, 'rejected');
    assert.equal(last.detail.reason, 'Wrong recipient');
    assert.equal(last.actor, 'john');
  });

  it('STATES export covers the full state graph', () => {
    assert.deepEqual([...STATES].sort(), [
      'approved',
      'draft',
      'expired',
      'failed',
      'pending-approval',
      'rejected',
      'sending',
      'sent',
    ]);
  });
});
