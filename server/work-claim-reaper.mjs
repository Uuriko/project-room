// Server-side claim reaper (guild-claimsboard B2, system #4 of John's
// 7-system build program).
//
// The reaper is the room's janitor for lapsed claim leases. It runs on the
// server/jobs.mjs registry (30 s tick, worker + node), holds a DB-backed
// leader lock so exactly one instance dispositions per tick, and applies the
// HIERARCHY guild's measured lease policy:
//
//   - grace after expiry: work 15 min / land 5 min / deploy 0
//   - forgiveness: a 2x grace window defers reaping while the lapsed owner
//     still shows life (a late worker is not punished for a hiccup)
//   - succession order for work: live successor_hint -> deterministic hash
//     LIVE[sha256(claim_id) mod n] with a 10-min exclusive adopt window ->
//     open pool. (No waitlist exists in the schema yet; that step is skipped
//     and documented.)
//   - deploy leases are non-renewable: on expiry they escalate to the room
//     owner (state held, lease cleared), never auto-reap
//   - correlated-death detector: >=15 silent or >=30% (>=3) of the room's
//     heartbeat-observed agents silent in ~120 s -> 30-min HOLD: park
//     orphans, release nothing. Mass death is a room problem, not a lease
//     problem.
//   - every reap bumps epoch+1 (crash/guild-epoch-fencing contract), so a
//     resurrected former holder presenting a stale epoch fails closed with
//     stale_epoch instead of clobbering the successor's work
//   - bounded blast radius: at most 5 dispositions per cycle
//
// READS DO NOT EMIT WRITES (claim-channel guild constraint): routine
// dispositions write history stamps only — zero room events, zero wakes.
// Deploy escalations get at most ONE coalesced room event per tick.
//
// The reaper never deletes: only state transitions + history appends. Every
// reap writes its audit record as a history stamp on the claim plus a
// structured log line.

import { randomUUID, createHash } from "node:crypto";
import {
  ACTIVE_CLAIM_STATES,
  electClaimSuccessor,
  releaseExpired,
  roomWorkClaimConfig,
} from "./work-claims.mjs";
import { WORK_CLAIM_ROW_KIND } from "./work-claim-sqlite.mjs";
import { encodeRow } from "./persisted-row.mjs";
import { emitWorkClaimEvent } from "./work-claim-events.mjs";

export const REAPER_TICK_MS = 30_000; // measured: lease 300s + sweep 30s; don't sweep tighter than ~L/10
export const REAPER_LOCK_ID = "claims";
export const REAPER_LOCK_TIMEOUT_MS = 90_000; // silence expiry: a dead holder stops fencing after 90 s
export const REAPER_MAX_DISPOSITIONS = 5; // bounded blast radius on the reaper itself
export const REAPER_GRACE_MS = Object.freeze({ work: 15 * 60_000, land: 5 * 60_000, deploy: 0 });
export const REAPER_FORGIVENESS_MULT = 2; // 2x grace: a late worker's unreaped claim is restored, not reaped
export const REAPER_ADOPT_WINDOW_MS = 10 * 60_000; // hash successor's exclusive adopt window
export const REAPER_NULL_LEASE_LEGACY_MS = 24 * 3600_000; // belt-and-suspenders for pre-lease rows (B1 backfills)
export const REAPER_SILENCE_MS = 120_000; // correlated-death detector window
export const REAPER_HOLD_MS = 30 * 60_000;
export const REAPER_HOLD_MIN_SILENT = 3; // the 30% clause needs >=3 silent or single-agent hiccups would hold a room
export const REAPER_HOLD_SILENT_COUNT = 15;
export const REAPER_HOLD_FRACTION = 0.30;
export const REAPER_HEARTBEAT_STALE_MS = 180_000; // matches agent-heartbeats HEARTBEAT_STALE_AFTER_MS
export const REAPER_ACTOR_ID = "reaper";

export const reaperSchema = `
  CREATE TABLE IF NOT EXISTS reaper_lock (
    id TEXT PRIMARY KEY,
    holder TEXT NOT NULL,
    heartbeat_at INTEGER NOT NULL,
    acquired_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS reaper_hold (
    room_id TEXT PRIMARY KEY,
    hold_until INTEGER NOT NULL,
    reason TEXT,
    triggered_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS work_claims_reaper_lease
    ON work_claims (room_id, json_extract(item_json, '$.data.leaseExpiresAt'));
`;

