// Adverse-decision packets and subject notices (accountability R-4 + R-6,
// issue #3615).
//
// R-4: when a verdict goes against a person — a rejected public-work
// submission, a failed verification, a bounty rejection — the affected
// subject can generate, on demand, a packet in plain language: what was
// decided and why, the principal factors from the recorded reason (and
// per-criterion outcomes when the decision record carries them), whether
// agents participated, the data the decision relied on, a correction path
// for wrong data (distinct from a dispute: it fixes the record, it does
// not re-open the verdict or move money), and a human-review route whose
// reviewer is never the original decider. The packet is readable by the
// subject's own identity without membership in the reviewer surface,
// following the contributorReview posture: no reviewer member ids leak.
//
// R-6: notices are records. When a subject is told an agent will perform
// or review their work, the delivery writes a subject_notices row carrying
// the notice content version, the exact text delivered, the recipient,
// the channel and the timestamp. The wired delivery paths are the two
// claim moments (public-work claim, bounty claim); the packet for a
// decision lists the notices on record for that subject and work item.
//
// Human review reuses the platform's existing authority shapes — the
// linked work item's designated human decision maker, the room owner, a
// bounty's designated dispute decider or verifier (the arbiter machinery
// of server/dispute-arbiters.mjs seats deciders distinct from the
// parties) — it does not build a second dispute system. A review request
// is a recorded routing, not a new verdict: the routed human acts through
// the surfaces they already hold.
import { randomUUID } from 'node:crypto';
import { validId } from '../src/events.js';
import { ServiceError } from './service-error.mjs';

export const adverseDecisionPacketsSchema = `
CREATE TABLE IF NOT EXISTS subject_notices (
  notice_id TEXT PRIMARY KEY, room_id TEXT, recipient TEXT NOT NULL, channel TEXT NOT NULL,
  notice_kind TEXT NOT NULL, content_version TEXT NOT NULL, content_text TEXT NOT NULL,
  agent_involved INTEGER NOT NULL, subject_ref TEXT, context_json TEXT NOT NULL, delivered_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS subject_notices_recipient ON subject_notices(recipient, subject_ref);
CREATE TABLE IF NOT EXISTS adverse_decision_followups (
  followup_id TEXT PRIMARY KEY, packet_kind TEXT NOT NULL, packet_ref TEXT NOT NULL, room_id TEXT,
  subject TEXT NOT NULL, kind TEXT NOT NULL, statement TEXT NOT NULL,
  routed_to TEXT, routed_to_role TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS adverse_decision_followups_packet ON adverse_decision_followups(packet_kind, packet_ref);`;
const fail = (status, code, message) => { throw new ServiceError(status, code, message); };
const check = (ok, message) => { if (!ok) fail(422, 'invalid_decision_packet', message); };
const normalize = sql => sql?.trim().replace(/;$/, '').replace(/IF NOT EXISTS /g, '').replace(/\s+/g, ' ');

// --- R-6: notice content -------------------------------------------------
// The text a subject is actually told at claim time, versioned so a later
// template edit never rewrites what a past delivery said: the row stores
// the version AND the exact text snapshot.
export const AGENT_PARTICIPATION_NOTICE_VERSION = 'agent-participation-notice/1';
export function agentParticipationNotice({ mode, title } = {}) {
  const what = typeof title === 'string' && title.length > 0 ? ` for "${title}"` : '';
  const tail = ' If a decision goes against you, you can read the full decision packet, file a correction if any information in it is wrong, and ask for a human review by someone who was not the original decider.';
  if (mode === 'agent') return { contentVersion: AGENT_PARTICIPATION_NOTICE_VERSION, agentInvolved: true,
    text: `An automated agent will review the work you submit${what} and can accept or reject it. No human checks the decision first.${tail}` };
  if (mode === 'human_with_agent_review') return { contentVersion: AGENT_PARTICIPATION_NOTICE_VERSION, agentInvolved: true,
    text: `An automated agent will check the work you submit${what} first, and a human will make the final decision.${tail}` };
  if (mode === 'legacy') return { contentVersion: AGENT_PARTICIPATION_NOTICE_VERSION, agentInvolved: false,
    text: `The poster, or a verifier the poster named, will review the work you submit${what}.${tail}` };
  return { contentVersion: AGENT_PARTICIPATION_NOTICE_VERSION, agentInvolved: false,
    text: `A human will review the work you submit${what}. No automated agent decides whether it is accepted.${tail}` };
}

