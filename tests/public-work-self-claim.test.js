import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { PublicWorkClaims, publicWorkClaimsSchema } from '../server/public-work-claims.mjs';
import { publicWorkClaimFenceSchema } from '../server/public-work-claim-fence.mjs';

// UT wave-2 lane 03-08 (F1, S2, executed): a poster could claim their own
// public-work task; with the poster as sole designated reviewer the resulting
// submission was permanently unreviewable (canVerify/canDecide false, verify
// and decide both 403). The bounty surface already refuses poster self-claim
// with 403 not_authorized "the poster cannot claim their own bounty"
// (lane 02-10, executed). These tests pin the same guard on the public-work
// claim path (PublicWorkClaims.apply — the serialized path REST, MCP and
// match auto-claim all funnel through), for every binding by which a global
// identity is the poster: an identity_links row, a member whose identityId
// is the claimant, or the agent-room founding member whose member id IS
// the identity id. They also pin the claim-time reviewer-independence leg:
// a claimant who is the task's ONLY designated reviewer can never verify
// their own submission, so that claim is refused when it is made.
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'public-work-self-claim-')), file = join(dir, 'room.sqlite');
  const store = new RoomStore(file, { now: () => Date.now() });
  store.initialize(initialRoom());
  store.db.exec(publicWorkClaimsSchema); store.db.exec(publicWorkClaimFenceSchema);
  const poster = store.identities.create('Poster');
  const reviewer = store.identities.create('Sole reviewer');
  const worker = store.identities.create('Worker');
  // Seat a second member in commons: a human with decide+verify standing,
  // so an offer can designate them as its only reviewer.
  const state = structuredClone(store.room('commons').state);
  state.members.reviewer = { id: 'reviewer', revision: 1, kind: 'human', active: true, displayName: 'Reviewer', permissions: ['read', 'decide', 'verify'] };
  store.db.prepare('UPDATE rooms SET projection=? WHERE id=?').run(JSON.stringify(state), 'commons');
  // Bind the poster's global identity to the owner member (the link a
  // room-creating identity gets — see server/agent-rooms.mjs) and the
  // reviewer's identity to the reviewer member.
  store.db.prepare('INSERT INTO identity_links(room_id,identity_id,member_id,linked_at) VALUES(?,?,?,?)')
    .run('commons', poster.identityId, 'owner', store.now());
  store.db.prepare('INSERT INTO identity_links(room_id,identity_id,member_id,linked_at) VALUES(?,?,?,?)')
    .run('commons', reviewer.identityId, 'reviewer', store.now());
  const service = () => new PublicWorkClaims(store);
  const enable = (id, reviewers = ['owner'], roomId = 'commons', actorId = 'owner', files = ['src/shared.js']) => {
    const input = { requestId: `create-${id}`, offerId: id, reviewerMemberIds: reviewers,
      terms: { kind: 'task', title: id, summary: 'Public result', acceptanceCriteria: ['Deliver the declared change'],
        repositoryUrl: 'https://github.com/Example/Project', reward: { kind: 'unpaid' }, approvalPolicy: { mode: 'human' } } };
    store.projectOffers.create(roomId, actorId, input);
    store.projectOffers.transition(roomId, actorId, id, 'publish', { requestId: `publish-${id}`, expectedRevision: 1 });
    return service().enable(roomId, actorId, id, { requestId: `enable-${id}`, expectedRevision: 2, expectedTermsVersion: 1, repositoryRef: 'main', files });
  };
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { store, service, poster, reviewer, worker, enable };
}
const claim = requestId => ({ requestId, expectedTermsVersion: 1 });
const isSelfClaimRefusal = error => error.status === 403 && error.code === 'not_authorized';

test('poster cannot claim their own public-work task (identity linked to the poster member); a different worker still can', t => {
  const f = fixture(t); f.enable('poster-task');
  assert.throws(() => f.service().act('poster-task', f.poster.secret, 'claim', claim('poster-claim')), isSelfClaimRefusal);
  // The refused claim moved nothing: the task is still unclaimed and a
  // different identity can take it.
  assert.equal(f.service().read('poster-task').claim.state, 'unclaimed');
  const taken = f.service().act('poster-task', f.worker.secret, 'claim', claim('worker-claim'));
  assert.equal(taken.task.claim.identityId, f.worker.identityId);
});

test('poster cannot claim their own task in an agent room, where the founding member id is the identity id', t => {
  const f = fixture(t);
  // An agent-created room: member id = identity id, member carries identityId.
  f.store.initialize(initialRoom('poster-room', f.poster.identityId));
  f.enable('agent-room-task', [f.poster.identityId], 'poster-room', f.poster.identityId);
  assert.throws(() => f.service().act('agent-room-task', f.poster.secret, 'claim', claim('poster-claim')), isSelfClaimRefusal);
  assert.equal(f.service().read('agent-room-task').claim.state, 'unclaimed');
  assert.equal(f.service().act('agent-room-task', f.worker.secret, 'claim', claim('worker-claim')).task.claim.identityId, f.worker.identityId);
});

test('the sole designated reviewer cannot claim a task only they could review; a task with another reviewer left standing can be claimed by one reviewer', t => {
  const f = fixture(t);
  f.enable('sole-reviewer-task', ['reviewer']);
  assert.throws(() => f.service().act('sole-reviewer-task', f.reviewer.secret, 'claim', claim('reviewer-claim')), isSelfClaimRefusal);
  assert.equal(f.service().read('sole-reviewer-task').claim.state, 'unclaimed');
  assert.equal(f.service().act('sole-reviewer-task', f.worker.secret, 'claim', claim('worker-claim')).task.claim.identityId, f.worker.identityId);
  // With a second designated reviewer (the owner) still able to review, a
  // reviewer claiming is not a never-verifiable configuration.
  f.enable('two-reviewer-task', ['reviewer', 'owner'], 'commons', 'owner', ['docs/two-reviewer.md']);
  assert.equal(f.service().act('two-reviewer-task', f.reviewer.secret, 'claim', claim('reviewer-claim-2')).task.claim.identityId, f.reviewer.identityId);
});
