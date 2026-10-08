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
// overrides the defaults; see roomWorkClaimConfig. The lease cap is 168h
// (7 days). null opts out only when the route has already allowed it
// (room owner or manage_claims).
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
// Manual reviewed completion requires a latest explicit approve bound to the
// current claim round and available revision/head metadata, plus current
// reviewer authority supplied by the HTTP layer. self_attested is unchanged.
// Note-only attestations remain caller-bound records but cannot approve work.
// This does not gate automatic PR/land/deploy settlement or bind artifact bytes.
import { parsePullRequestUrl } from "./claim-coordination.mjs";
const STATES = ["unclaimed", "claimed", "in_progress", "blocked", "done", "closed"];
const CLAIM_KINDS = ["work", "land", "deploy"];
const CI_STATES = ["pending", "success", "failure", "neutral"];
const REVIEW_VERDICTS = ["approve", "changes_requested", "comment"];
// Claim lifecycle: one explicit table, state x verb -> next state. Anything
// not listed is refused. done and closed are terminal: done means the work
// was delivered; closed means it was retired without delivery (close by the
// room's claim managers, cancel by whoever opened or holds it). Only open
// (non-terminal) items count against the room's open-claim cap.
const CLAIM_LIFECYCLE = Object.freeze({
  unclaimed: Object.freeze({ claim: "claimed", close: "closed", cancel: "closed" }),
  claimed: Object.freeze({ start: "in_progress", block: "blocked", release: "unclaimed", close: "closed", cancel: "closed" }),
  in_progress: Object.freeze({ block: "blocked", finish: "done", pause: "claimed", close: "closed", cancel: "closed" }),
  blocked: Object.freeze({ start: "in_progress", pause: "claimed", close: "closed", cancel: "closed" }),
  done: Object.freeze({}),
  closed: Object.freeze({}),
});
const CLAIM_VERBS = Object.freeze(["claim", "start", "block", "release", "pause", "finish", "close", "cancel"]);
const TERMINAL_CLAIM_STATES = Object.freeze(["done", "closed"]);
const isTerminalClaimState = state => TERMINAL_CLAIM_STATES.includes(state);
// The next state for a verb, or null when the table refuses it.
function nextClaimState(state, verb) {
  const row = Object.hasOwn(CLAIM_LIFECYCLE, state) ? CLAIM_LIFECYCLE[state] : null;
  return row && Object.hasOwn(row, verb) ? row[verb] : null;
}
// The /update state moves, derived from the table (close and cancel have
// their own routes so a retire always records who and why).
const TRANSITIONS = Object.freeze(Object.fromEntries(Object.entries(CLAIM_LIFECYCLE).map(([state, row]) =>
  [state, Object.freeze(Object.entries(row).filter(([verb]) => verb !== "close" && verb !== "cancel").map(([, next]) => next))])));
const DELIVERY_MODES = ["result", "merged", "production"];
const REVIEW_POLICIES = ["self_attested", "distinct_member", "independent_principal"];
// Receipt tags (RC-2026-09-24-205): free-form labels recorded when work is
// completed — no fixed taxonomy; tags converge from real use. Blob pointers
// are content-addressed evidence references (sha256:<64 hex>).
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
// Files a claim will touch (RC claim-files): repo-relative paths, normalized
// the same way server/claim-collisions.mjs normalizes them so overlap checks
// compare like with like. Optional; an empty list means "not declared".
const MAX_CLAIM_FILES = 64;
const BLOCK_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 _.:/-]{0,79}$/;
const normalizeClaimPath = path => {
  check(typeof path === "string" && path.trim().length > 0 && path.length <= 512, "each file must be a 1..512 character path");
  let p = path.trim().replace(/\/+/g, "/");
  while (p.startsWith("./")) p = p.slice(2);
  while (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  check(p.length > 0 && p !== "." && !p.startsWith("/") && !p.split("/").includes(".."), "each file must be a repo-relative path");
  return p;
};
// A file is a path, or { path, block? } / { path, region? }. A missing label
// is the whole file. Two labels on one path do not stack: a whole-file entry
// wins and the path stays exclusive.
const claimedFilesOf = value => {
  check(Array.isArray(value), "files must be an array");
  check(value.length <= MAX_CLAIM_FILES, `files must list at most ${MAX_CLAIM_FILES} paths`);
  const entries = value.map(entry => {
    if (typeof entry === "string") return { path: normalizeClaimPath(entry), block: null };
    check(entry !== null && typeof entry === "object" && !Array.isArray(entry), "each file must be a path or {path, block?}");
    const label = entry.block ?? entry.region ?? null;
    if (label !== null && label !== undefined) {
      check(typeof label === "string" && BLOCK_PATTERN.test(label), "file block must be 1..80 letters, numbers, spaces, or . _ : / -");
    }
    return { path: normalizeClaimPath(entry.path), block: label || null };
  });
  const whole = new Set(entries.filter(entry => !entry.block).map(entry => entry.path));
  const fileBlocks = {};
  for (const entry of entries) {
    if (entry.block && !whole.has(entry.path)) fileBlocks[entry.path] = entry.block;
  }
  return {
    files: Object.freeze([...new Set(entries.map(entry => entry.path))].sort()),
    fileBlocks: Object.freeze(fileBlocks)
  };
};
const fileBlocksOf = value => {
  if (value === undefined || value === null) return Object.freeze({});
  check(value !== null && typeof value === "object" && !Array.isArray(value), "fileBlocks must be an object");
  const entries = Object.entries(value).map(([path, block]) => ({ path, block }));
  return claimedFilesOf(entries).fileBlocks;
};
const NAME_PATTERN = /^[A-Za-z0-9._/-]{1,200}$/;
const repoOf = value => {
  if (value === undefined || value === null || value === "") return null;
  check(typeof value === "string" && NAME_PATTERN.test(value), "repo must be 1..200 characters of letters, numbers, or . _ / -");
  return value;
};
const branchOf = value => {
  if (value === undefined || value === null || value === "") return null;
  check(typeof value === "string" && NAME_PATTERN.test(value), "branch must be 1..200 characters of letters, numbers, or . _ / -");
  return value;
};
const MAX_PULLS = 16;
const MAX_CHAIN = 20;
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
// Provenance (orch-provenance-rollback): parentClaimId names the claim whose
// output or premise this claim builds on — the edge the provenance walk
// follows downstream. evidenceRefs are documentary pointers (sha256: content
// hashes or https:// URLs without credentials) that ride the claim onto its
// receipt. The walk traverses parentClaimId edges only; evidenceRefs are for
// humans, not graph edges.
const parentClaimIdOf = (value, selfId) => {
  if (value === undefined || value === null || value === "") return null;
  check(typeof value === "string" && DEPENDS_PATTERN.test(value), "parentClaimId must be a claim id");
  check(value !== selfId, "a claim cannot be its own parent");
  return value;
};
const MAX_EVIDENCE_REFS = 16;
const evidenceRefsOf = value => {
  if (value === undefined || value === null) return Object.freeze([]);
  check(Array.isArray(value), "evidenceRefs must be an array");
  check(value.length <= MAX_EVIDENCE_REFS, `evidenceRefs must hold at most ${MAX_EVIDENCE_REFS} pointers`);
  return Object.freeze(value.map(ref => {
    check(typeof ref === "string" && ref.length > 0 && ref.length <= 512,
      "each evidenceRef must be a 1..512 character string");
    if (BLOB_PATTERN.test(ref)) return ref;
    let url = null;
    try { url = new URL(ref); } catch { url = null; }
    check(url && url.protocol === "https:" && !url.username && !url.password,
      "each evidenceRef must be sha256:<64 hex> or an https:// URL without credentials");
    return ref;
  }));
};
// A premise-invalid flag: the named premise claim was declared a bad premise
// and this claim builds on it (directly or transitively). The flag marks the
// claim for re-review; it never changes the work's state or outcome.
const premiseFlagOf = value => {
  if (value === undefined || value === null) return null;
  check(value !== null && typeof value === "object" && !Array.isArray(value), "premiseFlag must be an object");
  check(typeof value.premiseId === "string" && value.premiseId.length > 0 && value.premiseId.length <= 256,
    "premiseFlag premiseId must be 1..256 characters");
  check(typeof value.reason === "string" && value.reason.length > 0 && value.reason.length <= 2000,
    "premiseFlag reason must be 1..2000 characters");
  check(typeof value.by === "string" && value.by.length > 0 && value.by.length <= 128,
    "premiseFlag by must be 1..128 characters");
  check(typeof value.at === "string" && Number.isFinite(Date.parse(value.at)),
    "premiseFlag at must be an ISO timestamp");
  return Object.freeze({ premiseId: value.premiseId, reason: value.reason, by: value.by, at: value.at });
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
  let ciCursor = null;
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
    if (value.ciCursor !== undefined && value.ciCursor !== null) {
      check(value.ciCursor === "status" || value.ciCursor === "checks" || value.ciCursor === "done", "pullRequest ciCursor must be status, checks, or done");
      ciCursor = value.ciCursor;
    }
  }
  return Object.freeze({
    url: parsed.url, repo: parsed.repo, number: parsed.number, outcome, syncedAt, nextPollAt,
    etag, rateLimitedUntil, pollBackoffMs, ciCursor
  });
};
const pullRequestsOf = value => {
  if (value === undefined || value === null) return Object.freeze([]);
  check(Array.isArray(value), "pullRequests must be an array");
  check(value.length <= MAX_PULLS, `pullRequests must list at most ${MAX_PULLS} pull requests`);
  const links = [];
  const seen = new Set();
  for (const entry of value) {
    const pull = pullRequestOf(entry);
    if (!pull || seen.has(pull.url)) continue;
    seen.add(pull.url);
    links.push(pull);
  }
  return Object.freeze(links);
};
const chainOf = value => {
  if (value === undefined || value === null) return Object.freeze([]);
  check(Array.isArray(value) && value.length <= MAX_CHAIN, `chain must hold at most ${MAX_CHAIN} links`);
  return Object.freeze(value.map(entry => {
    check(entry !== null && typeof entry === "object" && !Array.isArray(entry), "each chain link must be an object");
    check(entry.kind === "handoff" || entry.kind === "supersede", "chain kind must be handoff or supersede");
    check(typeof entry.targetId === "string" && entry.targetId.length > 0 && entry.targetId.length <= 128, "chain targetId must be 1..128 characters");
    check(typeof entry.at === "string" && Number.isFinite(Date.parse(entry.at)), "chain at must be an ISO timestamp");
    check(typeof entry.actorId === "string" && entry.actorId.length > 0 && entry.actorId.length <= 128, "chain actorId must be 1..128 characters");
    const note = entry.note ?? null;
    if (note !== null) check(typeof note === "string" && note.length <= 2000, "chain note must be at most 2000 characters");
    return Object.freeze({ kind: entry.kind, targetId: entry.targetId, at: entry.at, actorId: entry.actorId, note });
  }));
};
const optionalId = (value, what) => {
  if (value === undefined || value === null || value === "") return null;
  return idOf(value, what, 256);
};
const blobsOf = value => {
  check(Array.isArray(value), "blobs must be an array");
  check(value.length <= MAX_RECEIPT_BLOBS, `blobs must hold at most ${MAX_RECEIPT_BLOBS} pointers`);
  value.forEach(blob => check(typeof blob === "string" && BLOB_PATTERN.test(blob),
    "each blob must match sha256:<64 lowercase hex characters>"));
  return Object.freeze([...value]);
};
// Predicate for query-time tag filters (the route validates `tag=` params
// against the same shape stored tags must have).
export const isReceiptTag = value => typeof value === "string" && TAG_PATTERN.test(value);
const DEFAULT_LEASE_HOURS = 24;
const MAX_LEASE_HOURS = 168;
export const DEFAULT_MAX_OPEN_CLAIMS = 200;
export const DEFAULT_MAX_MEMBER_OPEN_CLAIMS = 20;
const CONFIG_CAP_CEILING = 10000;
const DEFAULT_REVIEW_POLICY = "self_attested";
const ACTIVE_CLAIM_STATES = ["claimed", "in_progress", "blocked"];
// History actions that end a claim round (the item can be claimed again after
// each of these). Used by appendWorkPullRequest to prove a previous round
// existed when an outcome timestamp ties the current round's claimedAt.
const ROUND_ENDED_ACTIONS = new Set(["pr_closed", "pr_merged", "state:unclaimed", "lease_expired"]);
class ClaimError extends Error { constructor(code, message) { super(message); this.name = "ClaimError"; this.code = code; } }
const fail = (code, message) => { throw new ClaimError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_claim_input", message); };

const toMs = value => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string") { const ms = Date.parse(value); check(Number.isFinite(ms), "now must be a ms epoch, Date, or ISO timestamp"); return ms; }
  fail("invalid_claim_input", "now must be a ms epoch, Date, or ISO timestamp");
};
const nowMsOf = value => value === undefined ? Date.now() : toMs(value);
const isoOf = ms => new Date(ms).toISOString();
const idOf = (value, what, max) => {
  check(typeof value === "string" && value.length > 0 && value.length <= max, `${what} must be 1..${max} characters`);
  return value;
};

