import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { event } from '../src/events.js';

// Selected-read status consistency: the packet must not contradict itself
// about whether work has started. Fixture pattern copied from
// tests/agent-continuity-successor.test.mjs: a real normalized RoomStore
// driven only through store.command, read through store.workContext.
//
// The defect: agent A accepts and starts an item through the native
// lifecycle commands (work.accepted / work.started) and stops. Those
// reducers move only item.state; they never write the parallel session
// ledger (src/work-item-session.js), whose record therefore stays at its
// never-started default. currentWorkRecord (server/work-context.mjs)
// presents status/displayStatus from that ledger via
// presentedSessionStatus, which derives from the work state only for
// completed work (queued -> done). A fresh reader's packet consequently
// says state "working" and status/displayStatus "queued" in the same
// object — the item reads as simultaneously underway and never started.
//
// The presentation the codebase already uses for started work is
// "processing": it is the status session.started itself writes, and what
// session-driven running work presents in the selected read
// (tests/work-context.test.js). Deriving it here claims only that a start
// was recorded — never a live heartbeat, which "active" would imply and
// which no native command records.
//
// Deliberately NOT asserted as changed: started_at stays null and
// attempt_count stays 0. Those are session-ledger facts; the native path
// recorded no session start and no session attempt, and presentation must
// not fabricate them. recordedStatus likewise stays "queued": the ledger
// is history, the presented status is the read-time derivation.
//
// No private-redaction control lives in this file: this store-level
// fixture has no private-work proposal shape (selected-read redaction is
// covered by the dedicated handoff-privacy suites, whose surfaces this
// repair does not touch). The derivation reads only item.state, which the
// same packet already exposes to the same viewer, so it moves no
// information across any boundary. Test (a) instead pins the two
// visibility facts this layer does own: the presentation is identical for
// a member with no role on the item, and no session internals (attempt
// ledger, worker_member_id) enter the packet.

function fixture(t) {
  const s = new RoomStore(':memory:');
  t.after(() => s.close());
  const es = initialRoom();
  for (const [id, permissions] of [['worker', ['accept_work', 'complete_work']],
      ['successor', ['accept_work', 'complete_work']], ['verifier', ['verify']]])
    es.push(event({ roomId: 'commons', actorId: 'owner', type: 'member.added',
      data: { memberId: id, displayName: id, kind: 'agent', permissions } }));
  s.initialize(es, { representation: 'normalized-current-v1' });
  const keys = Object.fromEntries(['owner', 'worker', 'successor', 'verifier']
    .map(id => [id, s.issueAccessKey('commons', id)]));
  const cmd = (who, id, type, data) => s.command(keys[who], 'commons', { id, type, data });
  const item = id => JSON.parse(s.db.prepare("SELECT body FROM work_entities WHERE work_id=?").get(id).body);
  const propose = (id, accountableMemberId) => cmd('owner', `propose-${id}`, 'work.proposed',
    { workItemId: id, title: `TITLE-${id}`, definitionOfDone: `DOD-${id}`, accountableMemberId,
      mode: 'read', independentVerificationRequired: false, ownerDecisionRequired: false });
  const accept = (who, id) => cmd(who, `accept-${id}`, 'work.accepted',
    { workItemId: id, expectedRevision: item(id).revision });
  const start = (who, id) => cmd(who, `start-${id}`, 'work.started',
    { workItemId: id, expectedRevision: item(id).revision });
  return { s, keys, cmd, item, propose, accept, start };
}

test('selected read: natively started work does not present as queued', t => {
  const f = fixture(t), { s, keys } = f;
  f.propose('task', 'worker');
  f.accept('worker', 'task');
  f.start('worker', 'task');
  // A stops here — no session events, no result, no handoff.

  // B arrives fresh and reads the item.
  const context = s.workContext(keys.successor, 'commons', 'task');
  assert.equal(context.work.state, 'working');
  assert.notEqual(context.work.status, 'queued',
    'a working item must not present the never-started session status');
  assert.equal(context.work.status, 'processing',
    'the presented status is the one a recorded start carries in this codebase');
  assert.equal(context.work.displayStatus, context.work.status,
    'displayStatus agrees with status');
  assert.equal(context.accessSummary.budget.sessionStatus, 'processing',
    'the access summary presents the same derived status');
  // The ledger itself is untouched history, still reported as recorded.
  assert.equal(context.work.recordedStatus, 'queued');
  assert.equal(context.accessSummary.budget.recordedSessionStatus, 'queued');
  // Presentation fabricates no ledger facts: no session start was recorded,
  // so none is presented.
  assert.equal(context.work.started_at, null);
  assert.equal(context.work.attempt_count, 0);

  // The presentation is viewer-independent: a member with no role on the
  // item reads the same status, and no session internals enter the packet.
  const bystander = s.workContext(keys.verifier, 'commons', 'task');
  assert.equal(bystander.work.status, 'processing');
  assert.equal(bystander.work.displayStatus, 'processing');
  assert.equal(Object.hasOwn(bystander.work, 'attempts'), false);
  assert.equal(Object.hasOwn(bystander.work, 'worker_member_id'), false);
});

test('selected read: accepted or proposed work that never started still presents as queued', t => {
  const f = fixture(t), { s, keys } = f;
  f.propose('accepted-task', 'successor');
  f.accept('successor', 'accepted-task');
  f.propose('fresh-task', 'worker');

  const accepted = s.workContext(keys.successor, 'commons', 'accepted-task');
  assert.equal(accepted.work.state, 'accepted');
  assert.equal(accepted.work.status, 'queued',
    'acceptance is not a start; the never-started presentation stays');
  assert.equal(accepted.work.displayStatus, 'queued');
  assert.equal(accepted.work.recordedStatus, 'queued');

  const fresh = s.workContext(keys.successor, 'commons', 'fresh-task');
  assert.equal(fresh.work.state, 'proposed');
  assert.equal(fresh.work.status, 'queued');
  assert.equal(fresh.work.displayStatus, 'queued');
});
