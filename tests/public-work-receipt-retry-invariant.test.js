// PRODUCT-200 reliability slice A11: RECEIPT CHAIN INTEGRITY ON RETRY.
//
// Invariant: for public work, the receipt chain
//   request journal (public_work_requests) -> receipt row (public_work_receipts) -> read-back
// must stay single and self-consistent across retries:
//   1. complete work -> request receipt (finish) -> retry the SAME receipt request
//      (identical input, same requestId) -> the response carries the identical
//      receipt id and artifact hash, and exactly ONE receipt row exists;
//   2. the receipt verifies through the hash_only path: sha256 of the exact
//      submitted UTF-8 bytes equals receipt.artifact.sha256, the stored row's
//      artifact_sha256, and the journaled/read-back receipt JSON;
//   3. a receipt request for already-receipted work (new requestId) is refused
//      cleanly with public_work_already_submitted — the original receipt is
//      returned by reads, and no second row is ever minted;
//   4. reusing the receipt requestId with DIFFERENT input is rejected as
//      request_id_reused — a retry may never fork the chain with new bytes.
//
// Fail-first via mutation: with the already-submitted guard removed from
// PublicWorkClaims.apply (or the request-journal replay disabled), this suite
// fails — the re-request either crashes on the receipt_id primary key instead
// of returning the clean 409, or the replay returns a second minted receipt.
// Reverting the mutation turns the suite green.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { PublicWorkClaims, publicWorkClaimsSchema } from '../server/public-work-claims.mjs';
import { publicWorkClaimFenceSchema, verifyPublicWorkClaimFence } from '../server/public-work-claim-fence.mjs';

// Real store/identity/offer/lease boundary; registration/HTTP/workerd keepers
// independently own transport and old-writer fencing. No registry doubles.
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'public-work-receipt-retry-')), file = join(dir, 'room.sqlite');
  let clock = Date.now(), store = new RoomStore(file, { now: () => clock });
  store.initialize(initialRoom());
  store.db.exec(publicWorkClaimsSchema); store.db.exec(publicWorkClaimFenceSchema);
  const identities = [store.identities.create('Receipt worker')];
  const service = () => new PublicWorkClaims(store);
  const enable = (id, files = ['src/shared.js']) => {
    const input = { requestId: `create-${id}`, offerId: id, reviewerMemberIds: ['owner'],
      terms: { kind: 'task', title: id, summary: 'Public result', acceptanceCriteria: ['Deliver the declared change'],
        repositoryUrl: 'https://github.com/Example/Project', reward: { kind: 'unpaid' }, approvalPolicy: { mode: 'human' } } };
    store.projectOffers.create('commons', 'owner', input);
    store.projectOffers.transition('commons', 'owner', id, 'publish', { requestId: `publish-${id}`, expectedRevision: 1 });
    return service().enable('commons', 'owner', id, { requestId: `enable-${id}`, expectedRevision: 2,
      expectedTermsVersion: 1, repositoryRef: 'main', files });
  };
  const counts = (taskId, generation) => ({
    receipts: store.db.prepare('SELECT count(*) AS n FROM public_work_receipts WHERE offer_id=? AND generation=?').get(taskId, generation).n,
    allReceipts: store.db.prepare('SELECT count(*) AS n FROM public_work_receipts').get().n,
    requests: store.db.prepare('SELECT count(*) AS n FROM public_work_requests WHERE offer_id=?').get(taskId).n,
  });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { get store() { return store; }, service, identities, enable, counts,
    tick(ms) { clock += ms; }, reopen() { store.close(); store = new RoomStore(file, { now: () => clock }); } };
}
const finishInput = (requestId, generation, artifactText) => ({
  requestId, expectedTermsVersion: 1, generation, artifactText, checksReported: ['Caller says tests passed'],
});
const code = expected => error => error.code === expected;

// The hash_only verification path: the receipt names no signature; trust comes
// from the artifact bytes hashing to the committed sha256.
const verifyHashOnly = (receipt, artifactText) => {
  assert.equal(receipt.schema, 'public-work-receipt/1');
  assert.equal(receipt.verification, 'hash_only');
  assert.equal(receipt.artifact.sha256, createHash('sha256').update(Buffer.from(artifactText)).digest('hex'));
  assert.equal(receipt.artifact.bytes, Buffer.byteLength(artifactText));
};

