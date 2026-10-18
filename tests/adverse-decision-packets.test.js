// #3615 (accountability R-4 + R-6): adverse-decision packets for the
// affected subject, and agent-participation notices as records.
//
// Public-work fixture mirrors tests/public-work-reviews.test.js (real
// persisted offers, identities, claim kernel and receipts). The bounty
// fixture mirrors tests/bounty-escrow.test.js (in-memory store double).
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { BountyEscrow } from '../server/bounty-escrow.mjs';
import { AdverseDecisionPackets, agentParticipationNotice, AGENT_PARTICIPATION_NOTICE_VERSION } from '../server/adverse-decision-packets.mjs';

const code = expected => error => error.code === expected;

function publicWorkFixture(t, mode = 'human') {
  // In-memory store: the file-backed variant hits this environment's known
  // SQLite overlay fault (errcode 778), which also fails the pre-existing
  // public-work suites locally; nothing here needs reopen persistence.
  const store = new RoomStore(':memory:');
  store.initialize(initialRoom());
  const producer = store.identities.create('Producer'), other = store.identities.create('Other');
  const state = structuredClone(store.room('commons').state);
  state.members.reviewer = { id: 'reviewer', revision: 1, kind: 'agent', active: true, displayName: 'Reviewer', permissions: ['read', 'verify'] };
  store.db.prepare('UPDATE rooms SET projection=? WHERE id=?').run(JSON.stringify(state), 'commons');
  const reviewers = mode === 'human' ? ['owner'] : ['reviewer'];
  store.projectOffers.create('commons', 'owner', { requestId: 'create', offerId: 'packet-task', reviewerMemberIds: reviewers,
    terms: { kind: 'task', title: 'Write the summary', summary: 'Packet fixture', acceptanceCriteria: ['Correct result', 'Cites sources'], repositoryUrl: 'https://github.com/example/project', reward: { kind: 'unpaid' }, approvalPolicy: { mode } } });
  store.projectOffers.transition('commons', 'owner', 'packet-task', 'publish', { requestId: 'publish', expectedRevision: 1 });
  store.publicWorkClaims.enable('commons', 'owner', 'packet-task', { requestId: 'enable', expectedRevision: 2, expectedTermsVersion: 1, repositoryRef: 'main', files: ['result.txt'] });
  const claim = store.publicWorkClaims.act('packet-task', producer.secret, 'claim', { requestId: 'claim', expectedTermsVersion: 1 });
  const receipt = store.publicWorkClaims.act('packet-task', producer.secret, 'finish', { requestId: 'finish', expectedTermsVersion: 1, generation: 1, artifactText: 'the result', checksReported: ['tests pass'] }).receipt;
  t.after(() => { store.close(); });
  const input = (requestId, revision, extra = {}) => ({ requestId, expectedReviewRevision: revision, taskId: receipt.taskId,
    expectedTermsVersion: receipt.termsVersion, generation: receipt.generation, artifactSha256: receipt.artifact.sha256,
    reason: 'The summary misses the second criterion', ...extra });
  return { store, producer, other, receipt, claim, input };
}

test('R-6: a public-work claim delivers the participation notice and records it with its content version', t => {
  const f = publicWorkFixture(t, 'agent');
  assert.equal(f.claim.notice.contentVersion, AGENT_PARTICIPATION_NOTICE_VERSION);
  assert.equal(f.claim.notice.agentInvolved, true);
  assert.match(f.claim.notice.text, /automated agent will review/);
  const rows = f.store.db.prepare('SELECT * FROM subject_notices').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].recipient, f.producer.identityId);
  assert.equal(rows[0].channel, 'public_work_claim');
  assert.equal(rows[0].content_version, AGENT_PARTICIPATION_NOTICE_VERSION);
  assert.equal(rows[0].content_text, f.claim.notice.text);
  assert.equal(rows[0].subject_ref, 'packet-task');
});

