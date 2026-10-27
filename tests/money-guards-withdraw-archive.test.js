// UT2 L7 money guards (candidate 8, EXECUTED S2 x2):
//  (i) withdrawing a project offer with a LIVE public claim used to succeed
//      silently and destroy the claim (task 404s for everyone, sponsor list
//      still showed the offer as claimable) —
//      wave-2026-10-27-user-testing-2/lanes/02-03-sponsor-manage/REPORT.md F-3.
//  (ii) archiving a room with credits locked in escrow used to succeed
//      silently, and funding + posting new bounties still succeeded
//      post-archive — lanes/02-10-sponsor-exit/REPORT.md F-3.
// Cure: refusal-with-enumeration. Withdraw with a live claim refuses 409
// offer_claim_live naming the claimant, generation, lease and reward amount,
// unless the owner passes forceWithdrawWithLiveClaim:true, in which case the
// stranded claim is enumerated on the returned (journalled) record. Archive
// with locked escrow refuses 409 room_archive_locked_escrow naming every
// affected bounty and the total. Post-archive fund/post refuse 409
// room_archived. No money moves in any of these paths.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { PublicWorkClaims, publicWorkClaimsSchema } from '../server/public-work-claims.mjs';
import { publicWorkClaimFenceSchema } from '../server/public-work-claim-fence.mjs';

const code = expected => error => error.code === expected;

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'money-guards-'));
  const file = join(dir, 'room.sqlite');
  let clock = Date.now();
  const store = new RoomStore(file, { now: () => clock });
  store.initialize(initialRoom());
  store.db.exec(publicWorkClaimsSchema); store.db.exec(publicWorkClaimFenceSchema);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { store, tick: ms => { clock += ms; } };
}

// A paid (work_trade) task settles to a room-member ledger lane, so the
// claiming identity must be linked to a member of the task room (the
// public-work-settlement fixture pattern).
const linkWorker = (store, name, memberId) => {
  const identity = store.identities.create(name);
  const state = structuredClone(store.room('commons').state);
  state.members[memberId] = { id: memberId, revision: 1, kind: 'agent', active: true, displayName: name, permissions: ['read'] };
  store.db.prepare('UPDATE rooms SET projection=? WHERE id=?').run(JSON.stringify(state), 'commons');
  store.db.prepare('INSERT INTO identity_links VALUES (?,?,?,?)').run('commons', identity.identityId, memberId, store.now());
  return identity;
};

const enablePaidTask = (store, id) => {
  const input = { requestId: `create-${id}`, offerId: id, reviewerMemberIds: ['owner'],
    terms: { kind: 'task', title: id, summary: 'Public result', acceptanceCriteria: ['Deliver the declared change'],
      repositoryUrl: 'https://github.com/Example/Project',
      reward: { kind: 'work_trade', unit: 'credit', amountMinor: '5000' }, approvalPolicy: { mode: 'human' } } };
  store.projectOffers.create('commons', 'owner', input);
  store.projectOffers.transition('commons', 'owner', id, 'publish', { requestId: `publish-${id}`, expectedRevision: 1 });
  return new PublicWorkClaims(store).enable('commons', 'owner', id,
    { requestId: `enable-${id}`, expectedRevision: 2, expectedTermsVersion: 1, repositoryRef: 'main', files: ['src/welcome.js'] });
};

