import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { createRoomServer } from '../server/http.mjs';
import { linkWithProof } from './helpers/link-with-proof.mjs';
import { setTier } from '../server/autonomy-tiers.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isCurrentRoom } from '../server/current-room-repository.mjs';

for (const representation of ['legacy', 'normalized-current-v1']) {
test(`${representation}: default catalog supports task pickup, correction, exact review and owner acceptance`, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'room-core-continuation-'));
  const database = join(directory, 'room.sqlite');
  let store = new RoomStore(database);
  store.initialize(initialRoom(), representation === 'legacy' ? {} : { representation });
  assert.equal(isCurrentRoom(store.db, 'commons'), representation === 'normalized-current-v1');
  const owner = store.issueAccessKey('commons', 'owner');
  const producer = store.identities.create('Producer');
  const reviewer = store.identities.create('Reviewer');
  for (const [identity, permissions] of [[producer, ['accept_work', 'complete_work']], [reviewer, ['verify']]]) {
    linkWithProof(store, owner, 'commons', identity, { displayName: identity === producer ? 'Producer' : 'Reviewer', permissions });
    setTier(store.db, 'commons', identity.identityId, 't2_standard', { updatedBy: 'owner', nowMs: Date.now() });
  }
  let server, origin;
  const start = async () => {
    server = createRoomServer({ store });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
  };
  const stop = async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); store.close();
  };
  await start();
  t.after(async () => {
    await stop(); rmSync(directory, { recursive: true, force: true });
  });
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
  const attention = async (identity, expected) => {
    const state = await call(identity, 'room_project_state');
    assert.equal(state.work.complete, true);
    assert.deepEqual(state.needsYou.filter(row => row.id === workItemId).map(row => row.next), expected);
    return state;
  };
  const ownerAttention = async expected => {
    const response = await fetch(origin + '/api/rooms/commons/state', { headers: { Authorization: 'Bearer ' + owner } });
    assert.equal(response.status, 200);
    const state = await response.json();
    assert.deepEqual(state.needsYou.filter(row => row.id === workItemId).map(row => row.next), expected);
  };
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
  const initialBrief = await call(producer, 'room_read_work', { workItemId, brief: true });
  const repeatedBrief = await call(producer, 'room_read_work', { workItemId, brief: true, knownBriefVersion: initialBrief.briefVersion });
  assert.equal(repeatedBrief.briefUnchanged, true);
  assert.equal(Object.hasOwn(repeatedBrief, 'brief'), false);
  assert.deepEqual(repeatedBrief.continuation, initialBrief.continuation);
  assert.ok(JSON.stringify(repeatedBrief).length < JSON.stringify(initialBrief).length * 0.5, 'unchanged reads omit repeated context');
  console.log('known-brief-fixture', JSON.stringify({fullBytes:Buffer.byteLength(JSON.stringify(initialBrief)),repeatBytes:Buffer.byteLength(JSON.stringify(repeatedBrief)),measurement:'structured response bytes, synthetic fixture'}));
  const otherViewer = await call(reviewer, 'room_read_work', { workItemId, brief: true, knownBriefVersion: initialBrief.briefVersion });
  assert.equal(otherViewer.briefUnchanged, undefined, 'versions are bound to the current identity scope');
  assert.equal(typeof otherViewer.brief, 'string');
  for (const options of [{brief:false}, {includeResult:true}, {includeDiscussion:true}, {knownBriefVersion:'bad'}]) {
    const refused = await invoke(producer, 'room_read_work', {workItemId, brief:true, knownBriefVersion:initialBrief.briefVersion, ...options});
    assert.ok(refused.error || refused.result?.isError, 'incompatible known-brief input is refused');
  }
  command('charter-change', 'room.charter_updated', {expectedRevision:0, purpose:'One useful contribution', outputs:'An exact reviewed result', boundaries:'Keep current access checks', escalation:'Report blockers'});
  const changedContext = await call(producer, 'room_read_work', {workItemId,brief:true,knownBriefVersion:initialBrief.briefVersion});
  assert.equal(changedContext.revision, initialBrief.revision, 'room instructions can change without work revision changing');
  assert.notEqual(changedContext.briefVersion, initialBrief.briefVersion);
  assert.equal(typeof changedContext.brief, 'string');
  const pickup = changedContext.continuation;
  assert.equal(pickup.tool, 'room_begin_work');
  assert.deepEqual(pickup.inputRequired, []);
  await call(producer, pickup.tool, pickup.arguments);
  assert.equal((await read()).work.state, 'working');
  assert.equal((await call(producer, 'room_read_work', { workItemId, brief: true })).continuation.tool, null,
    'Room working state must not invent or execute host work');
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
  await attention(reviewer, ['verify']);
  await attention(producer, []);
  await ownerAttention([]);
  const reviewRead = (await call(reviewer, 'room_read_work', { workItemId, brief: true })).continuation;
  assert.equal(reviewRead.tool, 'room_read_work');
  assert.equal(reviewRead.arguments.includeResult, true, 'review hint first fetches exact evidence');
  const prepared = await call(reviewer, reviewRead.tool, reviewRead.arguments);
  assert.equal(prepared.continuation.tool, 'room_record_verification');
  assert.deepEqual(prepared.continuation.inputRequired, ['result', 'summary']);
  assert.equal(prepared.continuation.arguments.evidenceVersion, first.exact.result.text.evidenceVersion);
  assert.equal(Object.hasOwn(prepared.continuation.arguments, 'result'), false, 'read must not invent a verdict');
  const verify = (exact, result, summary) => call(reviewer, 'room_record_verification', {
    workItemId, result, completionEventId: exact.result.receipt.eventId,
    evidenceVersion: exact.result.text.evidenceVersion, summary, nextAction: 'Include a reconnect check',
  });
  const selfReview = await invoke(producer, 'room_record_verification', {
    workItemId, result: 'pass', completionEventId: first.exact.result.receipt.eventId,
    evidenceVersion: first.exact.result.text.evidenceVersion, summary: 'Self review must fail',
  });
  assert.ok(selfReview.error || selfReview.result?.isError);
  await call(reviewer, prepared.continuation.tool, { ...prepared.continuation.arguments,
    result: 'fail', summary: 'Missing the required reconnect check', nextAction: 'Include a reconnect check' });
  assert.equal((await read()).work.state, 'blocked');
  await attention(producer, ['revise']);
  await attention(reviewer, []);
  await stop(); store = new RoomStore(database); await start();
  const resumed = await call(producer, 'room_read_work', { workItemId, brief: true });
  assert.match(resumed.brief, /Missing the required reconnect check/);
  assert.equal(resumed.continuation.tool, 'room_resolve_blocker');
  assert.deepEqual(resumed.continuation.inputRequired, ['resolution']);
  await call(producer, resumed.continuation.tool, { ...resumed.continuation.arguments,
    resolution: 'Add reconnect and duplicate-result checks' });
  await call(producer, 'room_begin_work', { workItemId });
  const revised = await submit('revised-draft', 'Reconnect the existing agent, select one bounded task, and verify its exact saved result appears once.');
  await verify(first.exact, 'pass', 'Old evidence cannot approve the revised result');
  assert.equal((await read()).work.verification, null);
  await attention(reviewer, ['verify']);
  await verify(revised.exact, 'pass', 'Exact revised text includes the reconnect check');
  assert.equal((await read()).next.action, 'decide');
  assert.equal((await read()).work.decision, null, 'review must not impersonate owner acceptance');
  await attention(reviewer, []);
  await ownerAttention(['decide']);
  command('owner-rationale', 'message.posted', { messageId: 'owner-rationale', body: 'Accepted the exact revised result.' });
  command('owner-accept', 'owner.decision_recorded', { workItemId, expectedRevision: (await read()).work.revision,
    decision: 'approved', completionEventId: revised.exact.result.receipt.eventId,
    evidenceVersion: revised.exact.result.text.evidenceVersion, reason: 'Accepted the exact revised result.', sourceMessageId: 'owner-rationale' });
  assert.equal((await read()).work.decision.decision, 'approved');
  await attention(producer, []);
  await attention(reviewer, []);
  await ownerAttention([]);
  const before = store.headSequence('commons');
  assert.equal((await call(producer, 'room_submit_text_result', revised.input)).duplicate, true);
  assert.equal(store.headSequence('commons'), before, 'reconnect retry must not duplicate completion');
  const finalBrief = await call(producer, 'room_read_work', {workItemId,brief:true});
  const member = store.authenticate(producer.secret, 'commons').member;
  command('revoke-after-completion','member.access_changed',{memberId:producer.identityId,expectedMemberRevision:member.revision,permissions:[],active:false});
  const revokedRead = await invoke(producer,'room_read_work',{workItemId,brief:true,knownBriefVersion:finalBrief.briefVersion});
  assert.ok(revokedRead.error || revokedRead.result?.isError, 'known content never bypasses fresh membership checks');
});
}
