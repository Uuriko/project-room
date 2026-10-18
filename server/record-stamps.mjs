// Record stamps for accountability R-1(ii)/(iii) + R-9 (#3612): every
// consequential record written after this change carries a `provenance`
// stamp naming (ii) the specific runtime instance/session that acted,
// (iii) the authorizing human principal, and — on submission/verdict
// records — the model + harness that produced or judged the work.
//
// Anti-spoof discipline: server-knowable stamps are NEVER read from the
// caller's record input. The session/instance id is derived here from
// server-set fields only (the claim owner and the claim-round key, both
// assigned from the server clock / claim state at write time); the
// principal is derived from room membership (memberOwnerId in
// src/events.js: a member's accountable human, a human member themself,
// else the room owner). Agent-declared model/harness is the one
// caller-supplied part: it is validated, stored verbatim, and labelled
// source:"declared" wherever it rides — never presented as verified.
// Platform-run verifiers stamp PLATFORM_RUNTIME with source:"platform".
//
// New records only: nothing here backfills or rewrites stored history.
//
// Dependency-free (node:crypto only) so the pure claim kernel
// (server/work-claims.mjs) can import it without import cycles. The
// principal derivation itself is memberOwnerId in src/events.js, applied
// by the call sites that hold room state.
import { createHash } from "node:crypto";

export const RECORD_STAMPS_SCHEMA = "record-provenance/1";

// The harness this server runs, for verdicts the platform itself
// executes (e.g. the public-work artifact-integrity re-hash on a verify
// PASS). The model is null: the platform check is deterministic code,
// not a model call, and the stamp says so rather than inventing one.
export const PLATFORM_RUNTIME = Object.freeze({
  model: null, harness: "project-room-server/0.1.0", source: "platform",
});

const stampText = (value, label) => {
  if (typeof value !== "string" || value.length === 0 || value.length > 128 || /[\x00-\x1f\x7f]/.test(value))
    throw new Error(`${label} must be a string of 1-128 characters without control characters`);
  return value;
};

// Deterministic instance id for one claim round. Every input is set by
// the server at claim time (owner from the authenticated identity,
// roundKey from the claim state the server wrote — a generation counter
// or the server-clock claimedAt), so two records from the same round
// name the same instance and a caller cannot mint a false one through
// the record input: the fields this hashes never come from it.
export function claimInstanceId(scope, workId, ownerId, roundKey) {
  // Fixed key order in a literal: the JSON is canonical by construction.
  const core = JSON.stringify({ scope: String(scope), workId: String(workId),
    ownerId: String(ownerId), roundKey: String(roundKey) });
  return "inst_" + createHash("sha256").update(core).digest("hex").slice(0, 24);
}

// Validate an agent-declared runtime ({ model, harness }, either field
// optional). Returns a frozen { model, harness, source: "declared" } or
// null when nothing was declared. Throws on a malformed declaration so
// the calling surface can refuse it with its own error shape.
export function declaredRuntimeOf(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value))
    throw new Error("declaredRuntime must be an object with model and/or harness");
  const keys = Object.keys(value);
  if (keys.some(key => key !== "model" && key !== "harness"))
    throw new Error("declaredRuntime carries only model and harness");
  const model = value.model === undefined || value.model === null ? null : stampText(value.model, "declaredRuntime.model");
  const harness = value.harness === undefined || value.harness === null ? null : stampText(value.harness, "declaredRuntime.harness");
  if (model === null && harness === null) throw new Error("declaredRuntime must name a model or a harness");
  return Object.freeze({ model, harness, source: "declared" });
}

// Carry a stored runtime stamp through a record normalizer: only the
// exact stamped shape survives (declared or platform, labelled), so a
// hand-written record cannot smuggle an unlabelled runtime claim into a
// read model.
export function runtimeStampOf(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) return null;
  if (value.source !== "declared" && value.source !== "platform") return null;
  const text = field => (typeof field === "string" && field.length > 0 && field.length <= 128 && !/[\x00-\x1f\x7f]/.test(field) ? field : null);
  const model = value.model === null ? null : text(value.model);
  const harness = value.harness === null ? null : text(value.harness);
  if (model === null && harness === null) return null;
  return Object.freeze({ model, harness, source: value.source });
}

// Validate/normalize a provenance stamp for storage on a record. Only
// server-computed values reach this: callers build the object from
// claimInstanceId / memberOwnerId / declaredRuntimeOf / PLATFORM_RUNTIME,
// never from the record input.
export function provenanceOf(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) return null;
  const id = field => (typeof field === "string" && field.length > 0 && field.length <= 128 ? field : null);
  const out = { sessionInstanceId: id(value.sessionInstanceId), principalMemberId: id(value.principalMemberId) };
  const producer = runtimeStampOf(value.producerRuntime);
  const verifier = runtimeStampOf(value.verifierRuntime);
  if (producer) out.producerRuntime = producer;
  if (verifier) out.verifierRuntime = verifier;
  return Object.freeze(out);
}
