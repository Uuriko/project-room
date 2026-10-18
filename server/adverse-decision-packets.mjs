import { createHash, randomUUID } from 'node:crypto';
import { validId, EVENT_TYPES, event, ownMember } from '../src/events.js';
import { ServiceError } from './service-error.mjs';

// #3615 (accountability R-4/R-6): the subject-facing adverse-decision packet
// and the agent-participation notice record.
//
// The packet is a composition over records that already exist — the public
// work receipt (artifact, the subject's own checks/attestation, executed
// checks), the private review record (decision, verification), and the offer
// (approval policy). The generator invents nothing: every field is copied
// from a record or derived by naming a recorded fact, and anything not on
// the record renders as null/empty, never as plausible filler. The recorded
// decision reason is the explanation, verbatim — the same reason the
// contributor review door already shares with the subject. Following that
// door's privacy discipline, the packet never carries a reviewer/member
// identity, the verification reason, or the review fingerprint; reviewer
// participation is disclosed by recorded KIND only.
//
// Access is the security core: the packet is the subject's own record. It
// resolves through the subject's global identity secret and the receipt's
// recorded identity_id — the contributorReview pattern — so the subject
// needs no room membership in the review surface, and any other identity
// (including another room member's) meets the same 404 as a missing record.
//
// The human-review route reuses the existing bounty dispute/arbiter
// machinery: for a paid task the packet names the settlement bounty and its
// existing dispute route, whose decider is seated distinct from the
// original decider by that machinery. No second decider path is built here.
// For an unpaid task no dispute vehicle exists on the record, and the
// packet says so rather than inventing a route.
//
// The correction path is distinct from a dispute: a subject-only route that
// RECORDS a correction request as a room event (adverse_decision
// .correction_requested). It adjudicates nothing and changes no verdict.
export const AGENT_PARTICIPATION_NOTICE_CONTENT_VERSION = 'agent-participation-notice/1';
export const AGENT_PARTICIPATION_CHANNELS = Object.freeze(['public_work_claim']);
const fail = (status, code, message) => { throw new ServiceError(status, code, message); };
const check = (ok, message) => { if (!ok) fail(422, 'invalid_adverse_decision', message); };
const hash = text => createHash('sha256').update(text).digest('hex');

const hasTable = (db, name) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));

// R-6 delivery point: a public-work claim. Claiming delivers the task terms
// to an identified subject, and the offer's recorded approvalPolicy is the
// agent-participation notice in those terms — an agent will review the
// subject's work when the mode is agent or human_with_agent_review. The
// notice is written as a room event in the same record system as every
// other work record, carrying content version, recipient, channel and the
// envelope timestamp. Human-only mode discloses no agent participation, so
// no notice is recorded for it (no over-fire). Archived rooms have no live
// timeline to record into (the access-requested precedent) and are skipped.
export function recordAgentParticipationNotice(store, { roomId, taskId, recipientIdentityId, approvalPolicyMode, termsVersion, channel = 'public_work_claim' }) {
  if (!['agent', 'human_with_agent_review'].includes(approvalPolicyMode)) return null;
  if (!AGENT_PARTICIPATION_CHANNELS.includes(channel)) return null;
  // Handler-unit stores have no event log; like the work-claim event rail,
  // a store without one records nothing here.
  if (typeof store?.appendSideTableEvent !== 'function' || typeof store?.room !== 'function') return null;
  const room = store.room(roomId);
  if (room.state.room.archivedAt) return null;
  const incoming = event({
    id: randomUUID(),
    idempotencyKey: randomUUID(),
    type: EVENT_TYPES.AGENT_PARTICIPATION_NOTICE_DELIVERED,
    actorId: recipientIdentityId,
    roomId,
    at: new Date(store.now()).toISOString(),
    data: { taskId, recipientIdentityId, contentVersion: AGENT_PARTICIPATION_NOTICE_CONTENT_VERSION,
      channel, approvalPolicyMode, termsVersion }
  });
  const sequence = store.appendSideTableEvent(roomId, incoming);
  return { sequence, event: incoming };
}

