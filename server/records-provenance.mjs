// Consequential-record provenance (#3612, accountability R-1/R-9).
//
// Every consequential record — a submission, a verdict, a settlement —
// must be able to answer five names plus the producing runtime:
//
//   (i)   persistent identity of the actor        — already on the records
//   (ii)  the specific runtime instance/session  — sessionInstanceId (here)
//   (iii) the human principal who authorized it  — authorizingPrincipalId
//   (iv)  the policy/rubric version that governed — already pinned per
//         surface (termsVersion, rubricVersion, reviewPolicy/fingerprint)
//   (v)   the verifying human, as an identity    — already on verdicts
//   R-9   model + harness version that produced the work
//
// FACTS vs CLAIMS — the semantics this module exists to keep honest:
//
// - sessionInstanceId and authorizingPrincipalId are FACTS. They are
//   derived by the server at write time from the authenticated context
//   and from rows the server already holds (the claim round the actor is
//   operating in; the offer's owner / the bounty's poster / the claim's
//   creator). A caller can never assert them: any caller-supplied value
//   for these fields is ignored by the builders below, which take them
//   only from their server-side arguments.
//
// - claimedModelVersion, claimedHarnessVersion and claimedEnvironment
//   are CLAIMS. They are reported by the caller's runtime about itself;
//   the platform does not execute or verify the reported runtime, so it
//   cannot stamp them as facts. The `claimed*` field naming carries
//   that semantics on the record itself: a reader (buyer, auditor,
//   insurer) sees a self-report pinned at write time, never a platform
//   attestation. Pinning is still the point — the claim is frozen onto
//   the record when the work is submitted or judged, instead of leaving
//   the session's floating `environment` report (server/store.mjs
//   mutateWorkSession) as the only, unpinned, copy.
//
// A null claimed* field means "not reported" — never a guessed default.
// A null authorizingPrincipalId means the server could not join one
// (e.g. a system-created claim with no creator stamp) — never invented.

import { createHash } from "node:crypto";

export const PROVENANCE_MAX_TEXT = 200;

const cleanClaim = (value, field) => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !value.trim() || value.length > PROVENANCE_MAX_TEXT
    || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error(`${field} must be a string of 1..${PROVENANCE_MAX_TEXT} characters without control characters`);
  }
  return value.trim();
};

const cleanFactId = (value, field) => {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 256 || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error(`${field} must be a string of at most 256 characters without control characters`);
  }
  return value;
};

// Normalize a caller-reported model/harness/environment triple. Accepts
// both the wire spellings ({ modelVersion, harnessVersion, environment })
// and the stored spellings ({ claimedModelVersion, ... }); the output is
// always the stored `claimed*` shape, so a claim can never be re-read as
// a server fact downstream.
export function claimedProvenanceOf(input) {
  if (input === undefined || input === null) {
    return Object.freeze({ claimedModelVersion: null, claimedHarnessVersion: null, claimedEnvironment: null });
  }
  if (typeof input !== "object" || Array.isArray(input)) throw new Error("claimed provenance must be an object");
  return Object.freeze({
    claimedModelVersion: cleanClaim(input.claimedModelVersion ?? input.modelVersion, "claimedModelVersion"),
    claimedHarnessVersion: cleanClaim(input.claimedHarnessVersion ?? input.harnessVersion, "claimedHarnessVersion"),
    claimedEnvironment: cleanClaim(input.claimedEnvironment ?? input.environment, "claimedEnvironment"),
  });
}

// Pull the caller-reported triple out of a flat request/input object
// (the submission and verdict inputs carry the fields at top level).
export function claimedProvenanceFromInput(input) {
  if (!input || typeof input !== "object") return claimedProvenanceOf(null);
  return claimedProvenanceOf({
    claimedModelVersion: input.claimedModelVersion ?? input.modelVersion,
    claimedHarnessVersion: input.claimedHarnessVersion ?? input.harnessVersion,
    claimedEnvironment: input.claimedEnvironment ?? input.environment,
  });
}

// Server-derived session/instance id (FACT). Deterministic over the
// claim round the authenticated actor is operating in — surface kind,
// the record's scope, the acting identity, and the round discriminator
// (claim generation, claimedAt, or submission fingerprint) — so the
// same round always names the same instance, replays reproduce it
// exactly, and a different round (re-claim, new generation, new actor)
// never collides with it. It names the instance that acted, derived
// from authenticated context; it is not a caller-chosen label.
export function sessionInstanceIdFor(kind, parts) {
  const material = [kind, ...parts.map(part => (part === undefined || part === null ? "" : String(part)))].join("\n");
  return `sess_${createHash("sha256").update(material, "utf8").digest("hex").slice(0, 24)}`;
}

const SESSION_INSTANCE_PATTERN = /^sess_[0-9a-f]{24}$/;

// Validate/normalize a provenance stamp as stored on a record. Used by
// codecs that round-trip records (work-claims.mjs): a malformed stamp
// fails closed there, exactly like the records' other bound fields.
// Records written before #3612 carry no stamp and normalize to null.
export function provenanceOf(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("provenance must be an object");
  const sessionInstanceId = value.sessionInstanceId ?? null;
  if (sessionInstanceId !== null && (typeof sessionInstanceId !== "string" || !SESSION_INSTANCE_PATTERN.test(sessionInstanceId))) {
    throw new Error("provenance sessionInstanceId must be a server-derived sess_ id");
  }
  return Object.freeze({
    sessionInstanceId,
    authorizingPrincipalId: cleanFactId(value.authorizingPrincipalId, "provenance authorizingPrincipalId"),
    claimedModelVersion: cleanClaim(value.claimedModelVersion, "claimedModelVersion"),
    claimedHarnessVersion: cleanClaim(value.claimedHarnessVersion, "claimedHarnessVersion"),
    claimedEnvironment: cleanClaim(value.claimedEnvironment, "claimedEnvironment"),
  });
}

// Build the stamp a write path records. `sessionInstanceId` and
// `authorizingPrincipalId` come only from the server-side arguments
// (authenticated actor + stored rows); `claimed` is the caller-reported
// triple from claimedProvenanceOf/FromInput. Returns a frozen object in
// the stored shape.
export function buildProvenance({ sessionInstanceId = null, authorizingPrincipalId = null, claimed = null } = {}) {
  if (sessionInstanceId !== null && (typeof sessionInstanceId !== "string" || !SESSION_INSTANCE_PATTERN.test(sessionInstanceId))) {
    throw new Error("sessionInstanceId must be derived with sessionInstanceIdFor");
  }
  const claims = claimed ? claimedProvenanceOf(claimed) : claimedProvenanceOf(null);
  return Object.freeze({
    sessionInstanceId,
    authorizingPrincipalId: cleanFactId(authorizingPrincipalId, "authorizingPrincipalId"),
    ...claims,
  });
}
