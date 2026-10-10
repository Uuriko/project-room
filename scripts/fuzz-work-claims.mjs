// Continuous fuzzing for the work-claims protocol (server/work-claims.mjs,
// server/claim-coordination.mjs, server/work-claim-sqlite.mjs).
//
// 200-hard-tasks #86 (burncrew Lane F). The invariant under test: for every
// random operation, the implementation must ACCEPT every operation the
// documented protocol says is legal, and REJECT every operation the protocol
// says is illegal. Anything else is a protocol bug:
//
//   illegal-accepted  — the enforcer accepted a forbidden move
//                       (anti-collision break, dead-state escape, ...)
//   legal-rejected    — the enforcer refused a legitimate move
//                       (a stuck claim the protocol says should move)
//   unclean           — anything that is neither a returned item nor a
//                       ClaimError (TypeError, RangeError, hang, ...).
//
// The oracle is an INDEPENDENT reading of the documented contract (the module
// docstrings + the hardcoded DOCUMENTED_TRANSITIONS table below, which is
// additionally asserted byte-equal to the implementation's exported
// TRANSITIONS — a doc/code drift fails loudly instead of silently
// re-baselining the oracle).
//
// Usage:
//   --seed N          PRNG seed (default 20261006; same seed => same ops)
//   --iterations N    random protocol ops (default 10000)
//   --budget-ms N     wall-clock budget for the random phase (default 480000)
//   --max-ms N        per-op soft time limit; slower is a "slow" failure
//                     (default 1000)
//   --quiet           summary line only
//   --json            machine-readable report on stdout
//
// Exit code: 0 when every case held the invariant, 1 otherwise.
// Failing cases are printed with the seed and case index so they reproduce
// deterministically with the same --seed.
//
// Bounded by design so it cannot stall the pipeline: an explicit monotonic
// `now` is threaded through every op (no wall-clock dependence), and the
// random phase stops at --iterations or --budget-ms, whichever comes first.

import { DatabaseSync } from "node:sqlite";
import {
  createWork, claimWork, renewWork, appendWorkPullRequest, updateWork,
  attestWork, recordReview, closeWhenLive, recordCi, notePullMerged,
  reassignWork, isLeaseExpired, releaseExpired, canCloseWork, stampClaimHistory,
  claimHistoryLength, MAX_CLAIM_HISTORY, ClaimError, STATES, TRANSITIONS, DELIVERY_MODES,
  REVIEW_POLICIES, REVIEW_VERDICTS, CLAIM_KINDS, CI_STATES,
  MAX_LEASE_HOURS, ACTIVE_CLAIM_STATES,
} from "../server/work-claims.mjs";
import {
  parsePullRequestUrl, pullRequestOutcomeFromWebhook, pullRequestOutcomeFromApi,
  settlePullRequest, fileLeaseConflicts, readyClaims, rateLimitUntil,
  rollupClaimCi, pullRequestDue, pullsReadyToSettle, batchPullOutcome,
  recordPullOutcome, usableEtag, nextPullBackoff,
} from "../server/claim-coordination.mjs";
import {
  createDurableWorkClaimRegistry, workClaimSchema,
} from "../server/work-claim-sqlite.mjs";

// --- deterministic PRNG (mulberry32, repo convention) -----------------------
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- the documented contract, hardcoded (NOT imported from the impl) --------
// From server/work-claims.mjs module docstring + TRANSITIONS:
//   unclaimed -> claimed; claimed -> in_progress|blocked|unclaimed(release);
//   in_progress -> blocked|done|claimed(pause); blocked -> in_progress|claimed;
//   done -> (none).
const DOCUMENTED_TRANSITIONS = Object.freeze({
  unclaimed: Object.freeze(["claimed"]),
  claimed: Object.freeze(["in_progress", "blocked", "unclaimed"]),
  in_progress: Object.freeze(["blocked", "done", "claimed"]),
  blocked: Object.freeze(["in_progress", "claimed"]),
  done: Object.freeze([]),
});
const DOCUMENTED_DELIVERY_MODES = ["result", "merged", "production"];
const DOCUMENTED_REVIEW_POLICIES = ["self_attested", "distinct_member", "independent_principal"];

// --- tiny report -------------------------------------------------------------
const report = {
  ops: 0, legalRejected: 0, illegalAccepted: 0, unclean: 0, slow: 0,
  failures: [], // {phase, op, index, detail}
};
function recordFailure(phase, op, index, detail) {
  if (report.failures.length < 25) report.failures.push({ phase, op, index, detail: String(detail).slice(0, 400) });
}

// --- oracle: independent model of one claim ----------------------------------
class OracleClaim {
  constructor(id) {
    this.id = id;
    this.state = "unclaimed";
    this.owner = null;
    this.leaseExpiresAt = null; // ms or null
    this.claimedAt = null;      // iso string or null
    this.kind = "work";
    this.revision = null;
    this.headSha = null;
    this.supersededBy = null;
    this.historyLen = 1; // create stamps one entry
  }
  get active() { return ["claimed", "in_progress", "blocked"].includes(this.state); }
  get leaseLapsed() { return this.leaseExpiresAt !== null && this.leaseExpiresAt <= oracleNow; }
  syncFrom(item) {
    this.state = item.state;
    this.owner = item.owner;
    this.leaseExpiresAt = item.leaseExpiresAt === null ? null : Date.parse(item.leaseExpiresAt);
    this.claimedAt = item.claimedAt;
    this.kind = item.kind;
    this.revision = item.revision;
    this.headSha = item.ci?.headSha ?? null;
    this.supersededBy = item.supersededBy;
    this.historyLen = claimHistoryLength(item);
  }
}

let oracleNow = 1_000_000_000_000;
const VALID_AGENT = id => typeof id === "string" && id.length > 0 && id.length <= 128;