const kindOf = item => (item?.kind === "land" || item?.kind === "deploy" ? item.kind : "work");
const epochOf = item => (Number.isSafeInteger(item?.epoch) && item.epoch >= 0 ? item.epoch : 0);

// When a claim becomes reaping-eligible, or null when it never becomes
// eligible on its own (inactive states, opted-out leases).
//
// Forgiveness: while the lapsed owner still shows life, the horizon stretches
// to expiry + 2x grace — a late worker that recovers inside the window finds
// its claim restored, never reaped; past the window it is reaped like any
// other. Deploy has no grace, so no forgiveness window either.
export function reapableAt(item, nowMs, { ownerAlive = false } = {}) {
  if (!item || !ACTIVE_CLAIM_STATES.includes(item.state)) return null;
  if (typeof item.leaseExpiresAt === "string") {
    const expiry = Date.parse(item.leaseExpiresAt);
    if (!Number.isFinite(expiry)) return null;
    const grace = REAPER_GRACE_MS[kindOf(item)] ?? REAPER_GRACE_MS.work;
    return expiry + (ownerAlive ? REAPER_FORGIVENESS_MULT * grace : grace);
  }
  // Null-lease legacy: reap iff untouched for 24 h (B1 is backfilling nulls;
  // this is the belt-and-suspenders for rows that predate leases entirely).
  const updated = typeof item.updatedAt === "string" ? Date.parse(item.updatedAt) : NaN;
  if (!Number.isFinite(updated)) return null;
  return updated + REAPER_NULL_LEASE_LEGACY_MS;
}

export function isReapable(item, nowMs, opts) {
  const at = reapableAt(item, nowMs, opts);
  return at !== null && nowMs >= at;
}

// --- leader lock -----------------------------------------------------------

export function ensureReaperSchema(db) {
  if (!db || typeof db.exec !== "function") return false;
  db.exec(reaperSchema);
  return true;
}

// Compare-and-swap acquire. Returns true iff this holder now owns the lock.
export function acquireReaperLock(db, holderId, nowMs) {
  if (!db?.prepare) return true; // registry-only stores: single process, no contention possible
  ensureReaperSchema(db);
  const cutoff = nowMs - REAPER_LOCK_TIMEOUT_MS;
  db.prepare(`
    INSERT INTO reaper_lock (id, holder, heartbeat_at, acquired_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET holder=excluded.holder, heartbeat_at=excluded.heartbeat_at,
      acquired_at=excluded.acquired_at
    WHERE reaper_lock.heartbeat_at < ?`).run(REAPER_LOCK_ID, holderId, nowMs, nowMs, cutoff);
  return db.prepare("SELECT holder FROM reaper_lock WHERE id=?").get(REAPER_LOCK_ID)?.holder === holderId;
}

export function heartbeatReaperLock(db, holderId, nowMs) {
  if (!db?.prepare) return;
  db.prepare("UPDATE reaper_lock SET heartbeat_at=? WHERE id=? AND holder=?").run(nowMs, REAPER_LOCK_ID, holderId);
}

export function releaseReaperLock(db, holderId) {
  if (!db?.prepare) return;
  db.prepare("DELETE FROM reaper_lock WHERE id=? AND holder=?").run(REAPER_LOCK_ID, holderId);
}

// --- liveness --------------------------------------------------------------

// member_id -> last_seen_at (max across hosts), or null when the heartbeat
// tables are absent (a store without heartbeat infra cannot judge liveness).
function heartbeatSnapshot(db, roomId) {
  if (!db?.prepare) return null;
  try {
    const rows = db.prepare(`
      SELECT il.member_id AS memberId, MAX(h.last_seen_at) AS lastSeen
      FROM identity_links il JOIN agent_hosts h ON h.agent_id = il.identity_id
      WHERE il.room_id = ? GROUP BY il.member_id`).all(roomId);
    return new Map(rows.map(row => [row.memberId, Number(row.lastSeen)]));
  } catch {
    return null;
  }
}