// Write one notice record. Safe to call inside the caller's transaction:
// the schema exec is idempotent, so surfaces whose store never booted the
// packet service (escrow unit doubles) still record correctly.
export function recordNotice(db, { roomId = null, recipient, channel, subjectRef = null, mode, title = null, context = {} } = {}) {
  check(typeof recipient === 'string' && recipient.length > 0, 'Notice recipient is required');
  check(typeof channel === 'string' && channel.length > 0, 'Notice channel is required');
  db.exec(adverseDecisionPacketsSchema);
  const notice = agentParticipationNotice({ mode, title });
  const row = { noticeId: `ntc_${randomUUID()}`, roomId, recipient, channel,
    noticeKind: 'agent_participation', contentVersion: notice.contentVersion, contentText: notice.text,
    agentInvolved: notice.agentInvolved, subjectRef, context, deliveredAt: new Date().toISOString() };
  db.prepare('INSERT INTO subject_notices VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run(row.noticeId, row.roomId, row.recipient, row.channel, row.noticeKind, row.contentVersion,
      row.contentText, row.agentInvolved ? 1 : 0, row.subjectRef, JSON.stringify(context), row.deliveredAt);
  return { noticeId: row.noticeId, contentVersion: row.contentVersion, text: row.contentText,
    agentInvolved: row.agentInvolved, channel: row.channel, deliveredAt: row.deliveredAt };
}
export function noticesFor(db, { recipient, subjectRef } = {}) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='subject_notices'").get()) return [];
  const rows = subjectRef
    ? db.prepare('SELECT * FROM subject_notices WHERE recipient=? AND subject_ref=? ORDER BY delivered_at').all(recipient, subjectRef)
    : db.prepare('SELECT * FROM subject_notices WHERE recipient=? ORDER BY delivered_at').all(recipient);
  return rows.map(row => ({ noticeId: row.notice_id, kind: row.notice_kind, contentVersion: row.content_version,
    text: row.content_text, agentInvolved: row.agent_involved === 1, channel: row.channel, deliveredAt: row.delivered_at }));
}

// Plain-language glosses for the dispute machine's fixed reason-code
// vocabulary (server/bounty-disputes.mjs REASON_CODES).
export const REASON_CODE_GLOSSES = Object.freeze({
  'receipt-incomplete': 'The submission record was incomplete.',
  'criterion-unmet': 'A required criterion was not met.',
  'evidence-insufficient': 'The evidence provided was not enough to verify the work.',
  'duplicate-work': 'The work duplicated another submission.',
  'identity-mismatch': 'The identity on the work did not match the claimant.',
  'frivolous': 'The claim or dispute was judged frivolous.',
  'verifier-conflict': 'The verifier had a conflict of interest.',
  'no-arbitrator': 'No independent arbitrator was available.',
});

