// Claim -> reputation projector (claim-bonds P1).
//
// What this is: the P1 reputation-cost claim-bond projector, gated by the
// P0 shadow baseline (hidden_files/claimbond-shadow/BASELINE-2026-10-05.md,
// verdict CONCENTRATED: 23 flakes, top-3 owners 91.3%, all lease_expired).
// Where P0 measured "do flakes concentrate?", P1 prices the two behaviors
// the baseline found: burst claiming (claim-hoarding) and observable flake.
//
// Design principle (from the spec): price hoarding, don't punish parallel
// work. The room's normal operating mode during QA waves IS many concurrent
// claims, so P1 uses reputation surcharges — cost, not prohibition. No
// strikes, no auto-ban, no auto-rejection of claims, no hard eligibility
// gate at any band. Consistent with server/reputation.mjs (scores gate
// eligibility and routing visibility only, never bans) and the room's
// retention finding (strike/absence-penalty framing is a retention
// destroyer).
//
// Denomination: reputation points in the existing tracker (bounded +/-100,
// 30-day decay half-life, trusted >= 40 / probation < -20; decay always
// offers a way back). The P0 "1000 millis" shadow bond moved nothing; P1
// keeps that honesty: nothing here moves credits, pays out, or changes any
// payout amount. Money-honesty line: claim bonds cost standing, not money;
// the room stays credits-only; no bond is redeemable and no forfeit pays
// anyone.
//
// Signal mapping (pure fold over work_claim.updated event rows; replay is
// idempotent — same events, same signals, always):
//   claimed                                  -> opens a position; no signal
//                                            (if the lane already holds >=
//                                            HOARDING_CAP open claims, an
//                                            immediate claim_hoarded (-4))
//   state_changed to done                    -> claim_completed (+3)
//   released (clean owner release)           -> claim_released (+1)
//   lease_expired                            -> claim_flaked (-6, existing
//                                            weight) to the previous owner
//   reviewed with verdict changes_requested  -> claim_judged_bad (-10)
//   renewed                                  -> nothing; the position stays
//                                            open. Renewal is the correct
//                                            escape hatch for long work:
//                                            extend the lease instead of
//                                            letting it lapse.
// Positions track open claims per lane; null-lease open claims count toward
// the cap (an open position with no lease is the maximum-hoarding shape,
// and excluding them would make leaseHours: null a trivial surcharge
// bypass). A reassigned claim moves its position to the new lane.
//
// Honest gaps (recorded, not solved): the room cannot observe off-board
// completion. A lane that finishes without marking done still takes
// claim_flaked on expiry; an eventual done posts claim_completed (+3)
// against it (net -3) and decay erases the rest over ~30d. Observable
// flake is what the room can price.
//
// Wiring: ADDITIVE ONLY. This module never imports or calls
// server/work-claims.mjs or server/work-claim-routes.mjs (lane-owned #1303
// code). It reads the durable `events` table and writes only its own
// `claim_reputation_signals` table, registered in server/writer-fence.mjs
// (lazyAdditiveTables) so the recovery audit keeps passing on room
// databases where the journal sync ran — allowed, never required, same
// standing as the P0 claim_bond_shadow table. Live wiring into the
// analytics tail stays analytics-lane owned; this change ships the
// projector, the journal, and the read-side visibility helper, not the
// wiring. No new room event types.
import { createReputation, bandOf, REPUTATION_BANDS, BOUNTY_SIGNAL_WEIGHTS } from "./reputation.mjs";

export { REPUTATION_BANDS, BOUNTY_SIGNAL_WEIGHTS, bandOf };

// A lane may hold many claims; the surcharge prices the tail beyond normal
// operating levels. Evidence anchor: the 10-05 Grok Bot cluster held 8
// concurrent claims; lanes in healthy operation sit at 2-4 open. 5 is
// above normal, below the observed hoard.
export const HOARDING_CAP = 5;

