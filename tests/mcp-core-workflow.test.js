import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { createRoomServer } from '../server/http.mjs';
import { linkWithProof } from './helpers/link-with-proof.mjs';
import { setTier } from '../server/autonomy-tiers.mjs';

test('default catalog supports task pickup, correction, exact review and owner acceptance', async t => {
  const store = new RoomStore(':memory:');
  store.initialize(initialRoom());
  const owner = store.issueAccessKey('commons', 'owner');
  const producer = store.identities.create('Producer');
  const reviewer = store.identities.create('Reviewer');
  for (const [identity, permissions] of [[producer, ['accept_work', 'complete_work']], [reviewer, ['verify']]]) {
    linkWithProof(store, owner, 'commons', identity, { displayName: identity === producer ? 'Producer' : 'Reviewer', permissions });
    setTier(store.db, 'commons', identity.identityId, 't2_standard', { updatedBy: 'owner', nowMs: Date.now() });
  }
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); store.close();
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const rpc = async (identity, method, params) => {
    const response = await fetch(origin + '/mcp', { method: 'POST', headers: {
      'Content-Type': 'application/json', Authorization: 'Bearer ' + identity.secret,
    }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    assert.equal(response.status, 200);
    return response.json();
  };
  const catalogs = new Map();
  for (const identity of [producer, reviewer]) {
    const listed = await rpc(identity, 'tools/list');
    assert.equal(listed.result.profile, 'core');
    catalogs.set(identity, new Set(listed.result.tools.map(tool => tool.name)));
  }
  const invoke = (identity, name, args = {}) => {
    assert.ok(catalogs.get(identity).has(name), `${name} must be discoverable without profile switching`);
    return rpc(identity, 'tools/call', { name, arguments: { roomId: 'commons', ...args } });
  };
  const call = async (identity, name, args) => {
    const body = await invoke(identity, name, args);
    assert.equal(body.error, undefined, JSON.stringify(body));
    assert.notEqual(body.result?.isError, true, JSON.stringify(body));
    return body.result.structuredContent;
  };
  const workItemId = 'core-contribution';
  const command = (id, type, data) => store.command(owner, 'commons', { id, type, data });
  command('propose-core', 'work.proposed', { workItemId, title: 'Review the contribution brief',
    definitionOfDone: 'One useful next step with a reconnect check', accountableMemberId: producer.identityId,
    mode: 'read', verifierMemberId: reviewer.identityId, independentVerificationRequired: true,
    ownerDecisionRequired: true, humanDecisionMakerId: 'owner' });
  await call(producer, 'room_check_access');
  await call(producer, 'room_activation_pack', { view: 'brief' });
  assert.ok((await call(producer, 'room_list_work', { focus: 'needs_me' })).work.some(work => work.id === workItemId));
  const read = () => call(producer, 'room_read_work', { workItemId });
  assert.equal((await read()).next.action, 'accept');
  await call(producer, 'room_begin_work', { workItemId });
  assert.equal((await read()).work.state, 'working');
  const submit = async (id, text) => {
    await call(producer, 'room_post_message', { id, workItemId, body: text });
    const preview = await call(producer, 'room_read_result', { workItemId, draftMessageId: id });
    const evidence = preview.result.text;
    const input = { workItemId, requestId: id + '-submit', summary: 'Contribution brief reviewed', nextAction: 'Review exact result',
      producerId: producer.identityId, evidenceMessageId: evidence.messageId,
      evidenceMessageEventId: evidence.messageEventId, evidenceVersion: evidence.evidenceVersion,
      previousCompletionEventId: preview.current.completionEventId };
    await call(producer, 'room_submit_text_result', input);
    return { input, exact: await call(reviewer, 'room_read_result', { workItemId }) };
  };
  const first = await submit('first-draft', 'Read the shared brief and choose one bounded next step.');
  const verify = (exact, result, summary) => call(reviewer, 'room_record_verification', {
    workItemId, result, completionEventId: exact.result.receipt.eventId,
    evidenceVersion: exact.result.text.evidenceVersion, summary, nextAction: 'Include a reconnect check',
  });
  const selfReview = await invoke(producer, 'room_record_verification', {
    workItemId, result: 'pass', completionEventId: first.exact.result.receipt.eventId,
    evidenceVersion: first.exact.result.text.evidenceVersion, summary: 'Self review must fail',
  });
  assert.ok(selfReview.error || selfReview.result?.isError);
  await verify(first.exact, 'fail', 'Missing the required reconnect check');
  assert.equal((await read()).work.state, 'blocked');
  await call(producer, 'room_resolve_blocker', { workItemId, resolution: 'Add reconnect and duplicate-result checks' });
  await call(producer, 'room_begin_work', { workItemId });
  const revised = await submit('revised-draft', 'Reconnect the existing agent, select one bounded task, and verify its exact saved result appears once.');
  await verify(first.exact, 'pass', 'Old evidence cannot approve the revised result');
  assert.equal((await read()).work.verification, null);
  await verify(revised.exact, 'pass', 'Exact revised text includes the reconnect check');
  assert.equal((await read()).next.action, 'decide');
  assert.equal((await read()).work.decision, null, 'review must not impersonate owner acceptance');
  command('owner-rationale', 'message.posted', { messageId: 'owner-rationale', body: 'Accepted the exact revised result.' });
  command('owner-accept', 'owner.decision_recorded', { workItemId, expectedRevision: (await read()).work.revision,
    decision: 'approved', completionEventId: revised.exact.result.receipt.eventId,
    evidenceVersion: revised.exact.result.text.evidenceVersion, reason: 'Accepted the exact revised result.', sourceMessageId: 'owner-rationale' });
  assert.equal((await read()).work.decision.decision, 'approved');
  const before = store.room('commons').sequence;
  assert.equal((await call(producer, 'room_submit_text_result', revised.input)).duplicate, true);
  assert.equal(store.room('commons').sequence, before, 'reconnect retry must not duplicate completion');
});
