// Automatic payout-epoch progression (#3693, #3844).
//
// closeEpoch has always been the escrow keeper pass — challenge-window
// auto-approve, the approved sweep, dispute timeout defaults, deadline
// refunds, unfunded expiry — but it only ever ran when a human or agent
// remembered to invoke the manual route, twice. Accepted awards sat
// attributed indefinitely and no surface complained, because job health
// had no escrow entry to go red. This module is the missing trigger: a
// due-scan over bounty_records plus one closeEpoch per room that has work
// waiting, registered as the "escrow-epochs" job in server/jobs.mjs so
// both runtimes run it and the heartbeat reports it.
//
// Two-step semantics are preserved by construction: closeEpoch snapshots
// its rows up front, so a bounty approved by a pass is not swept by the
// same pass. The keeper calls closeEpoch exactly once per room per tick;
// the second close (approved -> paid) happens on a later tick, exactly as
// the manual double invocation did. Nothing progresses before its window
// or deadline: the due predicate below mirrors _keeperPass condition for
// condition, and closeEpoch re-checks every condition itself.
import { BountyEscrow, DISPUTE_TIMEOUT_MS } from "./bounty-escrow.mjs";

const ACTIONABLE_STATES = "('proposed','funded','claimed','submitted','accepted','disputed','approved')";

// A dispute whose machine record is already terminal (resolved/withdrawn)
// but whose bounty never settled — the finalize handler must have thrown
// inline — is due for the keeper's retry immediately, not at the timeout.
// Dispute rows are envelope JSON ({v, kind, data}); legacy rows are bare.
const TERMINAL_DISPUTE = `EXISTS (SELECT 1 FROM bounty_disputes d
  WHERE d.dispute_id = b.dispute_id
  AND COALESCE(json_extract(d.body, '$.data.state'), json_extract(d.body, '$.state'))
    IN ('resolved','withdrawn'))`;

// "Due" mirrors _keeperPass in bounty-escrow.mjs exactly:
// - approved: always actionable (the sweep is the second close);
// - accepted: challenge window fully passed;
// - proposed: deadline passed and any snooze has lapsed (expire unfunded);
// - submitted / funded / claimed: deadline passed (settle / refund);
// - disputed, unsettled: dispute terminal (retry) or open past the 14-day
//   timeout (default release).
// Five ? parameters, all the same `now`.
const DUE_WHERE = `(
     b.state = 'approved'
  OR (b.state = 'accepted' AND b.challenge_ends_ms IS NOT NULL AND b.challenge_ends_ms <= ?)
  OR (b.state = 'proposed' AND b.deadline_ms <= ? AND (b.snoozed_until_ms IS NULL OR b.snoozed_until_ms <= ?))
  OR (b.state IN ('submitted','funded','claimed') AND b.deadline_ms <= ?)
  OR (b.state = 'disputed' AND b.dispute_id IS NOT NULL AND b.resolution_json IS NULL
      AND ((b.dispute_opened_ms IS NOT NULL AND ? - b.dispute_opened_ms > ${DISPUTE_TIMEOUT_MS})
           OR ${TERMINAL_DISPUTE}))
)`;

// CURE-CLOCK-UNIFY (S5): the production keeper tick is fed by three
// clock expressions that must be ONE source — the escrow-epochs job's
// enabled gate and run sample (server/jobs.mjs) and the store clock the
// production escrow is built with (server/store.mjs, `now: () =>
// this.now()`). Two wall-clock samples taken back to back agree to
// within a few milliseconds; independently-sourced clocks (a frozen
// fixture clock on one leg, the wall clock on another, a skewed second
// handle) diverge by orders of magnitude more. The assertion samples
// every source it is handed and throws when the spread exceeds the
// tolerance, so a mis-wired clock fails loud at the job door instead
// of silently splitting scan from settlement. It is silent when fewer
// than two sources are observable (a bare store double has neither a
// store clock nor a wired escrow — there is nothing to disagree).
export const ESCROW_CLOCK_DIVERGENCE_TOLERANCE_MS = 1000;

export function assertUnifiedEscrowClocks({ scanNow = null, store = null, escrow = null,
  toleranceMs = ESCROW_CLOCK_DIVERGENCE_TOLERANCE_MS } = {}) {
  const samples = [];
  const add = (label, value) => {
    const n = typeof value === "function" ? value() : value;
    if (Number.isFinite(n)) samples.push([label, Number(n)]);
  };
  add("scan", scanNow);
  if (store && typeof store.now === "function") add("store", () => store.now());
  const instance = escrow ?? (store?.bountyEscrow instanceof BountyEscrow ? store.bountyEscrow : null);
  if (instance && typeof instance.nowMs === "function") add("escrow", () => instance.nowMs());
  if (samples.length < 2) return 0;
  const values = samples.map(([, v]) => v);
  const spread = Math.max(...values) - Math.min(...values);
  if (spread > toleranceMs)
    throw new Error(`escrow clock sources diverge by ${spread}ms (tolerance ${toleranceMs}ms): `
      + samples.map(([label, v]) => `${label}=${v}`).join(", "));
  return spread;
}