// Verdicts: "accept" | "reject" | "impl" (implementation-defined; only the
// no-unclean-crash invariant applies).
const verdictOf = {
  claim(o, agent, opts = {}) {
    if (!VALID_AGENT(agent)) return "reject";
    if (o.state !== "unclaimed") return "reject";
    const lh = opts.leaseHours;
    if (lh !== undefined && lh !== null &&
        !(typeof lh === "number" && Number.isFinite(lh) && lh > 0 && lh <= 168)) return "reject";
    if (opts.note !== undefined && opts.note !== null &&
        !(typeof opts.note === "string" && opts.note.length <= 4000)) return "reject";
    return "accept";
  },
  update(o, agent, { state, deliveryMode, reviewedBy, tags, blobs, note }) {
    if (!VALID_AGENT(agent)) return "reject";
    if (o.state === "done") return "reject";
    if (o.owner !== agent) return "reject";
    if (note !== undefined && note !== null &&
        !(typeof note === "string" && note.length <= 4000)) return "reject";
    const hasPayload = deliveryMode != null || reviewedBy != null || tags != null || blobs != null;
    if (state !== undefined && !DOCUMENTED_TRANSITIONS[o.state].includes(state)) return "reject";
    if (hasPayload && state !== "done") return "reject";
    if (deliveryMode != null && !DOCUMENTED_DELIVERY_MODES.includes(deliveryMode)) return "reject";
    if (reviewedBy != null && !VALID_AGENT(reviewedBy)) return "reject";
    if (tags != null && !(Array.isArray(tags) && tags.length <= 10 &&
        tags.every(t => typeof t === "string" && /^[A-Za-z0-9_-]{1,32}$/.test(t)))) return "reject";
    if (blobs != null && !(Array.isArray(blobs) && blobs.length <= 10 &&
        blobs.every(b => typeof b === "string" && /^sha256:[0-9a-f]{64}$/.test(b)))) return "reject";
    return "accept";
  },
  renew(o, agent, { leaseHours, note } = {}) {
    if (!VALID_AGENT(agent)) return "reject";
    if (o.owner !== agent) return "reject";
    if (!o.active) return "reject";
    if (o.leaseExpiresAt === null) return "reject";
    if (o.leaseLapsed) return "reject";
    if (note !== undefined && note !== null &&
        !(typeof note === "string" && note.length <= 4000)) return "reject";
    const lh = leaseHours;
    if (lh !== undefined && lh !== null &&
        !(typeof lh === "number" && Number.isFinite(lh) && lh > 0 && lh <= 168)) return "reject";
    return "accept";
  },
  reassign(o, agent, newOwner, { authority } = {}) {
    if (authority) return "impl"; // HTTP-layer override; out of the pure contract
    if (!VALID_AGENT(agent) || !VALID_AGENT(newOwner)) return "reject";
    if (o.state === "done") return "reject";
    if (o.owner !== agent) return "reject";
    return "accept";
  },
  attest(o, agent, { note } = {}) {
    if (!VALID_AGENT(agent)) return "reject";
    if (!o.active) return "reject";
    if (note !== undefined && note !== null &&
        !(typeof note === "string" && note.length <= 512)) return "reject";
    return "accept";
  },
  review(o, agent, { verdict, summary }) {
    if (!VALID_AGENT(agent)) return "reject";
    if (!o.active) return "reject";
    if (o.owner === agent) return "reject"; // owner cannot review own claim
    if (!["approve", "changes_requested", "comment"].includes(verdict)) return "reject";
    if (!(typeof summary === "string" && summary.length > 0 && summary.length <= 2000)) return "reject";
    return "accept";
  },
  appendPR(o, agent, { url, expectedClaimedAt, expectedHistoryLength }) {
    if (!VALID_AGENT(agent)) return "reject";
    if (!o.active || o.owner === null || o.supersededBy) return "reject";
    if (o.owner !== agent) return "reject";
    if (o.leaseLapsed) return "reject";
    if (!(typeof expectedClaimedAt === "string" && expectedClaimedAt.length <= 100 &&
          Number.isFinite(Date.parse(expectedClaimedAt)))) return "reject";
    if (!(Number.isSafeInteger(expectedHistoryLength) && expectedHistoryLength >= 0)) return "reject";
    if (o.claimedAt !== expectedClaimedAt || o.historyLen !== expectedHistoryLength) return "reject";
    if (!isCanonicalPullUrl(url)) return "reject";
    return "accept"; // duplicates are accepted as no-ops by the impl
  },
  closeWhenLive(o, liveRevision) {
    if (!["land", "deploy"].includes(o.kind)) return "reject";
    if (o.state === "done") return "reject";
    if (!(typeof liveRevision === "string" && liveRevision.length > 0)) return "reject";
    if (o.revision !== liveRevision && o.headSha !== liveRevision) return "reject";
    return "accept";
  },
  stampHistory(o, agent, { action } = {}) {
    if (!VALID_AGENT(agent)) return "reject";
    if (!(typeof action === "string" && action.length > 0)) return "reject";
    return "accept"; // stamps on any state, including done
  },
};

const PULL_URL_RE = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/([1-9]\d{0,9})$/;
function isCanonicalPullUrl(value) {
  // Independent oracle for parsePullRequestUrl. Mirrors the documented rule:
  // canonical https://github.com/{owner}/{repo}/pull/{number}; query strings,
  // fragments, and credentials are refused. NOTE: like the implementation,
  // this is lenient about ports — new URL() normalizes the default :443 away
  // and the impl rebuilds the canonical URL from the path, so an explicit
  // port can never smuggle a tracker into a stored lease (the stored URL is
  // always the canonical github.com form).
  if (typeof value !== "string" || value.length > 300) return false;
  let url;
  try { url = new URL(value.trim()); } catch { return false; }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return false;
  if (url.hostname !== "github.com") return false;
  const path = url.pathname.length > 1 && url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;
  return PULL_URL_RE.test(`https://github.com${path}`);
}

// --- op runner: classify, execute, count -------------------------------------
let maxMs = 250;
function runOp(phase, opName, index, oracle, verdict, fn) {
  const started = performance.now();
  let threw = null, result;
  try {
    result = fn();
  } catch (e) {
    threw = e;
  }
  const ms = performance.now() - started;
  report.ops++;
  if (ms > maxMs) { report.slow++; recordFailure(phase, opName, index, `slow: ${ms.toFixed(0)}ms > ${maxMs}ms`); }
  if (threw && !(threw instanceof ClaimError)) {
    report.unclean++;
    recordFailure(phase, opName, index, `unclean throw ${threw?.constructor?.name}: ${threw?.message}`);
    return { threw, result: undefined, unclean: true };
  }
  if (verdict === "accept" && threw) {
    report.legalRejected++;
    recordFailure(phase, opName, index, `LEGAL REJECTED — oracle says accept, impl threw ${threw.code}: ${threw.message}`);
  } else if (verdict === "reject" && !threw) {
    report.illegalAccepted++;
    recordFailure(phase, opName, index, `ILLEGAL ACCEPTED — oracle says reject, impl returned ${JSON.stringify(result?.state ?? result)?.slice(0, 120)}`);
  }
  return { threw, result, unclean: false };
}

// --- RNG helpers --------------------------------------------------------------
function makeRng(rand) {
  const int = (min, max) => min + Math.floor(rand() * (max - min + 1));
  const pick = arr => arr[Math.floor(rand() * arr.length)];
  const bool = (p = 0.5) => rand() < p;
  const maybe = (fn, p = 0.5) => (bool(p) ? fn() : undefined);
  const agent = pool => pick(pool);
  const hex = n => Array.from({ length: n }, () => "0123456789abcdef"[int(0, 15)]).join("");
  const word = (n, alphabet = "abcXYZ019_-") =>
    Array.from({ length: n }, () => alphabet[int(0, alphabet.length - 1)]).join("");
  // valid id most of the time, occasionally garbage to exercise validators
  const idish = (prefix, n = 8) => bool(0.92) ? `${prefix}-${word(n)}` : pick(["", "x".repeat(300), null, 42, "has space", "semi;colon"]);
  const noteish = (max = 4000) => bool(0.93) ? word(int(0, 60)) : "n".repeat(int(max + 1, max + 500));
  const leaseHoursish = () => {
    const r = rand();
    if (r < 0.78) return int(1, 72);                    // valid
    if (r < 0.84) return null;                          // explicit opt-out
    if (r < 0.90) return undefined;                     // default
    return pick([0, -3, 169, 1e9, "12", NaN, Infinity]); // invalid
  };
  const tagish = () => bool(0.9) ? word(int(1, 12)) : pick(["bad tag!", "", "x".repeat(33), 7]);
  const blobish = () => bool(0.9) ? `sha256:${hex(64)}` : pick(["sha256:xyz", "SHA256:" + hex(64), "x".repeat(71)]);
  const pullUrlish = n => {
    const r = rand();
    if (r < 0.6) return `https://github.com/u${n}/repo${n}/pull/${int(1, 9999)}`;
    if (r < 0.7) return `https://github.com/u${n}/repo${n}/pull/${int(1, 9999)}/`; // trailing slash: still canonical
    if (r < 0.8) return `https://github.com/u${n}/repo${n}/pull/${int(1, 9999)}?x=1`; // query: refused
    if (r < 0.9) return `https://gitlab.com/u${n}/repo${n}/-/merge_requests/1`;     // wrong host: refused
    return pick(["not a url", "", "https://github.com//pull/1", null]);
  };
  return { int, pick, bool, maybe, agent, hex, word, idish, noteish, leaseHoursish, tagish, blobish, pullUrlish, rand };
}