const staleAfterMsOf = store =>
  Number.isFinite(store?.agentHeartbeats?.staleAfterMs) ? store.agentHeartbeats.staleAfterMs : REAPER_HEARTBEAT_STALE_MS;

// --- correlated-death detector ---------------------------------------------

export function detectCorrelatedDeath({ db, roomId, members, nowMs }) {
  const snapshot = heartbeatSnapshot(db, roomId);
  if (!snapshot) return { hold: false, reason: "no-heartbeat-data" };
  const observed = [];
  for (const id of Object.keys(members ?? {})) {
    if (snapshot.has(id)) observed.push(id);
  }
  if (observed.length === 0) return { hold: false, reason: "no-observed-agents" };
  const silent = observed.filter(id => nowMs - snapshot.get(id) > REAPER_SILENCE_MS);
  const fraction = silent.length / observed.length;
  if (silent.length >= REAPER_HOLD_SILENT_COUNT) {
    return { hold: true, reason: `${silent.length} agents silent in ~120s (>=${REAPER_HOLD_SILENT_COUNT} room-wide)` };
  }
  if (silent.length >= REAPER_HOLD_MIN_SILENT && fraction >= REAPER_HOLD_FRACTION) {
    return { hold: true, reason: `${silent.length}/${observed.length} agents silent in ~120s (>=30%)` };
  }
  return { hold: false, reason: "nominal" };
}

function holdActive(db, roomId, nowMs) {
  if (!db?.prepare) return null;
  const row = db.prepare("SELECT hold_until AS holdUntil, reason FROM reaper_hold WHERE room_id=?").get(roomId);
  if (!row) return null;
  if (Number(row.holdUntil) > nowMs) return row;
  db.prepare("DELETE FROM reaper_hold WHERE room_id=?").run(roomId);
  return null;
}

function setHold(db, roomId, nowMs, reason) {
  if (!db?.prepare) return;
  db.prepare(`INSERT INTO reaper_hold (room_id, hold_until, reason, triggered_at) VALUES (?,?,?,?)
    ON CONFLICT(room_id) DO UPDATE SET hold_until=excluded.hold_until, reason=excluded.reason,
    triggered_at=excluded.triggered_at`).run(roomId, nowMs + REAPER_HOLD_MS, reason, nowMs);
}

// --- succession ------------------------------------------------------------

// Board-write eligibility, mirroring mayWriteWorkClaims in
// server/work-claim-routes.mjs (not imported: the routes module's dependency
// tree is too heavy for the worker job path).
const WRITE_PROFILES = Object.freeze({
  contribute: ["accept_work", "complete_work"],
  review: ["verify"],
  collaborate: ["steer", "accept_work", "complete_work", "verify"],
});
const holdsProfile = (permissions, profile) => WRITE_PROFILES[profile].every(name => permissions.has(name));
function eligibleMember(ownerId, member) {
  if (!member || member.active === false) return false;
  if (ownerId && member.id === ownerId) return true;
  const permissions = new Set(member.permissions ?? []);
  if (member.kind === "human") return permissions.has("accept_work") || permissions.has("complete_work");
  return holdsProfile(permissions, "contribute") || holdsProfile(permissions, "review") || holdsProfile(permissions, "collaborate");
}

// Deterministic succession: live successor_hint, else hash
// LIVE[sha256(claim_id) mod n] over the live, eligible, non-lapsed members
// sorted by member id (stable total order — never wall-clock). The "longest
// waiter" step has no waitlist in the schema yet and is skipped. Returns
// { successor, via } with successor null for the open-pool backstop.
export function electWorkSuccessor({ item, members, ownerId, liveIds, heldCounts, maxHeld }) {
  const eligible = id => id !== item.owner && eligibleMember(ownerId, members[id]);
  const underCap = id => {
    if (!Number.isFinite(maxHeld)) return true;
    return (heldCounts?.get(id) ?? 0) < maxHeld;
  };
  const hint = typeof item?.successorHint === "string" ? item.successorHint : null;
  if (hint && liveIds.has(hint) && eligible(hint) && underCap(hint)) {
    return { successor: hint, via: "hint" };
  }
  const live = [...liveIds].filter(id => eligible(id) && underCap(id)).sort();
  if (live.length === 0) return { successor: null, via: "open-pool" };
  const digest = createHash("sha256").update(String(item.id)).digest();
  const start = Number(digest.readBigUInt64BE() % BigInt(live.length));
  return { successor: live[start], via: "hash" };
}

