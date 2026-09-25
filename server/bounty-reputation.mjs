// Bounty -> reputation projector (integration-map slice #4).
//
// Feeds the room's richest source of observed agent behavior — the bounty
// event stream — into the generic reputation tracker. Projection is a pure
// fold over `bounty_events`: replaying it twice yields byte-identical
// scores, so retries can never double-count. Scores are derived, never
// stored; the only persistent reputation state is the review-only packet
// journal for probation-gate denials (written by the escrow, read by
// arbiters).
//
// Standing flows into exactly two surfaces, both read-side and
// review-shaped — never money, never suspension:
//   1. CLAIM ELIGIBILITY (the gate): a probation-band lane may only claim
//      bounties up to PROBATION_MAX_CLAIM_CREDITS credits. Denials produce
//      review packets for humans/arbiters (the dispute machine stays the
//      human-bound path).
//   2. ROUTING VISIBILITY (the annotation): the bounty listing can carry a
//      per-viewer { band, maxClaimMillis, claimable } answer so the routing
//      layer sees which bounties are routable to that lane. Nothing is ever
//      hidden and the claim gate stays the sole enforcement point.
// Scores never touch payout amounts, never auto-ban, never auto-slash, and
// decay always offers a way back. Scores are reputation points, never
// money — the room stays credits-only.
//
// Beyond the five bounty-lifecycle signals, the projector consumes the
// human-verdict signals #792 added: a verifier's pinned-rubric acceptance
// overturned by an upheld dispute (acceptance_overturned, the overturn-rate
// feed candidate #6 names) and an arbiter-confirmed sybil cluster
// (sybil_confirmed; dismissed flags stay neutral — honest coincidence must
// be dismissible without lasting harm).
import { createReputation, bandOf, REPUTATION_BANDS, BOUNTY_SIGNAL_WEIGHTS } from "./reputation.mjs";

export { REPUTATION_BANDS, BOUNTY_SIGNAL_WEIGHTS };
// Probation-band lanes may only claim small bounties. 5 credits keeps the
// gate meaningful (well above micro-bounties) without being a soft ban.
export const PROBATION_MAX_CLAIM_CREDITS = 5;
export const PROBATION_MAX_CLAIM_MILLIS = PROBATION_MAX_CLAIM_CREDITS * 1000;

const laneOf = value => typeof value === "string" && value.length > 0 ? value : null;

// Typed signals for a `bounty.decided` event. The enriched event data
// carries claimant + challenger + verifier (bounty-escrow.mjs); old events
// without them are skipped rather than guessed at.
function decidedSignals(data) {
  const claimant = laneOf(data.claimant), challenger = laneOf(data.challenger);
  if (!claimant || !challenger) return [];
  const out = [];
  const outcome = data.outcome;
  if (outcome === "upheld") {
    // Challenger was right: the work was judged bad. Claimant loses the
    // dispute and the anti-flake bond is slashed to the pool. The verifier
    // whose pinned-rubric acceptance the dispute overturned takes the
    // acceptance_overturned signal (the overturn-rate feed integration-map
    // candidate #6 names; slice #6's rubrics make the verdict checkable).
    out.push({ agent: claimant, type: "dispute_lost" });
    out.push({ agent: claimant, type: "bond_forfeited" });
    out.push({ agent: challenger, type: "dispute_won" });
    const verifier = laneOf(data.verifier);
    if (verifier && verifier !== claimant && verifier !== challenger)
      out.push({ agent: verifier, type: "acceptance_overturned" });
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
    case "sybil.flag-resolved": {
      // Slice #4 + #10: an arbiter confirmed the lane's membership in a
      // correlated (sybil) cluster — a judged verdict, so it lands as a
      // penalty on every member lane. Dismissed flags (honest coincidence)
      // stay neutral: no signal, no lasting harm.
      if (data.resolution !== "confirmed") return [];
      const lanes = Array.isArray(data.memberLanes) ? data.memberLanes : [];
      return lanes.map(laneOf).filter(Boolean).map(agent => ({ agent, type: "sybil_confirmed" }));
    }
    default:
      return [];
  }
}

// Fold every bounty event for the room into per-agent reputation.
// Deterministic: same events, same nowMs -> same scores, always.
//
// Membership gate: reputation accrues only to CURRENT active room members.
// Stale labels (members who left) and phantom labels (never members) project
// to nothing — a forged or leftover lane in an old event can never build
// standing. Without a membership source (legacy string-only test mode) the
// projector keeps the historical unfiltered behavior.
export function projectBountyReputation(escrow, roomId, { nowMs } = {}) {
  const now = nowMs === undefined ? escrow.nowMs() : nowMs;
  const rep = createReputation();
  const applied = [];
  const memberIds = typeof escrow.memberLaneIds === "function" ? escrow.memberLaneIds(roomId) : null;
  for (const event of escrow.listEvents(roomId)) {
    const at = Number.isInteger(Date.parse(event.at)) ? Date.parse(event.at) : now;
    for (const s of signalsForEvent(event)) {
      if (memberIds !== null && !memberIds.has(s.agent)) continue;
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

// Routing visibility for one lane: the band-derived view the routing layer
// uses when deciding which bounties to surface to this lane. Projected once
// per call; claimable(amountMillis) answers per bounty without re-folding
// the event stream, and mirrors the claim gate's cap rule so the routing
// layer and the gate can never drift. Visibility only — nothing here hides
// bounties, blocks claims, or touches money; the claim gate stays the sole
// enforcement point, and bands still never suspend.
export function routingVisibility(escrow, roomId, agentId, { nowMs } = {}) {
  const summary = reputationSummary(escrow, roomId, agentId, { nowMs });
  const maxClaimMillis = summary.band === REPUTATION_BANDS.PROBATION ? PROBATION_MAX_CLAIM_MILLIS : null;
  return Object.freeze({
    agentId, band: summary.band, score: summary.score, maxClaimMillis,
    nowMs: summary.nowMs,
    claimable: amountMillis => maxClaimMillis === null || amountMillis <= maxClaimMillis,
  });
}

export { bandOf };