// --- phase 1: random protocol operations --------------------------------------
function phaseProtocol(rand, iterations, budgetMs) {
  const R = makeRng(rand);
  const agents = ["a1", "a2", "a3", "a4"];
  const claims = new Map(); // id -> { item, oracle }
  const liveIds = [];
  const deadline = Date.now() + budgetMs;
  let i = 0;
  for (; i < iterations; i++) {
    if (i % 256 === 0 && Date.now() > deadline) break;
    // monotonic-ish clock: mostly small steps forward, sometimes a lease-killing jump
    oracleNow += R.rand() < 0.03 ? R.int(1, 30) * 86400_000 : R.int(0, 3_600_000);

    const opKind = R.rand();
    const existing = liveIds.length && R.bool(0.8) ? R.pick(liveIds) : null;

    if (opKind < 0.10 || !existing) {
      // create
      const id = `fz-${R.word(6)}-${i}`;
      const kind = R.rand() < 0.12 ? R.pick(["land", "deploy"]) : "work";
      const o = new OracleClaim(id);
      o.kind = kind;
      const opts = {
        title: R.maybe(() => R.word(R.int(1, 40))),
        note: R.maybe(() => R.noteish()),
        reviewPolicy: R.maybe(() => R.pick(["self_attested", "distinct_member", "independent_principal", "bogus"])),
        kind,
        revision: kind !== "work" ? R.maybe(() => R.hex(40), 0.8) : undefined,
      };
      // Only deploy claims require a revision (createWork/workOf enforce it for
      // deploy only; land claims may resolve it later via notePullMerged or
      // ci.headSha). The oracle must not demand one for land.
      const verdict = opts.reviewPolicy === "bogus" || (kind === "deploy" && !opts.revision) ||
        (opts.note != null && !(typeof opts.note === "string" && opts.note.length <= 4000)) ? "reject" : "accept";
      const { threw, result, unclean } = runOp("protocol", "create", i, o, verdict,
        () => createWork({ id, ...opts }, { now: oracleNow, agentId: R.bool(0.9) ? R.agent(agents) : undefined }));
      if (!threw && !unclean) { o.syncFrom(result); claims.set(id, { item: result, oracle: o }); liveIds.push(id); }
      continue;
    }

    const rec = claims.get(existing);
    const o = rec.oracle;
    let item = rec.item;

    if (opKind < 0.28) {
      // claim
      const agent = R.agent(agents);
      const opts = { note: R.maybe(() => R.noteish()), leaseHours: R.leaseHoursish() };
      const v = verdictOf.claim(o, agent, opts);
      const { threw, result, unclean } = runOp("protocol", "claim", i, o, v,
        () => claimWork(item, agent, { ...opts, now: oracleNow }));
      if (!threw && !unclean) { o.syncFrom(result); rec.item = result; }
    } else if (opKind < 0.52) {
      // update: state move, note-only, or done with payloads
      const agent = R.bool(0.85) ? o.owner ?? R.agent(agents) : R.agent(agents);
      const r = R.rand();
      let state, deliveryMode, reviewedBy, tags, blobs;
      if (r < 0.55) state = R.pick([...DOCUMENTED_TRANSITIONS[o.state], ...STATES.filter(s => !DOCUMENTED_TRANSITIONS[o.state].includes(s) && R.bool(0.3))]);
      else if (r < 0.7) state = undefined; // note-only
      else state = "done";
      if (state === "done" || R.bool(0.08)) {
        deliveryMode = R.maybe(() => R.pick([...DOCUMENTED_DELIVERY_MODES, "bogus"]), 0.6);
        reviewedBy = R.maybe(() => R.bool(0.9) ? R.agent(agents) : "", 0.5);
        tags = R.maybe(() => Array.from({ length: R.int(0, 12) }, () => R.tagish()), 0.5);
        blobs = R.maybe(() => Array.from({ length: R.int(0, 12) }, () => R.blobish()), 0.4);
      }
      const opts = { state, note: R.maybe(() => R.noteish()), deliveryMode, reviewedBy, tags, blobs };
      const v = verdictOf.update(o, agent, opts);
      const { threw, result, unclean } = runOp("protocol", "update", i, o, v,
        () => updateWork(item, agent, { ...opts, now: oracleNow }));
      if (!threw && !unclean) {
        o.syncFrom(result); rec.item = result;
        // release/expiry clearing invariant: after release the next owner starts clean
        if (state === "unclaimed") {
          if (result.owner !== null || result.leaseExpiresAt !== null ||
              result.files.length !== 0 || Object.keys(result.fileBlocks).length !== 0 ||
              result.attestations.length !== 0 || result.reviews.length !== 0) {
            report.illegalAccepted++;
            recordFailure("protocol", "update-release", i, "release did not clear owner/lease/files/attestations/reviews");
          }
        }
      }
    } else if (opKind < 0.58) {
      // renew (op params generated once: the oracle and the impl must see the same inputs)
      const agent = R.bool(0.85) ? o.owner ?? R.agent(agents) : R.agent(agents);
      const opts = { leaseHours: R.leaseHoursish(), note: R.maybe(() => R.noteish()) };
      const v = verdictOf.renew(o, agent, opts);
      const { threw, result, unclean } = runOp("protocol", "renew", i, o, v,
        () => renewWork(item, agent, { ...opts, now: oracleNow }));
      if (!threw && !unclean) { o.syncFrom(result); rec.item = result; }
    } else if (opKind < 0.64) {
      // reassign
      const agent = R.bool(0.85) ? o.owner ?? R.agent(agents) : R.agent(agents);
      const target = R.agent(agents);
      const authority = R.bool(0.06);
      const v = verdictOf.reassign(o, agent, target, { authority });
      const opts = { note: R.maybe(() => R.noteish()) };
      const { threw, result, unclean } = runOp("protocol", "reassign", i, o, v,
        () => reassignWork(item, agent, target, { ...opts, now: oracleNow, authority }));
      if (!threw && !unclean) {
        o.syncFrom(result); rec.item = result;
        if (result.attestations.length !== 0 || result.reviews.length !== 0) {
          report.illegalAccepted++;
          recordFailure("protocol", "reassign", i, "reassign did not clear attestations/reviews");
        }
      }
    } else if (opKind < 0.70) {
      // attest (note generated once: oracle and impl must see the same input)
      const agent = R.agent(agents);
      const note = R.maybe(() => R.noteish(512));
      const v = verdictOf.attest(o, agent, { note });
      const { threw, result, unclean } = runOp("protocol", "attest", i, o, v,
        () => attestWork(item, agent, { note, now: oracleNow }));
      if (!threw && !unclean) { o.syncFrom(result); rec.item = result; }
    } else if (opKind < 0.76) {
      // review
      const agent = R.agent(agents);
      const verdict = R.pick(["approve", "changes_requested", "comment", "bogus"]);
      const summary = R.bool(0.9) ? R.word(R.int(1, 100)) : R.pick(["", "x".repeat(2001)]);
      const v = verdictOf.review(o, agent, { verdict, summary });
      const { threw, result, unclean } = runOp("protocol", "review", i, o, v,
        () => recordReview(item, agent, { verdict, summary, now: oracleNow }));
      if (!threw && !unclean) { o.syncFrom(result); rec.item = result; }
    } else if (opKind < 0.82) {
      // appendWorkPullRequest (optimistic concurrency)
      const agent = R.bool(0.85) ? o.owner ?? R.agent(agents) : R.agent(agents);
      const url = R.pullUrlish(i);
      const stale = R.bool(0.35);
      const expectedClaimedAt = stale && R.bool(0.5) ? new Date(oracleNow - 999_000).toISOString() : o.claimedAt;
      const expectedHistoryLength = stale && R.bool(0.5) ? Math.max(0, o.historyLen - R.int(1, 3)) : o.historyLen;
      const v = verdictOf.appendPR(o, agent, { url, expectedClaimedAt, expectedHistoryLength });
      const { threw, result, unclean } = runOp("protocol", "appendPR", i, o, v,
        () => appendWorkPullRequest(item, agent, { pullRequest: url, expectedClaimedAt, expectedHistoryLength, now: oracleNow }));
      if (!threw && !unclean) { o.syncFrom(result); rec.item = result; }
    } else if (opKind < 0.86) {
      // closeWhenLive for land/deploy claims. NOTE: the impl signals "cannot
      // close" by returning null (not by throwing), so runOp gets "impl" and
      // the accept/reject accounting below is the only counter.
      const liveRevision = R.bool(0.5) ? (o.revision ?? R.hex(40)) : R.hex(40);
      const v = verdictOf.closeWhenLive(o, liveRevision);
      const { threw, result } = runOp("protocol", "closeWhenLive", i, o, "impl",
        () => closeWhenLive(item, liveRevision, oracleNow));
      // closeWhenLive returns null (not throw) when it cannot close
      if (v === "accept" && !threw && result === null) {
        report.legalRejected++;
        recordFailure("protocol", "closeWhenLive", i, "oracle says closeable, impl returned null");
      } else if (v === "reject" && !threw && result !== null) {
        report.illegalAccepted++;
        recordFailure("protocol", "closeWhenLive", i, "oracle says not closeable, impl closed it");
      } else if (!threw && result !== null) { o.syncFrom(result); rec.item = result; }
    } else if (opKind < 0.90) {
      // canCloseWork differential: independent predicate vs impl
      const reviewer = R.agent(agents);
      const policy = R.maybe(() => R.pick([...DOCUMENTED_REVIEW_POLICIES, "bogus"]));
      const reviewMembers = new Set(agents.filter(() => R.bool(0.7)));
      const verifyMembers = new Set(agents.filter(() => R.bool(0.5)));
      const expected = oracleCanClose(o, item, reviewer, { policy, reviewMembers, verifyMembers });
      const { threw, result, unclean } = runOp("protocol", "canClose", i, o, "impl",
        () => canCloseWork(item, reviewer, { policy, reviewMembers, verifyMembers }));
      if (!threw && !unclean && expected !== "impl" && result !== expected) {
        report.illegalAccepted++;
        recordFailure("protocol", "canClose", i,
          `predicate mismatch: oracle=${expected} impl=${result} state=${o.state} owner=${o.owner} reviewer=${reviewer} policy=${policy ?? item.reviewPolicy ?? "self_attested"}`);
      }
    } else if (opKind < 0.94) {
      // releaseExpired sweep over the whole board
      const items = liveIds.map(id => claims.get(id).item);
      const { threw, result, unclean } = runOp("protocol", "releaseExpired", i, null, "impl",
        () => releaseExpired(items, oracleNow));
      if (!threw && !unclean) {
        for (let k = 0; k < liveIds.length; k++) {
          const id = liveIds[k], r2 = claims.get(id), o2 = r2.oracle;
          const before = { state: o2.state, owner: o2.owner, lease: o2.leaseExpiresAt };
          o2.syncFrom(result[k]); r2.item = result[k];
          const shouldRelease = ["claimed", "in_progress", "blocked"].includes(before.state) &&
            before.lease !== null && before.lease <= oracleNow;
          if (shouldRelease && (o2.state !== "unclaimed" || o2.owner !== null || o2.leaseExpiresAt !== null)) {
            report.illegalAccepted++;
            recordFailure("protocol", "releaseExpired", i, `expired claim ${id} not released`);
          }
          if (!shouldRelease && (o2.state !== before.state || o2.owner !== before.owner)) {
            report.illegalAccepted++;
            recordFailure("protocol", "releaseExpired", i, `live claim ${id} mutated by sweep`);
          }
        }
      }
    } else if (opKind < 0.96) {
      // stampClaimHistory: note-only history append on any state
      const agent = R.agent(agents);
      const action = R.bool(0.9) ? R.word(R.int(1, 20)) : R.pick(["", 42, null]);
      const v = verdictOf.stampHistory(o, agent, { action });
      const { threw, result, unclean } = runOp("protocol", "stampHistory", i, o, v,
        () => stampClaimHistory(item, agent, { action, note: R.maybe(() => R.word(20)), now: oracleNow }));
      if (!threw && !unclean) { o.syncFrom(result); rec.item = result; }
    } else {
      // recordCi / notePullMerged: cleanliness only (server-side observations)
      const { unclean } = runOp("protocol", "recordCi", i, null, "impl", () =>
        recordCi(item, {
          state: R.pick([...CI_STATES, "bogus"]),
          url: R.maybe(() => `https://ci.example.com/${R.word(6)}`),
          headSha: R.maybe(() => R.hex(40)),
        }, oracleNow));
      if (!unclean && R.bool(0.3)) {
        runOp("protocol", "notePullMerged", i, null, "impl",
          () => notePullMerged(item, R.hex(40), oracleNow));
      }
    }
  }
  return i;
}

