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


// RC-CURE (critic Defect 1 on PR #5136): the needs-me bounty summary is
// chartered VERBATIM. The cases below use the two shapes clip() destroys —
// a >140-char summary (truncated at 140, mid-word) and a multiline summary
// (whitespace collapsed) — and assert byte-identical arrival. Both fail on
// the uncured head and pass once bountyActionsNeededOf carries the summary
// unclipped.

function returnedBountyItem(t, summary) {
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
  escrow.requestChangesWork('board', bounty.bountyId,
    { requester: posterLane, summary });
  const page = collectNeedsMe(store, ada.secret, {});
  assert.equal(page.actionsNeeded?.length, 1);
  const item = page.actionsNeeded[0].top[0];
  assert.equal(item.why, 'changes_requested');
  assert.equal(item.kind, 'bounty');
  assert.equal(item.bountyId, bounty.bountyId);
  return item;
}

test('needs-me bounty summary verbatim: a >140-char summary arrives byte-identical', t => {
  const summary = 'Fix the introduction so it answers the prompt directly, add the missing worked example with its full calculation, replace the broken link in step two, and state the deadline rule in the final paragraph before resubmitting.';
  assert.ok(summary.length > 140, `fixture summary must exceed the old 140-char clip (got ${summary.length})`);
  const item = returnedBountyItem(t, summary);
  assert.equal(item.summary.length, summary.length);
  assert.equal(item.summary, summary);
});

test('needs-me bounty summary verbatim: a multiline summary arrives byte-identical', t => {
  const summary = 'Line one needs work.\n\nLine two:  keep\ttabs and  double spaces.';
  const item = returnedBountyItem(t, summary);
  assert.equal(item.summary, summary);
});