// The four P1 signal types, all registered in BOUNTY_SIGNAL_WEIGHTS (the
// tracker's signal vocabulary; signalTyped throws on unknown types).
export const CLAIM_REPUTATION_SIGNAL_TYPES = Object.freeze([
  "claim_completed",  // +3: claimed work finished and marked done
  "claim_released",   // +1: owner released cleanly before expiry (correct behavior)
  "claim_flaked",     // -6: existing weight, lease expiry (observable flake)
  "claim_judged_bad", // -10: review verdict changes_requested (judged bad work)
  "claim_hoarded"     // -4: claim opened while the lane held >= HOARDING_CAP open
]);

export const CLAIM_REPUTATION_SCHEMA = `
CREATE TABLE IF NOT EXISTS claim_reputation_signals (
  id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  weight INTEGER NOT NULL,
  at INTEGER NOT NULL,
  room_id TEXT,
  room_seq INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS claim_reputation_signals_claim ON claim_reputation_signals(claim_id);
CREATE INDEX IF NOT EXISTS claim_reputation_signals_kind ON claim_reputation_signals(kind);
CREATE INDEX IF NOT EXISTS claim_reputation_signals_agent ON claim_reputation_signals(agent_id);
`;

export function ensureClaimReputationSchema(db) {
  db.exec(CLAIM_REPUTATION_SCHEMA);
}

const laneOf = value => typeof value === "string" && value.length > 0 ? value : null;

