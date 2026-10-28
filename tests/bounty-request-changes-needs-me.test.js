// REQUEST-CHANGES R3 (charter request-changes.md): the worker learns of a
// send-back without polling the bounty board — needs-me carries an
// actionsNeeded entry for the bounty with the reviewer's summary verbatim
// (the bounty-side minimum of the work-claim changesRequested parity datum;
// the general bounty needs-me family is the attention-plumbing charter's).
import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomStore } from '../server/store.mjs';
import { AgentRooms } from '../server/agent-rooms.mjs';
import { collectNeedsMe } from '../server/needs-me.mjs';
import { canonicalLane } from '../server/bounty-escrow.mjs';
import { linkWithProof } from './helpers/link-with-proof.mjs';

const WRITER = ['steer', 'accept_work', 'complete_work', 'verify'];

test('needs-me actionsNeeded carries the bounty changes-requested item with the reviewer summary', t => {
  const store = new RoomStore(':memory:', { now: () => Date.parse('2026-10-05T00:00:00Z') });
  t.after(() => store.close());
  const rooms = new AgentRooms(store);
  const owner = store.identities.create('Owen');
  const ada = store.identities.create('Ada');
  rooms.create(owner.secret, { roomId: 'board', title: 'board', purpose: 'Request changes', kind: 'personal' });
  linkWithProof(store, owner.secret, 'board', ada, { displayName: 'Ada', permissions: WRITER });
  const memberOf = identity => store.db.prepare('SELECT member_id AS m FROM identity_links WHERE identity_id=? AND room_id=?')
    .get(identity.identityId, 'board').m;
  const posterLane = canonicalLane(memberOf(owner));
  const workerLane = canonicalLane(memberOf(ada));
  const escrow = store.bountyEscrow;
  escrow.ensureGenesis('board');
  const bounty = escrow.postBounty('board', { poster: posterLane, title: 'Guide', criteria: 'C',
    amount: 4, deadline: new Date(Date.parse('2026-10-05T00:00:00Z') + 3_600_000).toISOString() }).bounty;
  escrow.fundBounty('board', bounty.bountyId, { funder: posterLane });
  escrow.claimBounty('board', bounty.bountyId, { claimant: workerLane });
  escrow.submitWork('board', bounty.bountyId, { claimant: workerLane,
    evidence: { evidenceUrl: 'https://example.invalid/v1', summary: 'v1' } });

  assert.equal(collectNeedsMe(store, ada.secret, {}).actionsNeeded, undefined, 'nothing needed before the send-back');

  escrow.requestChangesWork('board', bounty.bountyId,
    { requester: posterLane, summary: 'Add the missing example, please' });

  const page = collectNeedsMe(store, ada.secret, {});
  assert.equal(page.actionsNeeded?.length, 1);
  const section = page.actionsNeeded[0];
  assert.equal(section.roomId, 'board');
  assert.equal(section.count, 1);
  const item = section.top[0];
  assert.equal(item.why, 'changes_requested');
  assert.equal(item.kind, 'bounty');
  assert.equal(item.bountyId, bounty.bountyId);
  assert.equal(item.summary, 'Add the missing example, please');
  // The poster does not carry the worker's action.
  const posterPage = collectNeedsMe(store, owner.secret, {});
  const posterItems = (posterPage.actionsNeeded ?? []).flatMap(s => s.top);
  assert.equal(posterItems.some(row => row.bountyId === bounty.bountyId), false);
});