// Per-criterion outcomes ride decision records only when the recording
// surface captured them (#3613 fields are not on main yet): read every
// shape the verdict family uses — criteriaOutcomes / criterionOutcomes /
// citations with {criterionId|criterion, verdict|outcome|result} — and
// degrade to no factors when the record carries none.
function criteriaFactors(record, sourceLabel) {
  const lists = [record?.criteriaOutcomes, record?.criterionOutcomes, record?.citations];
  const factors = [];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (!entry || typeof entry !== 'object') continue;
      const name = entry.criterionId ?? entry.criterion ?? entry.name;
      const outcome = entry.verdict ?? entry.outcome ?? entry.result ?? entry.status;
      if (typeof name !== 'string' || typeof outcome !== 'string') continue;
      factors.push({ label: `Criterion "${name}": ${outcome}`, source: sourceLabel,
        detail: typeof entry.note === 'string' && entry.note.length > 0 ? entry.note
          : `The recorded outcome for this criterion was "${outcome}".` });
    }
    if (factors.length) break;
  }
  return factors;
}
function failedCheckFactors(checks, sourceLabel) {
  if (!Array.isArray(checks)) return [];
  return checks.filter(entry => entry && entry.result === 'fail' && typeof entry.name === 'string')
    .map(entry => ({ label: `Recorded check "${entry.name}" did not pass`, source: sourceLabel,
      detail: `The platform's own "${entry.name}" check recorded a fail${entry.at ? ` at ${entry.at}` : ''}.` }));
}
// Pick the first candidate who is not the original decider and, where the
// member record is known, is human. Unknown kind (a lane with no current
// member row) is accepted only for the room owner, the room's accountable
// human authority.
function pickHumanReviewer(candidates, deciderId, kindOf) {
  for (const candidate of candidates) {
    if (!candidate?.id || candidate.id === deciderId) continue;
    const kind = kindOf(candidate.id);
    if (kind && kind !== 'human') continue;
    if (!kind && candidate.role !== 'room owner') continue;
    return { id: candidate.id, role: candidate.role, kind: kind ?? 'human' };
  }
  return null;
}
function humanReviewSection(reviewer, { surface } = {}) {
  const howTo = surface === 'bounty'
    ? 'File a follow-up with kind "human_review_request" on this packet (POST /api/rooms/{roomId}/bounties/{bountyId}/decision-packet/followups). Your request is recorded on this decision and routed to the reviewer named here.'
    : 'File a follow-up with kind "human_review_request" on this packet (POST /api/public-work/receipts/{receiptId}/decision-packet/followups). Your request is recorded on this decision and routed to the reviewer named here.';
  if (!reviewer) return { available: false, reviewerRole: null, reviewerIsOriginalDecider: false, howTo,
    note: 'No human reviewer distinct from the original decider is recorded for this work, so an in-system human review route cannot be offered honestly. The correction path below still applies, and the room owner can be reached through the room.' };
  return { available: true, reviewerRole: reviewer.role, reviewerIsOriginalDecider: false, howTo,
    note: `The reviewer is the ${reviewer.role}, who did not make the original decision. A review request does not move money or change the verdict by itself; the reviewer acts through the review surfaces they already hold.` };
}
function correctionSection(followups, { surface } = {}) {
  return { distinctFromDispute: true,
    summary: 'If any information this decision relied on is wrong — for example the fingerprint does not match the work you actually sent — you can file a correction. A correction fixes the record. It does not re-open the decision and it is not a dispute: no money moves and no bond is required.',
    howTo: surface === 'bounty'
      ? 'File a follow-up with kind "correction" on this packet (POST /api/rooms/{roomId}/bounties/{bountyId}/decision-packet/followups) describing what is wrong and what it should say.'
      : 'File a follow-up with kind "correction" on this packet (POST /api/public-work/receipts/{receiptId}/decision-packet/followups) describing what is wrong and what it should say.',
    filed: followups.filter(entry => entry.kind === 'correction') };
}
function followupView(row) {
  return { followupId: row.followup_id, kind: row.kind, statement: row.statement, status: row.status,
    ...(row.routed_to_role ? { routedToRole: row.routed_to_role } : {}), createdAt: row.created_at };
}

