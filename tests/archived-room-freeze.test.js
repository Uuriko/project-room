// EA-001 / EA2-002 / L05-C3: the archived-room freeze must hold at the
// registry/write choke point, not only on the commands route.
//
// Proven legs (wave-1/2 production executions + wave-3 store audit):
//  A. A Board work claim can be created (and claimed) over REST in an
//     archived room; the row lands in the durable work-claim registry and
//     never enters the room projection (phantom write).
//  B. A bounty can be created AND funded inside an archived room — real
//     escrow locks in a frozen room (specimen EXPERTAUDITD-1).
//  C. At the store layer itself, credential issuance, session creation,
//     mention-timeout and catch-up writes still land in archived rooms.
//
// Freeze scope (design statement, mirrored in the PR body). Per the
// coordinator's tranche-2 G8 routing, the freeze lives at the store /
// side-table write layer — one shared guard (server/archived-guard.mjs)
// at each store module's write-entry choke point — never as per-route
// patches in http.mjs (a funnel-only fix covers none of the executed
// acceptances).
//  FROZEN — work-claim registry writes (set/configure/delete) for a room
//  whose rooms.archived_at mirror is set; bounty post + fund (the two
//  money-creating/locking intake writes); store credential issuance and
//  session creation (insertCredential and every caller built on it);
//  setMentionTimeout; markCaughtUp; collab journal mutations (the
//  #transact funnel: assign/notes/locks/approvals/routing); project-map
//  push + pull-record; invite minting in both invite modules (guest
//  mint, agent-invite create).
//  LEFT — reads and export; the archive action itself (command path,
//  already guarded separately); every transition of a bounty that already
//  exists when the room archives (claim/submit/accept/reject/dispute/
//  decide/finalize), including the keeper timeout refund, so escrow
//  already locked in a room that later archives can still settle back;
//  credential revocation (cleanup); the read-triggered mention-expiry
//  flip (system maintenance, no new room content).
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { createRoomServer } from '../server/http.mjs';
import { RoomAgentClient } from '../client/room-agent.mjs';
import { pushProjectMap, recordProjectMapPull, readProjectMap } from '../server/project-map-store.mjs';

const future = (ms = 7 * 86400000) => new Date(Date.now() + ms).toISOString();
const isArchivedRefusal = error => error?.status === 409 && error?.code === 'room_archived';
const isEscrowArchivedRefusal = error => error?.code === 'room_archived';

function fixture(t) {
  const store = new RoomStore(':memory:');
  store.initialize(initialRoom('commons'));
  const ownerKey = store.issueAccessKey('commons', 'owner');
  store.command(ownerKey, 'commons', { id: 'add-worker', type: 'member.added',
    data: { memberId: 'worker', displayName: 'Worker', kind: 'human', permissions: ['accept_work', 'complete_work', 'verify'] } });
  t.after(() => store.close());
  const archive = () => store.command(ownerKey, 'commons', { id: 'archive-room', type: 'room.archived', data: { reason: 'pilot over' } });
  return { store, ownerKey, archive };
}

