// Bounty -> reputation projector (integration-map slice #4).
//
// Feeds the room's richest source of observed agent behavior — the bounty
// event stream — into the generic reputation tracker. Projection is a pure
// fold over `bounty_events`: replaying it twice yields byte-identical
// scores, so retries can never double-count. No new tables, no new
// persistent state; scores are derived, never stored.
//
// Standing flows into exactly one gate: CLAIM ELIGIBILITY. A probation-band
// lane may only claim bounties up to PROBATION_MAX_CLAIM_CREDITS credits.
// Scores never touch payout amounts, never auto-ban, never auto-slash:
// adverse moves produce review packets for humans/arbiters (the dispute
// machine stays the human-bound path), and decay always offers a way back.
// Scores are reputation points, never money — the room stays credits-only.
import { createReputation, bandOf, REPUTATION_BANDS, BOUNTY_SIGNAL_WEIGHTS } from "./reputation.mjs";

export { REPUTATION_BANDS, BOUNTY_SIGNAL_WEIGHTS };
// Probation-band lanes may only claim small bounties. 5 credits keeps the
// gate meaningful (well above micro-bounties) without being a soft ban.
export const PROBATION_MAX_CLAIM_CREDITS = 5;
export const PROBATION_MAX_CLAIM_MILLIS = PROBATION_MAX_CLAIM_CREDITS * 1000;

const laneOf = value => typeof value === "string" && value.length > 0 ? value : null;

// Typed signals for a `bounty.decided` event. The enriched event data
// carries claimant + challenger (bounty-escrow.mjs); old events without
// them are skipped rather than guessed at.
function decidedSignals(data) {
  const claimant = laneOf(data.claimant), challenger = laneOf(data.challenger);
  if (!claimant || !challenger) return [];
  const out = [];
  const outcome = data.outcome;
  if (outcome === "upheld") {
    // Challenger was right: the work was judged bad. Claimant loses the
    // dispute and the anti-flake bond is slashed to the pool.
    out.push({ agent: claimant, type: "dispute_lost" });
    out.push({ agent: claimant, type: "bond_forfeited" });
    out.push({ agent: challenger, type: "dispute_won" });
  } else if (outcome === "rejected" || outcome === "timeout-default" || outcome === "frivolous") {
    // Claimant was right (or the challenge died unresolved, or was ruled
    // frivolous): challenger loses; a forfeited challenge bond costs extra.
    out.push({ agent: challenger, type: "dispute_lost" });
    out.push({ agent: claimant, type: "dispute_won" });
    if (data.resolution && data.resolution.bondForfeited === true)
      out.push({ agent: challenger, type: "bond_forfeited" });
  } else if (outcome === "split") {
    // Nobody won cleanly: both sides share a small loss.
    out.push({ agent: claimant, type: "dispute_split" });
    out.push({ agent: challenger, type: "dispute_split" });
  }
  return out;
}

// Typed signals for one bounty event row ({ type, data, at, seq }).
// Returns [] for event types that carry no reputation signal.
export function signalsForEvent(event) {
  const data = event.data ?? {};
  switch (event.type) {
    case "bounty.paid": {
      // Payout released to the earner: the room's strongest positive signal.
      const earner = laneOf(data.earner);
      return earner ? [{ agent: earner, type: "payout_released" }] : [];
    }
    case "bounty.accepted": {
      // Verifier/poster accepted the submission: positive for the worker.
      const claimant = laneOf(data.claimant);
      return claimant ? [{ agent: claimant, type: "submission_accepted" }] : [];
    }
    case "bounty.refunded": {
      // Claimed then timed out without submitting: the flake signal.
      // (Dispute-cancel refunds carry resolution.kind "cancel", not
      // reason "timeout", so they never land here.)
      const claimant = laneOf(data.claimant);
      return data.reason === "timeout" && claimant ? [{ agent: claimant, type: "claim_flaked" }] : [];
    }
    case "bounty.decided":
      return decidedSignals(data);
    default:
      return [];
  }
}

// Fold every bounty event for the room into per-agent reputation.
// Deterministic: same events, same nowMs -> same scores, always.
export function projectBountyReputation(escrow, roomId, { nowMs } = {}) {
  const now = nowMs === undefined ? escrow.nowMs() : nowMs;
  const rep = createReputation();
  const applied = [];
  for (const event of escrow.listEvents(roomId)) {
    const at = Number.isInteger(Date.parse(event.at)) ? Date.parse(event.at) : now;
    for (const s of signalsForEvent(event)) {
      rep.signalTyped(s.agent, s.type, { at });
      applied.push(Object.freeze({ seq: event.seq, at, agent: s.agent, type: s.type }));
    }
  }
  return { reputation: rep, signals: Object.freeze(applied), nowMs: now };
}

// Full standing summary for one lane: decayed score, band, and the
// signals that built it.
export function reputationSummary(escrow, roomId, agentId, { nowMs } = {}) {
  const { reputation, signals, nowMs: now } = projectBountyReputation(escrow, roomId, { nowMs });
  const record = reputation.get(agentId);
  const mine = signals.filter(s => s.agent === agentId);
  return Object.freeze({
    agentId, score: reputation.scoreAt(agentId, now), band: reputation.bandFor(agentId, { nowMs: now }),
    positive: record.positive, negative: record.negative, updatedMs: record.updatedMs,
    signals: mine, nowMs: now,
  });
}

// Standing band for one lane, decayed to now. The claim path's only input.
export function claimBand(escrow, roomId, agentId, { nowMs } = {}) {
  const { reputation, nowMs: now } = projectBountyReputation(escrow, roomId, { nowMs });
  return reputation.bandFor(agentId, { nowMs: now });
}

// Claim eligibility for a lane against a bounty of amountMillis.
// Returns { allowed, band, maxClaimMillis }. Probation caps the bounty
// size; everything else is unchanged.
export function claimEligibility(escrow, roomId, agentId, amountMillis, { nowMs } = {}) {
  const band = claimBand(escrow, roomId, agentId, { nowMs });
  if (band === REPUTATION_BANDS.PROBATION && amountMillis > PROBATION_MAX_CLAIM_MILLIS)
    return { allowed: false, band, maxClaimMillis: PROBATION_MAX_CLAIM_MILLIS };
  return { allowed: true, band, maxClaimMillis: null };
}

export { bandOf };