// --- Packet builders (pure over the recorded facts) ----------------------
export function buildPublicWorkPacket({ receipt, review, offer, deciderKind, verifierKind, settlementPhase,
  reviewer, notices, followups, generatedAt }) {
  const decision = review?.decision ?? null, verification = review?.verification ?? null;
  const rejected = decision?.decision === 'rejected';
  const outcome = rejected ? 'rejected' : 'verification_failed';
  const title = offer?.title ?? receipt.title ?? 'this task';
  const reason = (rejected ? decision.reason : verification?.reason) ?? '';
  const decidedAt = rejected ? decision.at : verification?.at;
  const factors = [{ label: 'The reason recorded for the decision', source: 'decision_record',
    detail: reason || 'No reason was recorded.' },
    ...criteriaFactors(decision, 'decision_record'), ...criteriaFactors(verification, 'verification_record'),
    ...failedCheckFactors(verification?.executedChecks, 'verification_record'),
    ...failedCheckFactors(receipt.executedChecks, 'submission_record')];
  const mode = offer?.approvalPolicy?.mode ?? null;
  const agentInvolved = mode === 'agent' || mode === 'human_with_agent_review' || deciderKind === 'agent' || verifierKind === 'agent';
  const disclosure = deciderKind === 'agent'
    ? 'An automated agent made this decision.'
    : mode === 'human_with_agent_review'
      ? 'An automated agent checked your work first, and a human made the final decision.'
      : agentInvolved
        ? 'An automated agent took part in checking your work; a human made the final decision.'
        : 'A human made this decision. No automated agent decided it.';
  const dataReliedOn = [
    { label: 'The exact submission that was reviewed',
      detail: `Artifact fingerprint (SHA-256): ${receipt.artifact.sha256}. The decision was made on the submission with exactly this fingerprint. If it does not match the work you sent, file a correction.` },
    { label: 'The task terms in force', detail: `Terms version ${receipt.termsVersion}. Acceptance criteria: ${(offer?.acceptanceCriteria ?? []).join('; ') || 'none recorded'}.` },
    { label: 'Checks the platform itself ran',
      detail: [...(receipt.executedChecks ?? []), ...(verification?.executedChecks ?? [])]
        .map(entry => `${entry.name}: ${entry.result}`).join('; ') || 'No platform-run checks were recorded.' },
  ];
  if (Array.isArray(receipt.criteriaAttestation) && receipt.criteriaAttestation.length)
    dataReliedOn.push({ label: 'Your own criteria attestation (supplied by you at submission)',
      detail: receipt.criteriaAttestation.map(entry => `${entry.criterion}: ${entry.status}`).join('; ') });
  // Provenance stamps (#3612/#4041) ride the receipt when present; absent
  // fields are omitted, never fabricated.
  for (const [field, label] of [['sessionInstanceId', 'Work session instance'], ['authorizingPrincipalId', 'Authorizing principal'],
    ['claimedModel', 'Claimed model (self-reported)'], ['claimedHarness', 'Claimed harness (self-reported)']])
    if (receipt[field] != null) dataReliedOn.push({ label, detail: String(receipt[field]) });
  const consequence = settlementPhase === 'refunded'
    ? ' This task carried a credit payment: because the work was not accepted, the payment was returned to the poster in full and no payment was made to you.'
    : '';
  const explanation = rejected
    ? `Your submission for "${title}" was rejected on ${decidedAt}. The reviewer recorded this reason: "${reason}".${consequence}`
    : `A verification check on your submission for "${title}" recorded a FAIL on ${decidedAt}. The reviewer recorded this reason: "${reason}". A failed verification is recorded on your submission and can lead to rejection.`;
  return { schema: 'adverse-decision-packet/1', packetKind: 'public_work', ref: receipt.receiptId,
    generatedAt, subject: { id: receipt.identityId, kind: 'identity' },
    decision: { outcome, decidedAt, decidedBy: { kind: deciderKind ?? null, role: rejected ? 'designated reviewer' : 'designated verifier' },
      taskId: receipt.taskId, termsVersion: receipt.termsVersion },
    explanation, principalFactors: factors,
    agentParticipation: { agentInvolved, disclosure, approvalMode: mode, deciderKind: deciderKind ?? null, verifierKind: verifierKind ?? null },
    dataReliedOn, correctionPath: correctionSection(followups, { surface: 'public_work' }),
    humanReview: humanReviewSection(reviewer, { surface: 'public_work' }),
    reviewRequests: followups.filter(entry => entry.kind === 'human_review_request'),
    notices };
}