async function restFixture(t) {
  const base = fixture(t);
  const server = createRoomServer({ store: base.store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { ...base, origin, owner: new RoomAgentClient({ origin, roomId: 'commons', token: base.ownerKey }) };
}

test('EA-001: REST work-claim create and claim in an archived room refuse 409 room_archived and record nothing', async t => {
  const { store, owner, archive } = await restFixture(t);
  await owner.workClaimCreate({ id: 'before-archive', title: 'Created while live' });
  archive();
  await assert.rejects(owner.workClaimCreate({ id: 'after-archive', title: 'Phantom' }), isArchivedRefusal,
    'claim create in an archived room must refuse 409 room_archived');
  assert.equal(store.workClaims.get('commons', 'after-archive'), null, 'the refused claim was not recorded in the registry');
  await assert.rejects(owner.claimWorkItem('before-archive'), isArchivedRefusal,
    'claiming an existing claim in an archived room must refuse 409 room_archived');
  assert.equal(store.workClaims.get('commons', 'before-archive').state, 'unclaimed', 'the stored claim is unchanged');
  // Reads still work in the archived room.
  const page = await owner.workClaims();
  assert.ok(Array.isArray(page.claims ?? page), 'board read still answers in an archived room');
});

test('EA-001 choke point: the durable work-claim registry itself refuses set/configure in an archived room', async t => {
  const { store, archive } = fixture(t);
  store.workClaims.set('commons', { id: 'live', title: 'Live', state: 'unclaimed', owner: null, history: [] });
  archive();
  assert.throws(() => store.workClaims.set('commons', { id: 'phantom', title: 'Phantom', state: 'unclaimed', owner: null, history: [] }),
    isArchivedRefusal, 'registry set in an archived room must refuse 409 room_archived');
  assert.throws(() => store.workClaims.configure('commons', { defaultLeaseHours: 9 }),
    isArchivedRefusal, 'registry configure in an archived room must refuse 409 room_archived');
  assert.equal(store.workClaims.get('commons', 'phantom'), null);
  assert.equal(store.workClaims.get('commons', 'live').title, 'Live', 'pre-archive rows still read back');
});

test('EA2-002: bounty create and fund in an archived room refuse room_archived and lock no escrow', async t => {
  const { store, archive } = fixture(t);
  const escrow = store.bountyEscrow;
  const proposed = escrow.postBounty('commons', { poster: 'owner', title: 'Live bounty', criteria: 'Do it', amount: 5, deadline: future() }).bounty;
  archive();
  assert.throws(() => escrow.postBounty('commons', { poster: 'owner', title: 'Frozen bounty', criteria: 'Do it', amount: 5, deadline: future() }),
    isEscrowArchivedRefusal, 'bounty create in an archived room must refuse room_archived');
  const before = escrow.balances('commons', 'owner');
  assert.throws(() => escrow.fundBounty('commons', proposed.bountyId, { funder: 'owner' }),
    isEscrowArchivedRefusal, 'bounty fund in an archived room must refuse room_archived');
  assert.deepEqual(escrow.balances('commons', 'owner'), before, 'no escrow locked in the archived room');
  assert.equal(escrow.getBounty('commons', proposed.bountyId).state, 'proposed', 'the pre-archive bounty is unchanged');
  assert.equal(escrow.verifyConservation('commons').ok, true, 'ledger still conserves');
});

test('EA2-002 left-alone leg: a bounty funded before archiving still settles (accept) after archiving', async t => {
  const { store, archive } = fixture(t);
  const escrow = store.bountyEscrow;
  const bounty = escrow.postBounty('commons', { poster: 'owner', title: 'Settle me', criteria: 'Do it', amount: 5, deadline: future() }).bounty;
  escrow.fundBounty('commons', bounty.bountyId, { funder: 'owner' });
  escrow.claimBounty('commons', bounty.bountyId, { claimant: 'worker' });
  escrow.submitWork('commons', bounty.bountyId, { claimant: 'worker',
    evidence: { evidenceUrl: 'https://example.com/work', summary: 'done' } });
  archive();
  const accepted = escrow.acceptWork('commons', bounty.bountyId, { acceptor: 'owner',
    verifierAttestation: { at: new Date().toISOString(), note: 'verified', citations: [{ criterionId: 'c1', verdict: 'pass' }] } });
  assert.ok(accepted, 'settlement of an already-funded bounty still lands in an archived room');
  assert.equal(escrow.verifyConservation('commons').ok, true);
});

test('L05-C3: credential issuance, session creation, mention-timeout and catch-up writes refuse in an archived room', async t => {
  const { store, ownerKey, archive } = fixture(t);
  archive();
  assert.throws(() => store.issueAccessKey('commons', 'owner'), isArchivedRefusal,
    'issueAccessKey in an archived room must refuse 409 room_archived');
  assert.throws(() => store.mintAccessKey('commons', 'owner'), isArchivedRefusal,
    'mintAccessKey in an archived room must refuse 409 room_archived');
  assert.throws(() => store.createSession(ownerKey), isArchivedRefusal,
    'createSession in an archived room must refuse 409 room_archived');
  assert.throws(() => store.setMentionTimeout(ownerKey, 'commons', 60000), isArchivedRefusal,
    'setMentionTimeout in an archived room must refuse 409 room_archived');
  assert.throws(() => store.markCaughtUp(ownerKey, 'commons', store.room('commons').sequence), isArchivedRefusal,
    'markCaughtUp in an archived room must refuse 409 room_archived');
  // Revocation (cleanup) and reads are deliberately left alone.
  store.revoke(ownerKey);
  assert.ok(store.room('commons').state, 'room state still reads in an archived room');
});

// --- Tranche-2 G8 regression legs (coordinator steering, 2026-10-31) ---
// The freeze now routes at the store / side-table write layer: each
// family below was EXECUTED as an archived-room acceptance in tranche 2
// and becomes a regression test for the store-layer freeze, not a
// per-route patch (a funnel-only fix in http.mjs fixes none of them).

test('T2-L05c-C1: collab writes refuse in an archived room at the store layer and leave no rows', async t => {
  const { store, archive } = fixture(t);
  const collab = store.collab;
  const agent = { kind: 'agent', id: 'agent-a' };
  collab.assignThread('commons', 'thread-live', agent, { by: { kind: 'human', id: 'owner' } });
  archive();
  assert.throws(() => collab.assignThread('commons', 'thread-2', agent, { by: { kind: 'human', id: 'owner' } }),
    isArchivedRefusal, 'collab assign in an archived room must refuse 409 room_archived');
  assert.throws(() => collab.addThreadNote('commons', 'thread-live', { author: { kind: 'human', id: 'owner' }, body: 'late note' }),
    isArchivedRefusal, 'collab note in an archived room must refuse 409 room_archived');
  assert.throws(() => collab.acquireDraftLock('commons', 'thread-live', agent),
    isArchivedRefusal, 'collab draft lock in an archived room must refuse 409 room_archived');
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM collab_assignments WHERE room_id='commons'").get().n, 1,
    'only the pre-archive assignment exists');
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM collab_notes WHERE room_id='commons'").get().n, 0);
  assert.equal(collab.listAssignments('commons').length, 1, 'collab reads still work in an archived room');
});

test('T2-L05d-C1: project-map push and pull-record refuse in an archived room and persist nothing', async t => {
  const { store, archive } = fixture(t);
  store.featureEnv = {};
  const update = { repo: 'test/repo', revision: 'a'.repeat(40), files: [{ path: 'a.js', source: 'export function hello() {}' }] };
  await pushProjectMap(store, 'commons', update);
  archive();
  await assert.rejects(pushProjectMap(store, 'commons', { ...update, revision: 'b'.repeat(40) }),
    isArchivedRefusal, 'project-map push in an archived room must refuse 409 room_archived');
  assert.throws(() => recordProjectMapPull(store, 'commons', { repo: 'test/repo', number: 7, files: ['a.js'] }),
    isArchivedRefusal, 'project-map pull record in an archived room must refuse 409 room_archived');
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM project_map_pulls WHERE room_id='commons'").get().n, 0);
  assert.equal(readProjectMap(store, 'commons', { q: 'hello' }).revision, update.revision,
    'the pre-archive map still reads and was not overwritten');
});

test('T2-L02b-C1: invite minting refuses in an archived room in both invite modules', async t => {
  const { store, ownerKey, origin, archive } = await restFixture(t);
  archive();
  // Agent invites: ordinary create (the owner-level path already refused
  // by accident of its side-table event; the ordinary path did not).
  assert.throws(() => store.invites.create(ownerKey, 'commons', { profile: 'member', displayName: 'Late agent' }),
    isArchivedRefusal, 'agent-invite create in an archived room must refuse 409 room_archived');
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM agent_invite_codes WHERE room_id='commons'").get().n, 0);
  // Guest invites: mint over REST (the module's only archived check was
  // in redeem).
  const res = await fetch(`${origin}/api/rooms/commons/guest-invites`, { method: 'POST',
    headers: { Origin: origin, Authorization: `Bearer ${ownerKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId: randomUUID(), guestLabel: 'Late visit', expectedOwnerRevision: 0 }) });
  assert.equal(res.status, 409, `guest mint in an archived room must refuse 409, got ${res.status}`);
  assert.equal((await res.json()).error?.code, 'room_archived');
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM guest_invites WHERE room_id='commons'").get().n, 0);
});

test('control: the same writes still succeed in a room that is not archived', async t => {
  const { store, ownerKey } = fixture(t);
  store.initialize(initialRoom('open-room'));
  const openKey = store.issueAccessKey('open-room', 'owner');
  assert.equal(typeof openKey, 'string');
  assert.ok(store.createSession(ownerKey).token, 'session creation works in a live room');
  assert.equal(store.setMentionTimeout(ownerKey, 'commons', 60000).timeoutMs, 60000);
  store.workClaims.set('commons', { id: 'live', title: 'Live', state: 'unclaimed', owner: null, history: [] });
  const escrow = store.bountyEscrow;
  const bounty = escrow.postBounty('commons', { poster: 'owner', title: 'Live', criteria: 'C', amount: 1, deadline: future() }).bounty;
  escrow.fundBounty('commons', bounty.bountyId, { funder: 'owner' });
  assert.equal(escrow.getBounty('commons', bounty.bountyId).state, 'funded');
});