test('R-4: a rejected submission yields a packet the subject reads with their own identity only', t => {
  const f = publicWorkFixture(t, 'agent');
  const id = f.receipt.receiptId, packets = f.store.adverseDecisionPackets;
  // No adverse decision yet: honest 404, for the subject and everyone else.
  assert.throws(() => packets.forPublicWorkReceipt(f.producer.secret, id), code('no_adverse_decision'));
  f.store.publicWorkReviews.verify('commons', 'reviewer', id, f.input('verify', 0, { verdict: 'PASS' }));
  f.store.publicWorkReviews.decide('commons', 'reviewer', id, f.input('decide', 1, { decision: 'rejected' }));
  const packet = packets.forPublicWorkReceipt(f.producer.secret, id);
  assert.equal(packet.schema, 'adverse-decision-packet/1');
  assert.equal(packet.decision.outcome, 'rejected');
  assert.match(packet.explanation, /was rejected/);
  assert.match(packet.explanation, /misses the second criterion/);
  assert.equal(packet.principalFactors[0].detail, 'The summary misses the second criterion');
  // The decider was an agent: disclosed, in plain language.
  assert.equal(packet.agentParticipation.agentInvolved, true);
  assert.equal(packet.agentParticipation.deciderKind, 'agent');
  assert.match(packet.agentParticipation.disclosure, /automated agent made this decision/);
  // Data relied on names the exact artifact fingerprint.
  assert.match(packet.dataReliedOn[0].detail, new RegExp(f.receipt.artifact.sha256));
  // Correction path exists and is explicitly not a dispute.
  assert.equal(packet.correctionPath.distinctFromDispute, true);
  assert.match(packet.correctionPath.summary, /not a dispute/);
  // Human review routes to the room owner — never the agent decider.
  assert.equal(packet.humanReview.available, true);
  assert.equal(packet.humanReview.reviewerRole, 'room owner');
  assert.equal(packet.humanReview.reviewerIsOriginalDecider, false);
  // The claim-time notice is on the packet record, with its version.
  assert.equal(packet.notices.length, 1);
  assert.equal(packet.notices[0].contentVersion, AGENT_PARTICIPATION_NOTICE_VERSION);
  // No reviewer member ids leak to the subject.
  assert.equal(JSON.stringify(packet).includes('"actorId"'), false);
  // Another identity gets nothing; a bad secret is unauthenticated.
  assert.throws(() => packets.forPublicWorkReceipt(f.other.secret, id), code('packet_not_found'));
  assert.throws(() => packets.forPublicWorkReceipt('not-a-secret', id), code('unauthenticated'));
});

test('R-4: a failed verification alone yields a packet; an acceptance yields none', t => {
  const f = publicWorkFixture(t, 'agent');
  const id = f.receipt.receiptId, packets = f.store.adverseDecisionPackets;
  f.store.publicWorkReviews.verify('commons', 'reviewer', id, f.input('verify', 0, { verdict: 'FAIL', reason: 'Artifact does not match the claim' }));
  const packet = packets.forPublicWorkReceipt(f.producer.secret, id);
  assert.equal(packet.decision.outcome, 'verification_failed');
  assert.match(packet.explanation, /recorded a FAIL/);
  const g = publicWorkFixture(t, 'human');
  g.store.publicWorkReviews.decide('commons', 'owner', g.receipt.receiptId, g.input('decide', 0, { decision: 'accepted' }));
  assert.throws(() => g.store.adverseDecisionPackets.forPublicWorkReceipt(g.producer.secret, g.receipt.receiptId), code('no_adverse_decision'));
});

test('R-4: per-criterion outcomes ride the packet when the record carries them, and degrade when it does not', t => {
  const f = publicWorkFixture(t, 'human');
  const id = f.receipt.receiptId, packets = f.store.adverseDecisionPackets;
  f.store.publicWorkReviews.decide('commons', 'owner', id, f.input('decide', 0, { decision: 'rejected' }));
  const plain = packets.forPublicWorkReceipt(f.producer.secret, id);
  assert.equal(plain.principalFactors.length, 1); // reason only: no criteria outcomes recorded
  // Simulate a #3613-shaped record carrying per-criterion outcomes.
  const row = f.store.db.prepare('SELECT state_json FROM public_work_reviews WHERE receipt_id=?').get(id);
  const review = JSON.parse(row.state_json);
  review.decision.criteriaOutcomes = [{ criterionId: 'c1', verdict: 'pass' }, { criterionId: 'c2', verdict: 'fail', note: 'No sources cited' }];
  f.store.db.prepare('UPDATE public_work_reviews SET state_json=? WHERE receipt_id=?').run(JSON.stringify(review), id);
  const rich = packets.forPublicWorkReceipt(f.producer.secret, id);
  const criteria = rich.principalFactors.filter(factor => factor.source === 'decision_record');
  assert.equal(criteria.length, 3); // reason + two criterion outcomes
  assert.match(criteria[2].label, /Criterion "c2": fail/);
  assert.equal(criteria[2].detail, 'No sources cited');
});