// The hash successor's 10-min exclusive adopt window: if the most recent
// succession stamp elected the current owner and they never acted, the
// adoption failed — the claim falls to the open pool instead of being
// re-successed (which would deterministically re-elect the same member).
function successionFailed(item) {
  const history = Array.isArray(item?.history) ? item.history : [];
  for (let i = history.length - 1; i >= 0; i--) {
    const action = history[i]?.action;
    if (typeof action === "string" && action.startsWith("succession:")) {
      const elected = action.slice("succession:".length);
      if (elected !== item.owner) return false;
      return !history.slice(i + 1).some(stamp => stamp?.agentId === elected);
    }
  }
  return false;
}

function alreadyEscalated(item) {
  const history = Array.isArray(item?.history) ? item.history : [];
  return history.length > 0 && history[history.length - 1]?.action === "escalated";
}

// withHistory lives private in work-claims.mjs; the reaper needs exactly one
// history-only stamp (deploy escalation), mirrored from it.
const MAX_HISTORY = 200;
function stampHistory(item, atMs, agentId, action, note) {
  const stamp = Object.freeze({ at: new Date(atMs).toISOString(), agentId, action, note: note ?? null });
  const full = [...(item.history ?? []), stamp];
  const dropped = Math.max(0, full.length - MAX_HISTORY);
  const omitted = (Number.isSafeInteger(item.historyOmitted) && item.historyOmitted > 0 ? item.historyOmitted : 0) + dropped;
  return {
    ...item,
    updatedAt: new Date(atMs).toISOString(),
    history: Object.freeze(dropped > 0 ? full.slice(dropped) : full),
    ...(omitted > 0 ? { historyOmitted: omitted } : {}),
  };
}

// --- candidate scan ----------------------------------------------------------

function candidateRows(db, roomId, nowMs, limit) {
  const nowIso = new Date(nowMs).toISOString();
  const legacyCutoff = nowMs - REAPER_NULL_LEASE_LEGACY_MS;
  const leaseExpr = `coalesce(json_extract(item_json,'$.data.leaseExpiresAt'), json_extract(item_json,'$.leaseExpiresAt'))`;
  const stateExpr = `coalesce(json_extract(item_json,'$.data.state'), json_extract(item_json,'$.state'))`;
  return db.prepare(`
    SELECT claim_id AS claimId, item_json AS itemJson, rowid AS rowid
    FROM work_claims WHERE room_id = ?
      AND ${stateExpr} IN ('claimed','in_progress','blocked')
      AND (${leaseExpr} < ? OR (${leaseExpr} IS NULL AND updated_at < ?))
    ORDER BY ${leaseExpr} ASC, rowid ASC
    LIMIT ?`).all(roomId, nowIso, legacyCutoff, limit);
}

function distinctRooms(db) {
  return db.prepare("SELECT DISTINCT room_id AS roomId FROM work_claims").all().map(row => row.roomId);
}

// --- conditional write (CAS) -------------------------------------------------

// The reaper is the sole disposition writer (leader lock), but room members
// write concurrently through HTTP. Re-read under a write transaction,
// recompute the disposition from the fresh item, and commit only if the
// (owner, epoch, lease) triple still matches — a lost race skips instead of
// clobbering.
function withWriteTx(db, fn) {
  if (!db?.exec) return fn();
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
    throw error;
  }
}

function casWrite(db, registry, roomId, claimId, expected, nextItem, nowMs) {
  const json = JSON.stringify(encodeRow(WORK_CLAIM_ROW_KIND, nextItem));
  if (!db?.prepare) {
    const fresh = registry.get(roomId, claimId);
    if (!fresh || fresh.owner !== expected.owner || epochOf(fresh) !== expected.epoch
      || (fresh.leaseExpiresAt ?? null) !== (expected.leaseExpiresAt ?? null)) return false;
    registry.set(roomId, nextItem);
    return true;
  }
  const result = db.prepare(`
    UPDATE work_claims SET item_json=?, updated_at=?
    WHERE room_id=? AND claim_id=?
      AND coalesce(json_extract(item_json,'$.data.owner'), json_extract(item_json,'$.owner')) = ?
      AND coalesce(json_extract(item_json,'$.data.epoch'), json_extract(item_json,'$.epoch'), 0) = ?
      AND coalesce(json_extract(item_json,'$.data.leaseExpiresAt'), json_extract(item_json,'$.leaseExpiresAt')) IS ?`)
    .run(json, nowMs, roomId, claimId, expected.owner, expected.epoch, expected.leaseExpiresAt ?? null);
  return result.changes === 1;
}