test('retried receipt request returns the identical receipt and keeps exactly one receipt row', t => {
  const f = fixture(t), [worker] = f.identities;
  const taskId = 'retry-receipt-task';
  f.enable(taskId);
  f.service().act(taskId, worker.secret, 'claim', { requestId: 'claim-1', expectedTermsVersion: 1 });
  const artifactText = 'Unicode 🐈\nquoted "text"\tescaped \\ bytes';
  const args = finishInput('finish-1', 1, artifactText);

  // Complete work -> request receipt.
  const first = f.service().act(taskId, worker.secret, 'finish', args);
  assert.equal(first.action, 'submitted');
  assert.equal(first.task.claim.state, 'submitted');
  verifyHashOnly(first.receipt, artifactText);
  assert.ok(/^pwr_[0-9a-f]{64}$/.test(first.receipt.receiptId), 'receipt id is content-addressed');
  assert.deepEqual(f.counts(taskId, 1), { receipts: 1, allReceipts: 1, requests: 3 });
  assert.equal(verifyPublicWorkClaimFence(f.store.db), true, 'writer permit closed at rest');

  // Retry the identical receipt request (same requestId, same input):
  // the journaled outcome replays — identical receipt id and hash.
  const second = f.service().act(taskId, worker.secret, 'finish', args);
  assert.deepEqual(second, first, 'retry replays the journaled outcome byte-for-byte');
  assert.equal(second.receipt.receiptId, first.receipt.receiptId);
  assert.equal(second.receipt.artifact.sha256, first.receipt.artifact.sha256);
  assert.deepEqual(f.counts(taskId, 1), { receipts: 1, allReceipts: 1, requests: 3 }, 'retry minted no second row');

  // The receipt verifies through the hash_only path against the stored row.
  const row = f.store.db.prepare('SELECT * FROM public_work_receipts WHERE receipt_id=?').get(first.receipt.receiptId);
  assert.ok(row, 'exactly one receipt row for the minted receipt');
  assert.equal(row.artifact_sha256, first.receipt.artifact.sha256);
  assert.equal(createHash('sha256').update(Buffer.from(row.artifact_text)).digest('hex'), first.receipt.artifact.sha256);
  const stored = JSON.parse(row.receipt_json);
  assert.equal(stored.artifact.sha256, first.receipt.artifact.sha256);
  assert.equal(stored.verification, 'hash_only');

  // Reads return the original receipt — no second version of the truth.
  assert.deepEqual(f.service().receipt(first.receipt.receiptId), first.receipt);
  assert.deepEqual(f.service().artifact(first.receipt.receiptId),
    { artifactText, sha256: first.receipt.artifact.sha256, bytes: first.receipt.artifact.bytes });

  // The chain survives a restart: the journaled outcome still replays.
  f.tick(1000); f.reopen();
  assert.deepEqual(f.service().act(taskId, worker.secret, 'finish', args), first);
  assert.deepEqual(f.service().receipt(first.receipt.receiptId), first.receipt);
  assert.deepEqual(f.counts(taskId, 1), { receipts: 1, allReceipts: 1, requests: 3 });
});

test('a second receipt request for already-receipted work is refused without minting a new row', t => {
  const f = fixture(t), [worker] = f.identities;
  const taskId = 'receipt-once-task';
  f.enable(taskId);
  f.service().act(taskId, worker.secret, 'claim', { requestId: 'claim-1', expectedTermsVersion: 1 });
  const artifactText = 'Delivered result';
  const first = f.service().act(taskId, worker.secret, 'finish', finishInput('finish-1', 1, artifactText));
  verifyHashOnly(first.receipt, artifactText);
  const before = f.counts(taskId, 1);
  assert.deepEqual(before, { receipts: 1, allReceipts: 1, requests: 3 });

  // A fresh requestId for the same already-receipted work must be refused
  // cleanly — never minted into a second receipt row.
  let err = null;
  try {
    f.service().act(taskId, worker.secret, 'finish', finishInput('finish-2', 1, artifactText));
  } catch (error) { err = error; }
  assert.ok(err, 'second receipt request throws');
  assert.equal(err.code, 'public_work_already_submitted');
  assert.equal(err.status, 409);
  assert.deepEqual(f.counts(taskId, 1), before, 'refused request minted no row and left no journal entry');

  // The original receipt is what reads return — the chain was not forked.
  assert.deepEqual(f.service().receipt(first.receipt.receiptId), first.receipt);
  verifyHashOnly(f.service().receipt(first.receipt.receiptId), artifactText);
});

test('reusing a receipt request id with different input is rejected as a chain fork', t => {
  const f = fixture(t), [worker] = f.identities;
  const taskId = 'receipt-fork-task';
  f.enable(taskId);
  f.service().act(taskId, worker.secret, 'claim', { requestId: 'claim-1', expectedTermsVersion: 1 });
  const first = f.service().act(taskId, worker.secret, 'finish', finishInput('finish-1', 1, 'Original bytes'));
  const before = f.counts(taskId, 1);
  assert.deepEqual(before, { receipts: 1, allReceipts: 1, requests: 3 });

  // Same requestId, different artifact bytes: not a retry — a fork attempt.
  assert.throws(
    () => f.service().act(taskId, worker.secret, 'finish', finishInput('finish-1', 1, 'Swapped bytes')),
    code('request_id_reused'));
  assert.deepEqual(f.counts(taskId, 1), before, 'fork attempt changed nothing');
  assert.deepEqual(f.service().receipt(first.receipt.receiptId), first.receipt);
});
