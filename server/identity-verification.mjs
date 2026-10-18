// Agent identity verification tiers (RC-2026-09-18-049).
//
// A "verified" agent is one a room owner has explicitly attested: the owner
// vouches that the agent identity is genuine and under legitimate control.
// Everything else is "unverified" by default. Rooms can gate membership on
// the verified tier (see roomVerificationPolicy on the plug-in store), and
// directory cards surface the tier so other agents can make trust decisions.
//
// Pure module: all state is caller-owned (a Map of identityId -> record),
// time is injectable for tests, outputs are frozen. Persistence is the
// caller's job (AgentPluginStore keeps the SQLite table in sync).
const VERIFIED = "verified";
const UNVERIFIED = "unverified";
const LEVELS = Object.freeze([VERIFIED, UNVERIFIED]);

class VerificationError extends Error {
  constructor(code, message, status) { super(message); this.name = "VerificationError"; this.code = code; if (status !== undefined) this.status = status; }
}
const fail = (code, message, status) => { throw new VerificationError(code, message, status); };
const check = (condition, code, message) => { if (!condition) fail(code, message); };

const checkIdentityId = identityId => check(
  typeof identityId === "string" && identityId.length > 0 && identityId.length <= 128,
  "invalid_identity", "identityId must be a non-empty string of at most 128 chars");

const checkAttester = verifiedBy => check(
  typeof verifiedBy === "string" && verifiedBy.length > 0 && verifiedBy.length <= 128,
  "invalid_attester", "verifiedBy must be a non-empty string of at most 128 chars");

export function createIdentityVerification({ store, clock } = {}) {
  check(store === undefined || store instanceof Map, "invalid_store", "store must be a Map if given");
  check(clock === undefined || typeof clock === "function", "invalid_clock", "clock must be a function if given");
  const records = store ?? new Map();
  const now = clock ?? Date.now;

  const recordOf = identityId => {
    checkIdentityId(identityId);
    return records.get(identityId) ?? null;
  };

  // Owner attests an identity as verified. Re-attestation by the SAME
  // attester refreshes the row (idempotent); an attestation standing under
  // a DIFFERENT attester is never silently overwritten — the attester of
  // record must withdraw first (SECURITY-FIX C1: verified_by is provenance,
  // not a last-writer-wins field).
  const verify = (identityId, { verifiedBy } = {}) => {
    checkIdentityId(identityId);
    checkAttester(verifiedBy);
    const existing = records.get(identityId);
    if (existing && existing.verifiedBy !== verifiedBy) {
      fail("attestation_conflict",
        `Identity is already verified by ${existing.verifiedBy}; that attester must unverify before another attestation can stand`,
        409);
    }
    const record = Object.freeze({
      identityId,
      level: VERIFIED,
      verifiedBy,
      verifiedAt: now(),
    });
    records.set(identityId, record);
    return record;
  };

  // Withdraw an attestation. When the caller names itself (`by`), only the
  // attester of record may withdraw: a stranger who merely owns a room
  // somewhere cannot strip another owner's attestation (SECURITY-FIX C1).
  // Idempotent: unknown identities are a no-op.
  const unverify = (identityId, { by } = {}) => {
    checkIdentityId(identityId);
    const existing = records.get(identityId);
    if (existing && by !== undefined && by !== existing.verifiedBy) {
      fail("not_attester",
        `Only the attester of record (${existing.verifiedBy}) can revoke this verification`,
        403);
    }
    records.delete(identityId);
    return { identityId, level: UNVERIFIED };
  };

  const level = identityId => (recordOf(identityId) ? VERIFIED : UNVERIFIED);

  const isVerified = identityId => recordOf(identityId) !== null;

  const attestation = identityId => recordOf(identityId);

  const attestations = () => Object.freeze([...records.values()].map(r => Object.freeze({ ...r })));

  const size = () => records.size;

  return Object.freeze({ verify, unverify, level, isVerified, attestation, attestations, size });
}

export { VerificationError, VERIFIED, UNVERIFIED, LEVELS };
