/**
 * message-bus-audit.mjs — Tamper-evident append-only audit log for the message bus.
 *
 * Every bus event (message sent, delivered, redacted, claim taken, …) is
 * appended as a hash-chained entry:
 *
 *   Entry: { seq, at, actor, action, detail, prevHash, hash }
 *
 *   hash = SHA-256 hex over the canonical JSON of
 *          { seq, at, actor, action, detail, prevHash }
 *          (fixed key order; a missing detail is hashed as null).
 *
 * The first entry's prevHash is the constant 'GENESIS'. Because each entry's
 * hash covers its predecessor's hash, any later modification of an entry (or
 * any reordering / deletion) breaks the chain — verify() reports the exact
 * seq where the chain breaks.
 *
 * Pure module: no network, no DOM, no secrets, no ambient I/O. The only
 * platform import is node:crypto for SHA-256.
 *
 * Dependency injection (all via the `deps` parameter of createMessageBusAudit):
 *   - clock: () => number   (ms epoch for entry timestamps; default: Date.now)
 *   - id:    () => string   (log-instance id generator; default: crypto.randomUUID)
 *                            Exposed as `log.logId` so exported chains can be
 *                            correlated back to the log that produced them.
 *                            Entries themselves are seq-keyed, so no per-entry
 *                            id is minted.
 *
 * Operations:
 *   - append(actor, action, detail?) → frozen entry
 *   - get(seq)                      → entry (throws when unknown)
 *   - range(fromSeq, toSeq)         → entries, inclusive
 *   - verify()                      → { ok: true } | { ok: false, brokenAt }
 *   - export()                      → deep-copied array of entries
 *   - importChain(entries)          → validate-then-accept a full chain
 *                                     (atomic: rejects leave the log untouched)
 *   - stats()                       → { entries, bytesApprox, firstSeq, lastSeq }
 *
 * `verifyChain(entries)` is also exported standalone so any exported array
 * (e.g. one received over the wire) can be checked without a log instance.
 *
 * Error contract: every failure throws an Error with a `code` property.
 * Failures are never silent.
 *   MBA_INVALID_ENTRY   — actor/action not non-empty strings, or detail not
 *                         JSON-serializable
 *   MBA_INVALID_SEQ     — seq is not a positive integer
 *   MBA_NOT_FOUND       — no entry at the requested seq
 *   MBA_INVALID_RANGE   — range bounds not positive integers, or from > to
 *   MBA_INVALID_CHAIN   — importChain input is not an array, or an entry is
 *                         structurally malformed
 *   MBA_CORRUPT_CHAIN   — hash / prevHash-link / seq-continuity break;
 *                         err.detail.seq names the offending seq
 */

import { createHash, randomUUID } from 'node:crypto';

/** prevHash of the first entry in every chain. */
export const GENESIS_PREV_HASH = 'GENESIS';

/** Throw a coded audit error (never silent failures). */
function auditError(code, message, detail) {
  const err = new Error(message);
  err.code = code;
  if (detail !== undefined) err.detail = detail;
  return err;
}

/** Canonical JSON of the hash-covered fields — fixed key order. */
function canonicalEntry({ seq, at, actor, action, detail, prevHash }) {
  return JSON.stringify({ seq, at, actor, action, detail, prevHash });
}

/** SHA-256 hex digest of a UTF-8 string. */
function sha256Hex(input) {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** Deep-freeze a detail payload (cycle-safe) so entries are truly immutable. */
function deepFreeze(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const key of Object.keys(value)) deepFreeze(value[key], seen);
  return Object.freeze(value);
}

