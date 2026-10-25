import { canonicalLane, toCredits, MAX_CREDITS, MILLIS_PER_CREDIT } from './bounty-escrow.mjs';
import { claimEligibility } from './bounty-reputation.mjs';
import { ServiceError } from './service-error.mjs';

// Public-work settlement rail (First Shift §2 launch prerequisite).
//
// Shape chosen: (ii) public-work reward extension. A public task whose offer
// carries the existing matchmaking/offer vocabulary reward
// { kind: 'work_trade', unit: 'credit', amountMinor: <milli-credits> }
// (decimals 3, so amountMinor IS milli-credits in the bounty journal's own
// unit) is funded through the existing bounty escrow — no parallel ledger,
// no new journal, no new denomination, and the spend-grant "cents" system
// (#3305) is never touched. The alternative shape (i), a sponsor-room bounty
// mirror listed on the bounty board, was rejected: it duplicates the task on
// a second board with a second claim, and the two claim fences (public-work
// lease/generation vs bounty claim/bond) can diverge. Here the escrow bounty
// is an internal settlement vehicle for the one public task, never a second
// listing: post+fund at enable time, claim+submit at public submission time,
// accept/reject driven by the public-work review verdict.
//
// Semantics preserved from the escrow machinery, deliberately:
// - funding locks the poster's existing payable balance (no new issuance;
//   total_issued is unchanged by every step of this rail);
// - the existing 1% pool fee applies on released payouts only; refunds are
//   full and feeless; the pool keeps only that existing role (Constitution
//   Article VII sweep/spending is John-gated and NOT implemented here);
// - the existing flat 1-credit claim bond is locked at submission and
//   follows existing escrow outcomes (returned on payout, forfeited to the
//   pool when work is judged bad on rejection — the anti-flake ladder);
// - acceptance attributes the award to the claimant and the payout releases
//   through the existing epoch sweep after the existing challenge window.
//   The standard dispute flow applies, with one rail designation (#3702):
//   fund() names the offer's first non-poster reviewer as the escrow
//   bounty's dispute decider, so a dispute on a rail bounty can actually
//   be decided instead of running undecidable into the timeout default.
//   (The #3307 dispute-bond specification conflict is neither resolved
//   nor altered by any of this.);
// - reviewer silence settles NOTHING here: settlement fires only on an
//   actual review verdict. The free-miss flip (Constitution VIII.1) is
//   John-gated and not decided, so the mirror bounty's deadline is set a
//   year out — the escrow keeper must never free-miss a public-work mirror
//   out from under a pending review.
export const publicWorkSettlementSchema = `
CREATE TABLE IF NOT EXISTS public_work_settlements (
  offer_id TEXT PRIMARY KEY, room_id TEXT NOT NULL, bounty_id TEXT NOT NULL UNIQUE,
  poster_lane TEXT NOT NULL, claimant_lane TEXT, amount_millis INTEGER NOT NULL,
  receipt_id TEXT, created_at INTEGER NOT NULL
);`;

const fail = (status, code, message) => { throw new ServiceError(status, code, message); };
const normalize = sql => sql?.trim().replace(/;$/, '').replace(/IF NOT EXISTS /g, '').replace(/\s+/g, ' ');
// Escrow errors carry a machine code but no HTTP status; translate at this
// boundary so a funding failure (e.g. insufficient poster balance) is a
// client-visible refusal, never a bare 500.
const escrowError = error => {
  if (error instanceof ServiceError) return error;
  const code = typeof error?.code === 'string' ? error.code : 'settlement_failed';
  const status = code === 'not_authorized' ? 403 : code === 'insufficient_funds' ? 422
    : ['invalid_state', 'already_claimed', 'reputation_probation', 'unknown_bounty'].includes(code) ? 409 : 422;
  return new ServiceError(status, code, String(error?.message ?? error));
};

