import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { event } from '../src/events.js';
import { textVersion } from '../server/text-results.mjs';

// An accepted successor must wait on the predecessor’s exact review and acceptance.
const TASK_RESULT = 'Exact saved result RESULT-TASK-SENTINEL';

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
  const proposeTask = () => cmd('owner', 'propose-task', 'work.proposed', { workItemId: 'task',
    title: 'TASK-TITLE-SENTINEL', definitionOfDone: 'DOD-TASK-SENTINEL', accountableMemberId: 'worker',
    verifierMemberId: 'verifier', humanDecisionMakerId: 'owner',
    independentVerificationRequired: true, ownerDecisionRequired: true, mode: 'read' });
  const proposeNext = () => cmd('owner', 'propose-next', 'work.proposed', { workItemId: 'next-task',
    title: 'Next task', definitionOfDone: 'DOD-NEXT-SENTINEL', accountableMemberId: 'successor',
    mode: 'read', dependsOn: ['task'], independentVerificationRequired: false, ownerDecisionRequired: false });
  const accept = (who, id) => cmd(who, `accept-${id}`, 'work.accepted',
    { workItemId: id, expectedRevision: item(id).revision });
  const start = (who, id) => cmd(who, `start-${id}`, 'work.started',
    { workItemId: id, expectedRevision: item(id).revision });
  const completeTask = () => {
    const post = cmd('worker', 'result-task', 'message.posted',
      { messageId: 'result-task', body: TASK_RESULT, workItemId: 'task' });
    return cmd('worker', 'complete-task', 'work.completed', { workItemId: 'task',
      expectedRevision: item('task').revision, evidenceKind: 'room_text', evidenceMessageId: 'result-task',
      evidenceMessageEventId: post.event.id, evidenceVersion: textVersion(TASK_RESULT),
      producerId: 'worker', previousCompletionEventId: null, summary: 'Saved', nextAction: 'Independent review' });
  };
  const satisfyTaskGates = completion => {
    const receipt = item('task').receipt;
    cmd('verifier', 'verify-task', 'verification.recorded', { workItemId: 'task',
      expectedRevision: item('task').revision, result: 'pass', completionEventId: completion.event.id,
      evidenceVersion: receipt.evidenceVersion, summary: 'Checked exact result' });
    cmd('owner', 'rationale', 'message.posted', { messageId: 'rationale', body: 'I reviewed the exact result' });
    cmd('owner', 'decide-task', 'owner.decision_recorded', { workItemId: 'task',
      expectedRevision: item('task').revision, decision: 'approved', completionEventId: receipt.eventId,
      evidenceVersion: receipt.evidenceVersion, reason: 'Approved exact result', sourceMessageId: 'rationale' });
  };
  return { s, keys, proposeTask, proposeNext, accept, start, completeTask, satisfyTaskGates };
}

test('resume/next consistency (blocked): resume.next must not offer the start packet.next withholds', t => {
  const f = fixture(t), { s, keys } = f;
  f.proposeTask();
  f.accept('worker', 'task');
  f.start('worker', 'task');
  f.proposeNext();
  f.accept('successor', 'next-task');

  const context = s.workContext(keys.successor, 'commons', 'next-task');
  // Base-branch pins (PR #6257): the data half and the authoritative step
  // already tell the truth, so this harness cannot pass vacuously.
  assert.deepEqual(context.dependencies, [{ id: 'task', state: 'in_progress', satisfied: false }]);
  assert.equal(context.next.action, 'wait_prerequisites');
  assert.deepEqual(context.next.waitingOn, [{ id: 'task', state: 'in_progress' }]);
  // The weaker truth: while the packet's own dependencies show an unmet
  // prerequisite, no projection in the same packet may present a
  // prerequisite-gated action (start/claim) as the next step.
  assert.ok(!['start', 'claim'].includes(context.resume.next.action),
    `resume.next presents "${context.resume.next.action}" while dependencies show an unmet prerequisite`);
  // The consistency requirement: the resume projection's next step is the
  // packet's next step — same action, addressed to the same member.
  assert.equal(context.resume.next.action, context.next.action,
    'resume.next and next must agree on the next action');
  assert.equal(context.resume.next.memberId, context.next.memberId);
});

test('resume/next consistency (released): with prerequisites satisfied, resume.next and next agree', t => {
  const f = fixture(t), { s, keys } = f;
  f.proposeTask();
  f.accept('worker', 'task');
  f.start('worker', 'task');
  f.proposeNext();
  f.accept('successor', 'next-task');

  const completion = f.completeTask();
  f.satisfyTaskGates(completion);

  const context = s.workContext(keys.successor, 'commons', 'next-task');
  assert.deepEqual(context.dependencies, [{ id: 'task', state: 'done', satisfied: true }]);
  assert.equal(context.next.action, 'start');
  assert.equal(context.resume.next.action, 'start',
    'positive control: once the gate passes, resume.next offers the same start as next');
  assert.equal(context.resume.next.action, context.next.action);
  assert.equal(context.resume.next.memberId, context.next.memberId);
});
