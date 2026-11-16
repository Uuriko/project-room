import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { createRoomServer } from '../server/http.mjs';
import { linkWithProof } from './helpers/link-with-proof.mjs';
import { setTier } from '../server/autonomy-tiers.mjs';
import { previousResultRecord } from '../server/work-context.mjs';

// Agent A corrects a result; Agent B arrives to review or decide. Everything
// below is read through the same MCP tools and default catalog an agent uses.
for (const representation of ['legacy', 'normalized-current-v1']) {
  async function fixture(t) {
    const directory = mkdtempSync(join(tmpdir(), 'room-corrected-result-'));
    const store = new RoomStore(join(directory, 'room.sqlite'));
    store.initialize(initialRoom(), representation === 'legacy' ? {} : { representation });
    const owner = store.issueAccessKey('commons', 'owner');
    const producer = store.identities.create('Producer');
    const reviewer = store.identities.create('Reviewer');
    for (const [identity, permissions] of [[producer, ['accept_work', 'complete_work']], [reviewer, ['verify']]]) {
      linkWithProof(store, owner, 'commons', identity, { displayName: identity === producer ? 'Producer' : 'Reviewer', permissions });
      setTier(store.db, 'commons', identity.identityId, 't2_standard', { updatedBy: 'owner', nowMs: Date.now() });
    }
    const server = createRoomServer({ store });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    t.after(async () => {
      server.closeStreams(); server.closeAllConnections();
      await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true });
    });
    // Test identities are created per run by the store; nothing here is a fixed value.
    const credentialOf = identity => identity.secret;
    const call = async (identity, name, args = {}) => {
      const response = await fetch(origin + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + credentialOf(identity) },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: { roomId: 'commons', ...args } } }) });
      const body = await response.json();
      assert.equal(body.error, undefined, JSON.stringify(body));
      assert.notEqual(body.result?.isError, true, JSON.stringify(body));
      return body.result.structuredContent;
    };
    const command = (id, type, data) => store.command(owner, 'commons', { id, type, data });
    const workItemId = 'corrected-result';
    command('propose', 'work.proposed', { workItemId, title: 'Document the reconnect path', definitionOfDone: 'Reconnect and duplicate-result checks',
      accountableMemberId: producer.identityId, mode: 'read', verifierMemberId: reviewer.identityId,
      independentVerificationRequired: true, ownerDecisionRequired: true, humanDecisionMakerId: 'owner' });
    await call(producer, 'room_begin_work', { workItemId });
    const submit = async (id, text) => {
      await call(producer, 'room_post_message', { id, workItemId, body: text });
      const preview = await call(producer, 'room_read_result', { workItemId, draftMessageId: id });
      const evidence = preview.result.text;
      await call(producer, 'room_submit_text_result', { workItemId, requestId: id + '-submit', summary: 'Result ' + id, nextAction: 'Review exact result',
        producerId: producer.identityId, evidenceMessageId: evidence.messageId, evidenceMessageEventId: evidence.messageEventId,
        evidenceVersion: evidence.evidenceVersion, previousCompletionEventId: preview.current.completionEventId });
      return call(reviewer, 'room_read_result', { workItemId });
    };
    const verify = (exact, result, summary) => call(reviewer, 'room_record_verification', { workItemId, result, summary,
      completionEventId: exact.result.receipt.eventId, evidenceVersion: exact.result.text.evidenceVersion, nextAction: 'Address the finding' });
    const revision = async () => (await call(producer, 'room_read_work', { workItemId })).work.revision;
    return { store, producer, reviewer, call, command, workItemId, submit, verify, revision };
  }

  test(`${representation}: a reviewer of a corrected result is told what the earlier review found and that it does not apply`, async t => {
    const f = await fixture(t);
    const first = await f.submit('first', 'First draft without the reconnect check.');
    const firstRead = await f.call(f.reviewer, 'room_read_work', { workItemId: f.workItemId, brief: true, includeResult: true });
    assert.equal(firstRead.review.previous, null, 'a first result has no earlier result');
    await f.verify(first, 'fail', 'Missing the required reconnect check');
    const blocked = await f.call(f.producer, 'room_read_work', { workItemId: f.workItemId, brief: true });
    await f.call(f.producer, 'room_resolve_blocker', { workItemId: f.workItemId, expectedRevision: blocked.revision, resolution: 'Added reconnect check' });
    await f.call(f.producer, 'room_begin_work', { workItemId: f.workItemId });
    const second = await f.submit('second', 'Second draft with the reconnect check added.');

    const read = await f.call(f.reviewer, 'room_read_work', { workItemId: f.workItemId, brief: true, includeResult: true });
    assert.equal(read.continuation.tool, 'room_record_verification');
    assert.equal(read.continuation.arguments.completionEventId, second.result.receipt.eventId, 'the action names the current result, not the earlier one');
    const previous = read.review.previous;
    assert.ok(previous, 'the reviewer is told this result follows an earlier one');
    assert.equal(previous.completionEventId, first.result.receipt.eventId);
    assert.equal(previous.evidenceVersion, first.result.text.evidenceVersion);
    assert.equal(previous.review.result, 'fail');
    assert.equal(previous.review.summary, 'Missing the required reconnect check');
    assert.equal(previous.review.verifierId, f.reviewer.identityId);
    assert.equal(previous.decision, null);
    assert.equal(previous.appliesToCurrentResult, false);
    assert.match(read.brief, /Earlier result[^\n]*review: fail[^\n]*Missing the required reconnect check/);
    assert.match(read.brief, /applies to the current result/);

    const full = await f.call(f.reviewer, 'room_read_work', { workItemId: f.workItemId });
    assert.deepEqual(full.previousResult, previous);
    assert.equal(full.work.verification, null, 'the earlier verdict is not current authority');
    assert.ok(Buffer.byteLength(JSON.stringify(previous)) < 1500, 'bounded to one earlier result');
    // The producer and an unrelated reader see the same authoritative fact.
    const producerRead = await f.call(f.producer, 'room_read_work', { workItemId: f.workItemId });
    assert.equal(producerRead.previousResult.review.result, 'fail');
    assert.equal(producerRead.previousResult.review.untrusted, true, "another member's review text is marked as data");
    assert.equal(full.previousResult.review.untrusted, undefined, 'a reader\'s own review is not marked');
    const before = f.store.headSequence('commons');
    await f.call(f.reviewer, 'room_read_work', { workItemId: f.workItemId, brief: true, includeResult: true });
    assert.equal(f.store.headSequence('commons'), before, 'reading writes nothing');
  });

  test(`${representation}: a decision-maker of a result corrected after approval sees the earlier decision and review, not a transferred approval`, async t => {
    const f = await fixture(t);
    const first = await f.submit('first', 'Approved draft.');
    await f.verify(first, 'pass', 'Checks out');
    f.command('owner-note', 'message.posted', { messageId: 'owner-note', body: 'Accepted.' });
    f.command('owner-accept', 'owner.decision_recorded', { workItemId: f.workItemId, expectedRevision: await f.revision(), decision: 'approved',
      completionEventId: first.result.receipt.eventId, evidenceVersion: first.result.text.evidenceVersion, reason: 'Accepted.', sourceMessageId: 'owner-note' });
    await f.call(f.producer, 'room_block_work', { workItemId: f.workItemId, expectedRevision: await f.revision(), reason: 'Found a regression after approval', nextAction: 'Correct it' });
    const blocked = await f.call(f.producer, 'room_read_work', { workItemId: f.workItemId, brief: true });
    await f.call(f.producer, 'room_resolve_blocker', { workItemId: f.workItemId, expectedRevision: blocked.revision, resolution: 'Fixed the regression' });
    await f.call(f.producer, 'room_begin_work', { workItemId: f.workItemId });
    const second = await f.submit('second', 'Corrected draft.');
    await f.verify(second, 'pass', 'Corrected result checks out');

    const read = await f.call(f.reviewer, 'room_read_work', { workItemId: f.workItemId });
    assert.equal(read.next.action, 'decide');
    assert.equal(read.work.decision, null, 'approval of the earlier result is not transferred');
    assert.equal(read.previousResult.completionEventId, first.result.receipt.eventId);
    assert.equal(read.previousResult.decision.decision, 'approved');
    assert.equal(read.previousResult.decision.reason, 'Accepted.');
    assert.equal(read.previousResult.review.result, 'pass');
    assert.equal(read.previousResult.appliesToCurrentResult, false);
    // A third result replaces the second: only the immediate predecessor is carried.
    await f.call(f.producer, 'room_block_work', { workItemId: f.workItemId, expectedRevision: await f.revision(), reason: 'Another finding', nextAction: 'Correct again' });
    const again = await f.call(f.producer, 'room_read_work', { workItemId: f.workItemId, brief: true });
    await f.call(f.producer, 'room_resolve_blocker', { workItemId: f.workItemId, expectedRevision: again.revision, resolution: 'Fixed again' });
    await f.call(f.producer, 'room_begin_work', { workItemId: f.workItemId });
    const third = await f.submit('third', 'Third draft.');
    const chained = await f.call(f.reviewer, 'room_read_work', { workItemId: f.workItemId });
    assert.equal(chained.previousResult.completionEventId, second.result.receipt.eventId);
    assert.notEqual(chained.previousResult.completionEventId, first.result.receipt.eventId, 'older results stay omitted');
    assert.equal(chained.previousResult.review.result, 'pass');
    assert.equal(chained.previousResult.decision, null, 'no decision was recorded for the second result');
    assert.notEqual(third.result.receipt.eventId, second.result.receipt.eventId);
  });
}

