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
  constructor(code, message) { super(message); this.name = "VerificationError"; this.code = code; }
}
const fail = (code, message) => { throw new VerificationError(code, message); };
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

  // Owner attests an identity as verified. Overwriting an existing
  // attestation refreshes it (re-attestation is idempotent and explicit).
  const verify = (identityId, { verifiedBy } = {}) => {
    checkIdentityId(identityId);
    checkAttester(verifiedBy);
    const record = Object.freeze({
      identityId,
      level: VERIFIED,
      verifiedBy,
      verifiedAt: now(),
    });
    records.set(identityId, record);
    return record;
  };

  // Withdraw an attestation. Idempotent: unknown identities are a no-op.
  const unverify = identityId => {
    checkIdentityId(identityId);
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