// --- dispositions --------------------------------------------------------------

function disposeWork({ item, election, room, nowMs }) {
  if (successionFailed(item)) {
    const [released] = releaseExpired([item], nowMs);
    const noted = stampHistory(released, nowMs, REAPER_ACTOR_ID, "noted",
      `adopt window lapsed with no successor action — open pool`);
    return { next: noted, disposition: "released", note: `adopt window lapsed with no successor action — open pool` };
  }
  if (!election.successor) {
    const [released] = releaseExpired([item], nowMs);
    return { next: released, disposition: "released", note: "no live successor — open pool" };
  }
  const next = electClaimSuccessor(item, election.successor, {
    note: `lease+grace expired — ownership elected to ${election.successor} via ${election.via}; 10-min adopt window`,
    leaseHours: REAPER_ADOPT_WINDOW_MS / 3600_000,
    room,
    now: nowMs,
    agentId: REAPER_ACTOR_ID,
  });
  return { next, disposition: "succeeded", note: `successor ${election.successor} via ${election.via}` };
}

function disposeLand({ item, nowMs }) {
  const [released] = releaseExpired([item], nowMs);
  return { next: released, disposition: "released", note: "land lease+grace expired — released" };
}

function disposeDeploy({ item, ownerId, nowMs }) {
  // Deploy leases are non-renewable: escalate to the room owner, never
  // auto-reap. State stays; the lease is cleared so the claim is not
  // re-escalated every tick. No epoch bump — no ownership change.
  const next = stampHistory(
    { ...item, leaseStartAt: null, leaseExpiresAt: null },
    nowMs, REAPER_ACTOR_ID, "escalated",
    `deploy lease lapsed at ${item.leaseExpiresAt} — escalated to room owner ${ownerId ?? "unknown"}; state held`
  );
  return { next, disposition: "escalated", note: `escalated to room owner ${ownerId ?? "unknown"}` };
}

// --- the tick ------------------------------------------------------------------

const emptyReceipt = () => ({
  ok: true, lock: "held",
  succeeded: [], released: [], escalated: [], deferred: [], held: [], raced: [], errors: [],
});