test('previousResultRecord reports absent, retired, late and long records without inventing any', () => {
  const receipt = (eventId, evidenceVersion) => ({ eventId, evidenceVersion });
  assert.equal(previousResultRecord({ receipt: receipt('e1', 'v1'), receiptHistory: [] }), null, 'first result');
  assert.equal(previousResultRecord({ receipt: null, receiptHistory: [receipt('e0', 'v0')] }), null, 'no current result to compare');
  const long = 'x'.repeat(2000);
  const record = previousResultRecord({ receipt: receipt('e2', 'v2'), receiptHistory: [receipt('e0', 'v0'), receipt('e1', 'v1')],
    verificationHistory: [{ completionEventId: 'e0', evidenceVersion: 'v0', result: 'fail', summary: 'older', verifierId: 'r', eventId: 'x0' },
      { completionEventId: 'e1', evidenceVersion: 'v1', result: 'pass', summary: long, verifierId: 'r', eventId: 'x1', historical: true },
      { completionEventId: 'e1', evidenceVersion: 'other', result: 'fail', summary: 'wrong version', verifierId: 'r', eventId: 'x2' }],
    decisionHistory: [{ completionEventId: 'e1', evidenceVersion: 'v1', decision: 'approved', actorId: 'o', eventId: 'd1', reason: 'ok' },
      { completionEventId: 'e1', evidenceVersion: 'v1', decision: 'approved', actorId: 'o', eventId: 'd1', reason: 'ok', historical: true, invalidatedReason: 'verification_failed' }] }, 'viewer');
  assert.equal(record.completionEventId, 'e1');
  assert.equal(record.review.eventId, 'x1', 'only the review of that exact result and version');
  assert.equal(record.review.summary.length, 600);
  assert.equal(record.review.summaryTruncated, true);
  assert.equal(record.review.recordedAfterReplacement, true);
  assert.equal(record.decision.retiredBecause, 'verification_failed');
  assert.equal(record.appliesToCurrentResult, false);
  const bare = previousResultRecord({ receipt: receipt('e2', 'v2'), receiptHistory: [receipt('e1', 'v1')], verificationHistory: [], decisionHistory: [] });
  assert.equal(bare.review, null);
  assert.equal(bare.decision, null);
});
