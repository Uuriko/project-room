import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { publicWorkReviewsSchema } from '../server/public-work-reviews.mjs';
import { createRoomServer } from '../server/http.mjs';

// #3615 (R-4/R-6): subject-facing adverse-decision packets over the existing
// public-work review/receipt records, and agent-participation notices as
// records. Fixture mirrors tests/public-work-reviews.test.js: real offers,
// identities, claim kernel and receipts; the producer is NOT a room member.
function fixture(t, mode = 'human_with_agent_review') {
  const dir = mkdtempSync(join(tmpdir(), 'adverse-packet-')), file = join(dir, 'room.sqlite');
  const store = new RoomStore(file);
  store.initialize(initialRoom());
  store.db.exec(publicWorkReviewsSchema);
  const producer = store.identities.create('Producer'), other = store.identities.create('Other');
  const state = structuredClone(store.room('commons').state);
  state.members.reviewer = { id: 'reviewer', revision: 1, kind: 'agent', active: true, displayName: 'Reviewer', permissions: ['read', 'verify'] };
  state.members.stranger = { id: 'stranger', revision: 1, kind: 'human', active: true, displayName: 'Other human', permissions: ['read', 'decide', 'verify'] };
  store.db.prepare('UPDATE rooms SET projection=? WHERE id=?').run(JSON.stringify(state), 'commons');
  const reviewers = mode === 'human' ? ['owner'] : mode === 'agent' ? ['reviewer'] : ['owner', 'reviewer'];
  store.projectOffers.create('commons', 'owner', { requestId: 'create', offerId: 'review-task', reviewerMemberIds: reviewers,
    terms: { kind: 'task', title: 'Review this result', summary: 'Explicit feedback', acceptanceCriteria: ['Correct result'], repositoryUrl: 'https://github.com/example/project', reward: { kind: 'unpaid' }, approvalPolicy: { mode } } });
  store.projectOffers.transition('commons', 'owner', 'review-task', 'publish', { requestId: 'publish', expectedRevision: 1 });
  store.publicWorkClaims.enable('commons', 'owner', 'review-task', { requestId: 'enable', expectedRevision: 2, expectedTermsVersion: 1, repositoryRef: 'main', files: ['result.txt'] });
  store.publicWorkClaims.act('review-task', producer.secret, 'claim', { requestId: 'claim', expectedTermsVersion: 1 });
  const receipt = store.publicWorkClaims.act('review-task', producer.secret, 'finish', { requestId: 'finish', expectedTermsVersion: 1, generation: 1,
    artifactText: 'attempted result', checksReported: ['unit: pass'],
    criteriaAttestation: [{ criterion: 'Correct result', status: 'not_met' }] }).receipt;
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const input = (requestId, revision = 0, extra = {}) => ({ requestId, expectedReviewRevision: revision, taskId: receipt.taskId,
    expectedTermsVersion: receipt.termsVersion, generation: receipt.generation, artifactSha256: receipt.artifact.sha256,
    reason: 'Reviewed the exact artifact', ...extra });
  const notices = () => store.db.prepare(`SELECT body FROM events WHERE room_id='commons' AND json_extract(body,'$.type')='agent_participation.notice_delivered' ORDER BY sequence`).all().map(row => JSON.parse(row.body));
  return { store, producer, other, receipt, input, notices,
    packets: () => store.adverseDecisionPackets };
}
const code = expected => error => error.code === expected;