export class AdverseDecisionPackets {
  constructor(store) { this.store = store; this.db = store.db; }

  // Subject resolution shared by both doors: the caller's identity secret
  // must resolve, and the receipt must be recorded under that identity —
  // by receipt id, or by the task/offer id a settlement bounty is keyed by.
  // Every mismatch is the same 404, so the door is not an existence oracle.
  subjectReceipt(secret, id) {
    check(validId(id), 'Invalid receipt ID');
    const identity = this.store.identities.resolveGlobalIdentitySecret(secret);
    if (!identity) fail(401, 'unauthenticated', 'Unknown or revoked identity');
    if (!hasTable(this.db, 'public_work_receipts')) fail(404, 'adverse_packet_not_found', 'Adverse-decision packet not found');
    const byReceipt = this.db.prepare('SELECT * FROM public_work_receipts WHERE receipt_id=? AND identity_id=?').get(id, identity.identityId);
    const row = byReceipt ?? this.db.prepare('SELECT * FROM public_work_receipts WHERE offer_id=? AND identity_id=? ORDER BY created_at DESC LIMIT 1').get(id, identity.identityId);
    if (!row) fail(404, 'adverse_packet_not_found', 'Adverse-decision packet not found');
    return { identity, row, receipt: JSON.parse(row.receipt_json) };
  }

  reviewOf(receiptId) {
    if (!hasTable(this.db, 'public_work_reviews')) return null;
    const row = this.db.prepare('SELECT state_json FROM public_work_reviews WHERE receipt_id=?').get(receiptId);
    return row ? JSON.parse(row.state_json) : null;
  }

  // The room a receipt's task belongs to, from the task record — the packet
  // door never asks the subject for a room id and never checks membership.
  roomIdOf(offerId) {
    if (!hasTable(this.db, 'public_work_tasks')) return null;
    return this.db.prepare('SELECT room_id FROM public_work_tasks WHERE offer_id=?').get(offerId)?.room_id ?? null;
  }

  offerOf(offerId) {
    const row = this.db.prepare('SELECT * FROM project_offers WHERE offer_id=?').get(offerId);
    if (!row) return null;
    try { return this.store.projectOffers.record(row, true); } catch { return null; }
  }

  memberKind(roomId, memberId) {
    if (!roomId || !memberId) return null;
    try { return ownMember(this.store.room(roomId).state.members, memberId)?.kind ?? null; } catch { return null; }
  }

  noticeRecords(roomId, taskId, identityId) {
    if (!roomId) return [];
    const rows = this.db.prepare(`SELECT body FROM events WHERE room_id=? AND json_extract(body,'$.type')=? ORDER BY sequence`)
      .all(roomId, EVENT_TYPES.AGENT_PARTICIPATION_NOTICE_DELIVERED);
    const records = [];
    for (const row of rows) {
      try {
        const entry = JSON.parse(row.body);
        if (entry.data?.recipientIdentityId === identityId && entry.data?.taskId === taskId)
          records.push({ contentVersion: entry.data.contentVersion, channel: entry.data.channel,
            approvalPolicyMode: entry.data.approvalPolicyMode, termsVersion: entry.data.termsVersion, deliveredAt: entry.at });
      } catch { /* a malformed historical row is not this subject's record */ }
    }
    return records;
  }

