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
//
// Kill flag (AUDIT C-08 step-3 remainder, M-1): a dedicated halt for this
// keeper alone. Before it, the only pause was the deployment-wide
// maintenance mode (ROOM_MAINTENANCE), which stops every job and the
// whole room to stop one sweep. The flag lives in one lazy table with
// two scopes: a global row (scope "*") halts every room's keeper, and a
// per-room row (scope = room id) halts only that room — the two incident
// shapes (a fleet-wide bad sweep; one room's keeper wedged) — and either
// scope is set or cleared only through the operator-token surface
// (/api/operator/escrow-keeper/*), the same authority class as the
// maintenance flag: operator configuration, never a room permission or
// an ordinary request parameter. While a kill is in force the pass
// skips cleanly: no epoch closes, the summary reports killed (never
// errors — a deliberate halt is not a failure), and job health carries
// the state and its since-timestamp. Clearing a kill resumes at the
// normal rate: the due-scan below re-derives what is due from
// bounty_records on every tick and the two-step close still advances
// one step per room per tick, so there is no catch-up storm to damp.
import { BountyEscrow, DISPUTE_TIMEOUT_MS } from "./bounty-escrow.mjs";

export const ESCROW_KEEPER_KILL_SCHEMA = `
CREATE TABLE IF NOT EXISTS escrow_keeper_kill (
  scope TEXT PRIMARY KEY,
  killed_at INTEGER NOT NULL,
  set_by TEXT
);`;

export const ESCROW_KEEPER_GLOBAL_SCOPE = "*";

function killTableExists(store) {
  try {
    return Boolean(store.db.prepare(
      "SELECT 1 AS hit FROM sqlite_master WHERE type='table' AND name='escrow_keeper_kill'").get()?.hit);
  } catch { return false; }
}

export function ensureEscrowKeeperKillSchema(store) {
  if (store?.db?.exec) store.db.exec(ESCROW_KEEPER_KILL_SCHEMA);
}

// The kill state, oldest first. Read paths never create the table: a
// store the operator has never killed on has no rows and no table, and
// both read as "not killed".
export function escrowKeeperKillState(store) {
  const empty = { global: null, rooms: [] };
  if (!store?.db?.prepare || !killTableExists(store)) return empty;
  let rows;
  try {
    rows = store.db.prepare(
      "SELECT scope, killed_at, set_by FROM escrow_keeper_kill ORDER BY killed_at ASC, scope ASC").all();
  } catch { return empty; }
  const state = { global: null, rooms: [] };
  for (const row of rows ?? []) {
    const entry = { killedAt: Number(row.killed_at), setBy: row.set_by ?? null };
    if (row.scope === ESCROW_KEEPER_GLOBAL_SCOPE) state.global = entry;
    else state.rooms.push({ roomId: row.scope, ...entry });
  }
  return state;
}

const KILL_ROOM_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

// Set a kill. roomId null (or omitted) is the global scope. Idempotent:
// an already-killed scope keeps its first killed_at, so the health
// surface's since-timestamp is when the halt began, not when it was
// last re-asserted.
export function setEscrowKeeperKill(store, { roomId = null, by = null, now = Date.now() } = {}) {
  if (!store?.db?.prepare) throw new TypeError("keeper kill needs a store");
  if (roomId != null && (typeof roomId !== "string" || !KILL_ROOM_ID.test(roomId))) {
    throw new TypeError("keeper kill roomId must be a room id");
  }
  ensureEscrowKeeperKillSchema(store);
  store.db.prepare(
    "INSERT INTO escrow_keeper_kill (scope, killed_at, set_by) VALUES (?, ?, ?) ON CONFLICT(scope) DO NOTHING")
    .run(roomId ?? ESCROW_KEEPER_GLOBAL_SCOPE, now, by);
  return escrowKeeperKillState(store);
}