const kindOf = value => {
  if (value === undefined || value === null || value === "") return "work";
  check(CLAIM_KINDS.includes(value), `kind must be one of ${CLAIM_KINDS.join(", ")}`);
  return value;
};
const revisionOf = value => {
  if (value === undefined || value === null) return null;
  check(typeof value === "string" && value.length > 0 && value.length <= 200, "revision must be 1..200 characters");
  return value;
};
const ciOf = value => {
  if (value === undefined || value === null) return null;
  check(value !== null && typeof value === "object" && !Array.isArray(value), "ci must be an object");
  check(CI_STATES.includes(value.state), `ci.state must be one of ${CI_STATES.join(", ")}`);
  check(value.url == null || (typeof value.url === "string" && value.url.length > 0 && value.url.length <= 300), "ci.url must be a short string or null");
  check(value.headSha == null || (typeof value.headSha === "string" && /^[0-9a-f]{40}$/.test(value.headSha)), "ci.headSha must be a 40-character commit sha or null");
  check(typeof value.checkedAt === "string" && Number.isFinite(Date.parse(value.checkedAt)), "ci.checkedAt must be an ISO timestamp");
  return Object.freeze({
    state: value.state,
    url: value.url ?? null,
    headSha: value.headSha ?? null,
    checkedAt: value.checkedAt
  });
};
// Structured context for manual reviewed completion. This binds recorded
// claim metadata, not artifact bytes or a version the client proves it saw.
const reviewBasisOf = value => {
  if (value === undefined || value === null) return null;
  check(value && typeof value === "object" && !Array.isArray(value) && value.version === 1, "review basis must use version 1");
  check(typeof value.owner === "string" && value.owner.length > 0 && value.owner.length <= 128, "review basis owner is required");
  check(value.claimedAt === null || typeof value.claimedAt === "string" && Number.isFinite(Date.parse(value.claimedAt)), "review basis claimedAt must be an ISO timestamp or null");
  check(value.revision === null || typeof value.revision === "string" && value.revision.length > 0 && value.revision.length <= 200, "review basis revision must be a short string or null");
  check(value.headSha === null || typeof value.headSha === "string" && /^[0-9a-f]{40}$/.test(value.headSha), "review basis headSha must be a commit SHA or null");
  return Object.freeze({ version: 1, owner: value.owner, claimedAt: value.claimedAt, revision: value.revision, headSha: value.headSha });
};
const reviewBasisFor = item => Object.freeze({ version: 1, owner: item.owner, claimedAt: item.claimedAt,
  revision: item.revision ?? null, headSha: item.ci?.headSha ?? null });
const sameBasis = (left, right) => Boolean(left && right) && Object.keys(right).every(key => left[key] === right[key]);
const currentReviewBasis = (review, item) => {
  const basis = review?.basis, current = reviewBasisFor(item);
  return basis && Object.keys(current).every(key => basis[key] === current[key]);
};