// Independent canCloseWork predicate (from the docstring contract).
function oracleCanClose(o, item, reviewerId, { policy, reviewMembers, verifyMembers }) {
  const effective = policy ?? item.reviewPolicy ?? "self_attested";
  if (!DOCUMENTED_REVIEW_POLICIES.includes(effective)) return "impl"; // impl throws: programmer error
  if (item.state === "done" || item.state === "unclaimed" || item.owner === null) return false;
  if (typeof reviewerId !== "string" || reviewerId.length === 0) return false;
  if (effective === "self_attested") return reviewerId === item.owner;
  if (reviewerId === item.owner || item.supersededBy) return false;
  const basis = { version: 1, owner: item.owner, claimedAt: item.claimedAt,
    revision: item.revision ?? null, headSha: item.ci?.headSha ?? null };
  const review = item.reviews.find(e => e.memberId === reviewerId);
  if (review?.verdict !== "approve") return false;
  const rb = review.basis;
  if (!rb || !Object.keys(basis).every(k => rb[k] === basis[k])) return false;
  const attestation = item.attestations.find(e => e.memberId === reviewerId);
  if (!attestation || attestation.at !== review.at) return false;
  const reviewers = reviewMembers instanceof Set ? reviewMembers : new Set(reviewMembers ?? []);
  if (!reviewers.has(reviewerId)) return false;
  if (effective === "distinct_member") return true;
  const verifiers = verifyMembers instanceof Set ? verifyMembers : new Set(verifyMembers ?? []);
  return verifiers.has(reviewerId);
}