export function reapTick(store, {
  now = () => Date.now(),
  holderId = randomUUID(),
  rooms = null,
  maxDispositions = REAPER_MAX_DISPOSITIONS,
  emitEvents = true,
  log = (...args) => console.info(...args),
} = {}) {
  const nowMs = now();
  const db = store?.db ?? null;
  const registry = store?.workClaims;
  const receipt = emptyReceipt();
  if (!registry || typeof registry.get !== "function") {
    receipt.ok = false;
    receipt.errors.push("no work-claim registry on store");
    return receipt;
  }
  if (!acquireReaperLock(db, holderId, nowMs)) {
    receipt.lock = "contended";
    return receipt;
  }
  let dispositions = 0;
  const escalations = [];
  try {
    heartbeatReaperLock(db, holderId, nowMs);
    const roomIds = rooms ?? (db ? distinctRooms(db) : []);
    for (const roomId of roomIds) {
      if (dispositions >= maxDispositions) break;
      try {
        roomCycle(roomId, { nowMs, maxDispositions: maxDispositions - dispositions, escalations, log });
      } catch (error) {
        receipt.errors.push(`${roomId}: ${error?.message ?? error}`);
      }
      dispositions = receipt.succeeded.length + receipt.released.length + receipt.escalated.length;
    }
    emitEscalationEvent(store, escalations, { nowMs, emitEvents, log });
    log(JSON.stringify({
      event: "claim.reaper.tick", holder: holderId, at: new Date(nowMs).toISOString(),
      succeeded: receipt.succeeded.length, released: receipt.released.length,
      escalated: receipt.escalated.length, deferred: receipt.deferred.length,
      held: receipt.held.length, raced: receipt.raced.length, errors: receipt.errors.length,
    }));
    return receipt;
  } finally {
    releaseReaperLock(db, holderId);
  }

  // One room's share of the cycle. Pushes dispositions onto the receipt.
  function roomCycle(roomId, { nowMs, maxDispositions, escalations, log }) {
    const authority = store.roomAuthority?.(roomId) ?? null;
    const members = authority?.members ?? store.room?.(roomId)?.state?.members ?? {};
    const ownerId = authority?.ownerId ?? store.room?.(roomId)?.state?.room?.ownerId ?? null;

    const held = holdActive(db, roomId, nowMs);
    if (held) {
      receipt.held.push(roomId);
      log(JSON.stringify({ event: "claim.reaper.hold", roomId, reason: held.reason ?? "hold active" }));
      return 0;
    }
    const death = detectCorrelatedDeath({ db, roomId, members, nowMs });
    if (death.hold) {
      setHold(db, roomId, nowMs, death.reason);
      receipt.held.push(roomId);
      log(JSON.stringify({ event: "claim.reaper.hold", roomId, reason: death.reason }));
      return 0;
    }

    const snapshot = heartbeatSnapshot(db, roomId);
    const staleMs = staleAfterMsOf(store);
    const memberAlive = id => {
      if (typeof id !== "string") return false;
      if (!snapshot) return false; // without heartbeat infra, life cannot be observed
      const seen = snapshot.get(id);
      return Number.isFinite(seen) && nowMs - seen <= staleMs;
    };
    const liveIds = new Set(
      Object.keys(members).filter(id => {
        const member = members[id];
        if (!member || member.active === false || !eligibleMember(ownerId, member)) return false;
        if (!snapshot) return true; // no heartbeat infra: membership is the liveness signal
        return memberAlive(id);
      })
    );

    // Per-member active-claim counts for the succession cap check.
    const config = typeof registry.configFor === "function" ? registry.configFor(roomId) : roomWorkClaimConfig({});
    const maxHeld = config?.maxMemberOpenClaims;
    const heldCounts = new Map();
    let candidates;
    if (db?.prepare) {
      candidates = candidateRows(db, roomId, nowMs, 50).map(row => registry.get(roomId, row.claimId)).filter(Boolean);
      for (const item of registry.list(roomId)) {
        if (ACTIVE_CLAIM_STATES.includes(item.state) && typeof item.owner === "string") {
          heldCounts.set(item.owner, (heldCounts.get(item.owner) ?? 0) + 1);
        }
      }
    } else {
      const items = registry.list(roomId);
      for (const item of items) {
        if (ACTIVE_CLAIM_STATES.includes(item.state) && typeof item.owner === "string") {
          heldCounts.set(item.owner, (heldCounts.get(item.owner) ?? 0) + 1);
        }
      }
      candidates = items
        .filter(item => isReapable(item, nowMs))
        .sort((a, b) => (reapableAt(a, nowMs) - reapableAt(b, nowMs)) || (a.id < b.id ? -1 : 1))
        .slice(0, 50);
    }

    let done = 0;
    for (const seen of candidates) {
      if (done >= maxDispositions) break;
      const alive = memberAlive(seen.owner);
      // Forgiveness accounting: expired but inside the owner's 2x grace
      // window — the claim is restored if they recover, not reaped.
      if (!isReapable(seen, nowMs, { ownerAlive: alive })) {
        if (typeof seen.leaseExpiresAt === "string" && Date.parse(seen.leaseExpiresAt) <= nowMs) {
          receipt.deferred.push(seen.id);
        }
        continue;
      }
      const result = withWriteTx(db, () => {
        const fresh = registry.get(roomId, seen.id);
        if (!isReapable(fresh, nowMs, { ownerAlive: memberAlive(fresh.owner) }) || alreadyEscalated(fresh)) {
          return null; // lost race or settled
        }
        const kind = kindOf(fresh);
        const room = { workClaims: typeof registry.rawConfig === "function" ? registry.rawConfig(roomId) : {} };
        let op;
        if (kind === "deploy") op = disposeDeploy({ item: fresh, ownerId, nowMs });
        else if (kind === "land") op = disposeLand({ item: fresh, nowMs });
        else {
          const election = electWorkSuccessor({ item: fresh, members, ownerId, liveIds, heldCounts, maxHeld });
          op = disposeWork({ item: fresh, election, room, nowMs });
        }
        const expected = { owner: fresh.owner, epoch: epochOf(fresh), leaseExpiresAt: fresh.leaseExpiresAt ?? null };
        const wrote = casWrite(db, registry, roomId, fresh.id, expected, op.next, nowMs);
        return wrote ? op : "raced";
      });
      if (result === null || result === undefined) continue;
      if (result === "raced") { receipt.raced.push(seen.id); continue; }
      receipt[result.disposition].push(seen.id); // succeeded | released | escalated
      if (result.disposition === "escalated") escalations.push({ roomId, claimId: seen.id, ownerId });
      // The successor's grant changes their held count for later elections this cycle.
      if (result.disposition === "succeeded") {
        const newOwner = result.next.owner;
        heldCounts.set(newOwner, (heldCounts.get(newOwner) ?? 0) + 1);
      }
      done += 1;
      log(JSON.stringify({
        event: "claim.reaped", roomId, claimId: seen.id, kind: kindOf(seen),
        from: seen.owner ?? null, to: result.next.owner ?? null,
        disposition: result.disposition, epoch: epochOf(result.next), note: result.note,
      }));
    }
    return done;
  }
}

