import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { createRoomServer } from '../server/http.mjs';
import { readWorkItem } from '../server/work-repository.mjs';
import { textVersion } from '../server/text-results.mjs';
import { linkWithProof } from './helpers/link-with-proof.mjs';
import { setTier } from '../server/autonomy-tiers.mjs';

// Legacy storage, the real store and the real HTTP route that serves agent
// orientation (GET /api/rooms/{id}?view=orientation) and its sibling work view.
// A distinct sentinel per retained field, so a hidden title cannot mask a
// sibling field that still carries private text.
const SENTINEL = /PRIVATE-[A-Z]+-SENTINEL|acme\/private-repo|secret-branch|private-path/g;
const found = text => [...new Set(text.match(SENTINEL) ?? [])];

async function fixture(t, representation) {
  const store = new RoomStore(':memory:');
  store.initialize(initialRoom(), representation === 'legacy' ? {} : {representation});
  const owner = store.issueAccessKey('commons', 'owner');
  const member = (name, permissions) => { const identity = store.identities.create(name);
    linkWithProof(store, owner, 'commons', identity, { displayName: name, permissions });
    setTier(store.db, 'commons', identity.identityId, 't2_standard', { updatedBy: 'owner', nowMs: Date.now() }); return identity; };
  const producer = member('Producer', ['accept_work', 'complete_work']), reviewer = member('Reviewer', ['verify']);
  // Broad permissions and a handoff addressed to them, but neither a request party nor a member the task names.
  const observer = member('Unrelated member', ['accept_work', 'complete_work', 'verify']);
  const triage = member('Handoff addressee', ['steer', 'verify', 'accept_work', 'complete_work', 'manage_claims']);
  const key = identity => store.issueAccessKey('commons', identity.identityId), send = (who, type, data) => store.command(who, 'commons', { id: crypto.randomUUID(), type, data });
  const item = id => readWorkItem(store.db, 'commons', id), pk = key(producer), rk = key(reviewer);
  const build = (id, secret) => {
    const text = name => secret ? `PRIVATE-${name}-SENTINEL` : `open ${name.toLowerCase()}`;
    send(owner, 'work.proposed', { workItemId: id, title: text('TITLE'), definitionOfDone: text('DONE'), accountableMemberId: producer.identityId, mode: 'write',
      verifierMemberId: reviewer.identityId, independentVerificationRequired: true });
    if (secret) { store.dmConsents.request('commons', 'owner', producer.identityId, 'Private brief'); store.dmConsents.decide('commons', producer.identityId, 'owner', 'approve');
      send(owner, 'message.posted', { messageId: 'private-question', toMemberId: producer.identityId, workItemId: id, requestKind: 'reply', body: 'PRIVATE-BODY-SENTINEL' }); }
    const rev = () => item(id).revision;
    send(pk, 'work.accepted', { workItemId: id, expectedRevision: rev() });
    send(pk, 'claim.acquired', { workItemId: id, expectedRevision: rev(), repository: secret ? 'acme/private-repo' : 'acme/open-repo', ref: secret ? 'secret-branch' : 'open-branch',
      paths: [secret ? 'private-path.js' : 'open.js'], expiresAt: new Date(Date.now() + 3600000).toISOString() });
    send(pk, 'work.started', { workItemId: id, expectedRevision: rev() });
    send(pk, 'work.blocked', { workItemId: id, expectedRevision: rev(), reason: text('BLOCKER'), nextAction: text('UNBLOCK') });
    // A handoff that is later closed by restarting: it must not surface from retained history either.
    send(pk, 'work.handoff_recorded', { workItemId: id, expectedRevision: rev(), doneSummary: text('HANDOFF'), nextAction: text('HANDOFFNEXT'), limitReason: text('LIMIT'), toMemberId: triage.identityId });
    send(pk, 'work.blocker_resolved', { workItemId: id, expectedRevision: rev(), resolution: text('RESOLUTION') });
    send(pk, 'work.started', { workItemId: id, expectedRevision: rev() });
    const body = text('RESULT'), post = send(pk, 'message.posted', { messageId: id + '-result', workItemId: id, body });
    const done = send(pk, 'work.completed', { workItemId: id, expectedRevision: rev(), evidenceKind: 'room_text', evidenceMessageId: id + '-result', evidenceMessageEventId: post.event.id,
      evidenceVersion: textVersion(body), previousCompletionEventId: null, producerId: producer.identityId, summary: text('SUMMARY'), nextAction: text('RESULTNEXT'), checksClaimed: [text('CHECK')] });
    send(rk, 'verification.recorded', { workItemId: id, expectedRevision: rev(), result: 'fail', completionEventId: done.event.id, evidenceVersion: item(id).receipt.evidenceVersion,
      summary: text('REVIEW'), nextAction: text('REVIEWNEXT') });
  };
  build('secret', true); build('open', false);
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const read = async (identity, view) => { const response = await fetch(`http://127.0.0.1:${server.address().port}/api/rooms/commons?view=${view}`, { headers: { Authorization: 'Bearer ' + identity.secret } });
    assert.equal(response.status, 200); return response.text(); };
  return { store, producer, reviewer, observer, triage, read, item };
}