// --- phase 2: concurrent claims (interleaved agents) ---------------------------
function phaseConcurrency(rand) {
  const R = makeRng(rand);
  const agents = ["racer1", "racer2", "racer3"];
  let idx = 100_000;

  // 2a. N agents race to claim the same fresh item: exactly one winner.
  for (let round = 0; round < 60; round++) {
    idx++;
    oracleNow += R.int(1, 1000);
    const id = `race-${round}`;
    let item = createWork({ id }, { now: oracleNow, agentId: "system" });
    const order = [...agents].sort(() => R.rand() - 0.5);
    let winners = 0, winner = null;
    for (const agent of order) {
      idx++;
      const { threw, result } = runOp("concurrency", "race-claim", idx, null, "impl",
        () => claimWork(item, agent, { now: oracleNow }));
      if (!threw) { winners++; winner = agent; item = result; }
    }
    if (winners !== 1) {
      report.illegalAccepted++;
      recordFailure("concurrency", "race-claim", idx, `claim race: ${winners} winners, expected exactly 1`);
    }
    // 2b. losers cannot touch the winner's claim
    for (const loser of agents.filter(a => a !== winner)) {
      idx++;
      runOp("concurrency", "loser-update", idx, { state: "claimed", owner: winner },
        "reject", () => updateWork(item, loser, { state: "in_progress", now: oracleNow }));
      idx++;
      runOp("concurrency", "loser-renew", idx, { state: "claimed", owner: winner, active: true, leaseExpiresAt: Date.parse(item.leaseExpiresAt), leaseLapsed: false, claimedAt: item.claimedAt, kind: "work", revision: null, headSha: null, supersededBy: null, historyLen: claimHistoryLength(item) },
        "reject", () => renewWork(item, loser, { now: oracleNow }));
      idx++;
      runOp("concurrency", "loser-reassign", idx, { state: "claimed", owner: winner },
        "reject", () => reassignWork(item, loser, "racerX", { now: oracleNow }));
      idx++;
      runOp("concurrency", "loser-review-own", idx, null, "impl",
        () => recordReview(item, winner, { verdict: "approve", summary: "self review", now: oracleNow }));
      // owner reviewing own claim must throw (covered by verdictOf.review too, but assert here directly)
      const last = report.failures[report.failures.length - 1];
      void last;
    }
  }

  // 2c. optimistic-concurrency: stale appendPR reads must conflict.
  for (let round = 0; round < 120; round++) {
    idx++;
    oracleNow += R.int(1, 5000);
    const id = `occ-${round}`;
    const owner = "occ-owner";
    let item = claimWork(createWork({ id }, { now: oracleNow }), owner, { now: oracleNow });
    const o = new OracleClaim(id); o.syncFrom(item);
    const url = `https://github.com/acme/repo/pull/${1000 + round}`;
    // fresh read -> accept
    {
      idx++;
      const v = verdictOf.appendPR(o, owner, { url, expectedClaimedAt: o.claimedAt, expectedHistoryLength: o.historyLen });
      const { threw, result, unclean } = runOp("concurrency", "occ-fresh", idx, o, v,
        () => appendWorkPullRequest(item, owner, {
          pullRequest: url, expectedClaimedAt: o.claimedAt,
          expectedHistoryLength: o.historyLen, now: oracleNow }));
      if (!threw && !unclean) { o.syncFrom(result); item = result; }
    }
    // interleaving write changes history length
    if (R.bool(0.7)) {
      idx++;
      oracleNow += 1000;
      item = updateWork(item, owner, { note: "interleaving", now: oracleNow });
      o.syncFrom(item);
    }
    // stale read (pre-interleave values) -> must conflict
    {
      idx++;
      const staleLen = Math.max(0, o.historyLen - 1);
      const { threw } = runOp("concurrency", "occ-stale", idx, null, "impl",
        () => appendWorkPullRequest(item, owner, {
          pullRequest: url, expectedClaimedAt: o.claimedAt,
          expectedHistoryLength: staleLen, now: oracleNow }));
      if (!threw && staleLen !== o.historyLen) {
        report.illegalAccepted++;
        recordFailure("concurrency", "occ-stale", idx, "stale OCC write accepted");
      }
    }
    // duplicate URL with fresh read -> accepted no-op, history unchanged
    {
      idx++;
      const before = claimHistoryLength(item);
      const { threw, result, unclean } = runOp("concurrency", "occ-dup", idx, null, "impl",
        () => appendWorkPullRequest(item, owner, {
          pullRequest: url, expectedClaimedAt: o.claimedAt,
          expectedHistoryLength: o.historyLen, now: oracleNow }));
      if (!threw && !unclean && claimHistoryLength(result) !== before) {
        report.illegalAccepted++;
        recordFailure("concurrency", "occ-dup", idx, "duplicate PR link stamped history");
      }
    }
  }

  // 2d. release-then-reclaim: the next claimer starts clean.
  for (let round = 0; round < 60; round++) {
    idx++;
    oracleNow += R.int(1, 5000);
    const id = `rel-${round}`;
    let item = claimWork(createWork({ id, files: ["a/b.js"] }, { now: oracleNow }), "first", { now: oracleNow });
    item = attestWork(item, "second", { note: "hi", now: oracleNow });
    item = updateWork(item, "first", { state: "unclaimed", now: oracleNow });
    if (item.owner !== null || item.files.length !== 0 || item.attestations.length !== 0) {
      report.illegalAccepted++;
      recordFailure("concurrency", "release-clean", idx, "released claim kept owner/files/attestations");
    }
    idx++;
    const { threw, result } = runOp("concurrency", "reclaim", idx, null, "impl",
      () => claimWork(item, "second", { now: oracleNow }));
    if (!threw && (result.owner !== "second" || result.state !== "claimed")) {
      report.illegalAccepted++;
      recordFailure("concurrency", "reclaim", idx, "reclaim produced wrong owner/state");
    }
  }
  // 2e. history trim accounting: stamping past MAX_CLAIM_HISTORY keeps
  // history.length + historyOmitted == lifetime stamps, so the OCC check
  // (claimHistoryLength) never goes backwards.
  {
    idx++;
    oracleNow += 1000;
    let item = claimWork(createWork({ id: "trim-1" }, { now: oracleNow }), "trimmer", { now: oracleNow });
    const stamps = MAX_CLAIM_HISTORY + 50; // create(1) + claim(1) + N notes
    for (let s = 0; s < stamps; s++) {
      oracleNow += 1000;
      item = stampClaimHistory(item, "trimmer", { action: "noted", now: oracleNow });
    }
    const total = claimHistoryLength(item);
    const expected = 2 + stamps;
    const { unclean } = runOp("concurrency", "history-trim", idx, null, "impl", () => {
      if (item.history.length > MAX_CLAIM_HISTORY) throw new ClaimError("fuzz", "history exceeded cap");
      if (total !== expected) throw new ClaimError("fuzz", `history accounting drift: ${total} != ${expected}`);
      return true;
    });
    void unclean;
    // the trimmed item must still drive the OCC check monotonically
    idx++;
    const before = claimHistoryLength(item);
    item = updateWork(item, "trimmer", { note: "one more", now: oracleNow });
    if (claimHistoryLength(item) !== before + 1) {
      report.illegalAccepted++;
      recordFailure("concurrency", "history-trim-occ", idx, "claimHistoryLength not monotonic across trim boundary");
    }
  }
  return idx;
}