test('R-4: corrections and human-review requests are recorded on the packet; routing never names the decider', t => {
  const f = publicWorkFixture(t, 'agent');
  const id = f.receipt.receiptId, packets = f.store.adverseDecisionPackets;
  f.store.publicWorkReviews.verify('commons', 'reviewer', id, f.input('verify', 0, { verdict: 'PASS' }));
  f.store.publicWorkReviews.decide('commons', 'reviewer', id, f.input('decide', 1, { decision: 'rejected' }));
  const correction = packets.filePublicWorkFollowup(f.producer.secret, id,
    { kind: 'correction', statement: 'The fingerprint in the packet is not the file I sent.' });
  assert.equal(correction.status, 'recorded');
  const request = packets.filePublicWorkFollowup(f.producer.secret, id,
    { kind: 'human_review_request', statement: 'Please have a person look at this again.' });
  assert.equal(request.routedToRole, 'room owner');
  const packet = packets.forPublicWorkReceipt(f.producer.secret, id);
  assert.equal(packet.correctionPath.filed.length, 1);
  assert.equal(packet.correctionPath.filed[0].statement, 'The fingerprint in the packet is not the file I sent.');
  assert.equal(packet.reviewRequests.length, 1);
  // The routed member id is stored on the room side of the record only.
  const stored = f.store.db.prepare('SELECT routed_to FROM adverse_decision_followups WHERE kind=?').get('human_review_request');
  assert.equal(stored.routed_to, 'owner');
  assert.equal(JSON.stringify(packet).includes('"routedTo"'), false);
  // Another identity cannot file against the packet.
  assert.throws(() => packets.filePublicWorkFollowup(f.other.secret, id, { kind: 'correction', statement: 'not mine' }), code('packet_not_found'));
});

test('R-4: when the only human authority is the decider, the packet says so and review requests are refused honestly', t => {
  const f = publicWorkFixture(t, 'human');
  const id = f.receipt.receiptId, packets = f.store.adverseDecisionPackets;
  f.store.publicWorkReviews.decide('commons', 'owner', id, f.input('decide', 0, { decision: 'rejected' }));
  const packet = packets.forPublicWorkReceipt(f.producer.secret, id);
  assert.equal(packet.agentParticipation.agentInvolved, false);
  assert.equal(packet.humanReview.available, false);
  assert.match(packet.humanReview.note, /No human reviewer distinct from the original decider/);
  assert.throws(() => packets.filePublicWorkFollowup(f.producer.secret, id,
    { kind: 'human_review_request', statement: 'review please' }), code('no_distinct_human_reviewer'));
  // Corrections still work — they do not need a reviewer.
  assert.equal(packets.filePublicWorkFollowup(f.producer.secret, id,
    { kind: 'correction', statement: 'The criteria list is out of date.' }).status, 'recorded');
});

