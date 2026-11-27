import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { event } from '../src/events.js';
import { textVersion } from '../server/text-results.mjs';
import { readCurrentWorkSummaryForViewer } from '../server/current-room-repository.mjs';
import { auditRecovery } from '../server/recovery.mjs';

// Journey 4, second reader: correction after a failed review, read back by
// an agent who was never a party to either submission.
//
//   worker submits result v1 -> designated verifier records a FAIL against
//   v1's exact completion -> worker resolves the blocker and submits a
//   corrected v2 -> fresh member B reads the task.
//
// Everywhere else the version binding is pinned at the command layer (see
// tests/current-work-review.test.mjs): a review recorded against one result
// version cannot satisfy another version's gate. This test pins the same
// facts as one coherent view for a non-author reader, through the real
// viewer-scoped surfaces:
//   - store.workContext: the selected read. It serves the CURRENT receipt,
//     verification and decision only — prior receipts and checks are a
//     declared omission (WORK_CONTEXT_OMISSIONS), so B reaches v1 through
//     the current receipt's own previousCompletionEventId chain.
//   - store.workResult: the exact-text result read, current or addressed by
//     completionEventId; its `current` block always names the live
//     completion, so an earlier result can never present as current.
//   - store.eventsAfter: the room audit log, where the failed review itself
//     stays visible with the version identifiers it was recorded against.
// The `next` step on the selected read is a step object (action, memberId,
// completionEventId, evidenceVersion), not an action list addressed to B:
// B's own suggestedActions stay empty because B holds no role on the item,
// and the step names the verifier and v2's exact identifiers instead.
const V1_BODY = 'First attempt result RESULT-V1-SENTINEL';
const V2_BODY = 'Corrected result RESULT-V2-SENTINEL';
const REJECTION = 'REJECTION-REASON-SENTINEL';
const CONTROL_BODY = 'Public control result PUBLIC-RESULT-SENTINEL';

// Fixture pattern copied from tests/current-work-review.test.mjs: a real
// normalized RoomStore driven only through store.command, with the item
// body read back from work_entities. Members and the third-member read
// pattern follow tests/handoff-privacy-normalized.test.mjs: `reader` is a
// room member who is neither author, verifier, decision-maker nor party.
function fixture(t) {
  const s = new RoomStore(':memory:');
  t.after(() => s.close());
  const es = initialRoom();
  for (const [id, permissions] of [['worker', ['accept_work', 'complete_work']],
      ['verifier', ['verify']], ['reader', []]])
    es.push(event({ roomId: 'commons', actorId: 'owner', type: 'member.added',
      data: { memberId: id, displayName: id, kind: 'agent', permissions } }));
  s.initialize(es, { representation: 'normalized-current-v1' });
  const keys = Object.fromEntries(['owner', 'worker', 'verifier', 'reader']
    .map(id => [id, s.issueAccessKey('commons', id)]));
  const cmd = (who, id, type, data) => s.command(keys[who], 'commons', { id, type, data });
  const item = () => JSON.parse(s.db.prepare("SELECT body FROM work_entities WHERE work_id='task'").get().body);
  cmd('owner', 'propose', 'work.proposed', { workItemId: 'task', title: 'Useful work',
    definitionOfDone: 'Saved result independently checked', accountableMemberId: 'worker',
    verifierMemberId: 'verifier', humanDecisionMakerId: 'owner',
    independentVerificationRequired: true, ownerDecisionRequired: true, mode: 'read' });
  cmd('worker', 'accept', 'work.accepted', { workItemId: 'task', expectedRevision: 0 });
  // One completion, shaped exactly like the review fixture's: a room_text
  // result message plus work.completed bound to its event and text version.
  const submit = (tag, body, previousCompletionEventId) => {
    const post = cmd('worker', `result-${tag}`, 'message.posted',
      { messageId: `result-${tag}`, body, workItemId: 'task' });
    return cmd('worker', `complete-${tag}`, 'work.completed', { workItemId: 'task',
      expectedRevision: item().revision, evidenceKind: 'room_text', evidenceMessageId: `result-${tag}`,
      evidenceMessageEventId: post.event.id, evidenceVersion: textVersion(body),
      producerId: 'worker', previousCompletionEventId, summary: `Saved ${tag}`, nextAction: 'Independent review' });
  };
  // The review command shape from current-work-review.test.mjs, recorded as
  // a FAIL: verification.recorded bound to the exact current completion.
  const rejectCurrent = (id, summary) => cmd('verifier', id, 'verification.recorded',
    { workItemId: 'task', expectedRevision: item().revision, result: 'fail',
      completionEventId: item().receipt.eventId, evidenceVersion: item().receipt.evidenceVersion,
      summary, nextAction: 'Correct the result and resubmit' });
  // Public positive control: a second item whose result B must be able to
  // read in full, so the assertions below cannot pass by everything hiding.
  cmd('owner', 'propose-control', 'work.proposed', { workItemId: 'control', title: 'Public control',
    definitionOfDone: 'Public result visible to any member', accountableMemberId: 'worker', mode: 'read',
    independentVerificationRequired: false, ownerDecisionRequired: false });
  cmd('worker', 'accept-control', 'work.accepted', { workItemId: 'control', expectedRevision: 0 });
  const controlPost = cmd('worker', 'result-control', 'message.posted',
    { messageId: 'result-control', body: CONTROL_BODY, workItemId: 'control' });
  cmd('worker', 'complete-control', 'work.completed', { workItemId: 'control', expectedRevision: 1,
    evidenceKind: 'room_text', evidenceMessageId: 'result-control', evidenceMessageEventId: controlPost.event.id,
    evidenceVersion: textVersion(CONTROL_BODY), producerId: 'worker', previousCompletionEventId: null,
    summary: 'Control saved', nextAction: 'None' });
  return { s, keys, cmd, item, submit, rejectCurrent };
}