test('rejected trial yields a subject-readable packet composed only of recorded material', t => {
  const f = fixture(t), id = f.receipt.receiptId;
  f.store.publicWorkReviews.verify('commons', 'reviewer', id, f.input('agent-fail', 0, { verdict: 'FAIL', reason: 'Private review evidence' }));
  f.store.publicWorkReviews.decide('commons', 'owner', id, f.input('reject', 1, { decision: 'rejected', reason: 'Result does not meet the criterion' }));
  // The subject is not a room member and holds no identity link.
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM identity_links').get().n, 0);
  const packet = f.packets().packet(f.producer.secret, id);
  assert.equal(packet.schema, 'adverse-decision-packet/1');
  assert.equal(packet.receiptId, id); assert.equal(packet.taskId, 'review-task');
  assert.equal(packet.subjectIdentityId, f.producer.identityId);
  assert.equal(packet.adverseBasis, 'rejected_and_verification_failed');
  // Explanation is the recorded decision reason, verbatim.
  assert.deepEqual(packet.explanation, { source: 'recorded_decision_reason', text: 'Result does not meet the criterion' });
  assert.deepEqual(packet.decision, { decision: 'rejected', reason: 'Result does not meet the criterion', at: packet.decision.at });
  assert.equal(packet.verification.verdict, 'FAIL'); assert.equal(packet.verification.reviewerKind, 'agent');
  // Principal factors are recorded outcomes only: the rejection, the FAIL,
  // the subject's own not_met attestation, the platform's failed coverage check.
  assert.ok(packet.principalFactors.some(factor => factor.kind === 'decision' && factor.decision === 'rejected'));
  assert.ok(packet.principalFactors.some(factor => factor.kind === 'verification_verdict' && factor.verdict === 'FAIL' && factor.reviewerKind === 'agent'));
  assert.ok(packet.principalFactors.some(factor => factor.kind === 'criterion_outcome' && factor.criterion === 'Correct result' && factor.status === 'not_met'));
  assert.ok(packet.principalFactors.some(factor => factor.kind === 'executed_check' && factor.name === 'criteria_coverage' && factor.result === 'fail'));
  assert.deepEqual(packet.criteriaOutcomes.attestation, [{ criterion: 'Correct result', status: 'not_met' }]);
  // Agent participation is disclosed from recorded facts, by kind only.
  assert.equal(packet.agentParticipation.approvalPolicyMode, 'human_with_agent_review');
  assert.equal(packet.agentParticipation.verificationReviewerKind, 'agent');
  assert.equal(packet.agentParticipation.decisionActorKind, 'human');
  assert.equal(packet.agentParticipation.agentsParticipated, true);
  // The claim-time notice is on the record and the packet lists it.
  assert.equal(packet.agentParticipation.noticeRecords.length, 1);
  assert.equal(packet.agentParticipation.noticeRecords[0].contentVersion, 'agent-participation-notice/1');
  assert.equal(packet.agentParticipation.noticeRecords[0].channel, 'public_work_claim');
  // Evidence relied on is the recorded bundle.
  assert.equal(packet.evidenceReliedOn.artifactSha256, f.receipt.artifact.sha256);
  assert.deepEqual(packet.evidenceReliedOn.checksReported, ['unit: pass']);
  // Correction is a record route distinct from a dispute; human review names
  // the dispute machinery and honestly reports no vehicle for an unpaid task.
  assert.equal(packet.correction.distinctFromDispute, true); assert.equal(packet.correction.adjudicates, false);
  assert.equal(packet.correction.route, `/api/public-work/receipts/${id}/adverse-decision/correction`);
  assert.equal(packet.humanReview.available, false); assert.equal(packet.humanReview.kind, 'bounty_dispute');
  // Nothing member-side leaks: no identities, no verification reason, no fingerprint.
  const text = JSON.stringify(packet);
  for (const forbidden of ['"actorId"', 'fingerprint', 'Private review evidence', '"reviewer"', '"owner"']) assert.ok(!text.includes(forbidden), forbidden);
  // The packet is also addressable by the task/bounty id.
  assert.equal(f.packets().packet(f.producer.secret, 'review-task').receiptId, id);
});

