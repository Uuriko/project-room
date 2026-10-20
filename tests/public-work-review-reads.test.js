import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { PublicWorkReviews, publicWorkReviewsSchema } from '../server/public-work-reviews.mjs';
import { applicationTables, unfencedAdditiveTables } from '../server/writer-fence.mjs';
import { PURGE_TABLES } from '../server/purge-registry.mjs';

// The outcome-read journal (STRANGER-WAIT-CENSUS §2): contributorReview used
// to record nothing, so a participant's return to read their outcome was
// unmeasurable by construction. These tests pin the journal's contract:
// exactly one append-only row per successful read, the read's response
// byte-identical to the unjournaled behaviour, and a journal failure of any
// kind never failing or altering the read. Fixture mirrors
// tests/public-work-reviews.test.js: real persisted offers, identities,
// the public claim kernel and an immutable receipt.
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'public-review-reads-')), file = join(dir, 'room.sqlite');
  let store = new RoomStore(file);
  store.initialize(initialRoom()); store.initialize(initialRoom('other-room'));
  store.db.exec(publicWorkReviewsSchema);
  const producer = store.identities.create('Producer');
  store.projectOffers.create('commons', 'owner', { requestId: 'create', offerId: 'review-task', reviewerMemberIds: ['owner'],
    terms: { kind: 'task', title: 'Review this result', summary: 'Explicit feedback', acceptanceCriteria: ['Correct result'], repositoryUrl: 'https://github.com/example/project', reward: { kind: 'unpaid' }, approvalPolicy: { mode: 'human' } } });
  store.projectOffers.transition('commons', 'owner', 'review-task', 'publish', { requestId: 'publish', expectedRevision: 1 });
  store.publicWorkClaims.enable('commons', 'owner', 'review-task', { requestId: 'enable', expectedRevision: 2, expectedTermsVersion: 1, repositoryRef: 'main', files: ['result.txt'] });
  store.publicWorkClaims.act('review-task', producer.secret, 'claim', { requestId: 'claim', expectedTermsVersion: 1 });
  const receipt = store.publicWorkClaims.act('review-task', producer.secret, 'finish', { requestId: 'finish', expectedTermsVersion: 1, generation: 1, artifactText: '<not-html>🐈', checksReported: ['Caller reports success'] }).receipt;
  const service = () => new PublicWorkReviews(store);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { get store() { return store; }, service, receipt, producer, file,
    reopen() { store.close(); store = new RoomStore(file); },
    input(requestId, revision = 0, extra = {}) { return { requestId, expectedReviewRevision: revision, taskId: receipt.taskId, expectedTermsVersion: receipt.termsVersion,
      generation: receipt.generation, artifactSha256: receipt.artifact.sha256, reason: 'Reviewed the exact artifact', ...extra }; } };
}
const reads = f => f.store.db.prepare('SELECT * FROM public_work_review_reads ORDER BY rowid').all();

test('each successful contributor read appends exactly one journal row; the response is unchanged', t => {
  const f = fixture(t), id = f.receipt.receiptId;
  const first = f.service().contributorReview(f.producer.secret, id);
  const second = f.service().contributorReview(f.producer.secret, id);
  assert.equal(JSON.stringify(second), JSON.stringify(first), 'repeated reads return byte-identical responses');
  assert.deepEqual(reads(f).map(row => [row.receipt_id, row.room_id, row.reader_id, row.revision]),
    [[id, 'commons', f.receipt.identityId, 0], [id, 'commons', f.receipt.identityId, 0]]);
  for (const row of reads(f)) assert.ok(!Number.isNaN(Date.parse(row.at)), 'the journal row carries a timestamp');
  // A decision moves the revision; the next read journals the revision seen,
  // and the earlier rows are untouched (append-only).
  f.service().decide('commons', 'owner', id, f.input('accept', 0, { decision: 'accepted' }));
  const decided = f.service().contributorReview(f.producer.secret, id);
  assert.equal(decided.review.state, 'accepted'); assert.equal(decided.review.revision, 1);
  assert.deepEqual(reads(f).map(row => row.revision), [0, 0, 1]);
});

test('a failing journal write never fails or alters the read', t => {
  const f = fixture(t), id = f.receipt.receiptId;
  const baseline = f.service().contributorReview(f.producer.secret, id);
  assert.equal(reads(f).length, 1);
  f.store.db.exec(`CREATE TRIGGER fail_outcome_read_journal BEFORE INSERT ON public_work_review_reads
    BEGIN SELECT RAISE(ABORT, 'forced journal failure'); END`);
  const during = f.service().contributorReview(f.producer.secret, id);
  assert.equal(JSON.stringify(during), JSON.stringify(baseline), 'the read response is identical while the journal is broken');
  assert.equal(reads(f).length, 1, 'the aborted insert left no partial row');
  f.store.db.exec('DROP TRIGGER fail_outcome_read_journal');
  f.service().contributorReview(f.producer.secret, id);
  assert.equal(reads(f).length, 2, 'the journal resumes once the failure is gone');
});

test('a database without the reads sidecar still serves the read; a writable reopen installs the sidecar', t => {
  const f = fixture(t), id = f.receipt.receiptId;
  f.store.db.exec('DROP TABLE public_work_review_reads');
  const unjournaled = f.service().contributorReview(f.producer.secret, id);
  assert.equal(unjournaled.review.state, 'pending', 'the read succeeds with the sidecar absent');
  assert.equal(f.service().verifySchema({ allowAbsent: true }), true, 'an absent reads sidecar is tolerated, mirroring the versions sidecar');
  assert.equal(f.service().verifySchema(), true, 'sidecar absence is not drift even without allowAbsent');
  f.reopen();
  assert.equal(f.service().verifySchema(), true);
  f.service().contributorReview(f.producer.secret, id);
  assert.equal(reads(f).length, 1, 'the reopened store journals again');
});

test('a drifted reads sidecar is refused as operator reconciliation', t => {
  const f = fixture(t);
  f.store.db.exec('DROP TABLE public_work_review_reads; CREATE TABLE public_work_review_reads (receipt_id TEXT)');
  assert.throws(() => f.service().verifySchema(), /Public work review schema requires operator reconciliation/);
  assert.throws(() => f.service().verifySchema({ allowAbsent: true }), /Public work review schema requires operator reconciliation/);
});

test('the reads table carries the sidecar registrations of its siblings', () => {
  assert.ok(unfencedAdditiveTables.includes('public_work_review_reads'), 'writer fence: unfenced additive, like public_work_review_versions');
  assert.ok(applicationTables.includes('public_work_review_reads'), 'the recovery audit table set includes the journal');
  const purge = PURGE_TABLES.filter(entry => entry.table === 'public_work_review_reads');
  assert.equal(purge.length, 1, 'exactly one purge entry');
  assert.equal(purge[0].key, 'room_id'); assert.equal(purge[0].action, 'delete');
  assert.deepEqual(purge[0].match, { room: ['room_id'] });
});