// Pure fold: ordered work_claim.updated rows -> derived signals + end-of-fold
// open-claim counts per lane. A row is { roomId, seq, atMs, data } where
// data is the event's data object (workClaim, action, claimState, ownerId,
// previousOwnerId, verdict, ...).
function foldClaims(rows) {
  const signals = [];
  // Positions are keyed by (roomId, claimId): claim slugs are only unique
  // within a room, and the events table carries every room's claims, so a
  // claimId-only key mixes positions across rooms (wrong hoarding counts,
  // wrong attribution, dropped signals).
  const posKey = (roomId, claimId) => `${roomId}\0${claimId}`;
  const open = new Map();    // posKey -> ownerId (observed open positions)
  const seen = new Map();    // posKey -> true (ever observed, for mid-history terminals)
  const laneOpen = new Map(); // agentId -> open-claim count at the fold frontier
  const inc = agent => laneOpen.set(agent, (laneOpen.get(agent) ?? 0) + 1);
  const dec = agent => {
    const n = (laneOpen.get(agent) ?? 0) - 1;
    if (n <= 0) laneOpen.delete(agent); else laneOpen.set(agent, n);
  };
  const openPosition = (key, agent) => { open.set(key, agent); inc(agent); };
  const closePosition = key => {
    const agent = open.get(key);
    if (agent !== undefined) dec(agent);
    open.delete(key);
    return agent ?? null;
  };
  const emit = (key, claimId, row, agent, type) => {
    seen.set(key, true);
    signals.push(Object.freeze({
      roomId: typeof row?.roomId === "string" ? row.roomId : null,
      claimId, seq: row.seq, at: row.atMs, agent, type,
      weight: BOUNTY_SIGNAL_WEIGHTS[type]
    }));
  };

  for (const row of rows) {
    const data = row?.data;
    if (!data || typeof data !== "object") continue;
    const claimId = typeof data.workClaim === "string" ? data.workClaim : null;
    const action = typeof data.action === "string" ? data.action : null;
    if (!claimId || !action) continue;
    const roomId = typeof row?.roomId === "string" ? row.roomId : "";
    const key = posKey(roomId, claimId);
    const position = open.get(key) ?? null;
    const observed = seen.has(key);

    switch (action) {
      case "claimed": {
        // A mid-history fold may re-observe an open claim; only first sight opens.
        const agent = laneOf(data.ownerId);
        if (!position && agent && !observed) {
          // Hoarding surcharge, posted at claim time: cost, not prohibition.
          if ((laneOpen.get(agent) ?? 0) >= HOARDING_CAP) emit(key, claimId, row, agent, "claim_hoarded");
          openPosition(key, agent);
          seen.set(key, true);
        }
        break;
      }
      case "state_changed": {
        const state = data.claimState;
        if (state === "done") {
          if (position) { emit(key, claimId, row, position, "claim_completed"); closePosition(key); }
          else if (!observed) {
            // Mid-history completion: the lane did real work we never saw
            // claimed; price it once, then mark seen so repeats stay silent.
            const who = laneOf(data.ownerId);
            if (who) emit(key, claimId, row, who, "claim_completed");
            else seen.set(key, true);
          }
          // done on a seen-but-closed claim: duplicate terminal, silent.
        } else if ((state === "claimed" || state === "in_progress") && !position && !observed) {
          // The observer started mid-history: an owned, unfinished claim is
          // treated as open from first sight (same shape as the P0 shadow).
          const agent = laneOf(data.ownerId);
          if (agent) { openPosition(key, agent); seen.set(key, true); }
        }
        break;
      }
      case "released": {
        if (position) { emit(key, claimId, row, position, "claim_released"); closePosition(key); }
        else if (!observed) {
          const who = laneOf(data.ownerId);
          if (who) emit(key, claimId, row, who, "claim_released");
          else seen.set(key, true);
        }
        break;
      }
      case "reassigned": {
        const next = laneOf(data.ownerId);
        if (position && next && next !== position) { dec(position); openPosition(key, next); }
        else if (!position && next && !observed) { openPosition(key, next); seen.set(key, true); }
        break;
      }
      case "lease_expired": {
        // previousOwnerId names the lane that flaked (ownerId is cleared to
        // null on auto-release). Observable flake is priced even when the
        // claim was never observed open — the signal stands; the room cannot
        // tell "worked off-board" from "abandoned".
        if (position || !observed) {
          const who = laneOf(data.previousOwnerId) ?? position ?? laneOf(data.ownerId);
          if (who) emit(key, claimId, row, who, "claim_flaked");
          else seen.set(key, true);
        }
        closePosition(key);
        break;
      }
      case "reviewed": {
        if (data.verdict === "changes_requested" && (position || !observed)) {
          const who = laneOf(data.ownerId) ?? position;
          if (who) emit(key, claimId, row, who, "claim_judged_bad");
          else seen.set(key, true);
          // The position stays OPEN: the P1 spec counts positions open until
          // done/released/expired, and server/work-claims.mjs keeps a claim
          // active after a review (review only records an attestation). A
          // lane that reworks and marks done after a changes_requested
          // review earns the +3 completion, and its open-claim count keeps
          // counting the claim while it is being reworked.
        }
        // Any other verdict leaves the position open; a note is not a verdict.
        break;
      }
      // created, renewed, pr_merged, pr_closed, ci_changed: no signal.
      // Renewal is the correct escape hatch: extend the lease instead of
      // letting it lapse. The position stays open and no signal is posted.
      default:
        break;
    }
  }
  return { signals: Object.freeze(signals), openClaims: laneOpen };
}

// The derived signal list for an ordered row set. Idempotent: same rows ->
// same signals, so replays can never double-count.
export function deriveClaimSignals(rows) {
  return foldClaims(rows).signals;
}

// Fold every claim event for the room into per-agent reputation. Same
// shape as projectBountyReputation: { reputation, signals, openClaims, nowMs }.
export function projectClaimReputation(rows, { nowMs } = {}) {
  const { signals, openClaims } = foldClaims(rows);
  const rep = createReputation();
  for (const s of signals) {
    // Out-of-order signals are ignored by signalTyped: a late-arriving
    // older `at` must not regress updatedMs.
    rep.signalTyped(s.agent, s.type, { at: s.at });
  }
  return Object.freeze({
    reputation: rep,
    signals,
    openClaims: new Map(openClaims),
    nowMs: nowMs === undefined ? Date.now() : nowMs
  });
}

