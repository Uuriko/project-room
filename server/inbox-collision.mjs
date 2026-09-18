// Concurrent draft/reply detection for the inbox (lane C,
// inbox-agent-collab). Two agents (or an agent and a human) composing on the
// same thread at once get a soft lock: advisory, expiring, never a hard
// gate on sending — the failure this module prevents is silent last-writer-
// wins, not slowness. detectCollision names the other editor and ships a
// merge hint so the pair can reconcile before either sends.
//
// Pure, in-memory, dependency-free, deterministic; frozen outputs. Clock and
// id generator are injected so fixtures control time and ids.
import { randomUUID } from "node:crypto";
import { identityOf, threadIdOf } from "./inbox-assign.mjs";

export class CollisionError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = "CollisionError";
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}
const fail = (code, message, detail) => { throw new CollisionError(code, message, detail); };
const check = (condition, code, message) => { if (!condition) fail(code, message); };

export const defaultLockTtlMs = 5 * 60 * 1000; // 5 minutes of advisory exclusivity
const maxLockTtlMs = 60 * 60 * 1000;

const ttlOf = value => {
  if (value === undefined || value === null) return defaultLockTtlMs;
  check(Number.isSafeInteger(value) && value >= 1000 && value <= maxLockTtlMs, "collision_invalid",
    `ttlMs must be 1000..${maxLockTtlMs}`);
  return value;
};
const isoOf = ms => new Date(ms).toISOString();

// identityOf/threadIdOf come from the assignment module; wrap them so this
// module's public surface throws only CollisionError — one error contract per
// module, one catch for the caller.
const threadOf = value => {
  try { return threadIdOf(value); } catch (error) { fail("collision_invalid", error.message); }
};
const identity = (value, field) => {
  try { return identityOf(value, field); } catch (error) { fail("collision_invalid", error.message); }
};
const freezeLock = lock => Object.freeze({ ...lock, holder: Object.freeze({ ...lock.holder }) });

export function createCollisionTracker({ clock = () => Date.now(), id = () => randomUUID(),
  defaultTtlMs = defaultLockTtlMs } = {}) {
  check(Number.isSafeInteger(defaultTtlMs) && defaultTtlMs >= 1000 && defaultTtlMs <= maxLockTtlMs,
    "collision_invalid", "defaultTtlMs must be a sane millisecond value");
  const locks = new Map(); // threadId -> lock
  const byId = new Map();  // lockId -> threadId

  const expired = lock => clock() >= lock.expiresAt;
  const live = threadId => {
    const lock = locks.get(threadId);
    return lock && !expired(lock) ? lock : null;
  };
  const drop = threadId => {
    const lock = locks.get(threadId);
    if (lock) { locks.delete(threadId); byId.delete(lock.lockId); }
  };

  // Acquire the soft lock for a thread. A live lock held by a *different*
  // holder throws collision_lock_held with the current holder attached — the
  // caller renders the conflict warning instead of stomping. The same holder
  // re-acquiring just refreshes the expiry (duplicate: true); an expired
  // lock is silently replaced.
  function acquireLock(threadId, holder, { ttlMs = defaultTtlMs } = {}) {
    const tid = threadOf(threadId);
    const who = identity(holder, "holder");
    const ttl = ttlOf(ttlMs);
    const current = live(tid);
    if (current) {
      if (current.holder.kind === who.kind && current.holder.id === who.id) {
        const refreshed = freezeLock({ ...current, ttlMs: ttl, expiresAt: clock() + ttl });
        locks.set(tid, refreshed);
        return Object.freeze({ lock: refreshed, duplicate: true });
      }
      fail("collision_lock_held", `${current.holder.id} is already drafting on this thread.`,
        { holder: current.holder, expiresAt: current.expiresAt });
    }
    const now = clock();
    const lock = freezeLock({ lockId: id(), threadId: tid, holder: who,
      acquiredAt: isoOf(now), expiresAt: now + ttl, ttlMs: ttl });
    locks.set(tid, lock);
    byId.set(lock.lockId, tid);
    return Object.freeze({ lock, duplicate: false });
  }

  // Keep a live lock alive while the editor is still typing. Heartbeating an
  // expired lock throws collision_lock_expired — re-acquire instead of
  // resurrecting a lock the other side may have reasonably assumed was gone.
  function heartbeat(lockId) {
    check(typeof lockId === "string" && lockId.length >= 1, "collision_invalid", "lockId must be a non-empty string");
    const threadId = byId.get(lockId);
    const lock = threadId ? locks.get(threadId) : null;
    if (!lock || lock.lockId !== lockId) fail("collision_lock_not_found", "No such draft lock.");
    if (expired(lock)) { drop(threadId); fail("collision_lock_expired", "The draft lock expired; acquire it again."); }
    const refreshed = freezeLock({ ...lock, expiresAt: clock() + lock.ttlMs });
    locks.set(threadId, refreshed);
    return refreshed;
  }

  // Release by id. Only the holder releases their own lock — anyone else
  // gets collision_forbidden. (A human takeover of an abandoned lock goes
  // through acquireLock after expiry, which is why locks are soft.)
  function releaseLock(lockId, { by } = {}) {
    check(typeof lockId === "string" && lockId.length >= 1, "collision_invalid", "lockId must be a non-empty string");
    const who = identity(by, "by");
    const threadId = byId.get(lockId);
    const lock = threadId ? locks.get(threadId) : null;
    if (!lock || lock.lockId !== lockId) fail("collision_lock_not_found", "No such draft lock.");
    if (lock.holder.kind !== who.kind || lock.holder.id !== who.id)
      fail("collision_forbidden", "Only the lock holder may release it.");
    drop(threadId);
    return Object.freeze({ released: true, lockId });
  }

  // The detection read: is anyone *else* live-editing this thread right
  // now? Returns the warning and the merge hint verbatim so every caller
  // shows the same reconciliation guidance.
  function detectCollision(threadId, actor) {
    const tid = threadOf(threadId);
    const who = identity(actor, "actor");
    const lock = live(tid);
    const others = lock && !(lock.holder.kind === who.kind && lock.holder.id === who.id) ? [lock] : [];
    const collision = others.length > 0;
    const names = others.map(l => l.holder.label ?? l.holder.id).join(", ");
    return Object.freeze({
      collision,
      holders: Object.freeze(others.map(l => l.holder)),
      warning: collision
        ? `${names} ${others.length === 1 ? "is" : "are"} drafting a reply on this thread right now.`
        : null,
      mergeHint: collision
        ? `Before sending, compare drafts: ask ${names} to paste theirs, or send yours as a follow-up instead of replacing theirs. Last writer wins silently.`
        : null,
    });
  }

  // Housekeeping: drop expired locks, report how many went.
  function sweep() {
    let swept = 0;
    for (const [threadId, lock] of locks) if (expired(lock)) { drop(threadId); swept++; }
    return swept;
  }

  return Object.freeze({ acquireLock, heartbeat, releaseLock, detectCollision, sweep });
}