// --- phase 3: claim-coordination helpers (differential vs independent oracles) -
function phaseCoordination(rand) {
  const R = makeRng(rand);
  let idx = 200_000;

  // 3a. parsePullRequestUrl: differential vs independent regex oracle
  for (let k = 0; k < 1500; k++) {
    idx++;
    const raw = R.pick([
      `https://github.com/${R.word(4)}/${R.word(5)}/pull/${R.int(1, 99999)}`,
      `https://github.com/${R.word(4)}/${R.word(5)}/pull/${R.int(1, 99999)}/`,
      `https://github.com/a/b/pull/${R.int(1, 999)}?q=1`,
      `https://github.com/a/b/pull/${R.int(1, 999)}#frag`,
      `http://github.com/a/b/pull/1`,
      `https://github.com/a/b/pull/0`,
      `https://user:pass@github.com/a/b/pull/1`,
      `https://github.com:443/a/b/pull/1`,
      `https://gitlab.com/a/b/pull/1`,
      R.word(R.int(0, 40)), "", null, 42,
    ]);
    const expected = (() => {
      if (!isCanonicalPullUrl(raw)) return null;
      const u = new URL(String(raw).trim());
      const path = u.pathname.length > 1 && u.pathname.endsWith("/") ? u.pathname.slice(0, -1) : u.pathname;
      const m = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/([1-9]\d{0,9})$/.exec(path);
      return m ? { url: `https://github.com/${m[1]}/${m[2]}/pull/${m[3]}`, repo: `${m[1]}/${m[2]}`, number: Number(m[3]) } : null;
    })();
    const { threw, result, unclean } = runOp("coordination", "parsePullRequestUrl", idx, null, "impl",
      () => parsePullRequestUrl(raw));
    if (!threw && !unclean) {
      const got = result === null ? null : { url: result.url, repo: result.repo, number: result.number };
      if (JSON.stringify(got) !== JSON.stringify(expected)) {
        report.illegalAccepted++;
        recordFailure("coordination", "parsePullRequestUrl", idx, `mismatch for ${JSON.stringify(String(raw)).slice(0, 80)}: got ${JSON.stringify(got)} want ${JSON.stringify(expected)}`);
      }
    }
  }

  // 3b. webhook / API outcomes
  for (let k = 0; k < 800; k++) {
    idx++;
    const action = R.pick(["closed", "opened", "reopened", "synchronize", undefined]);
    const merged = R.pick([true, false, undefined]);
    const payload = R.bool(0.9) ? { action, pull_request: { html_url: `https://github.com/a/b/pull/${R.int(1, 99)}`, merged } } : R.pick([null, {}, { action: "closed" }]);
    const exp = payload && typeof payload === "object" && payload.action === "closed" &&
      payload.pull_request && typeof payload.pull_request === "object" &&
      isCanonicalPullUrl(payload.pull_request.html_url)
      ? { outcome: payload.pull_request.merged === true ? "merged" : "closed" } : null;
    const { threw, result, unclean } = runOp("coordination", "webhookOutcome", idx, null, "impl",
      () => pullRequestOutcomeFromWebhook(payload));
    if (!threw && !unclean && (result === null) !== (exp === null)) {
      report.illegalAccepted++;
      recordFailure("coordination", "webhookOutcome", idx, `null-ness mismatch: got ${JSON.stringify(result)?.slice(0, 80)}`);
    }
    if (!threw && !unclean && result && exp && result.outcome !== exp.outcome) {
      report.illegalAccepted++;
      recordFailure("coordination", "webhookOutcome", idx, `outcome mismatch: got ${result.outcome} want ${exp.outcome}`);
    }
  }
  for (let k = 0; k < 800; k++) {
    idx++;
    const body = R.pick([
      { merged: true, state: "closed" }, { merged: false, state: "closed" },
      { merged: false, state: "open" }, {}, null, "str", [],
    ]);
    const exp = !body || typeof body !== "object" || Array.isArray(body) ? "open"
      : body.merged === true ? "merged" : body.state === "closed" ? "closed" : "open";
    const { threw, result, unclean } = runOp("coordination", "apiOutcome", idx, null, "impl",
      () => pullRequestOutcomeFromApi(body));
    if (!threw && !unclean && result !== exp) {
      report.illegalAccepted++;
      recordFailure("coordination", "apiOutcome", idx, `got ${result} want ${exp}`);
    }
  }

  // 3c. settlePullRequest on random claims
  for (let k = 0; k < 1200; k++) {
    idx++;
    oracleNow += R.int(1, 1000);
    const id = `settle-${k}`;
    const withPR = R.bool(0.8);
    let item = createWork({ id }, { now: oracleNow });
    if (withPR) item = claimWork(item, "w1", { now: oracleNow });
    if (R.bool(0.5) && withPR) item = updateWork(item, "w1", { state: "in_progress", now: oracleNow });
    if (R.bool(0.2)) { try { item = updateWork(item, withPR ? "w1" : "system", { state: "done", now: oracleNow }); } catch { /* non-owner done: refused, keep item */ } }
    if (withPR) {
      try {
        item = appendWorkPullRequest(item, "w1", {
          pullRequest: `https://github.com/a/b/pull/${R.int(1, 999)}`,
          expectedClaimedAt: item.claimedAt, expectedHistoryLength: claimHistoryLength(item), now: oracleNow });
      } catch { /* lapsed lease etc: fine */ }
    }
    const outcome = R.pick(["merged", "closed", "open", "bogus"]);
    const live = ["claimed", "in_progress", "blocked"].includes(item.state);
    const ready = item.pullRequests?.length > 0 && item.pullRequests.every(p => p.outcome === "merged" || p.outcome === "closed");
    const shouldSettle = live && ready && (outcome === "merged" || outcome === "closed");
    const { threw, result, unclean } = runOp("coordination", "settlePullRequest", idx, null, "impl",
      () => settlePullRequest(item, outcome, oracleNow));
    if (threw || unclean) continue;
    if (shouldSettle && result === null) {
      report.legalRejected++;
      recordFailure("coordination", "settlePullRequest", idx, "should settle but returned null");
    } else if (!shouldSettle && result !== null) {
      report.illegalAccepted++;
      recordFailure("coordination", "settlePullRequest", idx, `settled when it should not (state=${item.state}, outcome=${outcome})`);
    } else if (result !== null) {
      const wantState = outcome === "merged" ? "done" : "unclaimed";
      if (result.item.state !== wantState) {
        report.illegalAccepted++;
        recordFailure("coordination", "settlePullRequest", idx, `wrong end state ${result.item.state} for ${outcome}`);
      }
      if (outcome === "closed" && (result.item.owner !== null || result.item.leaseExpiresAt !== null)) {
        report.illegalAccepted++;
        recordFailure("coordination", "settlePullRequest", idx, "closed PR did not clear owner/lease");
      }
    }
  }

  // 3d. fileLeaseConflicts: differential vs independent oracle
  for (let k = 0; k < 800; k++) {
    idx++;
    const n = R.int(1, 5);
    const items = [];
    for (let j = 0; j < n; j++) {
      items.push({
        id: `f-${k}-${j}`,
        state: R.pick(["claimed", "in_progress", "blocked", "unclaimed", "done"]),
        owner: `o${j}`,
        files: Array.from({ length: R.int(0, 3) }, () => `src/${R.word(3)}.js`),
        fileBlocks: {},
        leaseExpiresAt: null,
      });
      for (const f of items[j].files) if (R.bool(0.4)) items[j].fileBlocks[f] = `block-${R.int(1, 2)}`;
    }
    const claimed = { id: "f-want", files: Array.from({ length: R.int(0, 3) }, () => `src/${R.word(3)}.js`), fileBlocks: {} };
    for (const f of claimed.files) if (R.bool(0.4)) claimed.fileBlocks[f] = `block-${R.int(1, 2)}`;
    const expected = oracleFileConflicts(items, claimed);
    const { threw, result, unclean } = runOp("coordination", "fileLeaseConflicts", idx, null, "impl",
      () => fileLeaseConflicts(items, claimed));
    if (!threw && !unclean && JSON.stringify(result) !== JSON.stringify(expected)) {
      report.illegalAccepted++;
      recordFailure("coordination", "fileLeaseConflicts", idx, `got ${JSON.stringify(result).slice(0, 160)} want ${JSON.stringify(expected).slice(0, 160)}`);
    }
  }

  // 3e. readyClaims + rateLimitUntil + rollupClaimCi
  for (let k = 0; k < 600; k++) {
    idx++;
    const n = R.int(1, 6);
    const items = [];
    for (let j = 0; j < n; j++) {
      items.push({ id: `r-${k}-${j}`, state: R.pick(["unclaimed", "claimed", "done"]), owner: R.bool(0.5) ? `o${j}` : null,
        dependsOn: R.bool(0.5) ? [`r-${k}-${R.int(0, n - 1)}`] : [] });
    }
    const byId = new Map(items.map(x => [x.id, x]));
    const expected = items.filter(x => x.state === "unclaimed" && !x.owner &&
      (x.dependsOn || []).every(d => byId.get(d)?.state === "done"))
      .sort((a, b) => (a.id < b.id ? -1 : 1)).map(x => x.id);
    const { threw, result, unclean } = runOp("coordination", "readyClaims", idx, null, "impl",
      () => readyClaims(items));
    if (!threw && !unclean && JSON.stringify(result.map(x => x.id)) !== JSON.stringify(expected)) {
      report.illegalAccepted++;
      recordFailure("coordination", "readyClaims", idx, "ready set mismatch");
    }
  }
  for (let k = 0; k < 600; k++) {
    idx++;
    const status = R.pick([429, 403, 200, 500]);
    const remaining = R.pick(["0", "10", undefined]);
    const message = R.pick(["rate limit exceeded", "forbidden", undefined]);
    const reset = R.pick([undefined, String(Math.floor(oracleNow / 1000) + 120), "bogus"]);
    const retryAfter = R.pick([undefined, "30", "bogus"]);
    const limited = status === 429 || (status === 403 && (remaining === "0" || /rate limit/i.test(message ?? "")));
    let expected = null;
    if (limited) {
      expected = oracleNow + 60_000;
      if (typeof reset === "string" && /^\d+$/.test(reset.trim())) {
        const v = Number(reset.trim()); expected = v > 1e12 ? v : v * 1000;
      } else if (typeof retryAfter === "string" && /^\d+$/.test(retryAfter.trim())) {
        expected = oracleNow + Number(retryAfter.trim()) * 1000;
      }
      if (expected <= oracleNow) expected = oracleNow + 60_000;
    }
    const { threw, result, unclean } = runOp("coordination", "rateLimitUntil", idx, null, "impl",
      () => rateLimitUntil({ status, remaining, reset, retryAfter, message }, oracleNow));
    if (!threw && !unclean && result !== expected) {
      report.illegalAccepted++;
      recordFailure("coordination", "rateLimitUntil", idx, `got ${result} want ${expected}`);
    }
  }
  for (let k = 0; k < 600; k++) {
    idx++;
    const checkRuns = Array.from({ length: R.int(0, 5) }, () =>
      ({ conclusion: R.pick(["success", "failure", "cancelled", "timed_out", "action_required", "neutral", "skipped", "in_progress", null]) }));
    const status = R.bool(0.5) ? { total_count: R.int(0, 3), state: R.pick(["success", "failure", "error", "pending"]) } : null;
    // Independent oracle from the documented rule: "A failure wins. Anything
    // still running stays pending. All-success is success. Only neutral or
    // skipped signals, or no signal at all, is neutral."
    let failure = false, pending = false, success = 0;
    for (const r of checkRuns) {
      const c = r?.conclusion ?? null;
      if (["failure", "cancelled", "timed_out", "action_required"].includes(c)) failure = true;
      else if (c === "success") success++;
      else if (!["neutral", "skipped"].includes(c)) pending = true;
    }
    const total = status && typeof status === "object" ? Number(status.total_count) : 0;
    if (Number.isFinite(total) && total > 0) {
      if (status.state === "failure" || status.state === "error") failure = true;
      else if (status.state === "success") success++;
      else pending = true;
    }
    const exp = failure ? "failure" : pending ? "pending" : success > 0 ? "success" : "neutral";
    const { threw, result, unclean } = runOp("coordination", "rollupClaimCi", idx, null, "impl",
      () => rollupClaimCi({ status, checkRuns }));
    if (!threw && !unclean && result.state !== exp) {
      report.illegalAccepted++;
      recordFailure("coordination", "rollupClaimCi", idx, `got ${result.state} want ${exp}`);
    }
  }
  return idx;
}