test('only the subject identity reads the packet — other identities and room members get the missing-record 404', t => {
  const f = fixture(t), id = f.receipt.receiptId;
  f.store.publicWorkReviews.decide('commons', 'owner', id, f.input('reject', 0, { decision: 'rejected', reason: 'Not accepted' }));
  assert.throws(() => f.packets().packet(f.other.secret, id), code('adverse_packet_not_found'));
  // Even linked as a room member, a different identity is not the subject.
  f.store.db.prepare('INSERT INTO identity_links VALUES (?,?,?,?)').run('commons', f.other.identityId, 'stranger', Date.now());
  assert.throws(() => f.packets().packet(f.other.secret, id), code('adverse_packet_not_found'));
  assert.throws(() => f.packets().packet('not-a-secret', id), code('unauthenticated'));
  assert.throws(() => f.packets().packet(f.producer.secret, 'pwr_missing'), code('adverse_packet_not_found'));
  assert.equal(f.packets().packet(f.producer.secret, id).decision.reason, 'Not accepted');
});

test('no packet for non-adverse records: pending and accepted yield the same 404', t => {
  const pending = fixture(t);
  assert.throws(() => pending.packets().packet(pending.producer.secret, pending.receipt.receiptId), code('adverse_packet_not_found'));
  const accepted = fixture(t, 'human');
  accepted.store.publicWorkReviews.decide('commons', 'owner', accepted.receipt.receiptId, accepted.input('accept', 0, { decision: 'accepted' }));
  assert.throws(() => accepted.packets().packet(accepted.producer.secret, accepted.receipt.receiptId), code('adverse_packet_not_found'));
  const revised = fixture(t, 'human');
  revised.store.publicWorkReviews.decide('commons', 'owner', revised.receipt.receiptId, revised.input('revise', 0, { decision: 'revision_requested', reason: 'Please fix' }));
  assert.throws(() => revised.packets().packet(revised.producer.secret, revised.receipt.receiptId), code('adverse_packet_not_found'));
});

test('failed verification alone yields a packet whose explanation renders absent rather than invented', t => {
  const f = fixture(t, 'agent'), id = f.receipt.receiptId;
  f.store.publicWorkReviews.verify('commons', 'reviewer', id, f.input('agent-fail', 0, { verdict: 'FAIL', reason: 'Private review evidence' }));
  const packet = f.packets().packet(f.producer.secret, id);
  assert.equal(packet.adverseBasis, 'verification_failed');
  assert.equal(packet.decision, null);
  assert.deepEqual(packet.explanation, { source: 'recorded_verification_outcome', text: null });
  assert.ok(!JSON.stringify(packet).includes('Private review evidence'));
});

test('claim delivers the agent-participation notice as a record; human-only mode records none; a claim replay records no second notice', t => {
  const f = fixture(t, 'agent');
  const [notice] = f.notices();
  assert.ok(notice); assert.equal(notice.type, 'agent_participation.notice_delivered');
  assert.equal(notice.data.contentVersion, 'agent-participation-notice/1');
  assert.equal(notice.data.recipientIdentityId, f.producer.identityId);
  assert.equal(notice.data.channel, 'public_work_claim');
  assert.equal(notice.data.taskId, 'review-task');
  assert.equal(notice.data.approvalPolicyMode, 'agent');
  assert.equal(notice.data.termsVersion, 1);
  assert.ok(!Number.isNaN(Date.parse(notice.at)));
  // Journal replay of the same claim returns the recorded outcome and the
  // notice count stays at one.
  f.store.publicWorkClaims.act('review-task', f.producer.secret, 'claim', { requestId: 'claim', expectedTermsVersion: 1 });
  assert.equal(f.notices().length, 1);
  const human = fixture(t, 'human');
  assert.equal(human.notices().length, 0);
});

