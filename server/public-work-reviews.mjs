import { validId, roomPolicy } from '../src/events.js';
import { canonicalJson } from '../src/audit-receipts.mjs';
import { ServiceError } from './service-error.mjs';

// Private review is a separate fact. Submission bytes, public receipt, leases,
// work gates, credit balances and payment state are never changed here.
export const publicWorkReviewsSchema = `
CREATE TABLE IF NOT EXISTS public_work_reviews (
  receipt_id TEXT PRIMARY KEY, room_id TEXT NOT NULL, revision INTEGER NOT NULL, state_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS public_work_review_requests (
  room_id TEXT NOT NULL, actor_id TEXT NOT NULL, request_id TEXT NOT NULL,
  input_json TEXT NOT NULL, outcome_json TEXT NOT NULL,
  PRIMARY KEY(room_id,actor_id,request_id)
);`;
const fail = (status, code, message) => { throw new ServiceError(status, code, message); };
const check = (ok, message) => { if (!ok) fail(422, 'invalid_public_review', message); };
const normalize = sql => sql?.trim().replace(/;$/, '').replace(/IF NOT EXISTS /g, '').replace(/\s+/g, ' ');
const knownMember = (state, actorId) => {
  const actor = state.members[actorId];
  if (!actor || actor.active === false) fail(403, 'review_forbidden', 'Current room membership required');
  return actor;
};
export class PublicWorkReviews {
  constructor(store) { this.store = store; this.db = store.db; }
  verifySchema({ allowAbsent = false } = {}) {
    const shapes = publicWorkReviewsSchema.trim().split(/;\s*(?=CREATE|$)/).filter(Boolean).map(sql => ({ sql,
      actual: this.db.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(/CREATE TABLE IF NOT EXISTS ([a-z_]+)/.exec(sql)[1])?.sql }));
    if (allowAbsent && shapes.every(shape => shape.actual === undefined)) return false;
    if (shapes.some(shape => normalize(shape.sql) !== normalize(shape.actual))) throw new Error('Public work review schema requires operator reconciliation');
    return true;
  }
  hasTable(name) { return Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)); }
  scope(roomId, actorId, receiptId) {
    check(validId(roomId) && validId(actorId) && validId(receiptId), 'Invalid review identifier');
    const { state } = this.store.room(roomId);
    const actor = knownMember(state, actorId);
    if (state.room.archivedAt) fail(409, 'room_archived', 'Archived rooms cannot review contributions');
    if (!this.hasTable('public_work_receipts')) fail(404, 'review_not_found', 'Contribution not found in this room');
    // Room qualification precedes any public receipt or private binding lookup.
    const row = this.db.prepare(`SELECT r.*,t.room_id,t.repository_ref,t.files_json FROM public_work_receipts r
      JOIN public_work_tasks t ON t.offer_id=r.offer_id WHERE r.receipt_id=? AND t.room_id=?`).get(receiptId, roomId);
    if (!row) fail(404, 'review_not_found', 'Contribution not found in this room');
    const offerRow = this.db.prepare('SELECT * FROM project_offers WHERE offer_id=? AND room_id=?').get(row.offer_id, roomId);
    const offer = this.store.projectOffers.record(offerRow, true);
    const work = offer.workItemId ? state.workItems[offer.workItemId] : null;
    if (offer.workItemId && (!work || work.state === 'superseded')) fail(409, 'review_policy_changed', 'Linked work review policy is unavailable');
    const receipt = JSON.parse(row.receipt_json), policy = roomPolicy(state);
    const fingerprint = canonicalJson({ receiptId, taskId: receipt.taskId, termsVersion: receipt.termsVersion,
      generation: receipt.generation, sha256: receipt.artifact.sha256, approvalPolicy: offer.approvalPolicy,
      reviewers: offer.reviewerMemberIds, reviewerStanding: offer.reviewerMemberIds.map(id => { const member = state.members[id]; return { id, revision: member?.revision, kind: member?.kind, active: member?.active, permissions: member?.permissions }; }), policy, work: work ? { id: work.id, revision: work.revision,
        accountableMemberId: work.accountableMemberId, verifierMemberId: work.verifierMemberId,
        humanDecisionMakerId: work.humanDecisionMakerId, independentVerificationRequired: work.independentVerificationRequired,
        ownerDecisionRequired: work.ownerDecisionRequired, state: work.state } : null });
    return { roomId, actorId, state, actor, receipt, offer, work, policy, fingerprint, task: { repositoryRef: row.repository_ref, files: JSON.parse(row.files_json) } };
  }
  selfReviewer(scope, actorId) {
    return actorId === scope.receipt.identityId || scope.state.members[actorId]?.identityId === scope.receipt.identityId || Boolean(this.db.prepare('SELECT 1 FROM identity_links WHERE room_id=? AND member_id=? AND identity_id=?')
      .get(scope.roomId, actorId, scope.receipt.identityId));
  }
  permissions(scope, actorId) {
    const actor = scope.state.members[actorId], mode = scope.offer.approvalPolicy.mode;
    if (!actor || actor.active === false || !scope.offer.reviewerMemberIds.includes(actorId) || this.selfReviewer(scope, actorId)) return { decide: false, verify: false };
    const humanRequired = scope.policy.requireOwnerDecision || scope.work?.ownerDecisionRequired;
    const human = actor.kind === 'human' && actor.permissions?.includes('decide') === true;
    const agent = actor.kind === 'agent' && actor.permissions?.includes('verify') === true;
    const designatedHuman = !humanRequired || actorId === (scope.work?.humanDecisionMakerId ?? scope.state.room.ownerId);
    const independent = Boolean(scope.policy.requireIndependentReview || scope.work?.independentVerificationRequired);
    const designatedVerifier = !scope.work?.verifierMemberId || actorId === scope.work.verifierMemberId;
    const distinctAccountable = !independent || actorId !== scope.work?.accountableMemberId;
    return {
      decide: mode === 'agent' ? agent && !humanRequired && designatedVerifier : human && designatedHuman,
      verify: designatedVerifier && distinctAccountable && actor.permissions?.includes('verify') === true
        && (mode === 'human' ? independent && actor.kind === 'human' : actor.kind === 'agent')
    };
  }
  current(scope) {
    const row = this.hasTable('public_work_reviews') && this.db.prepare('SELECT * FROM public_work_reviews WHERE receipt_id=? AND room_id=?').get(scope.receipt.receiptId, scope.roomId);
    return row ? JSON.parse(row.state_json) : { revision: 0, state: 'pending', verification: null, decision: null };
  }
  passCurrent(scope, review) {
    const evidence = review.verification;
    return evidence?.verdict === 'PASS' && evidence.fingerprint === scope.fingerprint && this.permissions(scope, evidence.actorId).verify;
  }
  needsPass(scope) { return scope.offer.approvalPolicy.mode !== 'human' || scope.policy.requireIndependentReview || scope.work?.independentVerificationRequired; }
  view(scope) {
    const review = this.current(scope), permissions = this.permissions(scope, scope.actorId);
    const terminal = ['accepted', 'rejected'].includes(review.state);
    const ready = !this.needsPass(scope) || this.passCurrent(scope, review);
    const { fingerprint: ignored, ...evidence } = review.verification ?? {};
    void ignored;
    return { receipt: scope.receipt, offer: { id: scope.offer.id, title: scope.offer.title, summary: scope.offer.summary, acceptanceCriteria: scope.offer.acceptanceCriteria,
        exclusions: scope.offer.exclusions, repositoryUrl: scope.offer.repositoryUrl, status: scope.offer.status, approvalPolicy: scope.offer.approvalPolicy },
      task: scope.task,
      review: { schema: 'public-work-review/1', receiptId: scope.receipt.receiptId, taskId: scope.receipt.taskId,
        termsVersion: scope.receipt.termsVersion, generation: scope.receipt.generation, artifactSha256: scope.receipt.artifact.sha256,
        revision: review.revision, state: review.state, verification: review.verification ? { ...evidence, current: this.passCurrent(scope, review) } : null, decision: review.decision },
      authority: { canDecide: permissions.decide && !terminal, canVerify: permissions.verify && !terminal,
        acceptReady: permissions.decide && ready && !terminal,
        reason: terminal ? 'Review decision is final.' : !permissions.decide ? 'A designated reviewer must decide.' : !ready ? 'A current independent PASS is required.' : 'Ready for an explicit decision.' } };
  }
  inspect(roomId, actorId, receiptId) {
    return this.store.readTransaction(() => {
      const scope = this.scope(roomId, actorId, receiptId), authority = this.permissions(scope, actorId);
      if (scope.state.room.ownerId !== actorId && !authority.decide && !authority.verify) fail(403, 'review_forbidden', 'Only the owner or designated reviewer may inspect');
      return this.view(scope);
    });
  }
  results(roomId, actorId, { limit = 20, after = '' } = {}) {
    check(Number.isInteger(limit) && limit > 0 && limit <= 100 && (after === '' || validId(after)), 'Invalid result page');
    return this.store.readTransaction(() => {
      this.store.projectOffers.requireOwner(roomId, actorId);
      knownMember(this.store.room(roomId).state, actorId);
      if (!this.hasTable('public_work_receipts')) return { results: [], nextCursor: null };
      const rows = this.db.prepare(`SELECT r.receipt_id FROM public_work_receipts r JOIN public_work_tasks t ON t.offer_id=r.offer_id
        WHERE t.room_id=? AND r.receipt_id>? ORDER BY r.receipt_id LIMIT ?`).all(roomId, after, limit + 1);
      return { results: rows.slice(0, limit).map(row => this.view(this.scope(roomId, actorId, row.receipt_id))), nextCursor: rows.length > limit ? rows[limit - 1].receipt_id : null };
    });
  }
  contributorReview(secret, receiptId) {
    check(validId(receiptId), 'Invalid receipt ID');
    return this.store.readTransaction(() => {
      const identity = this.store.identities.resolveGlobalIdentitySecret(secret);
      if (!identity) fail(401, 'unauthenticated', 'Unknown or revoked identity');
      if (!this.hasTable('public_work_receipts')) fail(404, 'review_not_found', 'Contribution not found');
      const row = this.db.prepare('SELECT receipt_json FROM public_work_receipts WHERE receipt_id=? AND identity_id=?').get(receiptId, identity.identityId);
      if (!row) fail(404, 'review_not_found', 'Contribution not found');
      const receipt = JSON.parse(row.receipt_json);
      const saved = this.hasTable('public_work_reviews') && this.db.prepare('SELECT state_json FROM public_work_reviews WHERE receipt_id=?').get(receiptId);
      const current = saved ? JSON.parse(saved.state_json) : { revision: 0, state: 'pending' };
      return { receiptId, taskId: receipt.taskId, termsVersion: receipt.termsVersion, generation: receipt.generation,
        artifactSha256: receipt.artifact.sha256, review: { revision: current.revision, state: current.state,
          ...(current.decision ? { decision: current.decision.decision, reason: current.decision.reason, decidedAt: current.decision.at } : {}),
          ...(current.verification ? { verificationVerdict: current.verification.verdict, verificationReviewerKind: current.verification.reviewerKind } : {}) } };
    });
  }
  decide(roomId, actorId, receiptId, input) { return this.mutate(roomId, actorId, receiptId, 'decide', input); }
  verify(roomId, actorId, receiptId, input) { return this.mutate(roomId, actorId, receiptId, 'verify', input); }
  mutate(roomId, actorId, receiptId, action, input) {
    const keys = ['requestId', 'expectedReviewRevision', 'taskId', 'expectedTermsVersion', 'generation', 'artifactSha256', 'reason', action === 'decide' ? 'decision' : 'verdict'];
    check(input && typeof input === 'object' && !Array.isArray(input) && keys.every(key => Object.hasOwn(input, key)) && Object.keys(input).every(key => keys.includes(key)), 'Unexpected or missing review fields');
    check(validId(input.requestId) && validId(input.taskId) && Number.isSafeInteger(input.expectedReviewRevision) && input.expectedReviewRevision >= 0
      && Number.isSafeInteger(input.expectedTermsVersion) && input.expectedTermsVersion > 0 && Number.isSafeInteger(input.generation) && input.generation > 0
      && typeof input.artifactSha256 === 'string' && /^[a-f0-9]{64}$/.test(input.artifactSha256), 'Invalid review binding');
    check(typeof input.reason === 'string' && input.reason.trim().length > 0 && input.reason.length <= 2000 && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(input.reason), 'A concise review reason is required');
    check(action === 'decide' ? ['accepted', 'rejected', 'revision_requested'].includes(input.decision) : ['PASS', 'FAIL'].includes(input.verdict), 'Invalid review action');
    return this.store.transaction(() => {
      const scope = this.scope(roomId, actorId, receiptId), permission = this.permissions(scope, actorId);
      if (!permission[action]) fail(403, 'review_forbidden', 'Only the current designated reviewer may perform this action');
      const encoded = canonicalJson({ action, receiptId, ...input });
      const previous = this.db.prepare('SELECT * FROM public_work_review_requests WHERE room_id=? AND actor_id=? AND request_id=?').get(roomId, actorId, input.requestId);
      if (previous) {
        if (previous.input_json !== encoded) fail(409, 'request_id_reused', 'Review request ID was used for different input');
        return JSON.parse(previous.outcome_json);
      }
      const receipt = scope.receipt, current = this.current(scope);
      if (input.taskId !== receipt.taskId || input.expectedTermsVersion !== receipt.termsVersion || input.generation !== receipt.generation || input.artifactSha256 !== receipt.artifact.sha256)
        fail(409, 'stale_review_receipt', 'Review must identify this exact submission');
      if (current.revision !== input.expectedReviewRevision) fail(409, 'stale_review', 'Review changed; inspect it again');
      if (['accepted', 'rejected'].includes(current.state)) fail(409, 'review_final', 'Review decision is final');
      const at = new Date(this.store.now()).toISOString();
      if (action === 'verify') current.verification = { verdict: input.verdict, reviewerKind: scope.actor.kind, actorId, reason: input.reason, at, fingerprint: scope.fingerprint };
      else {
        if (input.decision === 'accepted' && this.needsPass(scope) && !this.passCurrent(scope, current)) fail(409, 'review_pass_required', 'Acceptance requires a current authorized independent PASS');
        current.state = input.decision; current.decision = { decision: input.decision, actorId, reason: input.reason, at };
      }
      current.revision += 1;
      this.db.prepare('INSERT INTO public_work_reviews VALUES (?,?,?,?) ON CONFLICT(receipt_id) DO UPDATE SET revision=excluded.revision,state_json=excluded.state_json')
        .run(receiptId, roomId, current.revision, JSON.stringify(current));
      const outcome = this.view(scope);
      this.db.prepare('INSERT INTO public_work_review_requests VALUES (?,?,?,?,?)').run(roomId, actorId, input.requestId, encoded, JSON.stringify(outcome));
      return outcome;
    });
  }
}