const reviewRecordOf = value => {
  check(value !== null && typeof value === "object" && !Array.isArray(value), "review must be an object");
  check(typeof value.memberId === "string" && value.memberId.length > 0 && value.memberId.length <= 128, "review memberId must be 1..128 characters");
  check(REVIEW_VERDICTS.includes(value.verdict), `verdict must be one of ${REVIEW_VERDICTS.join(", ")}`);
  check(typeof value.summary === "string" && value.summary.length > 0 && value.summary.length <= 2000, "summary must be 1..2000 characters");
  check(value.url == null || (typeof value.url === "string" && value.url.length <= 300), "review url must be at most 300 characters");
  check(typeof value.at === "string" && Number.isFinite(Date.parse(value.at)), "review at must be an ISO timestamp");
  const basis = reviewBasisOf(value.basis);
  return Object.freeze({ memberId: value.memberId, verdict: value.verdict, summary: value.summary, url: value.url ?? null, at: value.at,
    ...(basis ? { basis } : {}) });
};
const reviewsOf = value => {
  if (value === undefined || value === null) return Object.freeze([]);
  check(Array.isArray(value) && value.length <= 50, "reviews must hold at most 50 records");
  return Object.freeze(value.map(reviewRecordOf));
};
const attestationOf = value => {
  check(value !== null && typeof value === "object" && !Array.isArray(value), "attestation must be an object");
  check(typeof value.memberId === "string" && value.memberId.length > 0 && value.memberId.length <= 128, "attestation memberId must be 1..128 characters");
  check(typeof value.at === "string" && Number.isFinite(Date.parse(value.at)), "attestation at must be an ISO timestamp");
  if (value.note !== undefined && value.note !== null) check(typeof value.note === "string" && value.note.length <= 512, "attestation note must be at most 512 characters");
  // SEC-2: note attestations record the claim round and revision they were
  // made against, so a repeat note from the same reviewer is deduplicated.
  const basis = reviewBasisOf(value.basis);
  return Object.freeze({ memberId: value.memberId, at: value.at, note: value.note ?? null, ...(basis ? { basis } : {}) });
};

// W012 required reading: read-acknowledgments are a per-agent map of
// { docs, at }. Latest ack per agent wins; entries without docs are dropped
// so a row can never carry a meaningless ack.
const readingAcksOf = value => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return Object.freeze({});
  const out = {};
  for (const [agent, entry] of Object.entries(value)) {
    if (typeof agent !== "string" || agent.length === 0) continue;
    const docs = Array.isArray(entry?.docs)
      ? entry.docs.filter(doc => typeof doc === "string" && doc.length > 0 && doc.length <= 256).slice(0, 20)
      : [];
    if (docs.length === 0) continue;
    out[agent] = Object.freeze({ docs: Object.freeze(docs),
      at: typeof entry?.at === "string" ? entry.at : null });
  }
  return Object.freeze(out);
};
const workOf = value => {
  check(value !== null && typeof value === "object" && !Array.isArray(value), "work must be an object");
  check(typeof value.id === "string" && value.id.length > 0 && value.id.length <= 256, "work id must be 1..256 characters");
  check(value.state === undefined || STATES.includes(value.state), `state must be one of ${STATES.join(", ")}`);
  if (value.claimedAt !== undefined && value.claimedAt !== null) check(typeof value.claimedAt === "string" && Number.isFinite(Date.parse(value.claimedAt)), "claimedAt must be an ISO timestamp");
  if (value.leaseStartAt !== undefined && value.leaseStartAt !== null) check(typeof value.leaseStartAt === "string" && Number.isFinite(Date.parse(value.leaseStartAt)), "leaseStartAt must be an ISO timestamp");
  if (value.leaseExpiresAt !== undefined && value.leaseExpiresAt !== null) check(typeof value.leaseExpiresAt === "string" && Number.isFinite(Date.parse(value.leaseExpiresAt)), "leaseExpiresAt must be an ISO timestamp");
  if (value.deliveryMode !== undefined && value.deliveryMode !== null) check(DELIVERY_MODES.includes(value.deliveryMode), `deliveryMode must be one of ${DELIVERY_MODES.join(", ")}`);
  if (value.reviewPolicy !== undefined && value.reviewPolicy !== null) check(REVIEW_POLICIES.includes(value.reviewPolicy), `reviewPolicy must be one of ${REVIEW_POLICIES.join(", ")}`);
  if (value.reviewedBy !== undefined && value.reviewedBy !== null) check(typeof value.reviewedBy === "string" && value.reviewedBy.length > 0 && value.reviewedBy.length <= 128, "reviewedBy must be 1..128 characters");
  const attestations = Array.isArray(value.attestations) ? value.attestations.map(attestationOf) : [];
  const tags = value.tags === undefined || value.tags === null ? Object.freeze([]) : tagsOf(value.tags);
  const blobs = value.blobs === undefined || value.blobs === null ? Object.freeze([]) : blobsOf(value.blobs);
  const declared = value.files === undefined || value.files === null
    ? { files: Object.freeze([]), fileBlocks: Object.freeze({}) }
    : claimedFilesOf(value.files);
  const storedBlocks = fileBlocksOf(value.fileBlocks);
  const fileBlocks = Object.freeze({ ...storedBlocks, ...declared.fileBlocks });
  const files = declared.files;
  const dependsOn = value.dependsOn === undefined || value.dependsOn === null ? Object.freeze([]) : dependsOnOf(value.dependsOn, value.id);
  const parentClaimId = parentClaimIdOf(value.parentClaimId, value.id);
  const evidenceRefs = evidenceRefsOf(value.evidenceRefs);
  const premiseFlag = premiseFlagOf(value.premiseFlag);
  const listedPulls = Array.isArray(value.pullRequests) && value.pullRequests.length
    ? pullRequestsOf(value.pullRequests)
    : (value.pullRequest ? Object.freeze([pullRequestOf(value.pullRequest)]) : Object.freeze([]));
  const pullRequest = listedPulls.find(pull => !pull.outcome) ?? listedPulls[listedPulls.length - 1] ?? null;
  const kind = kindOf(value.kind);
  const revision = revisionOf(value.revision);
  if (kind === "deploy") check(revision, "a deploy claim needs a revision");
  const historyOmitted = historyOmittedOf(value.historyOmitted);
  const readingAcks = readingAcksOf(value.readingAcks);
  return { id: value.id, title: value.title ?? value.id, state: value.state ?? "unclaimed",
    owner: value.owner ?? null, history: Array.isArray(value.history) ? value.history : [],
    readingAcks,
    ...(historyOmitted > 0 ? { historyOmitted } : {}),
    claimedAt: value.claimedAt ?? null, leaseStartAt: value.leaseStartAt ?? null, leaseExpiresAt: value.leaseExpiresAt ?? null,
    deliveryMode: value.deliveryMode ?? null, reviewPolicy: value.reviewPolicy ?? null,
    reviewedBy: value.reviewedBy ?? null, attestations: Object.freeze(attestations),
    tags, files, fileBlocks, blobs, dependsOn, pullRequest, pullRequests: listedPulls,
    parentClaimId, evidenceRefs, premiseFlag,
    repo: repoOf(value.repo), branch: branchOf(value.branch),
    chain: chainOf(value.chain), supersededBy: optionalId(value.supersededBy, "supersededBy"),
    workItemId: optionalId(value.workItemId, "workItemId"),
    squadId: optionalId(value.squadId, "squadId"), // plan-squads: work offer targeted at a squad
    kind, revision, ci: ciOf(value.ci), reviews: reviewsOf(value.reviews) };
};
const agentOf = value => idOf(value, "agent id", 128);
const stamp = (atMs, agentId, action, note) =>
  Object.freeze({ at: isoOf(atMs), agentId, action, note: note ?? null });
// SEC-2: a claim keeps at most MAX_CLAIM_HISTORY history entries. Older
// entries are dropped from the front and counted in historyOmitted, so
// history.length + historyOmitted is the claim's lifetime entry count and
// still changes on every write (the PR-link concurrency check reads it).
export const MAX_CLAIM_HISTORY = 200;
const historyOmittedOf = value => (Number.isSafeInteger(value) && value > 0 ? value : 0);
export const claimHistoryLength = item =>
  (Array.isArray(item?.history) ? item.history.length : 0) + historyOmittedOf(item?.historyOmitted);