// Full standing summary for one lane: decayed score, band, open claims,
// and whether the lane sits at the hoarding cap.
export function claimReputationSummary(projected, agentId, { nowMs } = {}) {
  const now = nowMs === undefined ? (projected.nowMs ?? Date.now()) : nowMs;
  const record = projected.reputation.get(agentId);
  const open = projected.openClaims.get(agentId) ?? 0;
  return Object.freeze({
    agentId,
    score: projected.reputation.scoreAt(agentId, now),
    band: projected.reputation.bandFor(agentId, { nowMs: now }),
    positive: record.positive,
    negative: record.negative,
    updatedMs: record.updatedMs,
    openClaims: open,
    atCap: open >= HOARDING_CAP,
    nowMs: now
  });
}

// Read-side listing annotation for one lane (routing visibility, like
// bounty-reputation's routingVisibility): what the listing layer shows so
// the cap is legible to the lane before they claim. Visibility only —
// nothing here hides claims, blocks claims, or touches money.
export function laneClaimBondVisibility(projected, agentId, { nowMs } = {}) {
  const s = claimReputationSummary(projected, agentId, { nowMs });
  return Object.freeze({
    agentId: s.agentId, band: s.band, score: s.score,
    openClaims: s.openClaims, atCap: s.atCap, nowMs: s.nowMs
  });
}

const INSERT_SIGNAL = `INSERT OR IGNORE INTO claim_reputation_signals
  (id, claim_id, kind, agent_id, weight, at, room_id, room_seq)
  VALUES (?,?,?,?,?,?,?,?)`;

// Signal IDs carry the room: claim slugs are only unique within a room and
// per-room sequences restart at 1, so a room-less id collides across rooms
// and INSERT OR IGNORE silently drops the second room's signal.
const signalId = (roomId, claimId, type, roomSeq) => `claimrep:${roomId}:${claimId}:${type}:${roomSeq}`;

function parseEventRow(row) {
  try {
    const body = JSON.parse(row.body);
    if (!body || typeof body !== "object" || !body.data || typeof body.data !== "object") return null;
    const atMs = Date.parse(body.at);
    if (!Number.isFinite(atMs)) return null;
    return { roomId: row.room_id, seq: row.sequence, atMs, data: body.data };
  } catch {
    return null;
  }
}

// Read work_claim.updated events from the durable events table and fold
// them into the claim-reputation signal journal. Idempotent: re-running
// changes nothing. The journal is the analytics surface the P1 measurement
// section names (weekly diff against the 2026-10-05 baseline).
export function syncClaimReputationJournal(db, { roomId = null } = {}) {
  ensureClaimReputationSchema(db);
  // One-time format migration: pre-fix signal ids were
  // claimrep:{claimId}:{type}:{seq} with no room, so two rooms sharing a
  // claim slug collide. The journal is a pure fold of the events table, so
  // stale-format rows are purged and re-derived below — no data loss, no
  // double count. New ids always start with `claimrep:{room_id}:`.
  const purge = db.prepare(`DELETE FROM claim_reputation_signals WHERE id = ?`);
  for (const stale of db.prepare(`SELECT id, room_id FROM claim_reputation_signals`).all()) {
    if (typeof stale.room_id !== "string" || !stale.id.startsWith(`claimrep:${stale.room_id}:`)) {
      purge.run(stale.id);
    }
  }
  const rows = db.prepare(
    `SELECT room_id, sequence, body FROM events
     WHERE json_extract(body,'$.type')='work_claim.updated'
     ${roomId ? "AND room_id=?" : ""}
     ORDER BY sequence`
  ).all(...(roomId ? [roomId] : []));
  const parsed = [];
  for (const row of rows) {
    const event = parseEventRow(row);
    if (event) parsed.push(event);
  }
  const { signals } = foldClaims(parsed);
  const insert = db.prepare(INSERT_SIGNAL);
  let written = 0;
  const insertOne = s => {
    written += insert.run(
      signalId(s.roomId, s.claimId, s.type, s.seq),
      s.claimId, s.type, s.agent, s.weight, s.at,
      s.roomId, s.seq
    ).changes;
  };
  const write = db.transaction
    ? db.transaction(list => { for (const s of list) insertOne(s); })
    : (list => { for (const s of list) insertOne(s); });
  write(signals);
  return { eventsRead: parsed.length, signalsDerived: signals.length, signalsWritten: written };
}