// --- Bounty surface --------------------------------------------------------
const ROOM = 'room-test', POSTER = 'id:agent/jill', WORKER = 'id:agent/grokbot', OWNER = 'id:human/owner';
let nowMs = 1_786_000_000_000;
function bountyFixture() {
  const db = new DatabaseSync(':memory:');
  const transaction = fn => {
    db.exec('SAVEPOINT packet_test');
    try { const out = fn(); db.exec('RELEASE packet_test'); return out; }
    catch (error) { db.exec('ROLLBACK TO packet_test'); db.exec('RELEASE packet_test'); throw error; }
  };
  const state = { room: { id: ROOM, ownerId: OWNER }, members: {}, workItems: {} };
  const store = { db, transaction, readTransaction: transaction, room: () => ({ state }), now: () => nowMs };
  const escrow = new BountyEscrow(store, { now: () => nowMs, allowLegacyStringLanes: true });
  store.bountyEscrow = escrow;
  escrow.ensureGenesis(ROOM);
  return { db, store, escrow, packets: new AdverseDecisionPackets(store) };
}
function rejectedBounty({ escrow }) {
  const bounty = escrow.postBounty(ROOM, { poster: POSTER, title: 'Build the widget', criteria: 'Widget works', amount: 10,
    deadline: new Date(nowMs + 3_600_000).toISOString(), approvalMode: 'agent', verifierId: 'id:agent/instinct' }).bounty;
  escrow.fundBounty(ROOM, bounty.bountyId, { funder: POSTER });
  const claimed = escrow.claimBounty(ROOM, bounty.bountyId, { claimant: WORKER });
  escrow.submitWork(ROOM, bounty.bountyId, { claimant: WORKER,
    evidence: { evidenceUrl: 'https://example.com/work', summary: 'Widget built' } });
  escrow.rejectWork(ROOM, bounty.bountyId, { rejector: 'id:agent/instinct', reason: 'Widget fails on load' });
  return { bounty, claimed };
}

test('R-6 + R-4: bounty claim records the notice; rejection yields the claimant packet', t => {
  const f = bountyFixture();
  const { bounty, claimed } = rejectedBounty(f);
  assert.equal(claimed.notice.contentVersion, AGENT_PARTICIPATION_NOTICE_VERSION);
  assert.equal(claimed.notice.agentInvolved, true); // agent approval mode
  const noticeRows = f.db.prepare('SELECT * FROM subject_notices WHERE subject_ref=?').all(bounty.bountyId);
  assert.equal(noticeRows.length, 1);
  assert.equal(noticeRows[0].channel, 'bounty_claim');
  assert.equal(noticeRows[0].recipient, WORKER);

  const packet = f.packets.forBounty(ROOM, WORKER, bounty.bountyId);
  assert.equal(packet.schema, 'adverse-decision-packet/1');
  assert.equal(packet.decision.outcome, 'rejected');
  assert.match(packet.explanation, /Widget fails on load/);
  assert.match(packet.explanation, /returned to the poster in full/);
  assert.match(packet.explanation, /claim bond was forfeited/);
  assert.equal(packet.agentParticipation.agentInvolved, true);
  assert.match(packet.agentParticipation.disclosure, /agent verifier made the rejection/);
  assert.match(packet.dataReliedOn[0].detail, /example\.com\/work/);
  assert.equal(packet.notices.length, 1);
  assert.equal(packet.humanReview.available, true);
  assert.equal(packet.humanReview.reviewerRole, 'room owner');
  // Only the claimant can read it.
  assert.throws(() => f.packets.forBounty(ROOM, POSTER, bounty.bountyId), code('packet_not_found'));
  // Corrections file against it.
  const correction = f.packets.fileBountyFollowup(ROOM, WORKER, bounty.bountyId,
    { kind: 'correction', statement: 'The evidence URL in the record is the draft, not the final build.' });
  assert.equal(correction.status, 'recorded');
  assert.equal(f.packets.forBounty(ROOM, WORKER, bounty.bountyId).correctionPath.filed.length, 1);
});

test('notice content is versioned per approval mode', () => {
  assert.equal(agentParticipationNotice({ mode: 'agent', title: 'T' }).agentInvolved, true);
  assert.equal(agentParticipationNotice({ mode: 'human_with_agent_review', title: 'T' }).agentInvolved, true);
  assert.equal(agentParticipationNotice({ mode: 'human', title: 'T' }).agentInvolved, false);
  assert.equal(agentParticipationNotice({ mode: 'legacy', title: 'T' }).agentInvolved, false);
  for (const mode of ['agent', 'human_with_agent_review', 'human', 'legacy'])
    assert.equal(agentParticipationNotice({ mode, title: 'T' }).contentVersion, AGENT_PARTICIPATION_NOTICE_VERSION);
});