// Independent file-lease conflict oracle (from the documented rule:
// same path; a block-less slot conflicts with any slot on the path;
// two blocked slots conflict only on the same block).
function oracleFileConflicts(items, claimed) {
  const slots = it => {
    const blocks = it?.fileBlocks && typeof it.fileBlocks === "object" ? it.fileBlocks : {};
    return (it?.files ?? []).filter(f => typeof f === "string").map(path => ({
      path, block: typeof blocks[path] === "string" && blocks[path].length > 0 ? blocks[path] : null,
    }));
  };
  const conflict = (a, b) => a.path === b.path && (!a.block || !b.block || a.block === b.block);
  const wanted = slots(claimed);
  if (!wanted.length) return [];
  const out = [];
  for (const item of items ?? []) {
    if (!item || item.id === claimed.id) continue;
    if (!["claimed", "in_progress", "blocked"].includes(item.state)) continue;
    const files = [...new Set(slots(item).filter(h => wanted.some(w => conflict(w, h)))
      .map(s => (s.block ? `${s.path} (${s.block})` : s.path)))].sort();
    if (files.length) out.push({ holder: { claimId: item.id, owner: item.owner ?? null }, files, leaseExpiresAt: item.leaseExpiresAt ?? null });
  }
  out.sort((a, b) => (a.holder.claimId < b.holder.claimId ? -1 : 1));
  return out;
}