for (const representation of ['legacy', 'normalized-current-v1']) for (const view of ['orientation', 'work']) {
test(`${representation} ${view} view: private work is a minimal record for members outside it, and intact for its parties and named roles`, async t => {
  const f = await fixture(t, representation);
  assert.equal(f.store.privateWorkParties('commons', {workIds:['secret']}).get('secret')?.has(f.observer.identityId), false, 'fixture: the observer is not a party');
  assert.equal(f.store.privateWorkParties('commons', {workIds:['secret']}).get('secret')?.has(f.reviewer.identityId), false, 'fixture: the reviewer is a named role, not a party');
  const stored = JSON.stringify([f.item('secret'), f.item('open')]);

  // Outside the private work: the whole serialized response carries none of its text, however broad the member's permissions,
  // and being the addressee of its handoff grants nothing.
  for (const outsider of [f.observer, f.triage]) {
    const text = await f.read(outsider, view), record = JSON.parse(text).state.workItems.secret;
    assert.deepEqual(found(text), [], `${view} for a member outside the private work`);
    // Still listed, as a minimal record: identity, state and the members the task names, no participant-written content.
    assert.equal(record.id, 'secret'); assert.equal(record.title, null); assert.equal(record.definitionOfDone, null);
    assert.equal(record.state, f.item('secret').state); assert.equal(record.accountableMemberId, f.producer.identityId); assert.equal(record.verifierMemberId, f.reviewer.identityId);
    assert.equal(record.claim.holderId, f.producer.identityId); assert.equal(Object.hasOwn(record.claim, 'repository'), false); assert.equal(Object.hasOwn(record.claim, 'paths'), false);
    assert.deepEqual(Object.keys(record.receipt).sort(), ['eventId', 'evidenceVersion', 'producerAttribution', 'producerId', 'reportedById']);
    assert.equal(Object.hasOwn(record.verification, 'summary'), false); assert.equal(record.verification.result, 'fail');
    // The closed handoff is retained on the record. Its text is gone; so is any retained history list a later revision adds.
    if (representation === 'legacy') {
      assert.equal(record.handoff.open, false); assert.equal(Object.hasOwn(record.handoff, 'doneSummary'), false); assert.equal(record.handoff.triageMemberId, f.triage.identityId);
    } else assert.equal(record.handoff, null);
    if (view === 'orientation') assert.deepEqual(record.handoffHistory ?? [], []);
    // Public work is unchanged for the same member.
    const open = JSON.parse(text).state.workItems.open;
    assert.equal(open.title, 'open title'); assert.equal(open.claim.repository, 'acme/open-repo'); assert.equal(open.receipt.summary, 'open summary'); assert.equal(open.verification.summary, 'open review');
    assert.equal(open.handoff.doneSummary, 'open handoff', 'a public closed handoff is still served');
  }

  // Positive controls: the private request's recipient, and the named reviewer who is not a party.
  for (const insider of [f.producer, f.reviewer]) {
    const record = JSON.parse(await f.read(insider, view)).state.workItems.secret;
    assert.equal(record.title, 'PRIVATE-TITLE-SENTINEL'); assert.equal(record.claim.repository, 'acme/private-repo');
    assert.equal(record.receipt.summary, 'PRIVATE-SUMMARY-SENTINEL'); assert.deepEqual(record.receipt.checksClaimed, ['PRIVATE-CHECK-SENTINEL']);
    assert.equal(record.verification.summary, 'PRIVATE-REVIEW-SENTINEL');
    assert.equal(record.handoff.doneSummary, 'PRIVATE-HANDOFF-SENTINEL', 'the retained closed handoff is intact for authorized members');
  }
  assert.equal(JSON.stringify([f.item('secret'), f.item('open')]), stored, 'reads redact a copy; stored records are unchanged');
});
}