const withHistory = (work, atMs, agentId, action, note) => {
  const full = [...work.history, stamp(atMs, agentId, action, note)];
  const dropped = Math.max(0, full.length - MAX_CLAIM_HISTORY);
  const omitted = historyOmittedOf(work.historyOmitted) + dropped;
  return Object.freeze({ ...work, updatedAt: isoOf(atMs),
    history: Object.freeze(dropped > 0 ? full.slice(dropped) : full),
    ...(omitted > 0 ? { historyOmitted: omitted } : {}) });
};
// Append one history stamp to a claim without a state transition (W012
// required reading acks, and any future note-only stamps). Same trimming
// rules as every other claim write.
export function stampClaimHistory(work, agentId, { action, note, now } = {}) {
  const item = workOf(work), agent = agentOf(agentId), atMs = nowMsOf(now);
  if (typeof action !== "string" || action.length === 0) fail("invalid_claim_input", "history action is required");
  return withHistory(item, atMs, agent, action, note);
}
// A copy of the claim that keeps only the newest `keep` history entries,
// with the rest counted in historyOmitted. Board lists use it; the
// single-claim read returns the stored history.
export function summarizeClaimHistory(item, keep) {
  const history = Array.isArray(item?.history) ? item.history : [];
  if (history.length <= keep) return item;
  const dropped = history.length - keep;
  return { ...item, history: history.slice(dropped), historyOmitted: historyOmittedOf(item.historyOmitted) + dropped };
}
// Board order is updatedAt desc, then id. A later history stamp wins when a
// writer appended history without refreshing updatedAt.
export function claimUpdatedAt(item) {
  const history = Array.isArray(item?.history) ? item.history : [];
  const historyAt = history.length > 0 && typeof history[history.length - 1]?.at === "string" ? history[history.length - 1].at : "";
  const stored = typeof item?.updatedAt === "string" ? item.updatedAt : "";
  return historyAt > stored ? historyAt : (stored || historyAt);
}
const positiveCap = (value, fallback) =>
  Number.isSafeInteger(value) && value >= 1 && value <= CONFIG_CAP_CEILING ? value : fallback;