// The posted price of a public task, in bounty-journal milli-credits, or
// null when the task is unpaid. Cash rewards stay not-configured: only the
// existing work_trade/credit vocabulary settles on this rail.
export function publicWorkRewardMillis(offer) {
  const reward = offer?.reward;
  if (!reward || reward.kind === 'unpaid') return null;
  if (reward.kind !== 'work_trade' || reward.unit !== 'credit') return undefined;
  const millis = Number(reward.amountMinor);
  if (!Number.isSafeInteger(millis) || millis <= 0 || millis > MAX_CREDITS * MILLIS_PER_CREDIT) return undefined;
  return millis;
}

export class PublicWorkSettlement {
  constructor(store) { this.store = store; this.db = store.db; }
  verifySchema({ allowAbsent = false } = {}) {
    const shapes = publicWorkSettlementSchema.trim().split(/;\s*(?=CREATE|$)/).filter(Boolean).map(sql => ({ sql,
      actual: this.db.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(/CREATE TABLE IF NOT EXISTS ([a-z_]+)/.exec(sql)[1])?.sql }));
    if (allowAbsent && shapes.every(shape => shape.actual === undefined)) return false;
    if (shapes.some(shape => normalize(shape.sql) !== normalize(shape.actual))) throw new Error('Public work settlement schema requires operator reconciliation');
    return true;
  }
  hasTable() { return Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='public_work_settlements'").get()); }
  link(offerId) {
    if (!this.hasTable()) return null;
    return this.db.prepare('SELECT * FROM public_work_settlements WHERE offer_id=?').get(offerId) ?? null;
  }
  escrow() {
    const escrow = this.store.bountyEscrow;
    if (!escrow) fail(500, 'settlement_unavailable', 'Bounty escrow is not available in this store');
    return escrow;
  }
  // The escrow lane a global identity settles through in this room: the
  // member linked to the identity (identity_links), or a member whose own
  // identityId is the claimant identity — the same two bindings the review
  // module already uses to detect self-review. A claimant with neither has
  // no ledger account in the room (genesis issues per room member), so a
  // paid claim cannot be taken until the identity is linked to a member.
  laneForIdentity(roomId, identityId) {
    const { state } = this.store.room(roomId);
    const linked = this.hasIdentityLinks()
      ? this.db.prepare('SELECT member_id AS memberId FROM identity_links WHERE room_id=? AND identity_id=?').get(roomId, identityId)?.memberId : null;
    const memberId = linked ?? Object.keys(state.members).find(id => state.members[id]?.identityId === identityId) ?? null;
    if (!memberId) return null;
    const member = state.members[memberId];
    if (!member || member.active === false) return null;
    return canonicalLane(memberId);
  }
  hasIdentityLinks() { return Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='identity_links'").get()); }

  // Funding time (public enable): post + fund the internal escrow bounty
  // from the poster's existing balance and record the link. Runs inside the
  // caller's transaction (escrow transactions nest), so a funding failure
  // rolls the enable back with it — a paid task is never listed unfunded.
  fund(roomId, posterId, offer, amountMillis) {
    const escrow = this.escrow();
    const posterLane = canonicalLane(posterId);
    const deadline = new Date(this.store.now() + 365 * 24 * 3600 * 1000).toISOString();
    // Designate the dispute decider (#3702): the offer's first named
    // reviewer who is not the poster. Rail bounties previously designated
    // nobody, so no decider could ever be seated and every dispute ran
    // undecidable into the 14-day timeout default. The named reviewer is
    // the party the offer already seats to render verdicts; the escrow
    // seats them as tier-1 arbiter and re-checks independence from the
    // claimant at dispute time. When the sole named reviewer IS the
    // poster there is no third party to designate — the bounty then
    // honestly keeps the escrow's unavailable-dispute behavior. The
    // reviewer list lives in the offer's private links (the public
    // record omits it), so read the private record here.
    const offerRow = this.db.prepare('SELECT * FROM project_offers WHERE offer_id=? AND room_id=?')
      .get(offer.id, roomId);
    const reviewerMemberIds = offerRow
      ? (this.store.projectOffers.record(offerRow, true).reviewerMemberIds ?? [])
      : (offer.reviewerMemberIds ?? []);
    const deciderId = reviewerMemberIds
      .find(id => canonicalLane(id) !== posterLane) ?? null;
    let bountyId;
    try {
      const posted = escrow.postBounty(roomId, { poster: posterLane, title: offer.title,
        criteria: offer.acceptanceCriteria.join('\n').slice(0, 2000) || offer.title,
        amount: amountMillis / MILLIS_PER_CREDIT, deadline, approvalMode: 'human',
        ...(deciderId ? { disputeDeciderId: deciderId } : {}) });
      bountyId = posted.bounty.bountyId;
      escrow.fundBounty(roomId, bountyId, { funder: posterLane });
    } catch (error) { throw escrowError(error); }
    this.db.prepare('INSERT INTO public_work_settlements VALUES (?,?,?,?,?,?,?,?)')
      .run(offer.id, roomId, bountyId, posterLane, null, amountMillis, null, this.store.now());
    return this.view(this.link(offer.id));
  }

  // Claim time gate for paid tasks: the claimant must settle through a
  // linked room-member lane, must not be the poster, and must pass the same
  // reputation claim gate the escrow applies at claim (probation lanes are
  // capped at 5 credits — First Shift's 8-credit band is for established
  // lanes by design). No money moves here; the gate exists so a worker
  // never does paid work the escrow would refuse to attach at submission.
  assertClaimable(roomId, offerId, identityId) {
    const link = this.link(offerId);
    if (!link) return null;
    const lane = this.laneForIdentity(roomId, identityId);
    if (!lane) fail(422, 'settlement_lane_unlinked',
      'Paid public work settles to a room-member ledger lane: link this identity to a member of the task room before claiming');
    if (lane === link.poster_lane) fail(403, 'public_work_not_owner', 'The poster cannot claim their own paid task');
    const eligibility = claimEligibility(this.escrow(), roomId, lane, link.amount_millis);
    if (!eligibility.allowed) fail(409, 'reputation_probation',
      `Probation reputation band: may only claim bounties up to ${eligibility.maxClaimMillis / MILLIS_PER_CREDIT} credits`);
    return lane;
  }

  // Submission time: attach the public submission to the funded escrow
  // bounty (claim — locks the existing claim bond — then submit, with the
  // public-work receipt as the evidence pointer). Called inside the finish
  // transaction before the receipt row is written, so a settlement failure
  // leaves no orphan receipt and the claimant can retry the finish.
  attachSubmission(roomId, offerId, receipt) {
    const link = this.link(offerId);
    if (!link) return null;
    if (link.receipt_id) {
      if (link.receipt_id === receipt.receiptId) return this.view(link);
      fail(409, 'settlement_already_attached', 'This task already has a settled submission');
    }
    const lane = this.laneForIdentity(roomId, receipt.identityId);
    if (!lane) fail(422, 'settlement_lane_unlinked',
      'Paid public work settles to a room-member ledger lane: the claimant identity is not linked to a member of the task room');
    const escrow = this.escrow();
    try {
      escrow.claimBounty(roomId, link.bounty_id, { claimant: lane, suppressNotice: true });
      escrow.submitWork(roomId, link.bounty_id, { claimant: lane, evidence: {
        evidenceUrl: `https://room.trydemigod.com/api/public-work/receipts/${receipt.receiptId}`,
        evidenceKind: 'public-work-receipt',
        summary: `Public-work submission ${receipt.receiptId} for task ${offerId} (artifact sha256 ${receipt.artifact.sha256})`.slice(0, 2000),
        checksClaimed: (receipt.checksReported ?? []).map(text => String(text).slice(0, 256)),
      } });
    } catch (error) { throw escrowError(error); }
    this.db.prepare('UPDATE public_work_settlements SET claimant_lane=?, receipt_id=? WHERE offer_id=?')
      .run(lane, receipt.receiptId, offerId);
    return this.view(this.link(offerId));
  }

  // Verdict time: the ONLY settlement trigger. 'accepted' attributes the
  // award to the claimant through the poster's escrow approval authority
  // (the review module has already authorized the decider and any required
  // independent PASS; the escrow records its approval under the poster lane
  // that funded the bounty, exactly as a human-mode bounty acceptance).
  // Payout then releases through the existing epoch sweep after the
  // existing challenge window, minus the existing 1% pool fee, issuing the
  // escrow payout receipt. 'rejected' refunds the poster in full with no fee
  // through the existing reject path (claim bond follows existing anti-flake
  // semantics). Both escrow calls are idempotent, and the review journal
  // replay in the caller returns the recorded outcome without re-entering
  // here, so a duplicate verdict moves nothing twice.
  settleOnVerdict(roomId, offerId, { decision, reason }) {
    const link = this.link(offerId);
    if (!link) return null;
    if (!link.receipt_id || !link.claimant_lane) fail(409, 'settlement_not_submitted', 'Paid task has no attached submission to settle');
    const escrow = this.escrow();
    try {
      if (decision === 'accepted') {
        const result = escrow.acceptWork(roomId, link.bounty_id, { acceptor: link.poster_lane,
          verifierAttestation: { at: new Date(this.store.now()).toISOString(),
            note: `Public-work review accepted submission ${link.receipt_id}: ${String(reason).slice(0, 500)}`,
            citations: [{ criterionId: 'c1', verdict: 'pass' }] } });
        return { ...this.view(link), phase: result.bounty.state, challengeEndsAt: result.bounty.challengeEnds ?? null,
          escrowReceipt: { kind: result.receipt.kind, lotId: result.receipt.lotId, entries: result.receipt.entries, signed: result.receipt.signed ?? [] } };
      }
      const result = escrow.rejectWork(roomId, link.bounty_id, { rejector: link.poster_lane, reason: String(reason).slice(0, 500) });
      return { ...this.view(link), phase: result.bounty.state, alreadySettled: result.alreadySettled === true,
        escrowReceipt: { kind: result.receipt.kind, lotId: result.receipt.lotId ?? null, entries: result.receipt.entries ?? [], signed: result.receipt.signed ?? [] } };
    } catch (error) { throw escrowError(error); }
  }

  // Current settlement view for a link row, deriving the live phase (and,
  // once the epoch sweep has run, the payout receipt) from the escrow
  // bounty itself — the journal stays the only money record.
  view(link) {
    if (!link) return null;
    let bounty = null, payoutReceipt = null;
    try { bounty = this.escrow().getBounty(link.room_id, link.bounty_id); } catch { bounty = null; }
    if (bounty?.state === 'paid' && link.claimant_lane) {
      const payout = this.escrow().history(link.room_id, link.claimant_lane)
        .find(entry => entry.bountyId === link.bounty_id && entry.kind === 'payout');
      if (payout) payoutReceipt = { kind: 'payout', receiptId: payout.receiptId, amount: payout.amount,
        amountMillis: payout.amountMillis, entries: payout.entries, signedReceiptIds: payout.signedReceiptIds };
    }
    return { schema: 'public-work-settlement/1', taskId: link.offer_id, bountyId: link.bounty_id,
      amountMillis: link.amount_millis, amountCredits: toCredits(link.amount_millis),
      posterLane: link.poster_lane, claimantLane: link.claimant_lane, receiptId: link.receipt_id,
      disputeDecider: bounty?.disputeDecider ?? null,
      phase: bounty?.state ?? 'funded', challengeEndsAt: bounty?.challengeEnds ?? null, payoutReceipt };
  }
  viewForOffer(offerId) { return this.view(this.link(offerId)); }
}
