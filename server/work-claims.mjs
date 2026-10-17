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
// Delivered → verified (#3546/#3547): finish lands in `delivered`, a real
// state the work occupies with its delivery bundle recorded; only a verify
// transition moves it to `done`, and a reviewer's changes_requested sends it
// back to `in_progress`. Under `self_attested` a single done call collapses
// the two steps, but the item still records `verification` — self-attested
// and independently verified completions are distinguishable facts, never
// silently equivalent. The verify step runs the platform's own executed
// checks over the frozen bundle (bundle_integrity, criteria_coverage,
// ci_settlement) and records their results on the verification fact; a
// failing executed check blocks a non-self-attested verify. The delivery
// bundle is { artifact, checks, criteria } (see deliveryOf); it is required
// — artifact + at least one passing check + a full criteria mapping — when
// the item carries acceptanceCriteria or a non-self_attested review policy,
// and optional-but-recorded otherwise.
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
//
// Claim fencing (#3545): every claim round carries a monotonic
// claimGeneration (starts 0; bumped on claim, reassign, release and
// sweep-release). The write verbs accept expectedClaimGeneration — the
// generation the caller read — and refuse a mismatch with
// work_claim_conflict, so a holder from a stale round cannot land writes
// even when its identity matches the current holder (the same agent
// re-claiming is the case owner identity alone cannot discriminate). The
// machine also enforces the lease it issues: updateWork refuses non-release
// verbs on a lapsed lease with claim_lease_lapsed, instead of relying on
// the routes layer's per-request sweep to have run first.
import { createHash } from "node:crypto";
import { parsePullRequestUrl } from "./claim-coordination.mjs";
const STATES = ["unclaimed", "claimed", "in_progress", "blocked", "delivered", "done", "closed"];
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
  in_progress: Object.freeze({ block: "blocked", finish: "delivered", pause: "claimed", close: "closed", cancel: "closed" }),
  blocked: Object.freeze({ start: "in_progress", pause: "claimed", close: "closed", cancel: "closed" }),
  delivered: Object.freeze({ verify: "done", changes_requested: "in_progress", release: "unclaimed", close: "closed", cancel: "closed" }),
  done: Object.freeze({}),
  closed: Object.freeze({}),
});
const CLAIM_VERBS = Object.freeze(["claim", "start", "block", "release", "pause", "finish", "verify", "changes_requested", "close", "cancel"]);
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
  let ciStatus = null;
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
    if (value.ciStatus !== undefined && value.ciStatus !== null) {
      // The digest of a combined status fetched by a split CI read (#2841):
      // it rides with ciCursor "checks" so the resumed read can roll it up.
      // Without whitelisting it here, any state-machine write between the
      // two ticks would drop it and resurrect the split-read bug.
      check(value.ciStatus !== null && typeof value.ciStatus === "object" && !Array.isArray(value.ciStatus), "pullRequest ciStatus must be an object");
      check(value.ciStatus.state === undefined || value.ciStatus.state === null || (typeof value.ciStatus.state === "string" && value.ciStatus.state.length <= 64), "pullRequest ciStatus state must be a short string");
      check(typeof value.ciStatus.totalCount === "number" && Number.isFinite(value.ciStatus.totalCount) && value.ciStatus.totalCount >= 0, "pullRequest ciStatus totalCount must be a non-negative number");
      check(value.ciStatus.targetUrl === undefined || value.ciStatus.targetUrl === null || (typeof value.ciStatus.targetUrl === "string" && value.ciStatus.targetUrl.startsWith("https://") && value.ciStatus.targetUrl.length <= 2048), "pullRequest ciStatus targetUrl must be an https URL");
      ciStatus = Object.freeze({
        state: typeof value.ciStatus.state === "string" ? value.ciStatus.state : null,
        totalCount: value.ciStatus.totalCount,
        targetUrl: typeof value.ciStatus.targetUrl === "string" ? value.ciStatus.targetUrl : null
      });
    }
  }
  return Object.freeze({
    url: parsed.url, repo: parsed.repo, number: parsed.number, outcome, syncedAt, nextPollAt,
    etag, rateLimitedUntil, pollBackoffMs, ciCursor, ciStatus
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
// Acceptance criteria (#3547): the item-level criteria a delivery bundle
// maps against. Offers and bounties already carried criteria; work items
// gain the same field so a finish can be checked against stated criteria
// instead of a prose note.
const MAX_ACCEPTANCE_CRITERIA = 32;
const acceptanceCriteriaOf = value => {
  if (value === undefined || value === null) return Object.freeze([]);
  check(Array.isArray(value), "acceptanceCriteria must be an array");
  check(value.length <= MAX_ACCEPTANCE_CRITERIA, `acceptanceCriteria must hold at most ${MAX_ACCEPTANCE_CRITERIA} criteria`);
  return Object.freeze(value.map(criterion => {
    check(typeof criterion === "string" && criterion.length > 0 && criterion.length <= 500,
      "each acceptance criterion must be 1..500 characters");
    return criterion;
  }));
};
// The delivery bundle (#3547): what finish hands over — one artifact, the
// checks the deliverer ran (caller-reported results; the platform's own
// executed checks at verify time are a separate record), and a per-criterion
// mapping. The kernel freezes the bundle with the delivered state and stamps
// its digest; the digest covers exactly { artifact, checks, criteria }.
const DELIVERY_CHECK_RESULTS = ["pass", "fail", "error", "skipped"];
const DELIVERY_CRITERION_STATUSES = ["met", "not_met", "na"];
const MAX_DELIVERY_CHECKS = 50;
const MAX_DELIVERY_CRITERIA = 64;
const artifactShaOf = value => {
  const bare = typeof value === "string" && value.startsWith("sha256:") ? value.slice(7) : value;
  check(typeof bare === "string" && /^[0-9a-f]{64}$/.test(bare), "artifact sha256 must be 64 lowercase hex characters");
  return bare;
};
const deliveryOf = value => {
  if (value === undefined || value === null) return null;
  check(value !== null && typeof value === "object" && !Array.isArray(value), "delivery must be an object");
  let artifact = null;
  if (value.artifact !== undefined && value.artifact !== null) {
    check(typeof value.artifact === "object" && !Array.isArray(value.artifact), "delivery artifact must be an object");
    check(typeof value.artifact.kind === "string" && value.artifact.kind.length > 0 && value.artifact.kind.length <= 64,
      "delivery artifact kind must be 1..64 characters");
    check(typeof value.artifact.ref === "string" && value.artifact.ref.length > 0 && value.artifact.ref.length <= 512,
      "delivery artifact ref must be 1..512 characters");
    artifact = Object.freeze({ kind: value.artifact.kind, ref: value.artifact.ref, sha256: artifactShaOf(value.artifact.sha256) });
  }
  const checks = value.checks === undefined || value.checks === null ? [] : value.checks;
  check(Array.isArray(checks) && checks.length <= MAX_DELIVERY_CHECKS, `delivery checks must hold at most ${MAX_DELIVERY_CHECKS} entries`);
  const checkRows = checks.map(entry => {
    check(entry !== null && typeof entry === "object" && !Array.isArray(entry), "each delivery check must be an object");
    check(typeof entry.name === "string" && entry.name.length > 0 && entry.name.length <= 200,
      "each delivery check name must be 1..200 characters");
    check(DELIVERY_CHECK_RESULTS.includes(entry.result), `each delivery check result must be one of ${DELIVERY_CHECK_RESULTS.join(", ")}`);
    if (entry.command !== undefined && entry.command !== null)
      check(typeof entry.command === "string" && entry.command.length <= 500, "delivery check command must be at most 500 characters");
    return Object.freeze({ name: entry.name, result: entry.result, ...(entry.command != null ? { command: entry.command } : {}) });
  });
  const criteria = value.criteria === undefined || value.criteria === null ? [] : value.criteria;
  check(Array.isArray(criteria) && criteria.length <= MAX_DELIVERY_CRITERIA, `delivery criteria must hold at most ${MAX_DELIVERY_CRITERIA} entries`);
  const seenCriteria = new Set();
  const criteriaRows = criteria.map(entry => {
    check(entry !== null && typeof entry === "object" && !Array.isArray(entry), "each delivery criterion must be an object");
    check(typeof entry.criterion === "string" && entry.criterion.length > 0 && entry.criterion.length <= 500,
      "each delivery criterion must be 1..500 characters");
    check(!seenCriteria.has(entry.criterion), `delivery criteria maps criterion "${entry.criterion}" twice`);
    seenCriteria.add(entry.criterion);
    check(DELIVERY_CRITERION_STATUSES.includes(entry.status), `each delivery criterion status must be one of ${DELIVERY_CRITERION_STATUSES.join(", ")}`);
    let evidenceRef;
    if (entry.evidenceRef !== undefined && entry.evidenceRef !== null) evidenceRef = evidenceRefsOf([entry.evidenceRef])[0];
    return Object.freeze({ criterion: entry.criterion, status: entry.status, ...(evidenceRef !== undefined ? { evidenceRef } : {}) });
  });
  return Object.freeze({ artifact, checks: Object.freeze(checkRows), criteria: Object.freeze(criteriaRows) });
};
// The verification fact (#3546): written only by the verify step (or the
// self-attested collapse, or a changes_requested send-back). executedChecks
// are the platform's own results, recorded beside — never merged with — the
// bundle's caller-reported checks.
const VERIFICATION_STATES = ["self_attested", "verified", "changes_requested"];
const EXECUTED_CHECK_RESULTS = ["pass", "fail", "skipped"];
const executedChecksOf = value => {
  if (value === undefined || value === null) return Object.freeze([]);
  check(Array.isArray(value) && value.length <= 16, "executedChecks must hold at most 16 entries");
  return Object.freeze(value.map(entry => {
    check(entry !== null && typeof entry === "object" && !Array.isArray(entry), "each executed check must be an object");
    check(typeof entry.name === "string" && entry.name.length > 0 && entry.name.length <= 100,
      "each executed check name must be 1..100 characters");
    check(EXECUTED_CHECK_RESULTS.includes(entry.result), `each executed check result must be one of ${EXECUTED_CHECK_RESULTS.join(", ")}`);
    if (entry.detail !== undefined && entry.detail !== null)
      check(typeof entry.detail === "string" && entry.detail.length <= 500, "executed check detail must be at most 500 characters");
    return Object.freeze({ name: entry.name, result: entry.result, ...(entry.detail != null ? { detail: entry.detail } : {}) });
  }));
};
const verificationOf = value => {
  if (value === undefined || value === null) return null;
  check(value !== null && typeof value === "object" && !Array.isArray(value), "verification must be an object");
  check(VERIFICATION_STATES.includes(value.state), `verification state must be one of ${VERIFICATION_STATES.join(", ")}`);
  if (value.by !== undefined && value.by !== null)
    check(typeof value.by === "string" && value.by.length > 0 && value.by.length <= 128, "verification by must be 1..128 characters");
  check(typeof value.at === "string" && Number.isFinite(Date.parse(value.at)), "verification at must be an ISO timestamp");
  const basis = reviewBasisOf(value.basis);
  let jev;
  if (value.jev !== undefined && value.jev !== null) {
    check(typeof value.jev === "object" && !Array.isArray(value.jev), "verification jev must be an object");
    check(typeof value.jev.verdict === "string" && value.jev.verdict.length > 0 && value.jev.verdict.length <= 64,
      "verification jev verdict must be 1..64 characters");
    check(typeof value.jev.score === "number" && Number.isFinite(value.jev.score), "verification jev score must be a number");
    jev = Object.freeze({ verdict: value.jev.verdict, score: value.jev.score });
  }
  return Object.freeze({ state: value.state, by: value.by ?? null, at: value.at, basis,
    executedChecks: executedChecksOf(value.executedChecks), ...(jev ? { jev } : {}) });
};
// A delivery as stored on the item: the validated bundle plus the stamp the
// finish transition froze onto it (digest + who delivered + when).
const storedDeliveryOf = value => {
  if (value === undefined || value === null) return null;
  const bundle = deliveryOf(value);
  check(bundle !== null, "delivery must be an object");
  check(typeof value.digest === "string" && /^[0-9a-f]{64}$/.test(value.digest), "delivery digest must be 64 lowercase hex characters");
  check(typeof value.deliveredBy === "string" && value.deliveredBy.length > 0 && value.deliveredBy.length <= 128,
    "delivery deliveredBy must be 1..128 characters");
  check(typeof value.deliveredAt === "string" && Number.isFinite(Date.parse(value.deliveredAt)),
    "delivery deliveredAt must be an ISO timestamp");
  return Object.freeze({ ...bundle, digest: value.digest, deliveredBy: value.deliveredBy, deliveredAt: value.deliveredAt });
};
const DEFAULT_LEASE_HOURS = 24;
const MAX_LEASE_HOURS = 168;
// Board cleanup 2026-10-09: 200 jammed muse-room with an idle backlog while
// only ~13 claims were live. The room cap now counts live items only (see
// countsTowardOpenCap) and defaults to 1000; the per-member cap still bounds
// what any one member can hold.
export const DEFAULT_MAX_OPEN_CLAIMS = 1000;
export const DEFAULT_MAX_MEMBER_OPEN_CLAIMS = 20;
const CONFIG_CAP_CEILING = 10000;
const DEFAULT_REVIEW_POLICY = "self_attested";
const ACTIVE_CLAIM_STATES = ["claimed", "in_progress", "blocked"];
// States a reviewer may record a review or attestation against: the active
// states (reviewing work in flight) plus delivered (reviewing the delivery
// itself — the record the verify transition gates on). Delivered work is
// deliberately NOT an active claim state: its lease no longer lapses and
// the stale sweep never releases a delivery awaiting verification.
const REVIEWABLE_CLAIM_STATES = Object.freeze([...ACTIVE_CLAIM_STATES, "delivered"]);
// An unclaimed item nobody has touched for STALE_UNCLAIMED_DAYS is dormant.
// Dormant items do not count against the room's open-claim cap. When the room
// owner turns on workClaims.staleSweep (off by default), the cron's stale
// sweep (server/claim-pr-sync.mjs) also retires them, at most
// STALE_SWEEP_BATCH per room per pass, as closed with reason stale_sweep.
// Items with no readable timestamp are never dormant: unknown age counts.
export const STALE_UNCLAIMED_DAYS = 14;
export const STALE_SWEEP_BATCH = 25;
export const STALE_SWEEP_REASON = `stale_sweep: unclaimed with no activity for ${STALE_UNCLAIMED_DAYS} days. Open a new claim if the work is still wanted.`;
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
  // #3685: the settlement is bound to the delivery it was made against —
  // the digest of the delivery current when recordCi stamped it, or null
  // when the round had no delivery yet. Records predating the binding
  // carry no stamp and read as null (settled within the round).
  check(value.deliveryDigest == null || (typeof value.deliveryDigest === "string" && /^[0-9a-f]{64}$/.test(value.deliveryDigest)), "ci.deliveryDigest must be a 64-character delivery digest or null");
  check(typeof value.checkedAt === "string" && Number.isFinite(Date.parse(value.checkedAt)), "ci.checkedAt must be an ISO timestamp");
  return Object.freeze({
    state: value.state,
    url: value.url ?? null,
    headSha: value.headSha ?? null,
    deliveryDigest: value.deliveryDigest ?? null,
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
  // #3684: the basis also binds the delivery the review was recorded
  // against — its digest, and the claim's delivery generation at record
  // time (0 before any delivery exists). Bases written before the
  // binding carry neither and normalize to null/0, i.e. they read as
  // in-flight approvals (see currentReviewBasis for what those cover).
  check(value.deliveryDigest === undefined || value.deliveryDigest === null
    || typeof value.deliveryDigest === "string" && /^[0-9a-f]{64}$/.test(value.deliveryDigest), "review basis deliveryDigest must be a delivery digest or null");
  check(value.deliveryGeneration === undefined || value.deliveryGeneration === null
    || Number.isSafeInteger(value.deliveryGeneration) && value.deliveryGeneration >= 0, "review basis deliveryGeneration must be a non-negative integer");
  return Object.freeze({ version: 1, owner: value.owner, claimedAt: value.claimedAt, revision: value.revision, headSha: value.headSha,
    deliveryDigest: value.deliveryDigest ?? null, deliveryGeneration: value.deliveryGeneration ?? 0 });
};
const reviewBasisFor = item => Object.freeze({ version: 1, owner: item.owner, claimedAt: item.claimedAt,
  revision: item.revision ?? null, headSha: item.ci?.headSha ?? null,
  deliveryDigest: item.delivery?.digest ?? null, deliveryGeneration: item.deliveryGeneration ?? 0 });
const sameBasis = (left, right) => Boolean(left && right) && Object.keys(right).every(key => left[key] === right[key]);
const currentReviewBasis = (review, item) => {
  const basis = review?.basis, current = reviewBasisFor(item);
  if (!basis) return false;
  // #3684 delivery binding: an approval recorded while a delivery
  // existed counts only for that delivery's digest — a re-delivery
  // stales it exactly like a CI head move. An approval recorded before
  // any delivery (generation 0) attests the work in flight and counts
  // only for the round's FIRST delivery (generation 1); a replacement
  // delivery is outside what it attested and stales it too.
  const deliveryCurrent = basis.deliveryDigest !== null && basis.deliveryDigest !== undefined
    ? basis.deliveryDigest === current.deliveryDigest
    : (basis.deliveryGeneration ?? 0) === 0 && current.deliveryGeneration <= 1;
  return deliveryCurrent
    && ["version", "owner", "claimedAt", "revision", "headSha"].every(key => basis[key] === current[key]);
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
// PRODUCT-200 A4 (QA-200 AQ-HI-06): opt-in idempotency keys for updates. A
// requestId that already landed on the claim replays the stored outcome
// instead of appending another history entry — retry must not duplicate.
// The map rides on the work item so it survives the durable registry
// round-trip (restart/deploy); it is capped at MAX_REQUEST_OUTCOMES
// entries, oldest first.
//
// #2965: each record also binds the requestId to a digest of the update
// payload it carried. A retry re-sends the identical payload, so a seen
// requestId whose digest differs is not a retry — it is a new update
// riding an old id, and it is refused (work_claim_conflict) instead of
// being silently swallowed behind a success response. Records written
// before the binding existed are bare timestamp strings; their payload is
// unknowable, so they keep replaying, but every new record is bound.
export const MAX_REQUEST_OUTCOMES = 256;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
export const requestIdOf = value => {
  check(typeof value === "string" && REQUEST_ID_PATTERN.test(value),
    "requestId must be 1..128 characters [A-Za-z0-9_-]");
  return value;
};
// Canonical serialization for the payload digest: object keys sorted and
// undefined spelled out, so two sends of the same update digest alike
// regardless of key order, while absent and null stay distinct (they mean
// different things to updateWork for several fields).
const canonicalPayload = value => {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(canonicalPayload).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalPayload(value[key])}`).join(",")}}`;
};
// The digest binding a requestId to the update it carried: every field
// updateWork can apply, and nothing else (now/requestId itself excluded —
// a retry is stamped later and re-uses the id by definition).
export const updateRequestDigest = ({ state, note, deliveryMode, reviewedBy, tags, blobs, parentClaimId, evidenceRefs, delivery } = {}) =>
  createHash("sha256").update(canonicalPayload({ state, note, deliveryMode, reviewedBy, tags, blobs, parentClaimId, evidenceRefs, delivery }), "utf8").digest("hex");
// The bundle digest frozen at finish: sha256 over exactly the bundle's
// content fields, so the verify step can prove the bundle it checks is the
// bundle that was delivered (any later mutation of the stored row fails
// bundle_integrity instead of silently passing).
export const deliveryDigest = bundle => createHash("sha256").update(canonicalPayload({
  artifact: bundle?.artifact ?? null,
  checks: bundle?.checks ?? [],
  criteria: bundle?.criteria ?? [],
}), "utf8").digest("hex");
// An na criterion's evidenceRef counts as evidence only when it resolves
// to the delivery itself: the ref must name the bundle's own artifact
// (sha256:<artifact digest> — the one ref form the bundle codec admits
// that the platform can resolve against the frozen bundle). A ref to a
// blob that is not this delivery is a caller assertion, not evidence
// (#3683).
const naEvidenceResolves = (delivery, evidenceRef) => {
  if (typeof evidenceRef !== "string" || evidenceRef.length === 0) return false;
  const artifact = delivery?.artifact ?? null;
  return artifact !== null && evidenceRef === `sha256:${artifact.sha256}`;
};
// The platform's own executed checks over a delivered item (#3547: a
// checker re-runs rather than re-reads). Pure over the item: the bundle's
// stored digest is recomputed, the criteria mapping is re-validated against
// the item's criteria, and the platform-settled CI record (written by the
// claim-pr poller from the forge, never by the deliverer) is read back.
// Caller-reported check results are never consulted here.
export function executeDeliveryChecks(item) {
  const results = [];
  const delivery = item?.delivery ?? null;
  if (delivery) {
    const recomputed = deliveryDigest(delivery);
    results.push(Object.freeze({ name: "bundle_integrity",
      result: recomputed === delivery.digest ? "pass" : "fail",
      detail: recomputed === delivery.digest
        ? "stored bundle matches the digest frozen at finish"
        : "stored bundle no longer matches the digest frozen at finish" }));
    const criteria = item?.acceptanceCriteria ?? [];
    if (criteria.length > 0) {
      const mapped = new Map((delivery.criteria ?? []).map(entry => [entry.criterion, entry]));
      const missing = criteria.filter(criterion => !mapped.has(criterion));
      // #3683: coverage reads the mapping's own statuses, not just its
      // names. A criterion the delivery itself declares not_met fails the
      // check, and an na counts only with an evidenceRef that resolves to
      // the delivered artifact itself (naEvidenceResolves).
      const notMet = criteria.filter(criterion => mapped.get(criterion)?.status === "not_met");
      const unbackedNa = criteria.filter(criterion => {
        const entry = mapped.get(criterion);
        return entry?.status === "na" && !naEvidenceResolves(delivery, entry.evidenceRef);
      });
      const problems = [
        ...(missing.length > 0 ? [`criteria with no mapping: ${missing.join("; ")}`] : []),
        ...(notMet.length > 0 ? [`criteria the delivery declares not_met: ${notMet.join("; ")}`] : []),
        ...(unbackedNa.length > 0 ? [`criteria declared na without evidence resolving to the delivered artifact: ${unbackedNa.join("; ")}`] : []),
      ];
      results.push(Object.freeze({ name: "criteria_coverage",
        result: problems.length > 0 ? "fail" : "pass",
        detail: problems.length > 0 ? problems.join("; ") : `all ${criteria.length} criteria mapped and met` }));
    }
  }
  const ci = item?.ci ?? null;
  if (ci && (ci.state === "success" || ci.state === "failure")) {
    // #3685: a settlement counts only for the delivery round it was made
    // in. recordCi stamps the digest of the delivery current at settle
    // time (null when the round had no delivery yet); a stamp naming a
    // different delivery is stale evidence and fails closed — the poller
    // re-settles against the current delivery. (Re-delivery, release and
    // re-claim also clear the record outright; this is the second lock.)
    const bound = ci.deliveryDigest == null || (delivery !== null && ci.deliveryDigest === delivery.digest);
    results.push(Object.freeze({ name: "ci_settlement",
      result: bound && ci.state === "success" ? "pass" : "fail",
      detail: bound
        ? `platform-settled CI is ${ci.state}${ci.headSha ? ` at ${ci.headSha}` : ""}`
        : `platform-settled CI is ${ci.state}${ci.headSha ? ` at ${ci.headSha}` : ""} but was settled against a different delivery — fresh settlement required` }));
  }
  return Object.freeze(results);
}
// The finish-time bundle contract (#3547): when a bundle is required
// (criteria-bearing item or non-self-attested policy) it must carry an
// artifact, at least one check, no failing checks, and — when the item
// carries criteria — a mapping covering every criterion. Each refusal names
// the missing part. When a bundle is supplied voluntarily the same shape
// rules apply to what was supplied.
const requireBundleComplete = (item, bundle, { required }) => {
  if (!bundle) {
    if (required) fail("delivery_incomplete",
      `finishing "${item.id}" requires a delivery bundle { artifact, checks, criteria } — none was supplied`);
    return;
  }
  if (required && !bundle.artifact) fail("delivery_incomplete",
    `delivery bundle for "${item.id}" is missing its artifact — an artifact { kind, ref, sha256 } is required`);
  if (required && bundle.checks.length === 0) fail("delivery_incomplete",
    `delivery bundle for "${item.id}" is missing checks — at least one check with a result is required`);
  const failing = bundle.checks.find(entry => entry.result === "fail" || entry.result === "error");
  if (failing) fail("delivery_incomplete",
    `delivery bundle for "${item.id}" reports a failing check "${failing.name}" — a delivery cannot carry a failed check into verification`);
  const criteria = item.acceptanceCriteria ?? [];
  if (criteria.length > 0) {
    const mapped = new Set(bundle.criteria.map(entry => entry.criterion));
    const missing = criteria.find(criterion => !mapped.has(criterion));
    if (missing !== undefined) fail("delivery_incomplete",
      `delivery bundle for "${item.id}" does not map criterion "${missing}" — the criteria mapping must cover every acceptance criterion`);
  }
};
// How a stored replay record answers a new update under the same
// requestId: "replay" when the record binds this payload (or predates the
// binding), "conflict" when it binds a different payload, null when the
// requestId has not landed on this claim.
export const requestReplayVerdict = (outcomes, requestId, digest) => {
  if (!outcomes || !Object.hasOwn(outcomes, requestId)) return null;
  const record = outcomes[requestId];
  if (typeof record === "string") return "replay";
  return record.digest === digest ? "replay" : "conflict";
};
const requestOutcomeRecordOf = record => {
  // Legacy records are bare ISO timestamps; bound records are { at, digest }.
  if (typeof record === "string") return Number.isFinite(Date.parse(record)) ? record : undefined;
  if (record === null || typeof record !== "object" || Array.isArray(record)) return undefined;
  if (typeof record.at !== "string" || !Number.isFinite(Date.parse(record.at))) return undefined;
  if (typeof record.digest !== "string" || !/^[0-9a-f]{64}$/.test(record.digest)) return undefined;
  return Object.freeze({ at: record.at, digest: record.digest });
};
const requestOutcomesOf = value => {
  if (value === undefined || value === null) return null;
  check(typeof value === "object" && !Array.isArray(value), "requestOutcomes must be an object");
  const kept = Object.entries(value)
    .map(([key, record]) => [key, requestOutcomeRecordOf(record)])
    .filter(([key, record]) => REQUEST_ID_PATTERN.test(key) && record !== undefined);
  // String-key insertion order is oldest-first: drop the oldest beyond the cap.
  return Object.freeze(Object.fromEntries(kept.slice(Math.max(0, kept.length - MAX_REQUEST_OUTCOMES))));
};
const recordRequestOutcome = (current, key, at, digest) => requestOutcomesOf({ ...(current ?? {}), [key]: { at, digest } });
// Exported so writer paths that build claim rows outside the state machine
// (the work-item-board backfill, #3465) validate a row BEFORE storing it:
// the durable registry's codec decodes without validation, so a row stored
// unvalidated is readable but throws on its first state-machine touch.
export const workOf = value => {
  check(value !== null && typeof value === "object" && !Array.isArray(value), "work must be an object");
  check(typeof value.id === "string" && value.id.length > 0 && value.id.length <= 256, "work id must be 1..256 characters");
  check(value.state === undefined || STATES.includes(value.state), `state must be one of ${STATES.join(", ")}`);
  if (value.claimGeneration !== undefined && value.claimGeneration !== null) check(Number.isSafeInteger(value.claimGeneration) && value.claimGeneration >= 0, "claimGeneration must be a non-negative integer");
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
  const acceptanceCriteria = acceptanceCriteriaOf(value.acceptanceCriteria);
  const delivery = storedDeliveryOf(value.delivery);
  const verification = verificationOf(value.verification);
  const listedPulls = Array.isArray(value.pullRequests) && value.pullRequests.length
    ? pullRequestsOf(value.pullRequests)
    : (value.pullRequest ? Object.freeze([pullRequestOf(value.pullRequest)]) : Object.freeze([]));
  const pullRequest = listedPulls.find(pull => !pull.outcome) ?? listedPulls[listedPulls.length - 1] ?? null;
  const kind = kindOf(value.kind);
  const revision = revisionOf(value.revision);
  if (kind === "deploy") check(revision, "a deploy claim needs a revision");
  const historyOmitted = historyOmittedOf(value.historyOmitted);
  const readingAcks = readingAcksOf(value.readingAcks);
  const requestOutcomes = requestOutcomesOf(value.requestOutcomes);
  return { id: value.id, title: value.title ?? value.id, state: value.state ?? "unclaimed",
    owner: value.owner ?? null, history: Array.isArray(value.history) ? value.history : [],
    readingAcks,
    ...(requestOutcomes !== null ? { requestOutcomes } : {}),
    ...(historyOmitted > 0 ? { historyOmitted } : {}),
    claimGeneration: claimGenerationOf(value),
    claimedAt: value.claimedAt ?? null, leaseStartAt: value.leaseStartAt ?? null, leaseExpiresAt: value.leaseExpiresAt ?? null,
    deliveryMode: value.deliveryMode ?? null, reviewPolicy: value.reviewPolicy ?? null,
    reviewedBy: value.reviewedBy ?? null, attestations: Object.freeze(attestations),
    tags, files, fileBlocks, blobs, dependsOn, pullRequest, pullRequests: listedPulls,
    parentClaimId, evidenceRefs, premiseFlag,
    acceptanceCriteria, delivery, verification,
    // #3684: how many deliveries this claim round has frozen (0 = none
    // yet). In-flight approvals (basis generation 0) cover only the
    // round's first delivery; the counter is what makes "first" a fact
    // the kernel can check rather than a narrative.
    deliveryGeneration: Number.isSafeInteger(value.deliveryGeneration) && value.deliveryGeneration > 0 ? value.deliveryGeneration : 0,
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
// The claim-round fencing token (#3545). Rows written before fencing carry
// no generation and read as round 0.
export const claimGenerationOf = value =>
  (Number.isSafeInteger(value?.claimGeneration) && value.claimGeneration >= 0 ? value.claimGeneration : 0);
// Fencing check shared by the write verbs: when the caller presents the
// generation it read, it must still be the current round. A mismatch is the
// same work_claim_conflict the claimedAt+historyLength binding raises.
// Absent (undefined) keeps the pre-fencing call contract unchanged.
const checkClaimGeneration = (item, expectedClaimGeneration) => {
  if (expectedClaimGeneration === undefined) return;
  check(Number.isSafeInteger(expectedClaimGeneration) && expectedClaimGeneration >= 0,
    "expectedClaimGeneration must be a non-negative integer");
  if (claimGenerationOf(item) !== expectedClaimGeneration) {
    fail("work_claim_conflict", "The claim changed since it was read — stale claim generation");
  }
};
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
export function isDormantClaim(item, now) {
  if (!item || item.state !== "unclaimed") return false;
  const at = Date.parse(claimUpdatedAt(item));
  if (!Number.isFinite(at)) return false;
  return nowMsOf(now) - at >= STALE_UNCLAIMED_DAYS * 24 * 3600 * 1000;
}
// What the room's open-claim cap counts: non-terminal, non-dormant items.
export function countsTowardOpenCap(item, now) {
  return !!item && !isTerminalClaimState(item.state) && !isDormantClaim(item, now);
}
export function openClaimCount(items, now) {
  let open = 0;
  for (const item of items ?? []) if (countsTowardOpenCap(item, now)) open += 1;
  return open;
}
// Retire dormant unclaimed items, oldest first, at most `limit`. Pure: returns
// [before, closed] pairs; the caller writes them and emits the events.
// Never-sweep pin (follow-up to #2341): a room can keep deliberate standing
// backlog by tagging the item "never-sweep" at create. A pinned item still
// goes dormant (so it never jams the open-claim cap) but the stale sweep
// leaves it open.
export const NEVER_SWEEP_TAG = "never-sweep";
export function isSweepPinned(item) {
  return (item?.tags ?? []).some(tag => typeof tag === "string" && tag.toLowerCase() === NEVER_SWEEP_TAG);
}
export function closeStaleUnclaimed(items, now, { limit = STALE_SWEEP_BATCH } = {}) {
  const atMs = nowMsOf(now);
  return (items ?? [])
    .filter(item => isDormantClaim(item, atMs) && !isSweepPinned(item))
    .sort((a, b) => claimUpdatedAt(a).localeCompare(claimUpdatedAt(b)))
    .slice(0, Math.max(0, limit))
    .map(before => [before, closeWork(before, "system", { verb: "close", reason: STALE_SWEEP_REASON, now: atMs, authority: true })]);
}
const positiveCap = (value, fallback) =>
  Number.isSafeInteger(value) && value >= 1 && value <= CONFIG_CAP_CEILING ? value : fallback;
// Room config hook: resolve per-room work-claim defaults from an optional
// room object. Rooms opt in by carrying workClaims = { defaultLeaseHours,
// reviewPolicy, maxOpenClaims, maxMemberOpenClaims, staleSweep }; anything
// missing or invalid falls back to the defaults (staleSweep: off).
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
    staleSweep: raw.staleSweep === true,
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
export function createWork({ id, title, reviewPolicy, note, tags, files, dependsOn, parentClaimId, evidenceRefs, pullRequest, pullRequests, repo, branch, fileBlocks, workItemId, kind, revision, squadId, acceptanceCriteria } = {}, { now, agentId } = {}) {
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
    claimGeneration: 0,
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
    acceptanceCriteria: acceptanceCriteriaOf(acceptanceCriteria),
    delivery: null,
    verification: null,
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
  // H4 (QA-200 2026-10-08): distinguish self re-claim from a foreign holder in
  // the message — "release it first" was destructive for the holder and
  // unactionable for anyone else, and it never named the holder. The code
  // stays invalid_claim_input (internal callers pin it).
  check(item.state === "unclaimed", item.state !== "claimed"
    ? `work "${item.id}" is already ${item.state}`
    : item.owner === agent
      ? `work "${item.id}" is already claimed by you — no new claim was saved; read the item to confirm`
      : `work "${item.id}" is held by ${item.owner ?? "someone else"} — ask them to reassign or release it`);
  // QA D-1: the 4000-char bound applies to every note stored on a history
  // stamp, not just create — an unbounded claim note is the same
  // storage/amplification vector the SEC2 create cap closed.
  if (note !== undefined && note !== null) check(typeof note === "string" && note.length <= 4000, "note must be a string of at most 4000 characters");
  const wanted = leaseHoursOf(leaseHours);
  const effective = wanted === null ? null : wanted ?? roomWorkClaimConfig(room).defaultLeaseHours;
  const declared = files === undefined || files === null ? null : claimedFilesOf(files);
  const links = pullRequest === undefined && pullRequests === undefined ? null : pullList(pullRequest, pullRequests);
  const claimed = { ...item, state: "claimed", owner: agent, claimedAt: isoOf(atMs),
    claimGeneration: item.claimGeneration + 1, // a claim opens a new round (#3545)
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
    // #3685: a fresh claim opens a fresh delivery round — no CI
    // settlement from a previous round may be cited for this one, and
    // the delivery generation restarts with the round (#3684).
    // The round's delivery and verification fact restart too: every
    // release path clears them when a round ends, and the claim refuses
    // to inherit any residue that reached the pool anyway (bug sweep
    // 2026-10-16 F1 — the lease sweep once leaked exactly this).
    ci: null, deliveryGeneration: 0, delivery: null, verification: null,
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
export function appendWorkPullRequest(work, agentId, { pullRequest, expectedClaimedAt, expectedHistoryLength, expectedClaimGeneration, now } = {}) {
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
  checkClaimGeneration(item, expectedClaimGeneration);
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
// Update claimed work: move state or add a note. Only the owner may update
// (authority callers — the verify step by a reviewer — are the exception).
// The finish transition (in_progress -> delivered) accepts deliveryMode,
// tags, blobs and the delivery bundle — recorded on the item and frozen
// with the delivered state. The verify transition (delivered -> done)
// accepts reviewedBy and records the verification fact. A done call on
// in_progress work under self_attested collapses finish+verify into one
// step; under a reviewed policy it is refused (work_not_delivered) — the
// work must occupy delivered and be verified by its reviewer.
export function updateWork(work, agentId, { state, note, deliveryMode, reviewedBy, tags, blobs, parentClaimId, evidenceRefs, delivery, policy, jev, requestId, expectedClaimGeneration, now, authority = false, pauseForRelease = false } = {}) {
  const item = workOf(work), agent = agentOf(agentId), atMs = nowMsOf(now);
  // PRODUCT-200 A4 (QA-200 AQ-HI-06): idempotent retry. A requestId that
  // already landed on this claim replays the stored outcome — the update
  // applied exactly once, so the identical retry appends nothing.
  // #2965: the replay is bound to the payload digest — a seen requestId
  // carrying a different update is refused, never silently swallowed.
  const key = requestId === undefined ? undefined : requestIdOf(requestId);
  const digest = key === undefined ? undefined
    : updateRequestDigest({ state, note, deliveryMode, reviewedBy, tags, blobs, parentClaimId, evidenceRefs, delivery });
  if (key !== undefined) {
    const verdict = requestReplayVerdict(item.requestOutcomes, key, digest);
    if (verdict === "replay") return item;
    if (verdict === "conflict") fail("work_claim_conflict",
      `requestId "${key}" already landed on work "${item.id}" with a different update — a reused requestId cannot carry a new payload`);
  }
  check(authority === true || item.owner === agent, `work "${item.id}" is owned by ${item.owner ?? "nobody"} — only the owner can update it`);
  check(!isTerminalClaimState(item.state), `work "${item.id}" is ${item.state} and immutable`);
  // The effective review policy for this transition: the caller (route)
  // resolves the room default and passes it in; the item's own policy is
  // what the digest of record says when no override is supplied.
  if (policy !== undefined && policy !== null) check(REVIEW_POLICIES.includes(policy), `policy must be one of ${REVIEW_POLICIES.join(", ")}`);
  const effectivePolicy = policy ?? item.reviewPolicy ?? DEFAULT_REVIEW_POLICY;
  const collapse = state === "done" && item.state === "in_progress";
  if (collapse && effectivePolicy !== "self_attested") {
    fail("work_not_delivered",
      `work "${item.id}" is under review policy "${effectivePolicy}" — finish it to "delivered" first; its reviewer then verifies it to "done"`);
  }
  if (state !== undefined) {
    check(STATES.includes(state), `state must be one of ${STATES.join(", ")}`);
    const allowed = TRANSITIONS[item.state] ?? [];
    const allowedLabel = next => next === "unclaimed" ? "released" : next;
    check(allowed.includes(state) || collapse,
      `cannot move "${item.id}" from ${item.state} to ${state} — allowed: ${item.state} -> ${allowed.map(allowedLabel).join("|") || "none"}`);
  }
  const finishing = state === "delivered" || collapse;
  if (deliveryMode !== undefined && deliveryMode !== null) {
    check(finishing || state === "done", "deliveryMode is only recorded on the finish/verify transitions");
    check(DELIVERY_MODES.includes(deliveryMode), `deliveryMode must be one of ${DELIVERY_MODES.join(", ")}`);
  }
  if (reviewedBy !== undefined && reviewedBy !== null) {
    check(state === "done", "reviewedBy is only recorded on the done transition");
    agentOf(reviewedBy);
  }
  if (tags !== undefined && tags !== null) {
    check(finishing || state === "done", "tags are only recorded on the finish/verify transitions");
    tagsOf(tags);
  }
  if (blobs !== undefined && blobs !== null) {
    check(finishing || state === "done", "blobs are only recorded on the finish/verify transitions");
    blobsOf(blobs);
  }
  if (delivery !== undefined && delivery !== null) {
    check(finishing, "a delivery bundle is only recorded on the finish transition");
    deliveryOf(delivery);
  }
  let jevRecord;
  if (jev !== undefined && jev !== null) {
    check(state === "done", "jev is only recorded on the verify transition");
    check(typeof jev === "object" && !Array.isArray(jev)
      && typeof jev.verdict === "string" && jev.verdict.length > 0 && jev.verdict.length <= 64
      && typeof jev.score === "number" && Number.isFinite(jev.score), "jev must be { verdict, score }");
    jevRecord = Object.freeze({ verdict: jev.verdict, score: jev.score });
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
  // #3545 fencing, checked after every field validation above (invalid
  // input keeps its precedence — invariant failed-updatework-no-mutation)
  // and after the requestId replay, so an already-landed update's retry
  // still replays: a caller presenting the generation it read must still
  // be in that round — owner identity alone cannot tell a stale round
  // from the current one when the same agent re-claimed.
  checkClaimGeneration(item, expectedClaimGeneration);
  // #3545 lease enforcement: the machine refuses non-release verbs on a
  // lapsed lease itself, not only when a sweep happened to run first.
  // Release (state -> unclaimed) stays allowed — it is how a lapsed claim
  // is given up — and releaseWork's internal pause step (pauseForRelease,
  // never set by route layers) precedes exactly such a release.
  if (state !== "unclaimed" && pauseForRelease !== true && isLeaseExpired(item, atMs)) {
    fail("claim_lease_lapsed", "The current claim lease has lapsed — claim it again instead");
  }
  // Finish step: validate the bundle against the item's contract and freeze
  // it (with its digest) onto the item. A fresh delivery clears any earlier
  // verification fact — the new bundle awaits a new verdict.
  let deliveredItem = item;
  if (finishing) {
    const bundle = delivery === undefined ? item.delivery : deliveryOf(delivery);
    requireBundleComplete(item, bundle, {
      required: (item.acceptanceCriteria?.length ?? 0) > 0 || effectivePolicy !== "self_attested",
    });
    deliveredItem = bundle
      ? { ...item, delivery: Object.freeze({ ...bundle, digest: deliveryDigest(bundle), deliveredBy: agent, deliveredAt: isoOf(atMs) }),
        // #3684: every frozen delivery advances the round's generation —
        // approvals bound to an earlier generation's delivery go stale.
        deliveryGeneration: (item.deliveryGeneration ?? 0) + 1 }
      : { ...item, delivery: null };
  }
  // #3685: a finish that REPLACES an existing delivery opens a new
  // delivery round — the previous round's CI settlement is invalidated
  // with the old delivery, and fresh evidence must settle against the
  // new one. A round's first finish keeps the settlement the round
  // already earned. (Review approvals stale on their own: the basis
  // binds the delivery digest — #3684.)
  const replacesDelivery = finishing && item.delivery != null;
  if (replacesDelivery) deliveredItem = { ...deliveredItem, ci: null };
  // Verify step: the platform's executed checks run over the delivered
  // bundle. A failing executed check blocks a reviewed verify outright; on
  // a self-attested collapse the results are recorded on the verification
  // fact instead (visible, never hidden, but the owner's call stands).
  let verification = item.verification;
  if (state === "done") {
    // Defense in depth (bug sweep 2026-10-16 F2): under a reviewed
    // policy the executed checks run over the delivered bundle — a
    // claim carrying no delivery has nothing to verify, and an empty
    // executed-checks list must never be stamped "verified". Finish
    // requires the bundle under exactly these policies; verify now
    // refuses its absence outright instead of trusting that every road
    // into `delivered` supplied one.
    if (effectivePolicy !== "self_attested" && !deliveredItem.delivery) {
      fail("delivery_incomplete",
        `verifying "${item.id}" under review policy "${effectivePolicy}" requires a recorded delivery bundle — the claim carries none`);
    }
    const executedChecks = executeDeliveryChecks(deliveredItem);
    const failed = executedChecks.find(entry => entry.result === "fail");
    if (failed && effectivePolicy !== "self_attested") {
      fail("delivery_check_failed",
        `executed check "${failed.name}" failed for "${item.id}" — ${failed.detail ?? "the delivery does not pass system verification"}`);
    }
    verification = Object.freeze({
      state: effectivePolicy === "self_attested" ? "self_attested" : "verified",
      by: reviewedBy ?? agent, at: isoOf(atMs), basis: reviewBasisFor(deliveredItem),
      executedChecks, ...(jevRecord ? { jev: jevRecord } : {}),
    });
  } else if (state === "in_progress" && item.state === "delivered") {
    // changes_requested: the delivery stays as the record of what was
    // handed over; the verification fact records who sent it back.
    verification = Object.freeze({ state: "changes_requested", by: agent, at: isoOf(atMs),
      basis: reviewBasisFor(item), executedChecks: Object.freeze([]) });
  } else if (finishing) {
    verification = null;
  }
  if (released) verification = null;
  const next = state === undefined ? { ...item, ...withProvenance } : { ...item, state,
    claimGeneration: released ? item.claimGeneration + 1 : item.claimGeneration, // a release ends the round (#3545)
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
    deliveryMode: (finishing || state === "done") && deliveryMode != null ? deliveryMode : item.deliveryMode,
    // a verify from delivered stamps the verifying reviewer even when the
    // caller did not restate their own id in reviewedBy — the receipt's
    // reviewer is the member whose session performed the verify
    reviewedBy: state === "done" && item.state === "delivered" ? verification.by
      : state === "done" && reviewedBy != null ? reviewedBy : item.reviewedBy,
    tags: (finishing || state === "done") && tags != null ? tagsOf(tags) : item.tags,
    blobs: (finishing || state === "done") && blobs != null ? blobsOf(blobs) : item.blobs,
    // the delivery belongs to the owner's round: a release clears it (and
    // its verification fact) exactly like the round's reviews
    delivery: released ? null : deliveredItem.delivery,
    // #3685: the CI settlement belongs to the delivery round too — a
    // release or a replacement delivery clears it (see replacesDelivery)
    ci: released || replacesDelivery ? null : item.ci,
    // A release ends the round, so its delivery generation ends with
    // it — the same reset releaseExpired and reassignWork apply, so no
    // round-ending path leaves a different residue than another.
    deliveryGeneration: released ? 0 : deliveredItem.deliveryGeneration ?? item.deliveryGeneration ?? 0,
    verification,
    ...withProvenance };
  return key === undefined ? withHistory(next, atMs, agent, state === undefined ? "noted" : `state:${state}`, note)
    : Object.freeze({ ...withHistory(next, atMs, agent, state === undefined ? "noted" : `state:${state}`, note),
      requestOutcomes: recordRequestOutcome(item.requestOutcomes, key, isoOf(atMs), digest) });
}
// Release a claim, bound to the claim round the caller read (E5/D4, QA-200
// 2026-10-08): expectedClaimedAt + expectedHistoryLength must match the
// current item, so a stale replay (timed-out retry) or a delayed duplicate
// landing after an intervening release + re-claim is refused instead of
// silently destroying the fresh claim. Mirrors appendWorkPullRequest's
// round check — the history length also discriminates same-millisecond
// re-claims, which keep the previous round's claimedAt. Claims held
// in_progress/blocked are routed through the internal pause transition
// first (W2); both steps are stamped in history.
export function releaseWork(work, agentId, { expectedClaimedAt, expectedHistoryLength, expectedClaimGeneration, note, now, authority = false } = {}) {
  const item = workOf(work), agent = agentOf(agentId), atMs = nowMsOf(now);
  check(typeof expectedClaimedAt === "string" && expectedClaimedAt.length <= 100 && Number.isFinite(Date.parse(expectedClaimedAt)), "expectedClaimedAt must be the current claim timestamp");
  check(Number.isSafeInteger(expectedHistoryLength) && expectedHistoryLength >= 0, "expectedHistoryLength must be a non-negative integer");
  if (item.claimedAt !== expectedClaimedAt || claimHistoryLength(item) !== expectedHistoryLength) {
    fail("work_claim_conflict", "The claim changed since it was read");
  }
  checkClaimGeneration(item, expectedClaimGeneration);
  let current = item;
  if (current.state === "in_progress" || current.state === "blocked") {
    current = updateWork(current, agent, { state: "claimed", note: "paused for release", now: atMs, authority, pauseForRelease: true });
  }
  return updateWork(current, agent, { state: "unclaimed", note, now: atMs, authority });
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
  check(REVIEWABLE_CLAIM_STATES.includes(item.state), `work "${item.id}" is ${item.state} — only active or delivered claims can be reviewed`);
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
export function recordReview(work, agentId, { verdict, summary, url, now, expectedBasis } = {}) {
  const item = workOf(work), agent = agentOf(agentId), atMs = nowMsOf(now);
  check(item.owner !== agent, `work "${item.id}" is owned by ${item.owner ?? "nobody"} — the owner cannot review it`);
  check(REVIEWABLE_CLAIM_STATES.includes(item.state), `work "${item.id}" is ${item.state} — only active or delivered claims can be reviewed`);
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
  // #2966, revised: an identical resubmission is ambiguous — it can be a
  // blind retry of the request that already landed, or a deliberate
  // re-review of changed context with the same wording ("LGTM" on a new CI
  // head). The two must not be conflated: a blind retry never refreshes
  // the old binding, or it would silently approve changed work (the
  // approval-binding invariant), yet a reviewer must not be forced to
  // invent new wording to re-approve a new head, or reviewed completion
  // deadlocks. `expectedBasis` is the distinguishing signal: the caller
  // names the current basis (owner, claimedAt, revision, ci.headSha) they
  // actually reviewed, as read back from the claim. A supplied basis that
  // no longer matches is a conflict, not a review of the current context.
  const currentBasis = reviewBasisFor(item);
  let namedBasis = null;
  if (expectedBasis !== undefined && expectedBasis !== null) {
    namedBasis = reviewBasisOf(expectedBasis);
    if (!sameBasis(namedBasis, currentBasis)) {
      fail("work_claim_conflict", `expected review basis does not match the current basis of work "${item.id}"`);
    }
  }
  if (prior && prior.verdict === verdict && prior.summary === summary && prior.url === reviewUrl) {
    // A true replay on the still-current basis changes nothing.
    if (currentReviewBasis(prior, item)) return Object.freeze(item);
    // The prior basis is stale (or the record predates bases). Only a
    // deliberate re-review — one naming the current basis — may refresh
    // it, and only for the #2966 case: CI recorded a new head (headSha is
    // the sole changed basis field and there is a current head to bind
    // to), or the prior record is a legacy unbound review. A basis stale
    // because the revision, owner or claim round changed, or because CI
    // was cleared with no current head (a newly linked PR), still cannot
    // be refreshed by identical content — that takes a fresh summary.
    const soleHeadMove = prior.basis !== null && prior.basis !== undefined && currentBasis.headSha !== null
      && prior.basis.headSha !== currentBasis.headSha
      && ["version", "owner", "claimedAt", "revision", "deliveryDigest", "deliveryGeneration"].every(key => prior.basis[key] === currentBasis[key]);
    const deliberateRefresh = namedBasis !== null && (soleHeadMove || !prior.basis);
    if (!deliberateRefresh) return Object.freeze(item);
  }
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
  // #3685: stamp the settlement with the delivery it was made against —
  // the digest of the delivery current now, or null when this round has
  // no delivery yet. The stamp is computed here, never caller-supplied,
  // so a settlement can never claim a delivery it did not settle under.
  const next = ciOf({ ...ci, deliveryDigest: item.delivery?.digest ?? null, checkedAt: ci?.checkedAt ?? isoOf(atMs) });
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
// Reassign: the owner hands work to another agent. Attestations and
// reviews are cleared — they belong to the previous owner's round of
// review. The round's DELIVERY state (delivery, verification, ci,
// deliveryGeneration) belongs to the round, not the owner, and follows
// the round semantics below (bug sweep 2026-10-16 F2):
//  - a fresh assignment from unclaimed opens a new round: cleared.
//  - a live round (claimed / in_progress / blocked) changes hands
//    intact — a delivery retained by a send-back is the record of what
//    was handed over and survives the handover.
//  - a delivered claim never changes hands in `delivered`: nulling its
//    bundle while keeping the state stranded it where verify could
//    stamp it "verified" with zero executed checks. The handover
//    instead reopens the round to in_progress — the state a reviewer's
//    send-back produces — with the delivery retained as the round's
//    record and no verdict standing (verification clears with the
//    reviews). The new owner re-finishes and a reviewer verifies.
export function reassignWork(work, agentId, newOwner, { expectedClaimedAt, expectedHistoryLength, expectedClaimGeneration, note, now, authority = false, room } = {}) {
  const item = workOf(work), agent = agentOf(agentId), target = agentOf(newOwner), atMs = nowMsOf(now);
  check(authority === true || item.owner === agent, `work "${item.id}" is owned by ${item.owner ?? "nobody"} — only the owner can reassign it`);
  check(!isTerminalClaimState(item.state), `work "${item.id}" is ${item.state} and immutable`);
  // E5/D4 follow-up: the HTTP route requires the claim round the client read
  // (claimedAt + history length), like release. In-process callers may omit
  // both; when either is given both are validated and compared. An unclaimed
  // item has claimedAt null, so null is its valid round token.
  if (expectedClaimedAt !== undefined || expectedHistoryLength !== undefined) {
    check(expectedClaimedAt === null || typeof expectedClaimedAt === "string" && expectedClaimedAt.length <= 100 && Number.isFinite(Date.parse(expectedClaimedAt)), "expectedClaimedAt must be the current claim time (ISO string) or null for an unclaimed item");
    check(Number.isSafeInteger(expectedHistoryLength) && expectedHistoryLength >= 0, "expectedHistoryLength must be a non-negative integer");
    if (item.claimedAt !== expectedClaimedAt || claimHistoryLength(item) !== expectedHistoryLength) {
      fail("work_claim_conflict", "The claim changed since it was read");
    }
  }
  checkClaimGeneration(item, expectedClaimGeneration);
  // Assigning an unclaimed item hands it over as a claim: state claimed with
  // a fresh lease (room default), the same shape create-with-assignee gives.
  // Before this, the owner was set but the state stayed "unclaimed" with no
  // lease, so the item showed as free to take and never expired.
  const fresh = item.state === "unclaimed";
  const hours = fresh ? roomWorkClaimConfig(room).defaultLeaseHours : null;
  const claim = fresh ? { state: "claimed", claimedAt: isoOf(atMs),
    leaseStartAt: hours === null ? null : isoOf(atMs),
    leaseExpiresAt: hours === null ? null : isoOf(atMs + hours * 3600 * 1000) } : {};
  // A fresh assignment opens a fresh round (delivery state cleared,
  // exactly like a claim). A live round keeps its delivery state. A
  // delivered claim reopens to in_progress with its delivery retained
  // and its verification fact cleared — no verdict recorded against the
  // previous owner stands over the new owner's round.
  const round = fresh
    ? { delivery: null, verification: null, ci: null, deliveryGeneration: 0 }
    : item.state === "delivered"
      ? { state: "in_progress", verification: null }
      : {};
  return withHistory({ ...item, ...claim, ...round, owner: target,
    claimGeneration: item.claimGeneration + 1, // a handover opens the new owner's round (#3545)
    attestations: Object.freeze([]), reviews: Object.freeze([]) },
    atMs, agent, `reassigned:${target}`, note);
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
    // The round's delivery state goes with it (bug sweep 2026-10-16 F1):
    // a claim sent back to in_progress keeps its delivery as the record
    // of what was handed over, so a lease lapse after a send-back used
    // to leave the frozen bundle, its verification fact, and its
    // generation on the unclaimed item — and the next claimant's
    // bundle-less finish then froze that bundle as THEIR delivery.
    // Every round-ending path now clears the same set: delivery,
    // verification, ci, and the delivery generation.
    const released = { ...item, state: "unclaimed", owner: null, leaseStartAt: null, leaseExpiresAt: null, ci: null,
      delivery: null, verification: null, deliveryGeneration: 0,
      claimGeneration: item.claimGeneration + 1, // the sweep ends the round (#3545)
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