// --- phase 4: sqlite persistence round-trip -----------------------------------
function phaseSqlite(rand) {
  const R = makeRng(rand);
  let idx = 300_000;
  const db = new DatabaseSync(":memory:");
  db.exec(workClaimSchema);
  const registry = createDurableWorkClaimRegistry(db, { now: () => oracleNow });
  const roomId = "fuzz-room";

  // 4a. random items survive set -> get -> workOf with fields intact
  for (let k = 0; k < 700; k++) {
    idx++;
    oracleNow += R.int(1, 1000);
    const id = `sql-${k}`;
    let item = createWork({ id, title: `title ${k}` }, { now: oracleNow, agentId: "sq" });
    if (R.bool(0.7)) {
      try { item = claimWork(item, R.pick(["sq", "sq2"]), { leaseHours: R.pick([1, 24, null]), now: oracleNow }); } catch { /* invalid: skip */ }
    }
    if (R.bool(0.4) && item.owner) {
      try { item = updateWork(item, item.owner, { state: R.pick(["in_progress", "blocked"]), now: oracleNow }); } catch { /* skip */ }
    }
    idx++;
    // validate via a pure read that runs workOf internally: our own writes
    // must always validate (the registry docstring: a row is never trusted
    // without passing through the state machine first)
    const { threw, result, unclean } = runOp("sqlite", "roundtrip", idx, null, "impl", () => {
      registry.set(roomId, item);
      const back = registry.get(roomId, id);
      isLeaseExpired(back, oracleNow);
      return back;
    });
    if (!threw && !unclean) {
      for (const field of ["id", "state", "owner", "kind", "claimedAt", "leaseExpiresAt"]) {
        if (JSON.stringify(result[field] ?? null) !== JSON.stringify(item[field] ?? null)) {
          report.illegalAccepted++;
          recordFailure("sqlite", "roundtrip", idx, `field ${field} changed: ${JSON.stringify(item[field])} -> ${JSON.stringify(result[field])}`);
          break;
        }
      }
    }
  }

  // 4b. corrupted rows decode cleanly. The must-reject set is exactly what the
  // documented contract rejects: malformed JSON (SyntaxError), non-objects
  // (Error), and rows failing workOf's real validation (ClaimError: bad id,
  // bad state, ...). workOf is DELIBERATELY lenient about owner type and
  // history shape (coerced, not rejected — "rows written by older code still
  // load"), so those are not in the must-reject set.
  // Corrupt rows live in their own room so they cannot poison the list()
  // reads of the other phases.
  const corruptRoom = "fuzz-room-corrupt";
  const corruptions = [
    "{not json", "", "null", "[]", "42", '{"id":1}',
    JSON.stringify({ id: "c1", state: "bogus-state" }),
    JSON.stringify({ id: "c1", claimedAt: "not-a-date" }),
  ];
  for (const raw of corruptions) {
    for (let rep = 0; rep < 20; rep++) {
      idx++;
      const id = `corrupt-${idx}`;
      // Storage-layer contract (tests/persisted-row.test.js pins it): a
      // corrupt row must be REJECTED — any Error throw (SyntaxError from
      // JSON.parse, Error from decodeRow, ClaimError from workOf) is a clean
      // rejection. The bug would be accepting a corrupt row as a valid claim.
      let threw = null, back = "unset";
      const started = performance.now();
      try {
        db.prepare("INSERT INTO work_claims (room_id, claim_id, item_json, updated_at) VALUES (?,?,?,?)")
          .run(corruptRoom, id, raw, oracleNow);
        back = registry.get(corruptRoom, id);
        if (back !== null) isLeaseExpired(back, oracleNow); // workOf validation
      } catch (e) { threw = e; }
      const ms = performance.now() - started;
      report.ops++;
      if (ms > maxMs) { report.slow++; recordFailure("sqlite", "corrupt", idx, `slow: ${ms.toFixed(0)}ms`); }
      if (!threw && back !== null) {
        report.illegalAccepted++;
        recordFailure("sqlite", "corrupt", idx, `corrupt row accepted as a valid claim: ${JSON.stringify(raw).slice(0, 60)}`);
      }
      if (threw && !(threw instanceof Error)) {
        report.unclean++;
        recordFailure("sqlite", "corrupt", idx, `non-Error throw: ${threw}`);
      }
    }
  }

  // 4c. list/has/delete/configure smoke
  for (let k = 0; k < 100; k++) {
    idx++;
    const { unclean } = runOp("sqlite", "registry-ops", idx, null, "impl", () => {
      const id = `ops-${k}`;
      const item = createWork({ id }, { now: oracleNow });
      registry.set(roomId, item);
      if (!registry.has(roomId, id)) throw new ClaimError("fuzz", "has() missed a stored claim");
      const listed = registry.list(roomId);
      if (!listed.some(x => x.id === id)) throw new ClaimError("fuzz", "list() missed a stored claim");
      registry.delete(roomId, id);
      if (registry.has(roomId, id)) throw new ClaimError("fuzz", "delete() did not remove the claim");
      if (registry.get(roomId, id) !== null) throw new ClaimError("fuzz", "get() after delete not null");
      const cfg = registry.configure(roomId, R.bool(0.5) ? { defaultLeaseHours: R.int(1, 100) } : null);
      if (!(cfg.defaultLeaseHours >= 1 && cfg.defaultLeaseHours <= 168)) throw new ClaimError("fuzz", "bad config");
      return true;
    });
    void unclean;
  }
  db.close();
  return idx;
}

// --- main ---------------------------------------------------------------------
function parseArgs(argv) {
  const out = { seed: 20261006, iterations: 10000, budgetMs: 480000, maxMs: 1000, quiet: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--seed") out.seed = Number(argv[++i]);
    else if (a === "--iterations") out.iterations = Number(argv[++i]);
    else if (a === "--budget-ms") out.budgetMs = Number(argv[++i]);
    else if (a === "--max-ms") out.maxMs = Number(argv[++i]);
    else if (a === "--quiet") out.quiet = true;
    else if (a === "--json") out.json = true;
    else { console.error(`unknown arg ${a}`); process.exit(2); }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  maxMs = args.maxMs;

  // 0. doc/code drift gate: the implementation's exported TRANSITIONS must
  // equal the documented table the oracle was built from.
  if (JSON.stringify(TRANSITIONS) !== JSON.stringify(DOCUMENTED_TRANSITIONS)) {
    report.illegalAccepted++;
    recordFailure("gate", "transitions-drift", 0,
      `TRANSITIONS export drifted from the documented table: ${JSON.stringify(TRANSITIONS)}`);
  }
  for (const [name, got, want] of [
    ["STATES", STATES, ["unclaimed", "claimed", "in_progress", "blocked", "done"]],
    ["DELIVERY_MODES", DELIVERY_MODES, DOCUMENTED_DELIVERY_MODES],
    ["REVIEW_POLICIES", REVIEW_POLICIES, DOCUMENTED_REVIEW_POLICIES],
    ["REVIEW_VERDICTS", REVIEW_VERDICTS, ["approve", "changes_requested", "comment"]],
    ["CLAIM_KINDS", CLAIM_KINDS, ["work", "land", "deploy"]],
    ["CI_STATES", CI_STATES, ["pending", "success", "failure", "neutral"]],
    ["ACTIVE_CLAIM_STATES", ACTIVE_CLAIM_STATES, ["claimed", "in_progress", "blocked"]],
    ["MAX_LEASE_HOURS", MAX_LEASE_HOURS, 168],
  ]) {
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      report.illegalAccepted++;
      recordFailure("gate", "enum-drift", 0, `${name} drifted: ${JSON.stringify(got)}`);
    }
  }

  const rand = mulberry32(args.seed);
  const t0 = Date.now();
  const nProtocol = phaseProtocol(rand, args.iterations, args.budgetMs);
  const t1 = Date.now();
  phaseConcurrency(rand);
  const t2 = Date.now();
  phaseCoordination(rand);
  const t3 = Date.now();
  phaseSqlite(rand);
  const t4 = Date.now();

  const failed = report.legalRejected + report.illegalAccepted + report.unclean;
  const summary = {
    seed: args.seed,
    ops: report.ops,
    protocolOps: nProtocol,
    illegalAccepted: report.illegalAccepted,
    legalRejected: report.legalRejected,
    unclean: report.unclean,
    slow: report.slow,
    ms: { protocol: t1 - t0, concurrency: t2 - t1, coordination: t3 - t2, sqlite: t4 - t3, total: t4 - t0 },
    failures: report.failures,
    pass: failed === 0,
  };
  if (args.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    if (!args.quiet) {
      console.log(`work-claims fuzz: seed=${args.seed} ops=${report.ops} (protocol ${nProtocol})`);
      console.log(`  illegal accepted: ${report.illegalAccepted}`);
      console.log(`  legal rejected:   ${report.legalRejected}`);
      console.log(`  unclean throws:   ${report.unclean}`);
      console.log(`  slow ops:         ${report.slow}`);
      console.log(`  wall: protocol=${t1 - t0}ms concurrency=${t2 - t1}ms coordination=${t3 - t2}ms sqlite=${t4 - t3}ms`);
      for (const f of report.failures) console.log(`  FAIL [${f.phase}] ${f.op}#${f.index}: ${f.detail}`);
    } else {
      console.log(`ops=${report.ops} illegalAccepted=${report.illegalAccepted} legalRejected=${report.legalRejected} unclean=${report.unclean} pass=${failed === 0}`);
    }
  }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(e => { console.error("fuzzer crashed:", e); process.exit(2); });