  packet(secret, id) {
    return this.store.readTransaction(() => {
      const { identity, receipt } = this.subjectReceipt(secret, id);
      const review = this.reviewOf(receipt.receiptId);
      const decision = review?.decision ?? null;
      const verification = review?.verification ?? null;
      const rejected = decision?.decision === 'rejected';
      const failed = verification?.verdict === 'FAIL';
      // F-7: packets exist for adverse records only — a rejected decision or
      // a failed verification. Accepted, pending and revision-requested
      // records have the contributor review door; they get no packet.
      if (!rejected && !failed) fail(404, 'adverse_packet_not_found', 'Adverse-decision packet not found');
      const roomId = this.roomIdOf(receipt.taskId);
      const offer = this.offerOf(receipt.taskId);
      const approvalPolicyMode = offer?.approvalPolicy?.mode ?? null;
      const decisionActorKind = this.memberKind(roomId, decision?.actorId);
      const executedChecks = [];
      const seenChecks = new Set();
      for (const [source, entries] of [['receipt', receipt.executedChecks], ['verification', verification?.executedChecks]])
        for (const entry of entries ?? []) {
          if (!entry || typeof entry.name !== 'string') continue;
          const key = `${source}:${entry.name}`;
          if (seenChecks.has(key)) continue;
          seenChecks.add(key);
          executedChecks.push({ name: entry.name, result: entry.result ?? null, source, ...(entry.at ? { at: entry.at } : {}) });
        }
      const principalFactors = [];
      if (rejected) principalFactors.push({ kind: 'decision', decision: 'rejected' });
      if (failed) principalFactors.push({ kind: 'verification_verdict', verdict: 'FAIL', reviewerKind: verification.reviewerKind ?? null });
      for (const entry of receipt.criteriaAttestation ?? [])
        principalFactors.push({ kind: 'criterion_outcome', criterion: entry.criterion, status: entry.status,
          ...(entry.evidenceRef != null ? { evidenceRef: entry.evidenceRef } : {}) });
      // Reviewer-side per-criterion outcomes (#3613) ride the verification
      // record when present; on records without them this stays empty.
      for (const entry of verification?.criterionOutcomes ?? [])
        principalFactors.push({ kind: 'criterion_outcome', ...(entry.criterionId ? { criterionId: entry.criterionId } : {}),
          ...(entry.criterion ? { criterion: entry.criterion } : {}), verdict: entry.verdict ?? entry.status ?? null });
      for (const entry of executedChecks) principalFactors.push({ kind: 'executed_check', name: entry.name, result: entry.result, source: entry.source });
      const settlement = this.store.publicWorkSettlement?.viewForOffer(receipt.taskId) ?? null;
      return {
        schema: 'adverse-decision-packet/1',
        receiptId: receipt.receiptId,
        taskId: receipt.taskId,
        subjectIdentityId: identity.identityId,
        adverseBasis: rejected && failed ? 'rejected_and_verification_failed' : rejected ? 'rejected' : 'verification_failed',
        // The explanation is the recorded decision reason, verbatim — the
        // text the decider put on the record. A failed verification with no
        // decision carries no subject-shareable reason on the record (the
        // verification reason stays member-side), so it renders absent.
        explanation: decision?.reason
          ? { source: 'recorded_decision_reason', text: decision.reason }
          : { source: 'recorded_verification_outcome', text: null },
        decision: decision ? { decision: decision.decision, reason: decision.reason, at: decision.at } : null,
        verification: verification ? { verdict: verification.verdict, reviewerKind: verification.reviewerKind ?? null, at: verification.at } : null,
        principalFactors,
        criteriaOutcomes: {
          attestation: receipt.criteriaAttestation ?? null,
          reviewerOutcomes: verification?.criterionOutcomes ?? null,
          executedChecks
        },
        agentParticipation: {
          approvalPolicyMode,
          verificationReviewerKind: verification?.reviewerKind ?? null,
          decisionActorKind,
          agentsParticipated: approvalPolicyMode !== null && approvalPolicyMode !== 'human'
            || verification?.reviewerKind === 'agent' || decisionActorKind === 'agent',
          noticeRecords: this.noticeRecords(roomId, receipt.taskId, identity.identityId)
        },
        evidenceReliedOn: {
          artifactSha256: receipt.artifact.sha256,
          artifactBytes: receipt.artifact.bytes,
          checksReported: receipt.checksReported ?? [],
          criteriaAttestation: receipt.criteriaAttestation ?? null,
          executedChecks,
          termsVersion: receipt.termsVersion,
          generation: receipt.generation
        },
        correction: {
          kind: 'adverse_decision_correction_request',
          distinctFromDispute: true,
          adjudicates: false,
          method: 'POST',
          route: `/api/public-work/receipts/${receipt.receiptId}/adverse-decision/correction`,
          fields: ['artifact', 'checksReported', 'criteriaAttestation', 'decisionReason', 'other']
        },
        humanReview: settlement
          ? { available: true, kind: 'bounty_dispute', reuses: 'bounty_dispute_arbiter_machinery',
              method: 'POST', route: `/api/rooms/${roomId}/bounties/${settlement.bountyId}/dispute`,
              bountyId: settlement.bountyId,
              deciderRule: 'the dispute decider seated by the dispute machinery, distinct from the original decider' }
          : { available: false, kind: 'bounty_dispute', reuses: 'bounty_dispute_arbiter_machinery',
              reason: 'no settlement bounty is recorded for this task, so no dispute vehicle exists to seat an independent decider' },
        generatedAt: new Date(this.store.now()).toISOString()
      };
    });
  }

