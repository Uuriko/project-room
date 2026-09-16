/**
 * multi-instance-election.mjs — Bully-ish lease election for multi-instance rooms.
 *
 * A single process-wide lock (kept in the injected `lockStore`) elects at most
 * one live leader at a time. Instances compete by writing a lease record
 * { holder, token, acquiredAt, expiresAt, startedAt }; the lease is live while
 * now < expiresAt. An expired lease may be taken by anyone (bully takeover);
 * a live lease can only be extended or released by its holder.
 *
 * Pure election logic only. NO network, NO DOM, NO secrets — coordination goes
 * through the injected `lockStore`, which is the only shared mutable state.
 *
 * Dependency injection (all via the `deps` parameter of createElection):
 *   - clock:     () => number  (ms epoch; default: Date.now)
 *   - id:        () => string  (instance-id generator; default: per-election
 *                               counter; used when acquire() is called without
 *                               an explicit instanceId)
 *   - lockStore: { get(), set(record), del() } — minimal lease storage.
 *                               get() returns the current lease record or
 *                               null/undefined; set(record) persists it;
 *                               del() clears it. Defaults to an in-memory
 *                               store (createMemoryLockStore), which only
 *                               coordinates instances inside one process —
 *                               production wiring MUST inject a shared store.
 *
 * Fencing token: every successful acquisition writes token = (previous token
 * ?? 0) + 1, so tokens are monotonically increasing across acquisitions.
 * Downstream writers must attach the token they acquired under and reject
 * writes carrying a stale token — that is what prevents a stale (deposed)
 * leader's writes from landing after a takeover.
 *
 * Leadership-loss notification: onLeadershipLost(cb) registers a listener
 * fired with { instanceId, token, reason, at } when this election object
 * discovers its instance no longer holds the lock (renew() throwing
 * EL_LOCK_LOST, or stepdown()). A listener that throws is skipped so one bad
 * listener cannot starve the others — listeners must not throw.
 *
 * Error contract: every failure throws an Error with a `code` property:
 *   EL_INVALID_ARGS — bad instanceId, non-positive ttlMs, non-function listener
 *   EL_LOCK_HELD    — acquire() re-called by the current live holder (use
 *                     renew()), or release() by an instance that never held
 *                     the lease while another instance holds it live
 *   EL_NOT_LEADER   — renew()/release() by an instance that never held the
 *                     lock while someone else holds (or held) it
 *   EL_LOCK_LOST    — renew()/release() by an instance that previously held
 *                     the lock but no longer does (takeover, expiry + takeover,
 *                     or external delete); leadership-loss listeners fire first
 * Failures are never silent.
 */

export const ELECTION_ERRORS = Object.freeze([
  'EL_INVALID_ARGS',
  'EL_LOCK_HELD',
  'EL_NOT_LEADER',
  'EL_LOCK_LOST',
]);

export const DEFAULT_LEASE_TTL_MS = 30_000;

/** Throw a coded election error (never silent failures). */
function electionError(code, message, detail) {
  const err = new Error(message);
  err.code = code;
  if (detail !== undefined) err.detail = detail;
  return err;
}

/** Minimal in-memory lease store: { get(), set(record), del() }. */
export function createMemoryLockStore() {
  let record = null;
  return {
    get() {
      return record;
    },
    set(next) {
      record = next;
    },
    del() {
      record = null;
    },
  };
}

/** True when a lease record exists and has not yet expired at `now`. */
function isLive(record, now) {
  return !!record && now < record.expiresAt;
}

function assertInstanceId(instanceId) {
  if (typeof instanceId !== 'string' || instanceId.length === 0) {
    throw electionError(
      'EL_INVALID_ARGS',
      `instanceId must be a non-empty string, got: ${String(instanceId)}`,
      { instanceId },
    );
  }
}

function assertTtlMs(ttlMs) {
  if (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw electionError(
      'EL_INVALID_ARGS',
      `ttlMs must be a positive finite number, got: ${String(ttlMs)}`,
      { ttlMs },
    );
  }
}

