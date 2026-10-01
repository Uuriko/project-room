// Work claims (B006/B007). A pure work-item state machine for agent
// coordination: work starts unclaimed; an agent claims it (claimed), starts
// it (in_progress), and finishes it (done) or marks it blocked. Only the
// claiming agent may update, release, or reassign its work — anyone else's
// attempt is refused, never half-applied. This is the anti-collision core:
// two agents cannot both own the same work item. Pure, dependency-free,
// deterministic; frozen outputs. Persistence is a later slice.
//
// Claim leases: a claim may carry a lease (default 24h). A claimed item
// records claimedAt + leaseExpiresAt; isLeaseExpired(work, now) reports
// whether the lease has lapsed, and releaseExpired(items, now) auto-releases
// expired claims back to unclaimed (owner cleared, history stamped). Pass
// leaseHours to claimWork, or null to opt out of leases entirely — claims
// without a lease behave exactly as before (never expire). Leases are
// configurable per room: a room object carrying
//   room.workClaims = { defaultLeaseHours, reviewPolicy }
// overrides the defaults; see roomWorkClaimConfig. The default lease cap is
// 720h (30 days).
//
// Delivery modes: the done transition accepts { deliveryMode } in
// { result, merged, production } — how the work was delivered — persisted on
// the item and stamped into history.
//
// Receipt tags and blobs (RC-2026-09-24-205): the done transition also
// accepts free-form { tags } (labels that converge from real use, no fixed
// taxonomy) and { blobs } (sha256:<hex> content pointers for evidence).
// Both are recorded on the item and frozen with the done state; the
// GET /api/rooms/{roomId}/receipts route searches them.
//
// Review policies: work items (or the room config) carry reviewPolicy in
// { self_attested, distinct_member, independent_principal }. canCloseWork
// enforces the policy for the done transition: self_attested lets the
// claimant close; distinct_member requires a different member to attest;
// independent_principal requires a different member holding the verify
// permission (supplied as verifyMembers) to attest. Enforcement lives with
// the caller (the HTTP layer applies it); the state machine itself only
// records the attestation (reviewedBy) on the done transition.
//
// SECURITY (QA-Sec 2026-09-19): attestations are first-class records, not
// caller-supplied names. attestWork records a review attestation from the
// authenticated caller's own session; the done transition only accepts a
// reviewedBy that has such a recorded attestation (for non-self policies).
// Naming another member without their attestation is rejected — the
// previous "name anyone" behavior was a confused-deputy flaw.
import { parsePullRequestUrl } from "./claim-coordination.mjs";
const STATES = ["unclaimed", "claimed", "in_progress", "blocked", "done"];
const TRANSITIONS = {
  unclaimed: ["claimed"],
  claimed: ["in_progress", "blocked", "unclaimed"], // unclaimed = release
  in_progress: ["blocked", "done", "claimed"],       // claimed = pause
  blocked: ["in_progress", "claimed"],
  done: [],
};
const DELIVERY_MODES = ["result", "merged", "production"];
const REVIEW_POLICIES = ["self_attested", "distinct_member", "independent_principal"];
const TAG_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const BLOB_PATTERN = /^sha256:[0-9a-f]{64}$/;
const MAX_RECEIPT_TAGS = 10;
const MAX_RECEIPT_BLOBS = 10;
const tagsOf = value => {
  check(Array.isArray(value), "tags must be an array");
  check(value.length <= MAX_RECEIPT_TAGS, `tags must hold at most ${MAX_RECEIPT_TAGS} tags`);
  value.forEach(tag => check(typeof tag === "string" && TAG_PATTERN.test(tag),
    "each tag must be 1..32 characters matching [A-Za-z0-9_-]"));
  return Object.freeze([...value]);
};
const MAX_CLAIM_FILES = 64;
const filesOf = value => {
  check(Array.isArray(value), "files must be an array");
  check(value.length <= MAX_CLAIM_FILES, `files must list at most ${MAX_CLAIM_FILES} paths`);
  const normalized = value.map(path => {
    check(typeof path === "string" && path.trim().length > 0 && path.length <= 512, "each file must be a 1..512 character path");
    let p = path.trim().replace(/\/+/g, "/");
    while (p.startsWith("./")) p = p.slice(2);
    while (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
    check(p.length > 0 && p !== "." && !p.startsWith("/") && !p.split("/").includes(".."), "each file must be a repo-relative path");
    return p;
  });
  return Object.freeze([...new Set(normalized)].sort());
};
const DEPENDS_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_DEPENDS = 16;
const dependsOnOf = (value, selfId) => {
  check(Array.isArray(value), "dependsOn must be an array");
  check(value.length <= MAX_DEPENDS, `dependsOn must list at most ${MAX_DEPENDS} claims`);
  const ids = value.map(id => {
    check(typeof id === "string" && DEPENDS_PATTERN.test(id), "each dependsOn entry must be a claim id");
    check(id !== selfId, "a claim cannot depend on itself");
    return id;
  });
  return Object.freeze([...new Set(ids)].sort());
};
const pullRequestOf = value => {
  if (value === undefined || value === null) return null;
  const url = typeof value === "string" ? value : value?.url;
  const parsed = parsePullRequestUrl(typeof url === "string" ? url : "");
  check(parsed, "pullRequest must be an https://github.com/{owner}/{repo}/pull/{number} URL");
  let outcome = null;
  let syncedAt = null;
  let nextPollAt = null;
  let etag = null;
  let rateLimitedUntil = null;
  let pollBackoffMs = null;
  if (value !== null && typeof value === "object") {
    if (value.outcome !== undefined && value.outcome !== null) {
      check(value.outcome === "merged" || value.outcome === "closed", "pullRequest outcome must be merged or closed");
      outcome = value.outcome;
    }
    if (value.syncedAt !== undefined && value.syncedAt !== null) {
      check(typeof value.syncedAt === "string" && Number.isFinite(Date.parse(value.syncedAt)), "pullRequest syncedAt must be an ISO timestamp");
      syncedAt = value.syncedAt;
    }
    if (value.nextPollAt !== undefined && value.nextPollAt !== null) {
      check(typeof value.nextPollAt === "number" && Number.isFinite(value.nextPollAt), "pullRequest nextPollAt must be a millisecond timestamp");
      nextPollAt = value.nextPollAt;
    }
    if (value.etag !== undefined && value.etag !== null) {
      check(typeof value.etag === "string" && value.etag.length > 0 && value.etag.length <= 200 && /^[\x21-\x7E]+$/.test(value.etag), "pullRequest etag must be a short printable token");
      etag = value.etag;
    }
    if (value.rateLimitedUntil !== undefined && value.rateLimitedUntil !== null) {
      check(typeof value.rateLimitedUntil === "number" && Number.isFinite(value.rateLimitedUntil), "pullRequest rateLimitedUntil must be a millisecond timestamp");
      rateLimitedUntil = value.rateLimitedUntil;
    }
    if (value.pollBackoffMs !== undefined && value.pollBackoffMs !== null) {
      check(typeof value.pollBackoffMs === "number" && Number.isFinite(value.pollBackoffMs) && value.pollBackoffMs >= 0, "pullRequest pollBackoffMs must be a non-negative number");
      pollBackoffMs = value.pollBackoffMs;
    }
  }
  return Object.freeze({
    url: parsed.url, repo: parsed.repo, number: parsed.number, outcome, syncedAt, nextPollAt,
    etag, rateLimitedUntil, pollBackoffMs
  });
};
PLACEHOLDER_TRUNCATED_DO_NOT_USE