// At most ONE coalesced room event per tick for deploy escalations (the
// claim-channel guild's event-budget rule). Everything else is history-only.
function emitEscalationEvent(store, escalations, { nowMs, emitEvents, log }) {
  if (!emitEvents || escalations.length === 0) return;
  const first = escalations[0];
  const item = store.workClaims.get(first.roomId, first.claimId);
  if (!item) return;
  try {
    const receipt = emitWorkClaimEvent(store, first.roomId, {
      actorId: first.ownerId ?? REAPER_ACTOR_ID,
      item,
      action: "lease_expired",
      previousOwnerId: item.owner ?? null,
      atMs: nowMs,
      attention: "lease_expired",
      attentionMemberId: first.ownerId ?? undefined,
    });
    log(JSON.stringify({
      event: "claim.reaper.escalated", roomId: first.roomId,
      claims: escalations.map(e => e.claimId), eventSeq: receipt?.sequence ?? null,
    }));
  } catch (error) {
    log(JSON.stringify({ event: "claim.reaper.escalation_event_failed", error: String(error?.message ?? error) }));
  }
}

// Next due time for the jobs registry: the earliest lease+grace horizon
// across active claims (null = nothing due, the job stays disabled).
export function reaperDueAt(store, nowMs) {
  const db = store?.db;
  if (!db?.prepare) return null;
  try {
    ensureReaperSchema(db);
    const legacyCutoff = nowMs - REAPER_NULL_LEASE_LEGACY_MS;
    const leaseExpr = `coalesce(json_extract(item_json,'$.data.leaseExpiresAt'), json_extract(item_json,'$.leaseExpiresAt'))`;
    const stateExpr = `coalesce(json_extract(item_json,'$.data.state'), json_extract(item_json,'$.state'))`;
    const kindExpr = `coalesce(json_extract(item_json,'$.data.kind'), json_extract(item_json,'$.kind'), 'work')`;
    const legacy = db.prepare(`
      SELECT 1 AS hit FROM work_claims
      WHERE ${stateExpr} IN ('claimed','in_progress','blocked')
        AND ${leaseExpr} IS NULL AND updated_at < ? LIMIT 1`).get(legacyCutoff);
    if (legacy?.hit) return nowMs;
    const row = db.prepare(`
      SELECT MIN(
        (strftime('%s', ${leaseExpr}) * 1000) +
        CASE ${kindExpr} WHEN 'land' THEN 300000 WHEN 'deploy' THEN 0 ELSE 900000 END
      ) AS due
      FROM work_claims
      WHERE ${stateExpr} IN ('claimed','in_progress','blocked') AND ${leaseExpr} IS NOT NULL`).get();
    const due = row?.due == null ? null : Number(row.due);
    return Number.isFinite(due) ? due : null;
  } catch {
    return null;
  }
}