  // The correction path: record the subject's correction request as a room
  // event in the same record system. Subject-only (the same resolution as
  // the packet), adverse records only, idempotent by requestId — a replay
  // returns the recorded request, a reused id with different input refuses.
  requestCorrection(secret, id, input) {
    check(input && typeof input === 'object' && !Array.isArray(input)
      && Object.keys(input).every(key => ['requestId', 'field', 'note'].includes(key))
      && validId(input.requestId), 'Unexpected or missing correction fields');
    check(['artifact', 'checksReported', 'criteriaAttestation', 'decisionReason', 'other'].includes(input.field), 'Invalid correction field');
    check(typeof input.note === 'string' && input.note.trim().length > 0 && input.note.length <= 1000, 'A concise correction note is required');
    const { identity, receipt } = this.subjectReceipt(secret, id);
    const review = this.reviewOf(receipt.receiptId);
    if (review?.decision?.decision !== 'rejected' && review?.verification?.verdict !== 'FAIL')
      fail(404, 'adverse_packet_not_found', 'Adverse-decision packet not found');
    const roomId = this.roomIdOf(receipt.taskId);
    if (!roomId) fail(404, 'adverse_packet_not_found', 'Adverse-decision packet not found');
    const eventId = hash(`adverse-correction:${receipt.receiptId}:${identity.identityId}:${input.requestId}`);
    const existing = this.db.prepare('SELECT body FROM events WHERE id=?').get(eventId);
    if (existing) {
      const recorded = JSON.parse(existing.body);
      if (recorded.data?.field !== input.field || recorded.data?.note !== input.note)
        fail(409, 'request_id_reused', 'Correction request ID was used for different input');
      return { schema: 'adverse-decision-correction/1', requestId: input.requestId, receiptId: receipt.receiptId,
        field: recorded.data.field, recordedAt: recorded.at, replayed: true };
    }
    const at = new Date(this.store.now()).toISOString();
    const incoming = event({
      id: eventId,
      idempotencyKey: eventId,
      type: EVENT_TYPES.ADVERSE_DECISION_CORRECTION_REQUESTED,
      actorId: identity.identityId,
      roomId,
      at,
      data: { requestId: input.requestId, receiptId: receipt.receiptId, taskId: receipt.taskId, field: input.field, note: input.note }
    });
    this.store.appendSideTableEvent(roomId, incoming);
    return { schema: 'adverse-decision-correction/1', requestId: input.requestId, receiptId: receipt.receiptId,
      field: input.field, recordedAt: at, replayed: false };
  }
}