/** JSON deep copy (details are guaranteed JSON-serializable at append time). */
function deepCopy(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Check a chain array without a log instance.
 * @param {Array} entries — candidate chain (oldest first)
 * @returns {{ok: boolean, brokenAt?: number}} — brokenAt names the seq where
 *          the hash / prevHash-link / seq-continuity check first failed.
 * @throws {Error} MBA_INVALID_CHAIN when entries is not an array.
 */
export function verifyChain(entries) {
  if (!Array.isArray(entries)) {
    throw auditError('MBA_INVALID_CHAIN', 'verifyChain expects an array of entries', {});
  }
  let prevHash = GENESIS_PREV_HASH;
  for (let i = 0; i < entries.length; i += 1) {
    const e = entries[i];
    const expectedSeq = i + 1;
    let recomputed = null;
    try {
      recomputed =
        e && typeof e === 'object'
          ? sha256Hex(
              canonicalEntry({
                seq: e.seq,
                at: e.at,
                actor: e.actor,
                action: e.action,
                detail: e.detail === undefined ? null : e.detail,
                prevHash: e.prevHash,
              }),
            )
          : null;
    } catch {
      recomputed = null; // non-serializable entry content can never be valid
    }
    const broken =
      !e ||
      typeof e !== 'object' ||
      e.seq !== expectedSeq ||
      e.prevHash !== prevHash ||
      typeof e.hash !== 'string' ||
      recomputed === null ||
      e.hash !== recomputed;
    if (broken) {
      return {
        ok: false,
        brokenAt: e && typeof e === 'object' && Number.isInteger(e.seq) ? e.seq : expectedSeq,
      };
    }
    prevHash = e.hash;
  }
  return { ok: true };
}

/** Structural validation of one imported entry; returns a frozen, normalized copy. */
function validateImportedEntry(raw, index) {
  const where = { index };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw auditError('MBA_INVALID_CHAIN', `Imported entry at index ${index} is not an object`, where);
  }
  if (!Number.isInteger(raw.seq) || raw.seq < 1) {
    throw auditError('MBA_INVALID_CHAIN', `Imported entry at index ${index} has a bad seq`, where);
  }
  if (typeof raw.at !== 'number' || !Number.isFinite(raw.at)) {
    throw auditError('MBA_INVALID_CHAIN', `Imported entry seq ${raw.seq} has a bad timestamp`, {
      seq: raw.seq,
    });
  }
  if (typeof raw.actor !== 'string' || raw.actor.length === 0) {
    throw auditError('MBA_INVALID_CHAIN', `Imported entry seq ${raw.seq} has a bad actor`, {
      seq: raw.seq,
    });
  }
  if (typeof raw.action !== 'string' || raw.action.length === 0) {
    throw auditError('MBA_INVALID_CHAIN', `Imported entry seq ${raw.seq} has a bad action`, {
      seq: raw.seq,
    });
  }
  if (typeof raw.prevHash !== 'string' || raw.prevHash.length === 0) {
    throw auditError('MBA_INVALID_CHAIN', `Imported entry seq ${raw.seq} has a bad prevHash`, {
      seq: raw.seq,
    });
  }
  if (typeof raw.hash !== 'string' || !/^[0-9a-f]{64}$/.test(raw.hash)) {
    throw auditError('MBA_INVALID_CHAIN', `Imported entry seq ${raw.seq} has a bad hash`, {
      seq: raw.seq,
    });
  }
  const detail = raw.detail === undefined ? null : deepCopy(raw.detail);
  return Object.freeze({
    seq: raw.seq,
    at: raw.at,
    actor: raw.actor,
    action: raw.action,
    detail: deepFreeze(detail),
    prevHash: raw.prevHash,
    hash: raw.hash,
  });
}

/**
 * Create a new tamper-evident message-bus audit log.
 * @param {object} [deps]
 * @param {() => number} [deps.clock]
 * @param {() => string} [deps.id]
 */
