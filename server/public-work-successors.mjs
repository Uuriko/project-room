import { createHash } from 'node:crypto';
import { canonicalJson } from '../src/audit-receipts.mjs';
import { validId } from '../src/events.js';
import { ServiceError } from './service-error.mjs';
import { isGuestAgentMemberId } from './guest-agent-links.mjs';

// An explicitly published new unpaid task; parent receipt/review and balances
// remain unchanged. Creation neither reopens nor assigns a claim.
export const publicWorkSuccessorsSchema = `
CREATE TABLE IF NOT EXISTS public_work_successors (
  parent_receipt_id TEXT PRIMARY KEY, room_id TEXT NOT NULL,
  child_offer_id TEXT NOT NULL UNIQUE, terms_version INTEGER NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS public_work_successor_requests (
  room_id TEXT NOT NULL, actor_id TEXT NOT NULL, request_id TEXT NOT NULL,
  input_json TEXT NOT NULL, outcome_json TEXT NOT NULL,
  PRIMARY KEY(room_id,actor_id,request_id)
);`;
const fail = (status, code, message) => { throw new ServiceError(status, code, message); };
const check = (ok, message) => { if (!ok) fail(422, 'invalid_follow_up', message); };
const normalize = sql => sql?.trim().replace(/;$/, '').replace(/IF NOT EXISTS /g, '').replace(/\s+/g, ' ');
const required = ['requestId', 'expectedReviewRevision', 'taskId', 'expectedTermsVersion', 'generation', 'artifactSha256', 'successorTaskId', 'terms', 'repositoryRef', 'files'];
export class PublicWorkSuccessors {
  constructor(store) { this.store = store; this.db = store.db; }
  verifySchema({ allowAbsent = false } = {}) {
    const shapes = publicWorkSuccessorsSchema.trim().split(/;\s*(?=CREATE|$)/).filter(Boolean).map(sql => ({ sql,
      actual: this.db.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(/CREATE TABLE IF NOT EXISTS ([a-z_]+)/.exec(sql)[1])?.sql }));
    if (allowAbsent && shapes.every(shape => shape.actual === undefined)) return false;
    if (shapes.some(shape => normalize(shape.sql) !== normalize(shape.actual))) throw new Error('Public work follow-up schema requires operator reconciliation');
    return true;
  }
  owner(roomId, ownerId) {
    const state = this.store.projectOffers.requireOwner(roomId, ownerId), member = state.members[ownerId];
    if (!member || member.active === false || isGuestAgentMemberId(ownerId)) fail(403, 'owner_only', 'Current non-guest room owner required');
    return state;
  }
  link(receiptId) {
    check(validId(receiptId), 'Invalid parent receipt');
    if (!this.verifySchema({ allowAbsent: true })) return null;
    const row = this.db.prepare('SELECT child_offer_id,terms_version FROM public_work_successors WHERE parent_receipt_id=?').get(receiptId);
    if (!row) return null;
    let available = true;
    try { this.store.publicWorkClaims.read(row.child_offer_id); }
    catch (error) { if (![404, 409].includes(error.status)) throw error; available = false; }
    return { taskId: row.child_offer_id, termsVersion: row.terms_version, available };
  }
  create(roomId, ownerId, receiptId, input) {
    check(validId(roomId) && validId(ownerId) && validId(receiptId), 'Invalid follow-up identifier');
    check(input && typeof input === 'object' && !Array.isArray(input) && required.every(key => Object.hasOwn(input, key))
      && Object.keys(input).every(key => required.includes(key)), 'Unexpected or missing follow-up fields');
    check(validId(input.requestId) && validId(input.taskId) && validId(input.successorTaskId)
      && Number.isSafeInteger(input.expectedReviewRevision) && input.expectedReviewRevision > 0
      && Number.isSafeInteger(input.expectedTermsVersion) && input.expectedTermsVersion > 0
      && Number.isSafeInteger(input.generation) && input.generation > 0
      && typeof input.artifactSha256 === 'string' && /^[a-f0-9]{64}$/.test(input.artifactSha256), 'Invalid original submission binding');
    return this.store.transaction(() => {
      this.owner(roomId, ownerId); this.verifySchema();
      const encoded = canonicalJson({ receiptId, ...input });
      const previous = this.db.prepare('SELECT * FROM public_work_successor_requests WHERE room_id=? AND actor_id=? AND request_id=?').get(roomId, ownerId, input.requestId);
      if (previous) {
        if (previous.input_json !== encoded) fail(409, 'request_id_reused', 'Follow-up request ID was used for different input');
        return JSON.parse(previous.outcome_json);
      }
      const scope = this.store.publicWorkReviews.scope(roomId, ownerId, receiptId), receipt = scope.receipt;
      if (input.taskId !== receipt.taskId || input.expectedTermsVersion !== receipt.termsVersion || input.generation !== receipt.generation || input.artifactSha256 !== receipt.artifact.sha256)
        fail(409, 'stale_review_receipt', 'Follow-up must identify the exact original submission');
      const review = this.store.publicWorkReviews.current(scope);
      if (review.revision !== input.expectedReviewRevision) fail(409, 'stale_review', 'Review changed; inspect it again');
      if (review.state !== 'revision_requested') fail(409, 'follow_up_not_requested', 'An explicit revision request is required');
      if (scope.offer.status !== 'published') fail(409, 'follow_up_unavailable', 'Original offer must still be published');
      if (this.db.prepare('SELECT 1 FROM public_work_successors WHERE parent_receipt_id=?').get(receiptId)) fail(409, 'follow_up_exists', 'This submission already has a follow-up task');
      check(input.terms?.reward?.kind === 'unpaid' && scope.offer.reward.kind === 'unpaid', 'Follow-up must be unpaid');
      check(input.terms?.approvalPolicy?.mode === scope.offer.approvalPolicy.mode && input.terms?.repositoryUrl === scope.offer.repositoryUrl,
        'Retain the original approval mode and repository URL');
      // Existing services retain their own journals inside the outer atomic
      // transaction; derived IDs cannot alias another parent's request.
      const request = action => 'follow_' + createHash('sha256').update(canonicalJson({ roomId, ownerId, receiptId, requestId: input.requestId, action })).digest('hex');
      const child = this.store.projectOffers.create(roomId, ownerId, { requestId: request('create'), offerId: input.successorTaskId,
        terms: input.terms, reviewerMemberIds: scope.offer.reviewerMemberIds, ...(scope.offer.workItemId ? { workItemId: scope.offer.workItemId } : {}) });
      const published = this.store.projectOffers.transition(roomId, ownerId, child.id, 'publish', { requestId: request('publish'), expectedRevision: child.revision });
      const task = this.store.publicWorkClaims.enable(roomId, ownerId, child.id, { requestId: request('enable'), expectedRevision: published.revision,
        expectedTermsVersion: published.version, repositoryRef: input.repositoryRef, files: input.files });
      this.db.prepare('INSERT INTO public_work_successors VALUES (?,?,?,?,?)').run(receiptId, roomId, child.id, task.termsVersion, this.store.now());
      const outcome = { followUp: { taskId: task.taskId, termsVersion: task.termsVersion, available: true }, task };
      this.db.prepare('INSERT INTO public_work_successor_requests VALUES (?,?,?,?,?)').run(roomId, ownerId, input.requestId, encoded, JSON.stringify(outcome));
      return outcome;
    });
  }
}
