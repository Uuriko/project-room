import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { event } from '../src/events.js';
import { textVersion } from '../server/text-results.mjs';

// Successor continuity: what a fresh agent B can correctly do next after
// agent A contributed, read only through the selected read (store.workContext)
// and the exact-result read (store.workResult) — no transcript, no message
// from A. Fixture pattern copied from tests/agent-continuity-correction.test.mjs:
// a real normalized RoomStore driven only through store.command.
//
// Journey E (dependency-blocked next step), in two halves:
//   (a) presentation — while prerequisite `task` is unfinished, B's accepted
//       `next-task` must not be offered the start that admission refuses with
//       work_claim_dependencies_unmet; the step itself must name the wait and
//       the unsatisfied dependency, the way server/project-state.mjs already
//       presents the same fact (next: "wait_prerequisites", waitingOn).
//   (b) release — once `task` completes and passes its own gates (independent
//       verification + owner decision, mirroring how
//       tests/canonical-work-dependencies.test.js satisfies a prerequisite),
//       a fresh read of the unedited dependent offers start again.
// Journey 6 pin (interruption with no handoff record):
//   (c) A accepts, starts, posts one linked progress message and stops. B's
//       read must keep the honest facts that hold today: the item is working,
//       A is still accountable, nothing is completed (receipt null, result
//       kind "none"), and no handoff exists. The packet's status/displayStatus
//       fields are deliberately NOT asserted (they contradict state; that is
//       documented separately), and neither is progress-text visibility.
const TASK_RESULT = 'Exact saved result RESULT-TASK-SENTINEL';
const CONTROL_BODY = 'Public control result PUBLIC-RESULT-SENTINEL';
const PROGRESS_BODY = 'PROGRESS-SENTINEL parser stage done, writer stage not started';

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
  // `task`: A's work, with the full gate — independent verification and an
  // owner decision are both required before a dependent may treat it as done.
  const proposeTask = () => cmd('owner', 'propose-task', 'work.proposed', { workItemId: 'task',
    title: 'TASK-TITLE-SENTINEL', definitionOfDone: 'DOD-TASK-SENTINEL', accountableMemberId: 'worker',
    verifierMemberId: 'verifier', humanDecisionMakerId: 'owner',
    independentVerificationRequired: true, ownerDecisionRequired: true, mode: 'read' });
  // `next-task`: B's work, gated on `task` through the native dependsOn mechanism.
  const proposeNext = () => cmd('owner', 'propose-next', 'work.proposed', { workItemId: 'next-task',
    title: 'Next task', definitionOfDone: 'DOD-NEXT-SENTINEL', accountableMemberId: 'successor',
    mode: 'read', dependsOn: ['task'], independentVerificationRequired: false, ownerDecisionRequired: false });
  const accept = (who, id) => cmd(who, `accept-${id}`, 'work.accepted',
    { workItemId: id, expectedRevision: item(id).revision });
  const start = (who, id) => cmd(who, `start-${id}`, 'work.started',
    { workItemId: id, expectedRevision: item(id).revision });
  // A's completion of `task`, shaped like the correction fixture's submit:
  // a room_text result message plus work.completed bound to it.
  const completeTask = () => {
    const post = cmd('worker', 'result-task', 'message.posted',
      { messageId: 'result-task', body: TASK_RESULT, workItemId: 'task' });
    return cmd('worker', 'complete-task', 'work.completed', { workItemId: 'task',
      expectedRevision: item('task').revision, evidenceKind: 'room_text', evidenceMessageId: 'result-task',
      evidenceMessageEventId: post.event.id, evidenceVersion: textVersion(TASK_RESULT),
      producerId: 'worker', previousCompletionEventId: null, summary: 'Saved', nextAction: 'Independent review' });
  };
  // The prerequisite's own gates, in order: verifier pass on the exact
  // completion, then the owner's approval decision bound to the same receipt.
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
  return { s, keys, cmd, item, proposeTask, proposeNext, accept, start, completeTask, satisfyTaskGates };
}