// Room config hook: resolve per-room work-claim defaults from an optional
// room object. Rooms opt in by carrying workClaims = { defaultLeaseHours,
// reviewPolicy, maxOpenClaims, maxMemberOpenClaims }; anything missing or
// invalid falls back to the defaults.
export function roomWorkClaimConfig(room) {
  const raw = room?.workClaims ?? {};
  const defaultLeaseHours = typeof raw.defaultLeaseHours === "number" && raw.defaultLeaseHours > 0 && raw.defaultLeaseHours <= MAX_LEASE_HOURS
    ? raw.defaultLeaseHours : DEFAULT_LEASE_HOURS;
  const reviewPolicy = REVIEW_POLICIES.includes(raw.reviewPolicy) ? raw.reviewPolicy : DEFAULT_REVIEW_POLICY;
  return Object.freeze({
    defaultLeaseHours,
    reviewPolicy,
    maxOpenClaims: positiveCap(raw.maxOpenClaims, DEFAULT_MAX_OPEN_CLAIMS),
    maxMemberOpenClaims: positiveCap(raw.maxMemberOpenClaims, DEFAULT_MAX_MEMBER_OPEN_CLAIMS),
  });
}
const leaseHoursOf = value => {
  if (value === null || value === undefined) return value; // null = explicit opt-out of leases
  check(typeof value === "number" && Number.isFinite(value) && value > 0 && value <= MAX_LEASE_HOURS,
    `leaseHours must be > 0 and <= ${MAX_LEASE_HOURS}, or null for no lease`);
  return value;
};
const pullList = (pullRequest, pullRequests) => {
  const links = pullRequestsOf(pullRequests);
  const single = pullRequestOf(pullRequest);
  if (!single) return links;
  if (links.some(pull => pull.url === single.url)) return links;
  check(links.length < MAX_PULLS, `pullRequests must list at most ${MAX_PULLS} pull requests`);
  return Object.freeze([...links, single]);
};
// Create a work item (unclaimed). Items usually enter the registry here;
// claiming an unknown id is refused so claims always reference real work.
// `tags` may be supplied up front (free-form, recorded on the item); blobs
// are evidence pointers and are only recorded on the done transition.
export function createWork({ id, title, reviewPolicy, note, tags, files, dependsOn, parentClaimId, evidenceRefs, pullRequest, pullRequests, repo, branch, fileBlocks, workItemId, kind, revision, squadId } = {}, { now, agentId } = {}) {
  const atMs = nowMsOf(now);
  idOf(id, "work id", 256);
  if (title !== undefined) check(typeof title === "string" && title.length > 0 && title.length <= 512, "title must be 1..512 characters");
  // SEC2: the create note is stored on the "created" history stamp and served
  // on every board list — without a bound, a direct API caller can stash an
  // arbitrarily large string. 4000 matches the New-item form's maxlength.
  if (note !== undefined && note !== null) check(typeof note === "string" && note.length <= 4000, "note must be a string of at most 4000 characters");
  if (reviewPolicy !== undefined && reviewPolicy !== null) check(REVIEW_POLICIES.includes(reviewPolicy), `reviewPolicy must be one of ${REVIEW_POLICIES.join(", ")}`);
  const claimKind = kindOf(kind);
  const claimRevision = revisionOf(revision);
  if (claimKind === "deploy") check(claimRevision, "a deploy claim needs a revision");
  const declared = files === undefined || files === null ? { files: Object.freeze([]), fileBlocks: Object.freeze({}) } : claimedFilesOf(files);
  const links = pullList(pullRequest, pullRequests);
  const item = { id, title: title ?? id, state: "unclaimed", owner: null, history: [],
    claimedAt: null, leaseStartAt: null, leaseExpiresAt: null, deliveryMode: null,
    reviewPolicy: reviewPolicy ?? null, reviewedBy: null, attestations: Object.freeze([]),
    tags: tags === undefined || tags === null ? Object.freeze([]) : tagsOf(tags),
    files: declared.files,
    fileBlocks: Object.freeze({ ...fileBlocksOf(fileBlocks), ...declared.fileBlocks }),
    blobs: Object.freeze([]),
    dependsOn: dependsOn === undefined || dependsOn === null ? Object.freeze([]) : dependsOnOf(dependsOn, id),
    parentClaimId: parentClaimIdOf(parentClaimId, id),
    evidenceRefs: evidenceRefsOf(evidenceRefs),
    premiseFlag: null,
    pullRequest: links.find(pull => !pull.outcome) ?? links[links.length - 1] ?? null,
    pullRequests: links,
    repo: repoOf(repo), branch: branchOf(branch),
    chain: Object.freeze([]), supersededBy: null, workItemId: optionalId(workItemId, "workItemId"),
    squadId: optionalId(squadId, "squadId"), // plan-squads: work offer targeted at a squad
    kind: claimKind, revision: claimRevision, ci: null, reviews: Object.freeze([]) };
  // The creating member when the route knows it; "system" for internal creates.
  return withHistory(item, atMs, agentId === undefined ? "system" : agentOf(agentId), "created", note);
}
// Claim unclaimed work. Refuses already-claimed work (the anti-collision rule).
// leaseHours: hours until the claim lapses (default: the room's
// defaultLeaseHours, else 24h); null opts out — the claim never expires.
export function claimWork(work, agentId, { note, leaseHours, files, dependsOn, parentClaimId, evidenceRefs, pullRequest, pullRequests, repo, branch, fileBlocks, room, now } = {}) {
  const item = workOf(work), agent = agentOf(agentId), atMs = nowMsOf(now);
  check(item.state === "unclaimed", `work "${item.id}" is already ${item.state} — release it first`);
  // QA D-1: the 4000-char bound applies to every note stored on a history
  // stamp, not just create — an unbounded claim note is the same
  // storage/amplification vector the SEC2 create cap closed.
  if (note !== undefined && note !== null) check(typeof note === "string" && note.length <= 4000, "note must be a string of at most 4000 characters");
  const wanted = leaseHoursOf(leaseHours);
  const effective = wanted === null ? null : wanted ?? roomWorkClaimConfig(room).defaultLeaseHours;
  const declared = files === undefined || files === null ? null : claimedFilesOf(files);
  const links = pullRequest === undefined && pullRequests === undefined ? null : pullList(pullRequest, pullRequests);
  const claimed = { ...item, state: "claimed", owner: agent, claimedAt: isoOf(atMs),
    files: declared ? declared.files : item.files,
    fileBlocks: declared
      ? Object.freeze({ ...fileBlocksOf(fileBlocks), ...declared.fileBlocks })
      : (fileBlocks === undefined ? item.fileBlocks : fileBlocksOf(fileBlocks)),
    dependsOn: dependsOn === undefined ? item.dependsOn : dependsOnOf(dependsOn ?? [], item.id),
    parentClaimId: parentClaimId === undefined ? item.parentClaimId : parentClaimIdOf(parentClaimId, item.id),
    evidenceRefs: evidenceRefs === undefined ? item.evidenceRefs : evidenceRefsOf(evidenceRefs),
    pullRequests: links ?? item.pullRequests,
    pullRequest: links ? (links.find(pull => !pull.outcome) ?? links[links.length - 1] ?? null) : item.pullRequest,
    repo: repo === undefined ? item.repo : repoOf(repo),
    branch: branch === undefined ? item.branch : branchOf(branch),
    leaseStartAt: effective === null ? null : isoOf(atMs),
    leaseExpiresAt: effective === null ? null : isoOf(atMs + effective * 3600 * 1000) };
  return withHistory(claimed, atMs, agent, "claimed",
    effective === null ? note : note ?? `lease: ${effective}h`);
}
// Renew a claim's lease: starts a fresh lease window from now, extending
// leaseExpiresAt by the lease duration (explicit leaseHours, else the
// room's default). Only the owner may renew, only while the claim is
// active, and only when the claim carries a lease (claims that opted out
// of leases have nothing to renew; lapsed leases must be claimed again).
// The route layer requires the owner's public progress message — posted
// in the room after the prior lease start — before calling this; the pure
// machine records the renewal, never the message check.
export function renewWork(work, agentId, { note, leaseHours, room, now } = {}) {
  const item = workOf(work), agent = agentOf(agentId), atMs = nowMsOf(now);
  check(item.owner === agent, `work "${item.id}" is owned by ${item.owner ?? "nobody"} — only the owner can renew it`);
  check(ACTIVE_CLAIM_STATES.includes(item.state), `work "${item.id}" is ${item.state} — only active claims can be renewed`);
  check(item.leaseExpiresAt !== null, `work "${item.id}" has no lease — nothing to renew`);
  check(Date.parse(item.leaseExpiresAt) > atMs, `work "${item.id}" lease already lapsed — claim it again instead`);
  // QA D-1: same 4000-char bound as create — see claimWork.
  if (note !== undefined && note !== null) check(typeof note === "string" && note.length <= 4000, "note must be a string of at most 4000 characters");
  const wanted = leaseHoursOf(leaseHours);
  // Explicit null opts out of leases, exactly like claimWork: the renewed
  // claim carries no lease window (it previously fell through to the room
  // default, contradicting claimWork's null handling).
  const effective = wanted === null ? null : wanted ?? roomWorkClaimConfig(room).defaultLeaseHours;
  const renewed = { ...item,
    leaseStartAt: effective === null ? null : isoOf(atMs),
    leaseExpiresAt: effective === null ? null : isoOf(atMs + effective * 3600 * 1000) };
  return withHistory(renewed, atMs, agent, "renewed",
    note ?? (effective === null ? "lease removed" : `lease: ${effective}h`));
}
// Append one URL to the current claim round without replacing its lease or
// evidence. A fresh duplicate in the same round is a byte-identical no-op;
// stale replay must read back before deciding whether the link was already
// recorded. A link whose recorded outcome provably predates the current
// claim round (syncedAt older than claimedAt) belongs to a previous round:
// re-linking it re-asserts the PR for the current round, so the link is
// reset (outcome cleared) and the poller re-reads it — without the reset
// the stale outcome would veto every future poll of the reopened PR.
// A same-round duplicate stays a byte-identical no-op.
export function appendWorkPullRequest(work, agentId, { pullRequest, expectedClaimedAt, expectedHistoryLength, now } = {}) {
  const item = workOf(work), agent = agentOf(agentId), atMs = nowMsOf(now);
  check(typeof pullRequest === "string" && pullRequest.length <= 300, "pullRequest must be a URL string of at most 300 characters");
  const parsed = parsePullRequestUrl(pullRequest);
  check(parsed && !new URL(pullRequest.trim()).port, "pullRequest must be a canonical https://github.com/{owner}/{repo}/pull/{number} URL");
  check(typeof expectedClaimedAt === "string" && expectedClaimedAt.length <= 100 && Number.isFinite(Date.parse(expectedClaimedAt)), "expectedClaimedAt must be the current claim timestamp");
  check(Number.isSafeInteger(expectedHistoryLength) && expectedHistoryLength >= 0, "expectedHistoryLength must be a non-negative integer");
  if (!ACTIVE_CLAIM_STATES.includes(item.state) || !item.owner || item.supersededBy) {
    fail("work_claim_conflict", "Only an active, unsuperseded claim can receive a PR link");
  }
  if (item.owner !== agent) fail("work_not_owner", "Only the current claim owner can link a PR");
  if (isLeaseExpired(item, atMs)) fail("claim_lease_lapsed", "The current claim lease has lapsed");
  if (item.claimedAt !== expectedClaimedAt || claimHistoryLength(item) !== expectedHistoryLength) {
    fail("work_claim_conflict", "The claim changed since it was read");
  }
  const settledLink = item.pullRequests.find(pull => pull.url === parsed.url) ?? null;
  // A recorded outcome is stale only when it provably predates the current
  // claim round (recorded before this round's claimedAt — the poller always
  // stamps syncedAt when it records). A same-round duplicate stays a
  // byte-identical no-op: the link's observations are current-round truth.
  // An outcome stamped at or before the round start is stale: a settled
  // outcome releases the claim, so a same-millisecond outcome and re-claim
  // can only mean the outcome ended the previous round (equality counts as
  // stale, so the decision does not depend on millisecond-strict ordering).
  // When the round is not provable either way, the no-op wins.
  const outcomeMs = typeof settledLink?.syncedAt === "string" ? Date.parse(settledLink.syncedAt) : NaN;
  const roundStartMs = typeof item.claimedAt === "string" ? Date.parse(item.claimedAt) : NaN;
  // At the exact same millisecond the timestamps cannot order the outcome
  // against the round start. Equality counts as stale only when the claim's
  // own history shows an earlier round; a link settled in the same tick as
  // the first claim is current-round truth.
  //
  // A previous round provably ended when the history carries a round-ending
  // stamp: pr_closed/pr_merged (the auto-settler), state:unclaimed (a manual
  // release), or lease_expired (the sweep). Counting "claimed" stamps alone
  // undercounts: a round that began via reassign stamps "reassigned:<target>"
  // instead of "claimed", and history trimming (MAX_CLAIM_HISTORY) can drop
  // early "claimed" stamps. Either gap misreads the tie as first-round
  // truth, and the stale outcome then vetoes every future poll of the
  // reopened PR. The two-"claimed"-stamps check stays as a backstop.
  const history = item.history ?? [];
  const priorRoundRecorded = history.some(entry => ROUND_ENDED_ACTIONS.has(entry?.action))
    || history.filter(entry => entry?.action === "claimed").length >= 2;
  const staleOutcome = Boolean(settledLink?.outcome)
    && Number.isFinite(outcomeMs) && Number.isFinite(roundStartMs)
    && (outcomeMs < roundStartMs || (outcomeMs === roundStartMs && priorRoundRecorded));
  if (settledLink && !staleOutcome) return work;
  check(item.pullRequests.length < MAX_PULLS, `pullRequests must list at most ${MAX_PULLS} pull requests`);
  // Keep the existing observations verbatim; only the server's poller may
  // fill in the new link's outcome, polling metadata, or CI.
  const prior = Array.isArray(work.pullRequests) && work.pullRequests.length ? work.pullRequests
    : (work.pullRequest ? [work.pullRequest] : []);
  const canonicalUrl = entry => {
    const raw = typeof entry === "string" ? entry : entry?.url;
    return typeof raw === "string" ? parsePullRequestUrl(raw)?.url ?? null : null;
  };
  const fresh = pullRequestOf(parsed.url);
  const links = settledLink
    ? Object.freeze(prior.map(entry => (canonicalUrl(entry) === parsed.url ? fresh : entry)))
    : Object.freeze([...prior, fresh]);
  return withHistory({ ...work, pullRequests: links,
    pullRequest: links.find(pull => !pull.outcome) ?? links[links.length - 1],
    ci: null, attestations: Object.freeze([]) }, atMs, agent, "pr_linked", `Linked pull request ${parsed.url}`);
}
// Update claimed work: move state or add a note. Only the owner may update.
// The done transition accepts deliveryMode (how the work was delivered),
// reviewedBy (the attesting member, per the item's review policy), tags
// (free-form receipt labels) and blobs (sha256 evidence pointers) — all
// four are recorded on the item and then frozen with the done state. tags
// and blobs are only meaningful on the done transition and are refused
// anywhere else.
export function updateWork(work, agentId, { state, note, deliveryMode, reviewedBy, tags, blobs, parentClaimId, evidenceRefs, now, authority = false } = {}) {
  const item = workOf(work), agent = agentOf(agentId), atMs = nowMsOf(now);
  check(authority === true || item.owner === agent, `work "${item.id}" is owned by ${item.owner ?? "nobody"} — only the owner can update it`);
  check(!isTerminalClaimState(item.state), `work "${item.id}" is ${item.state} and immutable`);
  if (state !== undefined) {
    check(STATES.includes(state), `state must be one of ${STATES.join(", ")}`);
    const allowed = TRANSITIONS[item.state] ?? [];
    const allowedLabel = next => next === "unclaimed" ? "released" : next;
    check(allowed.includes(state),
      `cannot move "${item.id}" from ${item.state} to ${state} — allowed: ${item.state} -> ${allowed.map(allowedLabel).join("|") || "none"}`);
  }
  if (deliveryMode !== undefined && deliveryMode !== null) {
    check(state === "done", "deliveryMode is only recorded on the done transition");
    check(DELIVERY_MODES.includes(deliveryMode), `deliveryMode must be one of ${DELIVERY_MODES.join(", ")}`);
  }
  if (reviewedBy !== undefined && reviewedBy !== null) {
    check(state === "done", "reviewedBy is only recorded on the done transition");
    agentOf(reviewedBy);
  }
  if (tags !== undefined && tags !== null) {
    check(state === "done", "tags are only recorded on the done transition");
    tagsOf(tags);
  }
  if (blobs !== undefined && blobs !== null) {
    check(state === "done", "blobs are only recorded on the done transition");
    blobsOf(blobs);
  }
  // QA D-1: same 4000-char bound as create — see claimWork.
  if (note !== undefined && note !== null) check(typeof note === "string" && note.length <= 4000, "note must be a string of at most 4000 characters");
  const released = state === "unclaimed";
  // Provenance is work-level, like dependsOn: it survives release and the
  // done transition freezes the final values onto the receipt. It applies on
  // note-only updates too — a provenance correction needs no state change.
  const withProvenance = {
    parentClaimId: parentClaimId === undefined ? item.parentClaimId : parentClaimIdOf(parentClaimId, item.id),
    evidenceRefs: evidenceRefs === undefined ? item.evidenceRefs : evidenceRefsOf(evidenceRefs),
  };
  const next = state === undefined ? { ...item, ...withProvenance } : { ...item, state,
    owner: released ? null : item.owner,
    leaseStartAt: released ? null : item.leaseStartAt, // a released claim holds no lease
    leaseExpiresAt: released ? null : item.leaseExpiresAt, // a released claim holds no lease
    // a released claim drops its reviews too — attestations belong to the
    // lapsed owner's round of work, never to whoever claims next
    attestations: released ? Object.freeze([]) : item.attestations,
    reviews: released ? Object.freeze([]) : item.reviews,
    // declared files belong to the owner's round too — a re-claim must not
    // inherit the previous owner's file declarations
    files: released ? Object.freeze([]) : item.files,
    fileBlocks: released ? Object.freeze({}) : item.fileBlocks,
    deliveryMode: state === "done" && deliveryMode != null ? deliveryMode : item.deliveryMode,
    reviewedBy: state === "done" && reviewedBy != null ? reviewedBy : item.reviewedBy,
    tags: state === "done" && tags != null ? tagsOf(tags) : item.tags,
    blobs: state === "done" && blobs != null ? blobsOf(blobs) : item.blobs,
    ...withProvenance };
  return withHistory(next, atMs, agent, state === undefined ? "noted" : `state:${state}`, note);
}
// Retire open work without delivering it. close: the room's claim managers
// (authority) or the current holder. cancel: whoever opened the item while
// it is still unclaimed, or the current holder; authority may also cancel.
// The item lands in the terminal closed state with no owner and no lease;
// the history stamp ("closed" | "cancelled") names who retired it and why.
export function closeWork(work, agentId, { verb = "close", reason, now, authority = false } = {}) {
  const item = workOf(work), agent = agentOf(agentId), atMs = nowMsOf(now);
  check(verb === "close" || verb === "cancel", "verb must be close or cancel");
  if (reason !== undefined && reason !== null) check(typeof reason === "string" && reason.length <= 4000, "reason must be a string of at most 4000 characters");
  const next = nextClaimState(item.state, verb);
  if (next === null) fail("work_claim_terminal", `Cannot ${verb} "${item.id}": it is already ${item.state}`);
  const holder = item.owner !== null && item.owner === agent;
  const opener = item.state === "unclaimed" && item.owner === null && creatorOf(item) === agent;
  const allowed = authority === true || holder || (verb === "cancel" && opener);
  if (!allowed) {
    fail("work_not_owner", verb === "cancel"
      ? `Only the member who opened "${item.id}" (while unclaimed), its holder, or a claim manager can cancel it`
      : `Only the holder of "${item.id}" or a claim manager (room owner or manage_claims) can close it`);
  }
  const closed = { ...item, state: next, owner: null, leaseStartAt: null, leaseExpiresAt: null,
    attestations: Object.freeze([]), reviews: Object.freeze([]),
    files: Object.freeze([]), fileBlocks: Object.freeze({}) };
  return withHistory(closed, atMs, agent, verb === "cancel" ? "cancelled" : "closed", reason);
}
// The member who created the item, when the creation stamp is still in history.
export function creatorOf(work) {
  const first = Array.isArray(work?.history) && !work.historyOmitted ? work.history[0] : null;
  return first && first.action === "created" && typeof first.agentId === "string" && first.agentId !== "system" ? first.agentId : null;
}
// Record a note from the caller's own authenticated session. A new note
// supersedes that member's active verdict but cannot approve reviewed completion.
// Refused on unclaimed work (nothing to review) and on done work (immutable).
export function attestWork(work, agentId, { note, now } = {}) {
  const item = workOf(work), agent = agentOf(agentId), atMs = nowMsOf(now);
  check(ACTIVE_CLAIM_STATES.includes(item.state), `work "${item.id}" is ${item.state} — only active claims can be reviewed`);
  if (note !== undefined && note !== null) check(typeof note === "string" && note.length <= 512, "note must be at most 512 characters");
  const prior = item.attestations.find(entry => entry.memberId === agent);
  const explicit = item.reviews.some(entry => entry.memberId === agent);
  if (!explicit && prior && prior.note === (note ?? null)) return Object.freeze(item);
  const basis = reviewBasisFor(item);
  // SEC-2: one attestation per reviewer per claim round and revision. A
  // repeat note on the same basis replaces the recorded note in place: no
  // history entry, so the route appends no room event for it.
  if (!explicit && prior && sameBasis(prior.basis, basis)) {
    const replaced = Object.freeze({ memberId: agent, at: prior.at, note: note ?? null, basis });
    return Object.freeze({ ...item, attestations: Object.freeze(item.attestations.map(entry => (entry.memberId === agent ? replaced : entry))) });
  }
  const attestation = Object.freeze({ memberId: agent, at: isoOf(atMs), note: note ?? null, basis });
  const attestations = Object.freeze([
    ...item.attestations.filter(entry => entry.memberId !== agent),
    attestation,
  ]);
  // A new note supersedes this member's active verdict; it is not an approve.
  // Immutable event/history records remain available for the prior review.
  const reviews = Object.freeze(item.reviews.filter(entry => entry.memberId !== agent));
  return withHistory({ ...item, attestations, reviews }, atMs, agent, "reviewed", note);
}
// A review record from someone other than the owner. Latest record per member
// wins. Only approve also records the caller-bound attestation used by the
// manual done policy. The owner cannot review their own claim.
export function recordReview(work, agentId, { verdict, summary, url, now } = {}) {
  const item = workOf(work), agent = agentOf(agentId), atMs = nowMsOf(now);
  check(item.owner !== agent, `work "${item.id}" is owned by ${item.owner ?? "nobody"} — the owner cannot review it`);
  check(ACTIVE_CLAIM_STATES.includes(item.state), `work "${item.id}" is ${item.state} — only active claims can be reviewed`);
  check(REVIEW_VERDICTS.includes(verdict), `verdict must be one of ${REVIEW_VERDICTS.join(", ")}`);
  check(typeof summary === "string" && summary.length > 0 && summary.length <= 2000, "summary must be 1..2000 characters");
  let reviewUrl = null;
  if (url !== undefined && url !== null) {
    check(typeof url === "string" && url.length > 0 && url.length <= 300, "url must be at most 300 characters");
    let parsed;
    try { parsed = new URL(url); } catch { parsed = null; }
    check(parsed && parsed.protocol === "https:" && !parsed.username && !parsed.password, "url must be an https URL without credentials");
    reviewUrl = url;
  }
  const prior = item.reviews.find(entry => entry.memberId === agent);
  // Replaying the latest identical content never refreshes its old binding.
  // A request ID is still needed to distinguish delayed retries after a newer verdict.
  if (prior && prior.verdict === verdict && prior.summary === summary && prior.url === reviewUrl) return Object.freeze(item);
  const at = isoOf(atMs);
  const review = Object.freeze({ memberId: agent, verdict, summary, url: reviewUrl, at, basis: reviewBasisFor(item) });
  const reviews = Object.freeze([...item.reviews.filter(entry => entry.memberId !== agent), review]);
  const attestations = Object.freeze([
    ...item.attestations.filter(entry => entry.memberId !== agent),
    ...(verdict === "approve" ? [Object.freeze({ memberId: agent, at, note: summary.slice(0, 512) })] : []),
  ]);
  return withHistory({ ...item, reviews, attestations }, atMs, agent, "reviewed", summary.slice(0, 512));
}
// Land and deploy claims close when this server's live revision matches the
// claim's revision. Any non-done state can close; the history stamp is the
// same state:done the receipts search already looks for.
export function closeWhenLive(work, liveRevision, now) {
  const item = workOf(work);
  if (item.kind !== "land" && item.kind !== "deploy") return null;
  if (isTerminalClaimState(item.state) || typeof liveRevision !== "string" || liveRevision.length === 0) return null;
  const head = item.ci?.headSha ?? null;
  if (item.revision !== liveRevision && head !== liveRevision) return null;
  const atMs = nowMsOf(now);
  return withHistory({ ...item, state: "done", deliveryMode: item.deliveryMode ?? "production" }, atMs, item.owner ?? "system", "state:done",
    `live revision matches ${liveRevision}`);
}
// Store a CI rollup. A state change is the only thing that stamps history;
// a repeat of the same state still refreshes the sha and the time.
export function recordCi(work, ci, now) {
  const item = workOf(work);
  const atMs = nowMsOf(now);
  const next = ciOf({ ...ci, checkedAt: ci?.checkedAt ?? isoOf(atMs) });
  const changed = (item.ci?.state ?? null) !== next.state;
  const updated = { ...item, ci: next };
  return { changed, item: changed ? withHistory(updated, atMs, item.owner ?? "system", "ci", next.state) : updated };
}
// A merged land or deploy pull records the merge commit as the revision the
// live server has to reach. The claim stays open until that revision is live.
export function notePullMerged(work, mergedSha, now) {
  const item = workOf(work);
  if (item.kind !== "land" && item.kind !== "deploy") return null;
  if (!item.pullRequest) return null;
  const atMs = nowMsOf(now);
  const revision = item.revision || (typeof mergedSha === "string" && /^[0-9a-f]{40}$/.test(mergedSha) ? mergedSha : null);
  const pullRequest = Object.freeze({
    ...item.pullRequest, outcome: "merged", syncedAt: isoOf(atMs), nextPollAt: null, rateLimitedUntil: null
  });
  return { ...item, revision, pullRequest };
}
// Reassign: the owner hands work to another agent (stays in the same state).
// Attestations are cleared — reviews belong to the previous owner's round.
export function reassignWork(work, agentId, newOwner, { note, now, authority = false, room } = {}) {
  const item = workOf(work), agent = agentOf(agentId), target = agentOf(newOwner), atMs = nowMsOf(now);
  check(authority === true || item.owner === agent, `work "${item.id}" is owned by ${item.owner ?? "nobody"} — only the owner can reassign it`);
  check(!isTerminalClaimState(item.state), `work "${item.id}" is ${item.state} and immutable`);
  // Assigning an unclaimed item hands it over as a claim: state claimed with
  // a fresh lease (room default), the same shape create-with-assignee gives.
  // Before this, the owner was set but the state stayed "unclaimed" with no
  // lease, so the item showed as free to take and never expired.
  const fresh = item.state === "unclaimed";
  const hours = fresh ? roomWorkClaimConfig(room).defaultLeaseHours : null;
  const claim = fresh ? { state: "claimed", claimedAt: isoOf(atMs),
    leaseStartAt: hours === null ? null : isoOf(atMs),
    leaseExpiresAt: hours === null ? null : isoOf(atMs + hours * 3600 * 1000) } : {};
  return withHistory({ ...item, ...claim, owner: target, attestations: Object.freeze([]), reviews: Object.freeze([]) }, atMs, agent, `reassigned:${target}`, note);
}
// Succession (FIX-12, WAVE-300): an unprivileged peer takes over a claim
// whose holder is gone. The route layer establishes eligibility — the
// holder's server-observed heartbeat is stale beyond the succession
// threshold ("holder_stale"), or the work lease already lapsed
// ("lease_lapsed"; in practice the per-request sweep releases those first)
// — so the pure machine only moves ownership. State, lease, claimedAt,
// files and notes survive: the successor resumes the round, it does not
// restart it. Attestations and reviews are cleared, exactly like reassign:
// they belong to the previous owner's round, never to the next holder's.
export function succeedWork(work, agentId, { via, note, now } = {}) {
  const item = workOf(work), agent = agentOf(agentId), atMs = nowMsOf(now);
  check(ACTIVE_CLAIM_STATES.includes(item.state), `work "${item.id}" is ${item.state} — only a held claim can be succeeded`);
  check(item.owner !== null && item.owner !== undefined, `work "${item.id}" has no holder — claim it instead`);
  check(item.owner !== agent, `work "${item.id}" is yours — renew or release it instead of succeeding it`);
  check(via === "holder_stale" || via === "lease_lapsed", `via must be "holder_stale" or "lease_lapsed"`);
  if (note !== undefined && note !== null) check(typeof note === "string" && note.length <= 4000, "note must be a string of at most 4000 characters");
  const succeeded = { ...item, owner: agent, attestations: Object.freeze([]), reviews: Object.freeze([]) };
  return withHistory(succeeded, atMs, agent, "succeeded",
    `unprivileged succession (${via}): previous holder ${item.owner}${note ? ` — ${note}` : ""}`);
}
// True when the item holds an active claim whose lease has lapsed. Items
// without a lease, and items not under claim, never expire.
export function isLeaseExpired(work, now) {
  const item = workOf(work);
  if (!ACTIVE_CLAIM_STATES.includes(item.state) || item.leaseExpiresAt === null) return false;
  return Date.parse(item.leaseExpiresAt) <= nowMsOf(now);
}
// Sweep a list: expired claims are auto-released to unclaimed (owner
// cleared, lease cleared, history stamped). Everything else passes through
// untouched. Returns a new list; inputs are never mutated.
export function releaseExpired(items, now) {
  check(Array.isArray(items), "items must be a list");
  const atMs = nowMsOf(now);
  return items.map(entry => {
    const item = workOf(entry);
    if (!isLeaseExpired(item, atMs)) return item;
    // Auto-release clears owner, lease, the lapsed owner's declared
    // files, and their attestations — whoever claims next starts clean.
    // 2026-09-30 (phase-2 gap audit L-P2-8): mirrors updateWork, where a
    // released claim drops its reviews too (attestations belong to the
    // lapsed owner's round of work, never to whoever claims next).
    const released = { ...item, state: "unclaimed", owner: null, leaseStartAt: null, leaseExpiresAt: null,
      files: Object.freeze([]), fileBlocks: Object.freeze({}), attestations: Object.freeze([]), reviews: Object.freeze([]) };
    return withHistory(released, atMs, item.owner ?? "system", "lease_expired",
      `claim by ${item.owner ?? "nobody"} lapsed at ${item.leaseExpiresAt} — auto-released`);
  });
}
// Review-policy gate for the done transition. policy resolves from the
// explicit option, then the work item, then self_attested. verifyMembers is
// the current set/list holding verify; reviewMembers is the current set/list
// allowed to record explicit reviews. verifyMembers is only consulted
// for independent_principal. Returns true when reviewerId may close the
// work; unknown policies throw (programmer error), identity mismatches
// simply return false.
export function canCloseWork(work, reviewerId, { policy, verifyMembers, reviewMembers } = {}) {
  const item = workOf(work);
  const effective = policy ?? item.reviewPolicy ?? DEFAULT_REVIEW_POLICY;
  check(REVIEW_POLICIES.includes(effective), `policy must be one of ${REVIEW_POLICIES.join(", ")}`);
  if (isTerminalClaimState(item.state) || item.state === "unclaimed" || item.owner === null) return false;
  if (typeof reviewerId !== "string" || reviewerId.length === 0) return false;
  if (effective === "self_attested") return reviewerId === item.owner;
  if (reviewerId === item.owner || item.supersededBy) return false;
  const review = item.reviews.find(entry => entry.memberId === reviewerId);
  if (review?.verdict !== "approve" || !currentReviewBasis(review, item)) return false;
  const attestation = item.attestations.find(entry => entry.memberId === reviewerId);
  if (!attestation || attestation.at !== review.at) return false;
  const reviewers = reviewMembers instanceof Set ? reviewMembers : new Set(reviewMembers ?? []);
  if (!reviewers.has(reviewerId)) return false;
  if (effective === "distinct_member") return true;
  const verifiers = verifyMembers instanceof Set ? verifyMembers : new Set(verifyMembers ?? []);
  return verifiers.has(reviewerId);
}
// Hard work (Hard Problems board, muse-room 2026-10-06): items tagged hard or
// hard-problem are done in pairs. needs-me lists them first, and the create
// route defaults them to a distinct reviewer.
export const HARD_WORK_TAGS = Object.freeze(["hard", "hard-problem"]);
export function isHardWork(item) {
  return (item?.tags ?? []).some(tag => HARD_WORK_TAGS.includes(String(tag).toLowerCase()));
}
// Named reviewers (tag rev-<memberId>, the hard lane's convention) and
// whether a member's review still stands on the item's current basis (owner,
// claim, revision, CI head sha). A new head or a re-claim makes it stale.
export function namedReviewers(item) {
  return (item?.tags ?? []).filter(tag => typeof tag === "string" && tag.startsWith("rev-")).map(tag => tag.slice(4));
}
// Resolve rev-<x> tags to ACTIVE members of the room: x is a member id, or a
// handle slug (display name lowercased, letters and digits only, e.g.
// rev-codexqa for "Codex QA") that matches exactly one active member, for ids
// too long for a 32-character tag. Anything else is dropped, so a tag can
// never route a wake or an ask to an identity outside the room.
const handleSlug = name => String(name ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
export function resolveNamedReviewers(item, members = {}) {
  const active = Object.entries(members ?? {}).filter(([, member]) => member && member.active !== false);
  const ids = new Set();
  for (const value of namedReviewers(item)) {
    if (active.some(([id]) => id === value)) { ids.add(value); continue; }
    const slug = handleSlug(value);
    const matches = slug ? active.filter(([, member]) => handleSlug(member.displayName) === slug) : [];
    if (matches.length === 1) ids.add(matches[0][0]);
  }
  return [...ids];
}
export function hasCurrentReview(item, memberId) {
  return (item?.reviews ?? []).some(review => review?.memberId === memberId && currentReviewBasis(review, item));
}
// Query helpers over a list.
export function workOwnedBy(items, agentId) {
  check(Array.isArray(items), "items must be a list");
  const agent = agentOf(agentId);
  return items.map(workOf).filter(item => item.owner === agent && !isTerminalClaimState(item.state));
}
export function unclaimedWork(items) {
  check(Array.isArray(items), "items must be a list");
  return items.map(workOf).filter(item => item.state === "unclaimed");
}
// Provenance walk (orch-provenance-rollback): given a claim id, return every
// claim that builds on it directly or transitively through parentClaimId
// edges, breadth-first with depth. Cycle-safe (a visited set bounds the
// traversal) and capped at MAX_PROVENANCE_WALK nodes so a pathological graph
// cannot burn the room's event budget when the rollback path flags it.
export const MAX_PROVENANCE_WALK = 200;
export function walkProvenance(items, rootId) {
  check(Array.isArray(items), "items must be a list");
  check(typeof rootId === "string" && rootId.length > 0 && rootId.length <= 256, "rootId must be a claim id");
  const byId = new Map();
  for (const entry of items) {
    const item = workOf(entry);
    byId.set(item.id, item);
  }
  const root = byId.get(rootId);
  if (!root) fail("unknown_claim", `No work claim "${rootId}"`);
  const children = new Map();
  for (const item of byId.values()) {
    if (item.parentClaimId && byId.has(item.parentClaimId)) {
      const list = children.get(item.parentClaimId) ?? [];
      list.push(item.id);
      children.set(item.parentClaimId, list);
    }
  }
  const downstream = [];
  const visited = new Set([rootId]);
  const queue = [{ id: rootId, depth: 0 }];
  let truncated = false;
  while (queue.length > 0 && !truncated) {
    const { id, depth } = queue.shift();
    for (const childId of children.get(id) ?? []) {
      if (visited.has(childId)) continue;
      visited.add(childId);
      if (downstream.length >= MAX_PROVENANCE_WALK) { truncated = true; break; }
      const child = byId.get(childId);
      downstream.push(Object.freeze({ id: childId, depth: depth + 1,
        state: child.state, owner: child.owner, title: child.title }));
      queue.push({ id: childId, depth: depth + 1 });
    }
  }
  return Object.freeze({ root: rootId, rootState: root.state, rootOwner: root.owner, rootTitle: root.title,
    truncated, downstream: Object.freeze(downstream) });
}
// Declare a claim's premise invalid: stamp the premise flag without changing
// the work's state or outcome. Works on done claims too — the bad premise is
// usually a completed receipt. The route layer walks the provenance graph and
// flags every downstream claim the same way, then notifies in the room.
export function flagPremiseInvalid(work, { premiseId, reason, byMemberId, now } = {}) {
  const item = workOf(work), agent = agentOf(byMemberId), atMs = nowMsOf(now);
  const pid = idOf(premiseId, "premise id", 256);
  check(typeof reason === "string" && reason.length > 0 && reason.length <= 2000, "reason must be 1..2000 characters");
  const flag = Object.freeze({ premiseId: pid, reason, by: agent, at: isoOf(atMs) });
  return withHistory({ ...item, premiseFlag: flag }, atMs, agent, "premise_flagged",
    `Premise "${pid}" declared invalid: ${reason.slice(0, 200)}`);
}
// Clear a premise flag after re-review. The history keeps both stamps, so
// the flag-clear cycle stays auditable.
export function clearPremiseFlag(work, { byMemberId, note, now } = {}) {
  const item = workOf(work), agent = agentOf(byMemberId), atMs = nowMsOf(now);
  check(item.premiseFlag !== null, `work "${item.id}" carries no premise flag`);
  if (note !== undefined && note !== null) check(typeof note === "string" && note.length <= 2000, "note must be at most 2000 characters");
  const { premiseFlag: _dropped, ...rest } = item;
  return withHistory({ ...rest, premiseFlag: null }, atMs, agent, "premise_cleared", note ?? null);
}
export { ClaimError, STATES, TRANSITIONS, CLAIM_LIFECYCLE, CLAIM_VERBS, TERMINAL_CLAIM_STATES, isTerminalClaimState, nextClaimState, DELIVERY_MODES, REVIEW_POLICIES, REVIEW_VERDICTS, CLAIM_KINDS, CI_STATES, DEFAULT_LEASE_HOURS, MAX_LEASE_HOURS, ACTIVE_CLAIM_STATES };
