import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { createRoomServer } from '../server/http.mjs';
import { readWorkItem } from '../server/work-repository.mjs';
import { linkWithProof } from './helpers/link-with-proof.mjs';
import { setTier } from '../server/autonomy-tiers.mjs';

// Viewer-scoped, through the real HTTP/MCP entry. A private request makes its
// work private to the request's parties and the members the work names.
const SECRETS = /PRIVATE-[A-Z]+-SENTINEL|acme\/private-repo|secret-branch|private-path/;

async function fixture(t, representation) {
  const store = new RoomStore(':memory:');
  store.initialize(initialRoom(), representation === 'legacy' ? {} : { representation });
  const owner = store.issueAccessKey('commons', 'owner');
  const member = (name, permissions) => { const identity = store.identities.create(name);
    linkWithProof(store, owner, 'commons', identity, { displayName: name, permissions });
    setTier(store.db, 'commons', identity.identityId, 't2_standard', { updatedBy: 'owner', nowMs: Date.now() }); return identity; };
  const producer = member('Producer', ['accept_work', 'complete_work']), reviewer = member('Reviewer', ['verify']);
  const observer = member('Unrelated member', ['accept_work', 'complete_work', 'verify']);
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const raw = async (identity, name, args = {}) => (await fetch(origin + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + identity.secret },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: { roomId: 'commons', ...args } } }) })).text();
  const call = async (identity, name, args) => { const body = JSON.parse(await raw(identity, name, args)); assert.equal(body.error, undefined, JSON.stringify(body)); assert.notEqual(body.result?.isError, true, JSON.stringify(body)); return body.result.structuredContent; };
  const command = (type, data, key = owner) => store.command(key, 'commons', { id: crypto.randomUUID(), type, data });
  const item = id => readWorkItem(store.db, 'commons', id), producerKey = store.issueAccessKey('commons', producer.identityId);
  const task = (id, title) => {
    command('work.proposed', { workItemId: id, title, definitionOfDone: title.replace('TITLE', 'DONE'), accountableMemberId: producer.identityId, mode: 'write',
      verifierMemberId: reviewer.identityId, independentVerificationRequired: true });
    command('work.accepted', { workItemId: id, expectedRevision: item(id).revision }, producerKey);
    command('claim.acquired', { workItemId: id, expectedRevision: item(id).revision, repository: id === 'secret' ? 'acme/private-repo' : 'acme/open-repo',
      ref: id === 'secret' ? 'secret-branch' : 'open-branch', paths: [id === 'secret' ? 'private-path.js' : 'open.js'], expiresAt: new Date(Date.now() + 3600000).toISOString() }, producerKey);
  };
  const submit = async id => {
    await call(producer, 'room_begin_work', { workItemId: id });
    await call(producer, 'room_post_message', { id: id + '-result', workItemId: id, body: id === 'secret' ? 'PRIVATE-RESULT-SENTINEL' : 'Open result' });
    const preview = await call(producer, 'room_read_result', { workItemId: id, draftMessageId: id + '-result' }), text = preview.result.text;
    await call(producer, 'room_submit_text_result', { workItemId: id, requestId: id + '-completion', summary: id === 'secret' ? 'PRIVATE-SUMMARY-SENTINEL' : 'Open summary', nextAction: 'Review',
      producerId: producer.identityId, evidenceMessageId: text.messageId, evidenceMessageEventId: text.messageEventId, evidenceVersion: text.evidenceVersion, previousCompletionEventId: preview.current.completionEventId });
  };
  return { store, origin, owner, producer, reviewer, observer, raw, call, command, task, submit };
}

const READS = [
  ['room_read_work', {}], ['room_read_work', { brief: true }], ['room_read_work', { includeSource: true }],
  ['room_read_work', { includeDiscussion: true }], ['room_read_work', { includeResult: true }], ['room_read_work', { brief: true, includeResult: true }],
  ['room_read_result', {}], ['room_read_work_discussion', {}]
];

for (const representation of ['legacy', 'normalized-current-v1']) {
test(`${representation}: selected reads of private work reach its parties and named roles, and refuse everyone else`, async t => {
  const f = await fixture(t, representation);
  f.task('secret', 'PRIVATE-TITLE-SENTINEL'); f.task('open', 'Open title');
  f.store.dmConsents.request('commons', 'owner', f.producer.identityId, 'Private brief');
  f.store.dmConsents.decide('commons', f.producer.identityId, 'owner', 'approve');
  f.command('message.posted', { messageId: 'private-question', toMemberId: f.producer.identityId, workItemId: 'secret', requestKind: 'reply', body: 'PRIVATE-BODY-SENTINEL' });
  await f.submit('secret'); await f.submit('open');
  assert.equal(f.store.privateWorkParties('commons', { workIds: ['secret'] }).get('secret')?.has(f.observer.identityId), false, 'fixture: the observer is not a party');

  // The unrelated member: every selected read is refused and carries nothing private.
  for (const [name, args] of READS) {
    const text = await f.raw(f.observer, name, { workItemId: 'secret', ...args }), body = JSON.parse(text);
    assert.ok(body.error || body.result?.isError === true, `${name} ${JSON.stringify(args)} must be refused`);
    assert.doesNotMatch(text, SECRETS, `${name} ${JSON.stringify(args)}`);
  }
  const batch = await f.raw(f.observer, 'room_read_work', { workItemIds: ['open', 'secret'] });
  assert.ok(JSON.parse(batch).error || JSON.parse(batch).result?.isError === true); assert.doesNotMatch(batch, SECRETS);
  const rest = await fetch(`${f.origin}/api/rooms/commons/work-context?workItemId=secret`, { headers: { Authorization: 'Bearer ' + f.observer.secret } });
  assert.equal(rest.status, 403); assert.doesNotMatch(await rest.text(), SECRETS);

  // Positive controls: the accountable producer (also a party) and the named reviewer (a role, not a party) keep every read.
  for (const viewer of [f.producer, f.reviewer]) {
    const full = await f.call(viewer, 'room_read_work', { workItemId: 'secret' });
    assert.equal(full.work.title, 'PRIVATE-TITLE-SENTINEL'); assert.equal(full.work.claim.repository, 'acme/private-repo');
    assert.match((await f.call(viewer, 'room_read_work', { workItemId: 'secret', brief: true })).brief, /PRIVATE-TITLE-SENTINEL/);
    assert.equal((await f.call(viewer, 'room_read_result', { workItemId: 'secret' })).result.text.body, 'PRIVATE-RESULT-SENTINEL');
    if (representation === 'legacy') await f.call(viewer, 'room_read_work_discussion', { workItemId: 'secret' });
  }
  const review = await f.call(f.reviewer, 'room_read_work', { workItemId: 'secret', brief: true, includeResult: true });
  assert.equal(review.continuation.tool, 'room_record_verification', 'the reviewer can still do the review');

  // Work without a private request is unchanged for the unrelated member.
  // In this fixture room_read_work_discussion answers 409 current_room_context_required on a normalized room for an authorized member too,
  // so discussion reads are exercised on legacy only. That is existing behavior, not part of this change.
  const served = READS.filter(([name, args]) => representation === 'legacy' || name !== 'room_read_work_discussion' && !args.includeDiscussion);
  for (const [name, args] of served) await f.call(f.observer, name, { workItemId: 'open', ...args });
  assert.equal((await f.call(f.observer, 'room_read_work', { workItemId: 'open' })).work.claim.repository, 'acme/open-repo');
});
}