/**
 * Create a leader-election participant.
 * @param {object} [deps]
 * @param {() => number} [deps.clock]
 * @param {() => string} [deps.id]
 * @param {{get():object|null,set(object):void,del():void}} [deps.lockStore]
 */
export function createElection(deps = {}) {
  const clock = deps.clock ?? (() => Date.now());
  const lockStore = deps.lockStore ?? createMemoryLockStore();

  let idCounter = 0;
  const newId = deps.id ?? (() => `instance-${(idCounter += 1)}`);

  /** Leadership-loss listeners: Set<(event) => void>. */
  const listeners = new Set();

  /**
   * Instances this election object believes it currently holds the lease for:
   * instanceId -> { token, ttlMs }. Drives EL_LOCK_LOST vs EL_NOT_LEADER.
   */
  const held = new Map();

  function fireLeadershipLost(instanceId, token, reason) {
    const event = Object.freeze({
      instanceId,
      token,
      reason,
      at: clock(),
    });
    for (const cb of [...listeners]) {
      try {
        cb(event);
      } catch {
        // One throwing listener must not starve the others; listeners are
        // documented as must-not-throw.
      }
    }
  }

  function snapshot(record, now) {
    return Object.freeze({
      holder: record.holder,
      token: record.token,
      acquiredAt: record.acquiredAt,
      expiresAt: record.expiresAt,
      startedAt: record.startedAt,
      releasedBy: record.releasedBy ?? null,
      live: now < record.expiresAt && record.holder != null,
    });
  }

  /**
   * Clear the lease without losing the fencing-token chain: write a tombstone
   * (holder null, immediately expired) instead of deleting, so the next
   * acquisition's token still climbs monotonically.
   */
  function clearLease(record, instanceId, now) {
    lockStore.set({
      holder: null,
      token: record.token,
      acquiredAt: record.acquiredAt,
      expiresAt: now,
      startedAt: record.startedAt,
      releasedBy: instanceId,
      releasedAt: now,
    });
    held.delete(instanceId);
  }

  const election = {
    /**
     * Try to become leader. Returns { leader: true, token, expiresAt } on
     * success (fresh or expired lease), or { leader: false, currentLeader }
     * when another instance holds a live lease.
     */
    acquire(instanceId = newId(), { ttlMs = DEFAULT_LEASE_TTL_MS, startedAt } = {}) {
      assertInstanceId(instanceId);
      assertTtlMs(ttlMs);
      const now = clock();
      const record = lockStore.get() ?? null;

      // A tombstone (holder null) or an expired lease is free for the taking.
      if (isLive(record, now) && record.holder != null) {
        if (record.holder === instanceId) {
          throw electionError(
            'EL_LOCK_HELD',
            `Instance ${instanceId} already holds a live lease (token ${record.token}); use renew() to extend it`,
            { instanceId, token: record.token },
          );
        }
        return { leader: false, currentLeader: record.holder };
      }

      // No lease, or the lease expired: take it. The fencing token climbs
      // monotonically from whatever the previous record carried.
      const token = (record?.token ?? 0) + 1;
      const next = {
        holder: instanceId,
        token,
        acquiredAt: now,
        expiresAt: now + ttlMs,
        startedAt: startedAt ?? now,
      };
      lockStore.set(next);
      held.set(instanceId, { token, ttlMs });
      return { leader: true, token, expiresAt: next.expiresAt };
    },

    /**
     * Extend the lease. Only the current holder may renew.
     * Throws EL_NOT_LEADER when the caller never held the lease,
     * EL_LOCK_LOST (after firing leadership-loss listeners) when the caller
     * previously held it but no longer does.
     */
    renew(instanceId, { ttlMs } = {}) {
      assertInstanceId(instanceId);
      const now = clock();
      const record = lockStore.get() ?? null;

      if (record && record.holder === instanceId) {
        const ttl = ttlMs ?? held.get(instanceId)?.ttlMs ?? DEFAULT_LEASE_TTL_MS;
        assertTtlMs(ttl);
        record.expiresAt = now + ttl;
        lockStore.set(record);
        held.set(instanceId, { token: record.token, ttlMs: ttl });
        return { leader: true, token: record.token, expiresAt: record.expiresAt };
      }

      if (held.has(instanceId)) {
        // We held it; the store now says otherwise (takeover, or an external
        // delete). Leadership is lost — notify, then throw.
        held.delete(instanceId);
        fireLeadershipLost(instanceId, record?.token ?? null, 'lock-lost');
        throw electionError(
          'EL_LOCK_LOST',
          `Instance ${instanceId} lost the leadership lock (now held by ${record?.holder ?? 'nobody'})`,
          { instanceId, currentHolder: record?.holder ?? null },
        );
      }

      throw electionError(
        'EL_NOT_LEADER',
        `Instance ${instanceId} cannot renew: lease is held by ${record?.holder ?? 'nobody'}`,
        { instanceId, currentHolder: record?.holder ?? null },
      );
    },

    /**
     * Release the lease. Only the current holder may release; the store keeps
     * a tombstone (holder null) so the fencing-token chain stays monotonic.
     * A live lease held by someone else throws EL_LOCK_HELD (unless the
     * caller previously held it — then EL_LOCK_LOST fires listeners first).
     */
    release(instanceId) {
      assertInstanceId(instanceId);
      const now = clock();
      const record = lockStore.get() ?? null;

      if (record && record.holder === instanceId) {
        const token = record.token;
        clearLease(record, instanceId, now);
        return { released: true, token };
      }

      if (held.has(instanceId)) {
        // Previously held here, but the store says otherwise now (takeover
        // or external delete). Leadership is lost — notify, then throw.
        held.delete(instanceId);
        fireLeadershipLost(instanceId, record?.token ?? null, 'lock-lost');
        throw electionError(
          'EL_LOCK_LOST',
          `Instance ${instanceId} lost the leadership lock before it could release (now held by ${record?.holder ?? 'nobody'})`,
          { instanceId, currentHolder: record?.holder ?? null },
        );
      }

      if (record && isLive(record, now)) {
        throw electionError(
          'EL_LOCK_HELD',
          `Instance ${instanceId} cannot release: lease is live and held by ${record.holder}`,
          { instanceId, currentHolder: record.holder },
        );
      }

      throw electionError(
        'EL_NOT_LEADER',
        `Instance ${instanceId} cannot release: it does not hold the lease`,
        { instanceId, currentHolder: record?.holder ?? null },
      );
    },

    /** True when `instanceId` holds a live lease at `now` (default: clock()). */
    isLeader(instanceId, now = clock()) {
      assertInstanceId(instanceId);
      const record = lockStore.get() ?? null;
      return !!record && record.holder === instanceId && now < record.expiresAt;
    },

    /**
     * Voluntarily give up leadership. Never throws: returns
     * { steppedDown: true, token } when this instance was leader (listeners
     * fire), or { steppedDown: false, currentLeader } otherwise.
     */
    stepdown(instanceId) {
      assertInstanceId(instanceId);
      const now = clock();
      const record = lockStore.get() ?? null;
      if (record && record.holder === instanceId) {
        const token = record.token;
        clearLease(record, instanceId, now);
        fireLeadershipLost(instanceId, token, 'stepdown');
        return { steppedDown: true, token };
      }
      return { steppedDown: false, currentLeader: record?.holder ?? null };
    },

    /**
     * Register a leadership-loss listener. Returns an unregister function.
     * The listener receives { instanceId, token, reason, at } and must not
     * throw (a throwing listener is skipped).
     */
    onLeadershipLost(cb) {
      if (typeof cb !== 'function') {
        throw electionError(
          'EL_INVALID_ARGS',
          `onLeadershipLost requires a function, got: ${String(cb)}`,
          { cb },
        );
      }
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },

    /** Read-only snapshot of the current lease (null when no lease exists). */
    status(now = clock()) {
      const record = lockStore.get() ?? null;
      return record ? snapshot(record, now) : null;
    },
  };

  return Object.freeze(election);
}