export function buildBountyPacket({ bounty, rejectedEventKind, reviewer, notices, followups, generatedAt }) {
  const resolution = bounty.resolution ?? {}, settlement = resolution.settlement ?? null;
  const reason = resolution.reason ?? settlement?.reason ?? '';
  const factors = [{ label: 'The reason recorded for the rejection', source: 'decision_record',
    detail: reason || 'No reason was recorded.' }];
  const agentInvolved = bounty.approvalMode === 'agent' || rejectedEventKind === 'agent';
  const disclosure = bounty.approvalMode === 'agent'
    ? 'This bounty used agent approval: the designated agent verifier made the rejection decision.'
    : rejectedEventKind === 'agent'
      ? 'An automated agent recorded the rejection.'
      : 'A human (the poster or their designated verifier) made the rejection decision.';
  const dataReliedOn = [
    { label: 'The work you submitted', detail: bounty.evidence
      ? `Evidence: ${bounty.evidence.evidenceUrl ?? 'none recorded'} — ${bounty.evidence.summary ?? ''}`.trim()
      : 'No submission evidence was recorded.' },
    { label: 'The fingerprint of the submission checked', detail: bounty.submissionHash ?? 'No submission hash was recorded.' },
    { label: 'The criteria in force', detail: `${bounty.criteria} (rubric version ${bounty.rubric?.version ?? 1}, hash ${bounty.rubric?.hash ?? 'unrecorded'})` },
  ];
  const flake = resolution.flake ? ` Your claim bond was forfeited and a flake strike was recorded on your lane (strike ${resolution.flake.strikes}).` : '';
  const explanation = `Your work on "${bounty.title}" was rejected by ${resolution.rejectedBy ?? 'the reviewer'} on ${resolution.rejectedAt ?? settlement?.settledAt ?? 'an unrecorded date'}. The recorded reason was: "${reason}". The payment of ${bounty.amount} credits was returned to the poster in full, and no payment was made to you.${flake}`;
  return { schema: 'adverse-decision-packet/1', packetKind: 'bounty', ref: bounty.bountyId,
    generatedAt, subject: { id: bounty.claimant, kind: 'lane' },
    decision: { outcome: 'rejected', decidedAt: resolution.rejectedAt ?? settlement?.settledAt ?? null,
      decidedBy: { id: resolution.rejectedBy ?? null, kind: rejectedEventKind ?? null, role: bounty.approvalMode === 'agent' ? 'designated agent verifier' : 'poster or designated verifier' },
      bountyId: bounty.bountyId, roomId: bounty.roomId },
    explanation, principalFactors: factors,
    agentParticipation: { agentInvolved, disclosure, approvalMode: bounty.approvalMode, deciderKind: rejectedEventKind ?? null },
    dataReliedOn, correctionPath: correctionSection(followups, { surface: 'bounty' }),
    humanReview: humanReviewSection(reviewer, { surface: 'bounty' }),
    reviewRequests: followups.filter(entry => entry.kind === 'human_review_request'),
    notices };
}

