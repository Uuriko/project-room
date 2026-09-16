/**
 * work-claim-store.mjs — Pure exclusive-lease claim store for the room's
 * work-claim / duplicate-claim guard (task B006-2, [quill-s2] 100-task program).
 *
 * Pure claim store: NO network, NO DOM, NO secrets. Persistence goes only
 * through the injected `storage` dependency (write-through on every mutation).
 *
 * A work claim is a lease over a task and its file paths:
 *   { id, taskId, lane, files[], claimedAt, leaseUntil, state }
 *
 * States: active → released | expired | completed
 * Only `active` claims hold a lease. Exclusivity is enforced per taskId AND
 * per file path: a second claim on an already-actively-claimed task or on an
 * overlapping file path throws WC_ALREADY_CLAIMED carrying the existing
 * claim id in `err.detail.existingClaimId` (the duplicate-claim guard).
 *
 * Heartbeat extends the lease (active claims only). sweep() expires stale
 * active claims (leaseUntil < now) with an audit entry each.
 *
 * Dependency injection (all via the `deps` parameter of createWorkClaimStore):
 *   - clock:       () => number  (ms epoch; default: Date.now)
 *   - id:          () => string  (claim id generator; default: per-store counter)
 *   - storage:     { load(): object|null, save(snapshot): void }
 *                  (default: in-memory, non-persistent; production wiring MUST
 *                  inject a real backing store)
 *   - leaseTtlMs:  number        (lease length for claims and heartbeats;
 *                  default: 30 minutes)
 *
 * Error contract: every failure throws an Error with a `code` property:
 *   WC_NOT_FOUND          — unknown claim id
 *   WC_ALREADY_CLAIMED    — taskId or a file path already under an active claim
 *                           (err.detail.existingClaimId names the conflicting claim)
 *   WC_INVALID_TRANSITION — operation not allowed from the current state
 *   WC_INVALID_CLAIM      — claim arguments failed validation
 *   WC_CORRUPT_SNAPSHOT   — restore()/load() snapshot is malformed or has a
 *                           wrong schema version
 *   WC_STORAGE_ERROR      — the injected storage threw
 * Failures are never silent.
 */

export const CLAIM_STATES = Object.freeze([
  'active',
  'released',
  'expired',
  'completed',
]);

export const SCHEMA_VERSION = 1;

export const DEFAULT_LEASE_TTL_MS = 30 * 60 * 1000;

const TERMINAL_STATES = new Set(['released', 'expired', 'completed']);

/** Throw a coded claim-store error (never silent failures). */
function claimError(code, message, detail) {
  const err = new Error(message);
  err.code = code;
  if (detail !== undefined) err.detail = detail;
  return err;
}

/** Default in-memory storage: satisfies the dep contract, persists nothing. */
function memoryStorage() {
  let held = null;
  return {
    load: () => held,
    save: (snapshot) => {
      held = snapshot;
    },
  };
}

/**
 * Create a new work-claim store.
 * @param {object} [deps]
 * @param {() => number} [deps.clock]
 * @param {() => string} [deps.id]
 * @param {{ load(): object|null, save(object): void }} [deps.storage]
 * @param {number} [deps.leaseTtlMs]
 */