test('fresh reader distinguishes current v2, previous v1 and the failed review bound to v1', t => {
  const f = fixture(t), { s, keys, item } = f;
  // v1 is submitted, rejected with an actionable reason, then corrected.
  const completion1 = f.submit('v1', V1_BODY, null);
  const v1 = { eventId: completion1.event.id, evidenceVersion: textVersion(V1_BODY) };
  assert.equal(item().receipt.eventId, v1.eventId);
  f.rejectCurrent('verify-fail', REJECTION);
  assert.equal(item().state, 'blocked', 'a failed review sends the work back, it does not close it');
  assert.equal(item().blocker.reason, REJECTION);
  f.cmd('worker', 'resolve', 'work.blocker_resolved',
    { workItemId: 'task', expectedRevision: item().revision, resolution: 'Corrected the result' });
  const completion2 = f.submit('v2', V2_BODY, v1.eventId);
  const v2 = { eventId: completion2.event.id, evidenceVersion: textVersion(V2_BODY) };
  assert.notEqual(v2.eventId, v1.eventId);
  assert.notEqual(v2.evidenceVersion, v1.evidenceVersion);

  // B reads the selected work. The current completion evidence is v2 and
  // is identified as current; v1 is reachable only as its predecessor.
  const context = s.workContext(keys.reader, 'commons', 'task');
  assert.equal(context.viewer.id, 'reader');
  assert.equal(context.work.state, 'completed');
  assert.equal(context.work.receipt.eventId, v2.eventId, 'current receipt is v2');
  assert.equal(context.work.receipt.evidenceVersion, v2.evidenceVersion);
  assert.equal(context.work.receipt.nativeText.previousCompletionEventId, v1.eventId,
    'the current receipt chains to v1 as the previous completion');
  // No verdict in B's view satisfies v2's gate with v1's review state: the
  // failed review is not carried onto v2, and no decision exists either.
  assert.equal(context.work.verification, null, 'v1\'s failed review does not ride onto v2');
  assert.equal(context.work.decision, null);
  // The exact next valid action is to verify v2, addressed to the verifier
  // and bound to v2's identifiers — not "approve", not "resubmit".
  assert.equal(context.next.action, 'verify');
  assert.equal(context.next.memberId, 'verifier');
  assert.equal(context.next.completionEventId, v2.eventId);
  assert.equal(context.next.evidenceVersion, v2.evidenceVersion);
  assert.equal(context.next.addressedToViewer, false, 'the step is the verifier\'s, and B can see that');
  assert.deepEqual(context.suggestedActions, [], 'B holds no role, so B is offered no action');
  // The verifier's own read of the same state addresses the step to them.
  const verifierContext = s.workContext(keys.verifier, 'commons', 'task');
  assert.equal(verifierContext.next.action, 'verify');
  assert.equal(verifierContext.next.addressedToViewer, true);
  assert.deepEqual(verifierContext.suggestedActions.map(a => a.action), ['verify']);
  // The list/summary surface B would scan first agrees with the selected read.
  const summary = readCurrentWorkSummaryForViewer(s.db, 'commons', 'task', 'reader');
  assert.equal(summary.receipt.eventId, v2.eventId);
  assert.equal(summary.receipt.evidenceVersion, v2.evidenceVersion);
  assert.equal(summary.verification, null);

  // B reads the exact results. The unaddressed read is the current one:
  // v2's text, with the read's own current pointer naming v2.
  const current = s.workResult(keys.reader, 'commons', 'task');
  assert.equal(current.result.text.body, V2_BODY);
  assert.equal(current.result.receipt.eventId, v2.eventId);
  assert.equal(current.current.completionEventId, v2.eventId, 'the read identifies v2 as current');
  // Addressed by v1's completion (found through the chain above), the same
  // read returns v1's text as an earlier result: its receipt is v1's while
  // the read's current pointer still names v2, so v1 is never current.
  const previous = s.workResult(keys.reader, 'commons', 'task', { completionEventId: v1.eventId });
  assert.equal(previous.result.text.body, V1_BODY);
  assert.equal(previous.result.receipt.eventId, v1.eventId);
  assert.equal(previous.result.receipt.evidenceVersion, v1.evidenceVersion);
  assert.equal(previous.result.receipt.nativeText.previousCompletionEventId, null, 'v1 is the first result');
  assert.equal(previous.current.completionEventId, v2.eventId, 'v1 reads as previous, never as current');
  assert.notEqual(previous.current.completionEventId, previous.result.receipt.eventId);

  // The failed review itself stays visible to B in the room audit log,
  // carrying the rejection reason and bound to v1's version identifiers —
  // the verifier's member id next to v1's completion, and nowhere near v2.
  const audit = s.eventsAfter(keys.reader, 'commons', 0, 100, null, { types: ['verification.recorded'] });
  const reviews = audit.events.map(({ event }) => event).filter(e => e.data.workItemId === 'task');
  assert.equal(reviews.length, 1, 'exactly one review exists so far, and B can see it');
  const [review] = reviews;
  assert.equal(review.actorId, 'verifier');
  assert.equal(review.data.result, 'fail');
  assert.equal(review.data.summary, REJECTION);
  assert.equal(review.data.completionEventId, v1.eventId, 'the failed review binds to v1');
  assert.equal(review.data.evidenceVersion, v1.evidenceVersion);
  assert.notEqual(review.data.completionEventId, v2.eventId, 'the failed review does not bind to v2');
  assert.notEqual(review.data.evidenceVersion, v2.evidenceVersion);

  assert.doesNotThrow(() => auditRecovery(s));
});

test('positive control: an unrelated public result reads back in full for the fresh reader', t => {
  const f = fixture(t), { s, keys } = f;
  const context = s.workContext(keys.reader, 'commons', 'control');
  assert.equal(context.work.state, 'completed');
  assert.ok(context.work.receipt.eventId);
  const read = s.workResult(keys.reader, 'commons', 'control');
  assert.equal(read.result.text.body, CONTROL_BODY);
  assert.equal(read.current.completionEventId, read.result.receipt.eventId,
    'the control result is current for its own item');
});