test('Journey E (blocked): the selected read does not offer the start admission refuses', t => {
  const f = fixture(t), { s, keys } = f;
  f.proposeTask();
  f.accept('worker', 'task');
  f.start('worker', 'task');
  f.proposeNext();
  f.accept('successor', 'next-task');

  const context = s.workContext(keys.successor, 'commons', 'next-task');
  // The packet's own data half already tells the truth.
  assert.deepEqual(context.dependencies, [{ id: 'task', state: 'in_progress', satisfied: false }]);
  // The step is addressed to B — which is exactly why offering start is harmful.
  assert.equal(context.next.memberId, 'successor');
  assert.equal(context.next.addressedToViewer, true);
  // The action presentation must agree with the data: no start on offer,
  // and the step itself names the wait and the unsatisfied dependency.
  assert.notEqual(context.next.action, 'start',
    'a dependency-blocked item must not present start as the next action');
  assert.equal(context.next.action, 'wait_prerequisites');
  assert.deepEqual(context.next.waitingOn, [{ id: 'task', state: 'in_progress' }],
    'the step names the unsatisfied dependency as the reason');
  assert.ok(!context.suggestedActions.some(entry => entry.action === 'start'),
    'suggestedActions must not include the refused start');
  // Admission is unchanged by presentation: attempting the start still
  // refuses with the dependency code and writes nothing.
  const before = s.headSequence('commons');
  assert.throws(() => f.start('successor', 'next-task'),
    error => error.code === 'work_claim_dependencies_unmet');
  assert.equal(s.headSequence('commons'), before);
  assert.equal(f.item('next-task').state, 'accepted');
});

test('Journey E (release): satisfying the prerequisite gate releases the dependent on a fresh read', t => {
  const f = fixture(t), { s, keys } = f;
  f.proposeTask();
  f.accept('worker', 'task');
  f.start('worker', 'task');
  f.proposeNext();
  f.accept('successor', 'next-task');
  const dependentRevision = f.item('next-task').revision;

  // A finishes `task` and the prerequisite passes its own gates. Nobody
  // edits `next-task` in between.
  const completion = f.completeTask();
  f.satisfyTaskGates(completion);
  assert.equal(f.item('next-task').revision, dependentRevision,
    'the release does not mutate the dependent item');

  const context = s.workContext(keys.successor, 'commons', 'next-task');
  assert.deepEqual(context.dependencies, [{ id: 'task', state: 'done', satisfied: true }]);
  assert.equal(context.next.action, 'start', 'a fresh read offers the released start');
  assert.equal(context.next.memberId, 'successor');
  assert.ok(context.suggestedActions.some(entry => entry.action === 'start'),
    'suggestedActions include the released start');
  assert.equal(context.next.waitingOn, undefined, 'nothing is waited on once the gate passes');
  // The offered start is real: B can take it.
  f.start('successor', 'next-task');
  assert.equal(f.item('next-task').state, 'working');
});

test('Journey 6 pin: a stopped worker with no handoff reads back honestly to a fresh successor', t => {
  const f = fixture(t), { s, keys } = f;
  f.proposeTask();
  f.accept('worker', 'task');
  f.start('worker', 'task');
  // A's only in-progress signal: an ordinary message linked to the item.
  // Then A stops — no result, no blocker, no handoff.
  f.cmd('worker', 'progress-1', 'message.posted',
    { messageId: 'progress-1', body: PROGRESS_BODY, workItemId: 'task' });
  // Public positive control: a second item whose completed result B must be
  // able to read in full, so the assertions below cannot pass by hiding.
  f.cmd('owner', 'propose-control', 'work.proposed', { workItemId: 'control', title: 'Public control',
    definitionOfDone: 'Public result visible to any member', accountableMemberId: 'worker', mode: 'read',
    independentVerificationRequired: false, ownerDecisionRequired: false });
  f.accept('worker', 'control');
  const controlPost = f.cmd('worker', 'result-control', 'message.posted',
    { messageId: 'result-control', body: CONTROL_BODY, workItemId: 'control' });
  f.cmd('worker', 'complete-control', 'work.completed', { workItemId: 'control',
    expectedRevision: f.item('control').revision, evidenceKind: 'room_text', evidenceMessageId: 'result-control',
    evidenceMessageEventId: controlPost.event.id, evidenceVersion: textVersion(CONTROL_BODY),
    producerId: 'worker', previousCompletionEventId: null, summary: 'Control saved', nextAction: 'None' });

  // B arrives fresh and reads the stopped item.
  const context = s.workContext(keys.successor, 'commons', 'task');
  assert.equal(context.work.state, 'working');
  assert.equal(context.work.accountableMemberId, 'worker', 'A is still the accountable member');
  assert.equal(context.work.receipt, null, 'nothing is completed, and the read says so');
  assert.equal(context.work.handoff, null, 'no handoff was recorded, and the read says so');
  const result = s.workResult(keys.successor, 'commons', 'task');
  assert.equal(result.result.kind, 'none', 'the exact-result read is explicitly empty, never a stale result');
  assert.equal(result.current.completionEventId, null);

  // The control reads back in full for the same fresh reader.
  const control = s.workContext(keys.successor, 'commons', 'control');
  assert.equal(control.work.state, 'completed');
  assert.ok(control.work.receipt.eventId);
  assert.equal(s.workResult(keys.successor, 'commons', 'control').result.text.body, CONTROL_BODY);
});