export function createWorkClaimStore(deps = {}) {
  const clock = deps.clock ?? (() => Date.now());
  const leaseTtlMs = deps.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
  const storage = deps.storage ?? memoryStorage();

  let idCounter = 0;
  const newId = deps.id ?? (() => `wc-${(idCounter += 1)}`);

  /** Internal claim records, keyed by id. */
  const claims = new Map();

  /** Append-only audit log: every transition lands here, never removed. */
  const audit = [];

  /** Subscriber notifications: Set of (event) => void. */
  const subscribers = new Set();

  function record({ at, from, to, actor, detail }) {
    const entry = Object.freeze({
      at,
      from,
      to,
      actor,
      detail: detail === undefined ? null : detail,
    });
    audit.push(entry);
    return entry;
  }

  function notify(type, claimSnapshot, actor) {
    const event = Object.freeze({
      type,
      actor,
      at: clock(),
      claim: claimSnapshot,
    });
    for (const sub of subscribers) {
      sub(event);
    }
  }

  function getClaimOrThrow(id) {
    const claim = claims.get(id);
    if (!claim) {
      throw claimError('WC_NOT_FOUND', `Unknown claim id: ${id}`, {
        claimId: id,
      });
    }
    return claim;
  }

  function snapshot(claim) {
    return Object.freeze({
      id: claim.id,
      taskId: claim.taskId,
      lane: claim.lane,
      files: Object.freeze([...claim.files]),
      claimedAt: claim.claimedAt,
      leaseUntil: claim.leaseUntil,
      state: claim.state,
    });
  }

  /**
   * Persist the full store to the injected storage (write-through). Throws
   * WC_STORAGE_ERROR when the storage dep fails.
   */
  function persist() {
    const data = Object.freeze({
      schemaVersion: SCHEMA_VERSION,
      savedAt: clock(),
      claims: claims.size === 0 ? [] : [...claims.values()].map(snapshot),
    });
    try {
      storage.save(data);
    } catch (err) {
      throw claimError(
        'WC_STORAGE_ERROR',
        `Storage save failed: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err instanceof Error ? err.message : String(err) },
      );
    }
    return data;
  }

  /**
   * Run mutate(), then persist. If persistence throws, roll back with undo()
   * so a failed write never leaves half-applied state behind.
   */
  function writeThrough({ mutate, undo }) {
    mutate();
    try {
      return persist();
    } catch (err) {
      undo();
      throw err;
    }
  }

  /** Find an active claim holding the taskId or any of the given files. */
  function findConflictingActiveClaim(taskId, files) {
    for (const claim of claims.values()) {
      if (claim.state !== 'active') continue;
      if (claim.taskId === taskId) return { claim, via: 'taskId' };
      for (const f of files) {
        if (claim.files.includes(f)) return { claim, via: 'file' };
      }
    }
    return null;
  }

  function validateClaimArgs(taskId, lane, files) {
    if (typeof taskId !== 'string' || taskId.trim() === '') {
      throw claimError('WC_INVALID_CLAIM', 'taskId must be a non-empty string', {
        taskId,
      });
    }
    if (lane !== undefined && (typeof lane !== 'string' || lane.trim() === '')) {
      throw claimError('WC_INVALID_CLAIM', 'lane must be a non-empty string when given', {
        lane,
      });
    }
    if (!Array.isArray(files) || files.length === 0) {
      throw claimError('WC_INVALID_CLAIM', 'files must be a non-empty array of paths', {
        files,
      });
    }
    for (const f of files) {
      if (typeof f !== 'string' || f.trim() === '') {
        throw claimError('WC_INVALID_CLAIM', 'every file path must be a non-empty string', {
          files,
        });
      }
    }
    if (new Set(files).size !== files.length) {
      throw claimError('WC_INVALID_CLAIM', 'files must not contain duplicates', {
        files,
      });
    }
  }

  function assertActive(claim, op) {
    if (claim.state !== 'active') {
      throw claimError(
        'WC_INVALID_TRANSITION',
        `Cannot ${op} claim ${claim.id} from state '${claim.state}'`,
        { claimId: claim.id, state: claim.state, op },
      );
    }
  }

  function transition(claim, to, actor, detail) {
    const from = claim.state;
    writeThrough({
      mutate: () => {
        claim.state = to;
        record({
          at: clock(),
          from,
          to,
          actor,
          detail: { claimId: claim.id, ...(detail ?? {}) },
        });
      },
      undo: () => {
        claim.state = from;
        audit.pop();
      },
    });
    const snap = snapshot(claim);
    notify(to, snap, actor);
    return snap;
  }

  /** True when an active claim's lease has lapsed (uses injected clock). */
  function isStale(claim) {
    return claim.state === 'active' && claim.leaseUntil < clock();
  }

  /** Validate a raw snapshot object before restore(); throws WC_CORRUPT_SNAPSHOT. */
  function validateSnapshot(data) {
    const bad = (reason, detail) =>
      claimError('WC_CORRUPT_SNAPSHOT', `Corrupt snapshot: ${reason}`, detail);
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw bad('snapshot must be an object', { data });
    }
    if (data.schemaVersion !== SCHEMA_VERSION) {
      throw bad(`unsupported schemaVersion ${data.schemaVersion}`, {
        schemaVersion: data.schemaVersion,
        expected: SCHEMA_VERSION,
      });
    }
    if (!Array.isArray(data.claims)) {
      throw bad('claims must be an array', { claims: data.claims });
    }
    for (const c of data.claims) {
      if (!c || typeof c !== 'object') throw bad('claim must be an object', { claim: c });
      if (typeof c.id !== 'string' || c.id === '') throw bad('claim.id missing', { claim: c });
      if (typeof c.taskId !== 'string' || c.taskId === '') {
        throw bad('claim.taskId missing', { claim: c });
      }
      if (!Array.isArray(c.files) || c.files.some((f) => typeof f !== 'string')) {
        throw bad('claim.files malformed', { claim: c });
      }
      if (!CLAIM_STATES.includes(c.state)) {
        throw bad(`unknown claim state '${c.state}'`, { claim: c });
      }
      if (typeof c.claimedAt !== 'number' || typeof c.leaseUntil !== 'number') {
        throw bad('claim timestamps malformed', { claim: c });
      }
    }
    const ids = data.claims.map((c) => c.id);
    if (new Set(ids).size !== ids.length) {
      throw bad('duplicate claim ids in snapshot', { ids });
    }
    // A snapshot must not contain overlapping ACTIVE claims — that would mean
    // the exclusivity guard was bypassed upstream.
    const activeClaims = data.claims.filter((c) => c.state === 'active');
    const seenTasks = new Map();
    const seenFiles = new Map();
    for (const c of activeClaims) {
      if (seenTasks.has(c.taskId)) {
        throw bad('snapshot has two active claims on the same taskId', {
          taskId: c.taskId,
        });
      }
      seenTasks.set(c.taskId, c.id);
      for (const f of c.files) {
        if (seenFiles.has(f)) {
          throw bad('snapshot has two active claims on the same file', {
            file: f,
          });
        }
        seenFiles.set(f, c.id);
      }
    }
  }

  const store = {
    /** Append-only audit trail of every transition: {at, from, to, actor, detail}. */
    get audit() {
      return [...audit];
    },

    get leaseTtlMs() {
      return leaseTtlMs;
    },

    /**
     * Subscribe to claim events: {type, actor, at, claim}. type is one of
     * 'claimed' | 'heartbeat' | 'released' | 'expired' | 'completed' | 'restored'.
     * Returns an unsubscribe function.
     */
    subscribe(fn) {
      if (typeof fn !== 'function') {
        throw claimError('WC_INVALID_CLAIM', 'subscriber must be a function', {});
      }
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },

    /**
     * Claim a lease on a task and its files. Throws WC_ALREADY_CLAIMED with
     * detail.existingClaimId when the taskId or any file is already actively
     * claimed (the duplicate-claim guard).
     */
    claim({ taskId, lane, files }, actor = 'agent') {
      validateClaimArgs(taskId, lane, files);
      const conflict = findConflictingActiveClaim(taskId, files);
      if (conflict) {
        throw claimError(
          'WC_ALREADY_CLAIMED',
          `Task '${taskId}' (via ${conflict.via}) already claimed by ${conflict.claim.id}`,
          {
            taskId,
            files,
            existingClaimId: conflict.claim.id,
            via: conflict.via,
          },
        );
      }
      const now = clock();
      const claimRecord = {
        id: newId(),
        taskId,
        lane: lane ?? null,
        files: [...files],
        claimedAt: now,
        leaseUntil: now + leaseTtlMs,
        state: 'active',
      };
      writeThrough({
        mutate: () => {
          claims.set(claimRecord.id, claimRecord);
          record({
            at: now,
            from: null,
            to: 'active',
            actor,
            detail: {
              claimId: claimRecord.id,
              taskId,
              lane: claimRecord.lane,
              files: [...files],
              leaseUntil: claimRecord.leaseUntil,
            },
          });
        },
        undo: () => {
          claims.delete(claimRecord.id);
          audit.pop();
        },
      });
      const snap = snapshot(claimRecord);
      notify('claimed', snap, actor);
      return snap;
    },

    /**
     * Extend an active claim's lease by leaseTtlMs from now.
     * Only active claims can heartbeat; anything else → WC_INVALID_TRANSITION.
     */
    heartbeat(id, actor = 'agent') {
      const claim = getClaimOrThrow(id);
      assertActive(claim, 'heartbeat');
      const now = clock();
      const from = claim.leaseUntil;
      writeThrough({
        mutate: () => {
          claim.leaseUntil = now + leaseTtlMs;
          record({
            at: now,
            from: 'active',
            to: 'active',
            actor,
            detail: { claimId: id, leaseUntilFrom: from, leaseUntilTo: claim.leaseUntil },
          });
        },
        undo: () => {
          claim.leaseUntil = from;
          audit.pop();
        },
      });
      const snap = snapshot(claim);
      notify('heartbeat', snap, actor);
      return snap;
    },

    /** Release an active claim back to the pool (active → released). */
    release(id, actor = 'agent') {
      const claim = getClaimOrThrow(id);
      assertActive(claim, 'release');
      return transition(claim, 'released', actor, { reason: 'released by holder' });
    },

    /** Mark an active claim's work done (active → completed). */
    complete(id, actor = 'agent') {
      const claim = getClaimOrThrow(id);
      assertActive(claim, 'complete');
      return transition(claim, 'completed', actor, { reason: 'work completed' });
    },

    /**
     * Expire every stale active claim (leaseUntil < now). Returns the ids that
     * expired in this sweep; each gets an audit entry.
     */
    sweep(actor = 'system') {
      const expired = [];
      for (const claim of claims.values()) {
        if (isStale(claim)) {
          transition(claim, 'expired', actor, {
            reason: 'lease elapsed',
            leaseUntil: claim.leaseUntil,
            leaseTtlMs,
          });
          expired.push(claim.id);
        }
      }
      return expired;
    },

    /** Read-only snapshot of a claim (null if unknown). */
    get(id) {
      const claim = claims.get(id);
      return claim ? snapshot(claim) : null;
    },

    /** All claims for a lane, in insertion order. */
    byLane(lane) {
      return [...claims.values()].filter((c) => c.lane === lane).map(snapshot);
    },

    /** All claims for a taskId, in insertion order. */
    byTask(taskId) {
      return [...claims.values()].filter((c) => c.taskId === taskId).map(snapshot);
    },

    /** All currently active claims. */
    active() {
      return [...claims.values()].filter((c) => c.state === 'active').map(snapshot);
    },

    /**
     * Active claims whose lease expires within `ms` from now
     * (including already-stale ones).
     */
    expiringWithin(ms) {
      const horizon = clock() + ms;
      return [...claims.values()]
        .filter((c) => c.state === 'active' && c.leaseUntil <= horizon)
        .map(snapshot);
    },

    /** Serialize the store (schemaVersion + claims) for persistence/export. */
    snapshot() {
      return persist();
    },

    /**
     * Replace the store contents from a snapshot. Validates schema version and
     * shape first — anything malformed throws WC_CORRUPT_SNAPSHOT and the
     * current state is left untouched.
     */
    restore(data, actor = 'agent') {
      validateSnapshot(data);
      const previous = [...claims.values()];
      writeThrough({
        mutate: () => {
          claims.clear();
          for (const c of data.claims) {
            claims.set(c.id, {
              id: c.id,
              taskId: c.taskId,
              lane: c.lane ?? null,
              files: [...c.files],
              claimedAt: c.claimedAt,
              leaseUntil: c.leaseUntil,
              state: c.state,
            });
          }
          record({
            at: clock(),
            from: null,
            to: 'restored',
            actor,
            detail: { claimCount: data.claims.length, schemaVersion: data.schemaVersion },
          });
        },
        undo: () => {
          claims.clear();
          for (const c of previous) claims.set(c.id, c);
          audit.pop();
        },
      });
      notify('restored', null, actor);
      return data.claims.length;
    },
  };

  // Load persisted state through the injected storage on creation, so a
  // process restart rehydrates without losing active leases.
  try {
    const loaded = storage.load();
    if (loaded != null) store.restore(loaded, 'system');
  } catch (err) {
    if (err instanceof Error && err.code === 'WC_CORRUPT_SNAPSHOT') throw err;
    throw claimError(
      'WC_STORAGE_ERROR',
      `Storage load failed: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err instanceof Error ? err.message : String(err) },
    );
  }

  return Object.freeze(store);
}