test('correction requests are recorded as room events, subject-only, idempotent by requestId, and adjudicate nothing', t => {
  const f = fixture(t), id = f.receipt.receiptId;
  f.store.publicWorkReviews.decide('commons', 'owner', id, f.input('reject', 0, { decision: 'rejected', reason: 'Based on the recorded checks' }));
  const request = { requestId: 'fix-1', field: 'checksReported', note: 'The check list omits the lint run I reported' };
  const recorded = f.packets().requestCorrection(f.producer.secret, id, request);
  assert.equal(recorded.schema, 'adverse-decision-correction/1'); assert.equal(recorded.replayed, false);
  const events = f.store.db.prepare(`SELECT body FROM events WHERE room_id='commons' AND json_extract(body,'$.type')='adverse_decision.correction_requested'`).all().map(row => JSON.parse(row.body));
  assert.equal(events.length, 1);
  assert.equal(events[0].data.receiptId, id); assert.equal(events[0].data.field, 'checksReported'); assert.equal(events[0].data.note, request.note);
  assert.equal(events[0].actorId, f.producer.identityId);
  // Replay returns the recorded request; a reused id with different input refuses.
  assert.equal(f.packets().requestCorrection(f.producer.secret, id, request).replayed, true);
  assert.throws(() => f.packets().requestCorrection(f.producer.secret, id, { ...request, note: 'Different note' }), code('request_id_reused'));
  assert.equal(f.store.db.prepare(`SELECT count(*) AS n FROM events WHERE json_extract(body,'$.type')='adverse_decision.correction_requested'`).get().n, 1);
  // Non-subjects cannot file against someone else's record, and the verdict stands.
  assert.throws(() => f.packets().requestCorrection(f.other.secret, id, { requestId: 'fix-2', field: 'other', note: 'Not mine' }), code('adverse_packet_not_found'));
  assert.equal(f.store.publicWorkReviews.contributorReview(f.producer.secret, id).review.state, 'rejected');
});

test('HTTP: the packet and correction doors ride the identity-secret bearer, with no room membership', async t => {
  const store = new RoomStore(':memory:'); store.initialize(initialRoom());
  store.db.exec(publicWorkReviewsSchema);
  const producer = store.identities.create('Producer'), other = store.identities.create('Other');
  store.projectOffers.create('commons', 'owner', { requestId: 'create', offerId: 'http-task', reviewerMemberIds: ['owner'],
    terms: { kind: 'task', title: 'HTTP task', summary: 's', acceptanceCriteria: ['Correct result'], repositoryUrl: 'https://github.com/example/project', reward: { kind: 'unpaid' }, approvalPolicy: { mode: 'human' } } });
  store.projectOffers.transition('commons', 'owner', 'http-task', 'publish', { requestId: 'publish', expectedRevision: 1 });
  store.publicWorkClaims.enable('commons', 'owner', 'http-task', { requestId: 'enable', expectedRevision: 2, expectedTermsVersion: 1, repositoryRef: 'main', files: ['result.txt'] });
  store.publicWorkClaims.act('http-task', producer.secret, 'claim', { requestId: 'claim', expectedTermsVersion: 1 });
  const receipt = store.publicWorkClaims.act('http-task', producer.secret, 'finish', { requestId: 'finish', expectedTermsVersion: 1, generation: 1, artifactText: 'x', checksReported: [] }).receipt;
  store.publicWorkReviews.decide('commons', 'owner', receipt.receiptId, { requestId: 'reject', expectedReviewRevision: 0, taskId: receipt.taskId,
    expectedTermsVersion: 1, generation: 1, artifactSha256: receipt.artifact.sha256, decision: 'rejected', reason: 'Recorded rejection reason' });
  const server = createRoomServer({ store }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = (path, secret, data) => fetch(origin + path, { method: data ? 'POST' : 'GET', headers: { Origin: origin, ...(secret ? { Authorization: `Bearer ${secret}` } : {}), ...(data ? { 'Content-Type': 'application/json' } : {}) }, ...(data ? { body: JSON.stringify(data) } : {}) });
  const path = `/api/public-work/receipts/${receipt.receiptId}/adverse-decision`;
  assert.equal((await call(path, null)).status, 401);
  assert.equal((await call(path, other.secret)).status, 404);
  const packet = await (await call(path, producer.secret)).json();
  assert.equal(packet.explanation.text, 'Recorded rejection reason');
  const correction = await call(path + '/correction', producer.secret, { requestId: 'c1', field: 'decisionReason', note: 'The reason cites a check I did run' });
  assert.equal(correction.status, 200);
  assert.equal((await correction.json()).schema, 'adverse-decision-correction/1');
  assert.equal((await call(path + '/correction', other.secret, { requestId: 'c2', field: 'other', note: 'nope' })).status, 404);
});