test('withdraw with a live public claim refuses with enumeration; force strands the claim on the record', t => {
  const { store } = fixture(t);
  const worker = linkWorker(store, 'Guard worker', 'worker');
  enablePaidTask(store, 'guard-task');
  const service = new PublicWorkClaims(store);
  const claimed = service.act('guard-task', worker.secret, 'claim', { requestId: 'claim-1', expectedTermsVersion: 1 });
  assert.equal(claimed.task.claim.state, 'claimed');

  let refused = null;
  try {
    store.projectOffers.transition('commons', 'owner', 'guard-task', 'withdraw', { requestId: 'withdraw-1', expectedRevision: 2 });
  } catch (error) { refused = error; }
  assert.ok(refused, 'withdraw with a live claim must refuse');
  assert.equal(refused.status, 409);
  assert.equal(refused.code, 'offer_claim_live');
  // Enumeration: who holds it, which generation, until when, how much.
  assert.match(refused.message, new RegExp(worker.identityId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(refused.message, /generation 1/);
  assert.match(refused.message, /lease expires/);
  assert.match(refused.message, /5 credits/);
  // Nothing was destroyed: the offer is still published and the task claimed.
  assert.equal(store.projectOffers.read('guard-task').status, 'published');
  assert.equal(service.read('guard-task').claim.state, 'claimed');
  assert.equal(service.read('guard-task').claim.identityId, worker.identityId);

  // Explicit force: withdraw proceeds and the stranded claim is on the record.
  const forced = store.projectOffers.transition('commons', 'owner', 'guard-task', 'withdraw',
    { requestId: 'withdraw-2', expectedRevision: 2, forceWithdrawWithLiveClaim: true });
  assert.equal(forced.status, 'withdrawn');
  assert.equal(forced.strandedLiveClaim.claimant, worker.identityId);
  assert.equal(forced.strandedLiveClaim.generation, 1);
  assert.equal(forced.strandedLiveClaim.amountCredits, 5);
  assert.ok(forced.strandedLiveClaim.leaseExpiresAt);
});

test('withdraw with only an expired claim, or no claim, still works without force', t => {
  const { store, tick } = fixture(t);
  const worker = linkWorker(store, 'Expiry worker', 'worker');
  enablePaidTask(store, 'expiry-task');
  const service = new PublicWorkClaims(store);
  service.act('expiry-task', worker.secret, 'claim', { requestId: 'claim-x', expectedTermsVersion: 1, leaseHours: 1 });
  tick(3600001);
  assert.equal(service.read('expiry-task').claim.state, 'unclaimed');
  const withdrawn = store.projectOffers.transition('commons', 'owner', 'expiry-task', 'withdraw', { requestId: 'withdraw-x', expectedRevision: 2 });
  assert.equal(withdrawn.status, 'withdrawn');
  assert.equal(withdrawn.strandedLiveClaim, undefined);
});

test('archive with locked escrow refuses with enumeration; post-archive fund/post refuse as archived', t => {
  const { store } = fixture(t);
  const escrow = store.bountyEscrow;
  const deadline = new Date(Date.now() + 86400000).toISOString();
  const a = escrow.postBounty('commons', { poster: 'owner', title: 'A', criteria: 'C', amount: 6, deadline }).bounty;
  const b = escrow.postBounty('commons', { poster: 'owner', title: 'B', criteria: 'C', amount: 5, deadline }).bounty;
  escrow.fundBounty('commons', a.bountyId, { funder: 'owner' });
  escrow.fundBounty('commons', b.bountyId, { funder: 'owner' });
  assert.equal(escrow.balances('commons', 'owner').locked, 11);

  const ownerKey = store.issueAccessKey('commons', 'owner');
  let refused = null;
  try {
    store.command(ownerKey, 'commons', { id: 'archive-1', type: 'room.archived', data: {} });
  } catch (error) { refused = error; }
  assert.ok(refused, 'archive with locked escrow must refuse');
  assert.equal(refused.status, 409);
  assert.equal(refused.code, 'room_archive_locked_escrow');
  assert.match(refused.message, /11 credits/);
  assert.match(refused.message, new RegExp(a.bountyId));
  assert.match(refused.message, new RegExp(b.bountyId));
  assert.match(refused.message, /6 credits/);
  assert.match(refused.message, /5 credits/);
  // The room is NOT archived and no money moved.
  assert.equal(store.room('commons').state.room.archivedAt, undefined);
  assert.equal(escrow.balances('commons', 'owner').locked, 11);

  // A room whose only bounty is proposed (nothing locked) archives fine —
  // then funding that bounty and posting a new one refuse as archived.
  store.initialize(initialRoom('guard-archive-room'));
  const p = escrow.postBounty('guard-archive-room', { poster: 'owner', title: 'P', criteria: 'C', amount: 2, deadline }).bounty;
  const roomKey = store.issueAccessKey('guard-archive-room', 'owner');
  store.command(roomKey, 'guard-archive-room', { id: 'archive-2', type: 'room.archived', data: {} });
  assert.equal(typeof store.room('guard-archive-room').state.room.archivedAt, 'string');
  assert.throws(() => escrow.fundBounty('guard-archive-room', p.bountyId, { funder: 'owner' }), code('room_archived'));
  assert.throws(() => escrow.postBounty('guard-archive-room', { poster: 'owner', title: 'N', criteria: 'C', amount: 1, deadline }), code('room_archived'));
  assert.equal(escrow.balances('guard-archive-room', 'owner').locked, 0);
});