// Clear exactly one scope (global when roomId is omitted). Clearing a
// scope that is not killed is a no-op; the other scope is untouched.
export function clearEscrowKeeperKill(store, { roomId = null } = {}) {
  if (!store?.db?.prepare) throw new TypeError("keeper kill needs a store");
  if (roomId != null && (typeof roomId !== "string" || !KILL_ROOM_ID.test(roomId))) {
    throw new TypeError("keeper kill roomId must be a room id");
  }
  ensureEscrowKeeperKillSchema(store);
  store.db.prepare("DELETE FROM escrow_keeper_kill WHERE scope = ?")
    .run(roomId ?? ESCROW_KEEPER_GLOBAL_SCOPE);
  return escrowKeeperKillState(store);
}

const isoOrNull = ms => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

// Full state for the operator surface (token-gated; room ids allowed).
export function escrowKeeperKillView(store) {
  const state = escrowKeeperKillState(store);
  return {
    killed: Boolean(state.global) || state.rooms.length > 0,
    global: state.global
      ? { since: isoOrNull(state.global.killedAt), setBy: state.global.setBy }
      : null,
    rooms: state.rooms.map(room => ({
      roomId: room.roomId, since: isoOrNull(room.killedAt), setBy: room.setBy
    }))
  };
}

// The public job-health projection: state and since-timestamps, counts
// only — a killed room's id is that room's business, so it never
// reaches the unauthenticated health surface (the integrity job's
// recordId rule). `since` is the earliest kill still in force.
export function escrowKeeperHealth(store) {
  const state = escrowKeeperKillState(store);
  const roomSince = state.rooms.length ? Math.min(...state.rooms.map(room => room.killedAt)) : null;
  const since = state.global && roomSince != null
    ? Math.min(state.global.killedAt, roomSince)
    : state.global ? state.global.killedAt : roomSince;
  return {
    killed: Boolean(state.global) || state.rooms.length > 0,
    global: Boolean(state.global),
    since: isoOrNull(since),
    globalSince: state.global ? isoOrNull(state.global.killedAt) : null,
    killedRooms: state.rooms.length,
    roomSince: isoOrNull(roomSince)
  };
}

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
// - killed / killedAt / killedRooms: present only when the kill flag
//            actually held work this pass (globally, or per-room).
//            A killed pass never sets errors: a deliberate halt is a
//            skip, not a failure.
export function progressEscrowEpochs(store, { now = Date.now(), escrow = null } = {}) {
  const summary = { rooms: 0, due: 0, approved: 0, paid: 0, refunded: 0,
    released: 0, expired: 0, failed: 0, errors: 0, overdue: 0 };
  if (!store?.db?.prepare) return summary;
  const kill = escrowKeeperKillState(store);
  summary.due = dueCount(store, now);
  if (kill.global) {
    // Killed fleet-wide: close nothing, count the halt as a skip, never
    // as a failure. `due`/`overdue` still report the waiting work, so
    // the stall the operator chose stays visible in job health.
    summary.skipped = 1;
    summary.killed = 1;
    summary.killedAt = kill.global.killedAt;
    summary.overdue = dueCount(store, now, { excludeApproved: true });
    return summary;
  }
  if (summary.due === 0) return summary;
  const roomRows = query(store,
    `SELECT DISTINCT b.room_id AS roomId FROM bounty_records b WHERE ${DUE_WHERE}`,
    [now, now, now, now, now]);
  const instance = escrow
    ?? (store.bountyEscrow instanceof BountyEscrow ? store.bountyEscrow : new BountyEscrow(store));
  const killedRoomIds = new Set(kill.rooms.map(room => room.roomId));
  let killedRooms = 0;
  for (const { roomId } of roomRows ?? []) {
    if (killedRoomIds.has(roomId)) { killedRooms += 1; continue; }
    summary.rooms += 1;
    try {
      // No caller: a mechanical close attributes to the rule actor and
      // records triggeredBy null, exactly like the keeper pass itself.
      const { summary: epoch } = instance.closeEpoch(roomId);
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
  if (killedRooms > 0) {
    // At least one due room was held by its per-room kill: the tick
    // reports the halt (killed) without failing, exactly like the
    // global path. Rooms with no kill closed normally above.
    summary.killed = 1;
    summary.killedRooms = killedRooms;
  }
  if (summary.rooms > 0) console.info(JSON.stringify({ event: "room.escrow_epochs", ...summary }));
  return summary;
}