// --- Service ---------------------------------------------------------------
export class AdverseDecisionPackets {
  constructor(store) { this.store = store; this.db = store.db; }
  verifySchema({ allowAbsent = false } = {}) {
    const shapes = adverseDecisionPacketsSchema.trim().split(/;\s*(?=CREATE|$)/).filter(Boolean)
      .filter(sql => sql.startsWith('CREATE TABLE'))
      .map(sql => ({ sql, actual: this.db.prepare('SELECT sql FROM sqlite_master WHERE name=?')
        .get(/CREATE TABLE IF NOT EXISTS ([a-z_]+)/.exec(sql)[1])?.sql }));
    if (allowAbsent && shapes.every(shape => shape.actual === undefined)) return false;
    if (shapes.some(shape => normalize(shape.sql) !== normalize(shape.actual))) throw new Error('Adverse decision packet schema requires operator reconciliation');
    return true;
  }
  hasTable(name) { return Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)); }
  followups(packetKind, packetRef) {
    if (!this.hasTable('adverse_decision_followups')) return [];
    return this.db.prepare('SELECT * FROM adverse_decision_followups WHERE packet_kind=? AND packet_ref=? ORDER BY created_at')
      .all(packetKind, packetRef).map(followupView);
  }
  roomState(roomId) { try { return this.store.room(roomId).state; } catch { return null; } }

  // Subject read surface for public work: the caller's own identity secret
  // is the only credential — no room membership in the review surface is
  // required or consulted (the contributorReview posture).
  forPublicWorkReceipt(secret, receiptId) {
    check(validId(receiptId), 'Invalid receipt ID');
    return this.store.readTransaction(() => {
      const identity = this.store.identities.resolveGlobalIdentitySecret(secret);
      if (!identity) fail(401, 'unauthenticated', 'Unknown or revoked identity');
      if (!this.hasTable('public_work_receipts')) fail(404, 'packet_not_found', 'Contribution not found');
      const row = this.db.prepare('SELECT receipt_json FROM public_work_receipts WHERE receipt_id=? AND identity_id=?').get(receiptId, identity.identityId);
      if (!row) fail(404, 'packet_not_found', 'Contribution not found');
      const receipt = JSON.parse(row.receipt_json);
      const saved = this.hasTable('public_work_reviews') && this.db.prepare('SELECT state_json FROM public_work_reviews WHERE receipt_id=?').get(receiptId);
      const review = saved ? JSON.parse(saved.state_json) : null;
      const adverse = review?.decision?.decision === 'rejected' || review?.verification?.verdict === 'FAIL';
      if (!adverse) fail(404, 'no_adverse_decision', 'No adverse decision is recorded for this contribution');
      const taskRow = this.hasTable('public_work_tasks') && this.db.prepare('SELECT room_id FROM public_work_tasks WHERE offer_id=?').get(receipt.taskId);
      const offerRow = taskRow && this.db.prepare('SELECT * FROM project_offers WHERE offer_id=? AND room_id=?').get(receipt.taskId, taskRow.room_id);
      const offer = offerRow ? this.store.projectOffers.record(offerRow, true) : null;
      const state = taskRow ? this.roomState(taskRow.room_id) : null;
      const deciderId = review.decision?.actorId ?? review.verification?.actorId ?? null;
      const deciderKind = deciderId && state?.members?.[deciderId] ? state.members[deciderId].kind : null;
      const verifierKind = review.verification?.reviewerKind ?? null;
      const work = offer?.workItemId && state?.workItems ? state.workItems[offer.workItemId] : null;
      const reviewer = state ? pickHumanReviewer([
        { id: work?.humanDecisionMakerId, role: 'designated human decision maker for this work' },
        { id: state.room?.ownerId, role: 'room owner' }], deciderId, id => state.members?.[id]?.kind) : null;
      const settlement = this.store.publicWorkSettlement?.viewForOffer?.(receipt.taskId) ?? null;
      const followups = this.followups('public_work', receiptId);
      return buildPublicWorkPacket({ receipt, review, offer, deciderKind, verifierKind,
        settlementPhase: settlement?.phase ?? null, reviewer,
        notices: noticesFor(this.db, { recipient: identity.identityId, subjectRef: receipt.taskId }),
        followups, generatedAt: new Date(this.store.now()).toISOString() });
    });
  }

  // Subject read surface for bounties: the caller lane must be the
  // claimant of a bounty whose recorded resolution is a rejection.
  forBounty(roomId, lane, bountyId) {
    check(validId(roomId) && typeof lane === 'string' && lane.length > 0 && validId(bountyId), 'Invalid bounty packet identifier');
    return this.store.readTransaction(() => {
      const escrow = this.store.bountyEscrow;
      if (!escrow) fail(404, 'packet_not_found', 'Bounty not found');
      let bounty = null;
      try { bounty = escrow.getBounty(roomId, bountyId); } catch { bounty = null; }
      if (!bounty || bounty.claimant !== lane) fail(404, 'packet_not_found', 'Bounty not found');
      if (bounty.resolution?.kind !== 'rejected') fail(404, 'no_adverse_decision', 'No adverse decision is recorded for this bounty');
      const event = this.hasTable('bounty_events') && this.db.prepare(
        "SELECT actor_kind FROM bounty_events WHERE room_id=? AND bounty_id=? AND type='bounty.rejected' ORDER BY seq DESC LIMIT 1").get(roomId, bountyId);
      const state = this.roomState(roomId);
      const reviewer = state ? pickHumanReviewer([
        { id: state.room?.ownerId, role: 'room owner' },
        { id: bounty.disputeDecider, role: 'designated dispute decider' },
        { id: bounty.verifier, role: 'designated verifier' }], bounty.resolution.rejectedBy ?? null,
        id => state.members?.[id]?.kind) : null;
      const followups = this.followups('bounty', bountyId);
      return buildBountyPacket({ bounty, rejectedEventKind: event?.actor_kind ?? null, reviewer,
        notices: noticesFor(this.db, { recipient: lane, subjectRef: bountyId }),
        followups, generatedAt: new Date(this.store.now()).toISOString() });
    });
  }

  fileFollowup({ packetKind, packetRef, roomId = null, subject, reviewer = null, input } = {}) {
    check(input && typeof input === 'object' && !Array.isArray(input)
      && Object.keys(input).every(key => ['kind', 'statement'].includes(key)), 'Unexpected or missing follow-up fields');
    check(['correction', 'human_review_request'].includes(input?.kind), 'Follow-up kind must be "correction" or "human_review_request"');
    check(typeof input.statement === 'string' && input.statement.trim().length > 0 && input.statement.length <= 2000
      && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(input.statement), 'A concise statement (1-2000 characters) is required');
    return this.store.transaction(() => {
      this.db.exec(adverseDecisionPacketsSchema);
      const routed = input.kind === 'human_review_request' ? reviewer : null;
      if (input.kind === 'human_review_request' && !routed)
        fail(409, 'no_distinct_human_reviewer', 'No human reviewer distinct from the original decider is recorded for this work; a review request cannot be routed honestly');
      const row = { followupId: `fwu_${randomUUID()}`, packetKind, packetRef, roomId, subject,
        kind: input.kind, statement: input.statement.trim(), routedTo: routed?.id ?? null,
        routedToRole: routed?.role ?? null, status: 'recorded', createdAt: new Date(this.store.now()).toISOString() };
      this.db.prepare('INSERT INTO adverse_decision_followups VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .run(row.followupId, row.packetKind, row.packetRef, row.roomId, row.subject, row.kind,
          row.statement, row.routedTo, row.routedToRole, row.status, row.createdAt);
      return followupView({ followup_id: row.followupId, kind: row.kind, statement: row.statement,
        status: row.status, routed_to_role: row.routedToRole, created_at: row.createdAt });
    });
  }
  // Filing resolves the packet first (which enforces subject ownership and
  // the adverse-decision precondition), then records against it.
  filePublicWorkFollowup(secret, receiptId, input) {
    const packet = this.forPublicWorkReceipt(secret, receiptId);
    // The routed member id stays on the room side of the record: the
    // packet names the role; the followup row resolves the id internally.
    const resolved = this.#resolvePublicWorkReviewer(receiptId);
    return this.fileFollowup({ packetKind: 'public_work', packetRef: receiptId, subject: packet.subject.id,
      reviewer: resolved, input });
  }
  #resolvePublicWorkReviewer(receiptId) {
    const receiptRow = this.db.prepare('SELECT receipt_json FROM public_work_receipts WHERE receipt_id=?').get(receiptId);
    if (!receiptRow) return null;
    const receipt = JSON.parse(receiptRow.receipt_json);
    const saved = this.hasTable('public_work_reviews') && this.db.prepare('SELECT state_json FROM public_work_reviews WHERE receipt_id=?').get(receiptId);
    const review = saved ? JSON.parse(saved.state_json) : null;
    const taskRow = this.hasTable('public_work_tasks') && this.db.prepare('SELECT room_id FROM public_work_tasks WHERE offer_id=?').get(receipt.taskId);
    const state = taskRow ? this.roomState(taskRow.room_id) : null;
    if (!state) return null;
    const offerRow = this.db.prepare('SELECT * FROM project_offers WHERE offer_id=? AND room_id=?').get(receipt.taskId, taskRow.room_id);
    const offer = offerRow ? this.store.projectOffers.record(offerRow, true) : null;
    const work = offer?.workItemId && state.workItems ? state.workItems[offer.workItemId] : null;
    const deciderId = review?.decision?.actorId ?? review?.verification?.actorId ?? null;
    return pickHumanReviewer([
      { id: work?.humanDecisionMakerId, role: 'designated human decision maker for this work' },
      { id: state.room?.ownerId, role: 'room owner' }], deciderId, id => state.members?.[id]?.kind);
  }
  fileBountyFollowup(roomId, lane, bountyId, input) {
    const packet = this.forBounty(roomId, lane, bountyId);
    const resolved = this.#resolveBountyReviewer(roomId, bountyId);
    return this.fileFollowup({ packetKind: 'bounty', packetRef: bountyId, roomId, subject: lane,
      reviewer: resolved, input });
  }
  #resolveBountyReviewer(roomId, bountyId) {
    let bounty = null;
    try { bounty = this.store.bountyEscrow?.getBounty(roomId, bountyId); } catch { bounty = null; }
    const state = bounty ? this.roomState(roomId) : null;
    if (!bounty || !state) return null;
    return pickHumanReviewer([
      { id: state.room?.ownerId, role: 'room owner' },
      { id: bounty.disputeDecider, role: 'designated dispute decider' },
      { id: bounty.verifier, role: 'designated verifier' }], bounty.resolution?.rejectedBy ?? null,
      id => state.members?.[id]?.kind);
  }
}