function query(store, sql, params = []) {
  if (!store?.db?.prepare) return null;
  try { return store.db.prepare(sql).all(...params); }
  catch { return null; } // a store that has never run escrow has no tables
}

function dueCount(store, now, { excludeApproved = false } = {}) {
  const rows = query(store,
    `SELECT COUNT(*) AS n FROM bounty_records b WHERE ${DUE_WHERE}${excludeApproved ? " AND b.state != 'approved'" : ""}`,
    [now, now, now, now, now]);
  return rows ? Number(rows[0]?.n ?? 0) : 0;
}

// The next UTC millisecond at which any bounty becomes actionable, or
// null when no bounty is waiting on time at all. Two ? parameters: `now`,
// used as the due time of work that is already actionable (approved rows
// awaiting their sweep, terminal disputes awaiting their retry).
export function escrowEpochNextDueAt(store, now) {
  const rows = query(store, `SELECT MIN(t) AS due FROM (
      SELECT CASE b.state
        WHEN 'approved' THEN ?
        WHEN 'accepted' THEN b.challenge_ends_ms
        WHEN 'proposed' THEN MAX(b.deadline_ms, COALESCE(b.snoozed_until_ms, b.deadline_ms))
        WHEN 'disputed' THEN CASE WHEN ${TERMINAL_DISPUTE} THEN ?
          ELSE b.dispute_opened_ms + ${DISPUTE_TIMEOUT_MS + 1} END
        ELSE b.deadline_ms
      END AS t
      FROM bounty_records b
      WHERE b.state IN ${ACTIONABLE_STATES}
    ) WHERE t IS NOT NULL`, [now, now]);
  if (!rows) return null;
  const due = rows[0]?.due;
  return due == null ? null : Number(due);
}

// One automatic epoch pass over every room with due work. Returns a
// numbers-only summary (the job heartbeat's compact summary keeps numbers
// and booleans verbatim):
// - due:     bounties the pass found waiting;
// - overdue: bounties STILL past their window after the pass, excluding
//            `approved` ones (an approved bounty is mid-progression — its
//            sweep is next tick's work, by design). On a healthy tick this
//            is 0; a poisoned bounty that fails its keeper action stays
//            counted here until it lands, so a stall is visible in job
//            health instead of silent;
// - failed / errors: per-bounty failures (closeEpoch already isolates
//            them in its summary; a whole-room throw counts once). errors
//            mirrors failed so the schedulers mark the tick failed.
export function progressEscrowEpochs(store, { now = Date.now(), escrow = null } = {}) {
  const summary = { rooms: 0, due: 0, approved: 0, paid: 0, refunded: 0,
    released: 0, expired: 0, failed: 0, errors: 0, overdue: 0 };
  if (!store?.db?.prepare) return summary;
  summary.due = dueCount(store, now);
  if (summary.due === 0) return summary;
  const roomRows = query(store,
    `SELECT DISTINCT b.room_id AS roomId FROM bounty_records b WHERE ${DUE_WHERE}`,
    [now, now, now, now, now]);
  const instance = escrow
    ?? (store.bountyEscrow instanceof BountyEscrow ? store.bountyEscrow : new BountyEscrow(store));
  for (const { roomId } of roomRows ?? []) {
    summary.rooms += 1;
    try {
      // No caller: a mechanical close attributes to the rule actor and
      // records triggeredBy null, exactly like the keeper pass itself.
      // CURE-CLOCK-UNIFY: the tick's one `now` is threaded into the
      // close — closeEpoch must not re-read the escrow's live clock
      // mid-tick (S2: a lot becoming due between the scan and its room's
      // close was approved same-tick while `due` under-reported it; S5:
      // scan/escrow divergence split what a tick could settle).
      const { summary: epoch } = instance.closeEpoch(roomId, { now });
      summary.approved += epoch.approved?.length ?? 0;
      summary.paid += epoch.swept?.length ?? 0;
      summary.refunded += epoch.refunded?.length ?? 0;
      summary.released += epoch.released?.length ?? 0;
      summary.expired += epoch.expiredUnfunded?.length ?? 0;
      summary.failed += epoch.failed?.length ?? 0;
    } catch (error) {
      // One room's epoch throwing must not stall the other rooms.
      summary.failed += 1;
      console.error(`[escrow-epochs] epoch close failed: ${String(error?.message ?? error).replace(/[\r\n]+/g, " ").slice(0, 200)}`);
    }
  }
  summary.errors = summary.failed;
  summary.overdue = dueCount(store, now, { excludeApproved: true });
  if (summary.rooms > 0) console.info(JSON.stringify({ event: "room.escrow_epochs", ...summary }));
  return summary;
}