export function createMessageBusAudit(deps = {}) {
  const clock = deps.clock ?? (() => Date.now());
  const newId = deps.id ?? (() => randomUUID());
  const logId = newId();

  /** Internal entries, oldest first; seq is always index + 1. */
  const entries = [];

  function stats() {
    let bytesApprox = 0;
    for (const e of entries) bytesApprox += JSON.stringify(e).length;
    return {
      entries: entries.length,
      bytesApprox,
      firstSeq: entries.length > 0 ? entries[0].seq : null,
      lastSeq: entries.length > 0 ? entries[entries.length - 1].seq : null,
    };
  }

  const log = {
    /** Log-instance id (from deps.id) for correlating exported chains. */
    get logId() {
      return logId;
    },

    /**
     * Append a bus event. Returns the frozen entry.
     * @param {string} actor  — who/what produced the event
     * @param {string} action — what happened
     * @param {*} [detail]   — optional JSON-serializable payload
     */
    append(actor, action, detail) {
      if (typeof actor !== 'string' || actor.length === 0) {
        throw auditError('MBA_INVALID_ENTRY', 'append requires a non-empty string actor', {
          actor,
        });
      }
      if (typeof action !== 'string' || action.length === 0) {
        throw auditError('MBA_INVALID_ENTRY', 'append requires a non-empty string action', {
          action,
        });
      }
      const normalizedDetail = detail === undefined ? null : detail;
      const seq = entries.length + 1;
      const at = clock();
      const prevHash = seq === 1 ? GENESIS_PREV_HASH : entries[entries.length - 1].hash;
      let payload;
      try {
        payload = canonicalEntry({ seq, at, actor, action, detail: normalizedDetail, prevHash });
      } catch {
        throw auditError('MBA_INVALID_ENTRY', 'append detail is not JSON-serializable', { seq });
      }
      const entry = Object.freeze({
        seq,
        at,
        actor,
        action,
        detail: deepFreeze(normalizedDetail),
        prevHash,
        hash: sha256Hex(payload),
      });
      entries.push(entry);
      return entry;
    },

    /** The entry at seq (throws MBA_INVALID_SEQ / MBA_NOT_FOUND). */
    get(seq) {
      if (!Number.isInteger(seq) || seq < 1) {
        throw auditError('MBA_INVALID_SEQ', `get requires a positive integer seq, got ${seq}`, {
          seq,
        });
      }
      const entry = entries[seq - 1];
      if (!entry || entry.seq !== seq) {
        throw auditError('MBA_NOT_FOUND', `No audit entry at seq ${seq}`, { seq });
      }
      return entry;
    },

    /** Entries fromSeq..toSeq inclusive (frozen entries in a fresh array). */
    range(fromSeq, toSeq) {
      for (const s of [fromSeq, toSeq]) {
        if (!Number.isInteger(s) || s < 1) {
          throw auditError(
            'MBA_INVALID_RANGE',
            `range requires positive integer bounds, got ${fromSeq}..${toSeq}`,
            { fromSeq, toSeq },
          );
        }
      }
      if (fromSeq > toSeq) {
        throw auditError(
          'MBA_INVALID_RANGE',
          `range requires fromSeq <= toSeq, got ${fromSeq}..${toSeq}`,
          { fromSeq, toSeq },
        );
      }
      return entries.slice(fromSeq - 1, toSeq);
    },

    /**
     * Walk the chain checking seq continuity, prevHash links, and hashes.
     * @returns {{ok: boolean, brokenAt?: number}}
     */
    verify() {
      return verifyChain(entries);
    },

    /** Deep-copied array of all entries, oldest first. */
    export() {
      return entries.map((e) => deepCopy({ ...e }));
    },

    /**
     * Replace the log with a validated chain. Validation is all-or-nothing:
     * a rejected chain leaves the current entries untouched.
     * @param {Array} chain — full chain starting at seq 1 with GENESIS prevHash
     * @throws {Error} MBA_INVALID_CHAIN / MBA_CORRUPT_CHAIN
     */
    importChain(chain) {
      if (!Array.isArray(chain)) {
        throw auditError('MBA_INVALID_CHAIN', 'importChain expects an array of entries', {});
      }
      const rebuilt = chain.map((raw, index) => validateImportedEntry(raw, index));
      const result = verifyChain(rebuilt);
      if (!result.ok) {
        throw auditError(
          'MBA_CORRUPT_CHAIN',
          `Imported chain is corrupt: break at seq ${result.brokenAt}`,
          { seq: result.brokenAt },
        );
      }
      entries.length = 0;
      for (const e of rebuilt) entries.push(e);
      return stats();
    },

    /** { entries, bytesApprox, firstSeq, lastSeq } (seqs null when empty). */
    stats() {
      return stats();
    },
  };

  return Object.freeze(log);
}
