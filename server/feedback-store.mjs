// Feedback endpoint core: validation, dedup/clustering, Mark-staked triage
// economics, filer lifecycle (credit loop, appeals, reviewer economics,
// cluster velocity, severity routing).
// Production port of ~/workspace/feedback-endpoint/feedback.mjs (spec:
// docs/feedback-endpoint.md). Pure module in the repo's conventions:
// injected clock, caller-owned state, frozen outputs, domain errors thrown
// (no HTTP status); the HTTP mapping lives in server/feedback-routes.mjs.
//
// The Jev triage-advisor seam is deliberately NOT wired here (owner call:
// leave Jev open, build without it). Triage is lane-operated; the advisor
// interface is documented in docs/feedback-endpoint.md §5 for a future slice.
//
// Anti-spam design (the load-bearing question): junk must have a price and
// signal must earn. Filing costs Mark standing; accepted-as-real refunds the
// cost and pays a reward; duplicates cost nothing (encourages filing even when
// unsure); rejected-as-junk keeps the cost and counts toward suspension.
// A mandatory machine-checkable repro (request/response pair) is the quality
// gate — most junk cannot produce one. This mirrors the Round-1 optimistic-
// verification winner: honest-equilibrium cost ~$0, adversarial cost real.

import { createHash } from "node:crypto";
import { scrubString, scrubAttempt } from "./feedback-scrub.mjs";

export const SEVERITIES = Object.freeze(["bug", "missing-feature", "docs", "perf"]);
export const FEEDBACK_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

// Snapshot format version (server/feedback-persistence.mjs). Bump on any
// change that an older reader could not understand; unknown versions are
// dropped rather than mis-read.
export const SNAPSHOT_VERSION = 1;

// Mark economics. Small on purpose: the price is a filter, not a toll.
export const MARK_FILING_COST = 1;      // debited on every non-duplicate filing
export const MARK_ACCEPT_REWARD = 5;    // credited when triage accepts as real
export const MARK_JUNK_SUSPEND_AFTER = 20; // filings window for junk-rate check
export const MARK_JUNK_SUSPEND_RATE = 0.5; // junk rate that suspends new filings

// Filer lifecycle economics (see SPEC.md §7).
export const MARK_MERGE_BONUS = 10;       // filer bonus when promoted feedback ships
export const MARK_APPEAL_COST = 1;       // debited on appeal, refunded if overturned
export const MARK_REVIEWER_CONFIRMED = 2; // reviewer reward per outcome-confirmed verdict
export const MARK_REVIEWER_MISVERDICT = 3;// reviewer deduction per overturned verdict
export const APPEAL_WINDOW_MS = 72 * 3600 * 1000;   // one appeal per filing, within 72h
export const PROMOTED_STALE_MS = 60 * 24 * 3600 * 1000; // promoted, never shipped
export const CLUSTER_FAST_TRACK_PER_DAY = 5;   // heat ≥ 5/day → triage fast-track
export const CLUSTER_SEVERITY_BUMP_PER_DAY = 25; // heat ≥ 25/day → severity escalation
export const CLUSTER_FILEDAT_CAP = 500;          // per-cluster filing timestamps kept

// Severity routing: not every real verdict is a bug task.
export const ROUTE_FOR_SEVERITY = Object.freeze({
  bug: "task", perf: "task", "missing-feature": "proposal", docs: "docs-fix",
});
export const routeForSeverity = s => ROUTE_FOR_SEVERITY[s] ?? "task";

class FeedbackError extends Error {
  constructor(code, message) { super(message); this.name = "FeedbackError"; this.code = code; }
}
export { FeedbackError };
const fail = (code, message) => { throw new FeedbackError(code, message); };
const check = (cond, code, message) => { if (!cond) fail(code, message); };

const isPlainObject = v => typeof v === "object" && v !== null && !Array.isArray(v);
const isNonEmptyString = (v, max = 4000) => typeof v === "string" && v.length > 0 && v.length <= max;

// Normalize a path template: /api/rooms/abc123/work-claims -> /api/rooms/{id}/work-claims
// Only segments that look like IDs (contain a digit, length >= 4) are
// normalized — real words like "work-claims" have no digits and survive.
// Query strings are stripped: tokens hide in ?api_key= params, and volatile
// query params must not split clusters of the same bug.
export function normalizePath(path) {
  return String(path).split("?")[0].split("/").map(seg => {
    if (/^\{.*\}$/.test(seg)) return seg; // already templated
    return /^(?=.*[0-9])[A-Za-z0-9_-]{4,}$/.test(seg) ? "{id}" : seg;
  }).join("/");
}

// Error signature: status + first stable error code/message fragment.
function errorSignature(response) {
  if (!isPlainObject(response)) return "no-response";
  const status = response.status ?? "?";
  const body = response.body;
  let code = "";
  if (isPlainObject(body)) code = body.code ?? body.error ?? "";
  else if (typeof body === "string") code = body.slice(0, 80);
  return `${status}:${String(code).slice(0, 120)}`;
}

// Dedup key: sha256 of method + normalized path + error signature.
export function dedupKey({ method, path, response }) {
  const canon = `${String(method).toUpperCase()} ${normalizePath(path)} :: ${errorSignature(response)}`;
  return createHash("sha256").update(canon).digest("hex").slice(0, 32);
}

function validateAgent(agent) {
  check(isPlainObject(agent), "invalid_agent", "agent must be an object");
  check(isNonEmptyString(agent.lane, 64), "invalid_agent", "agent.lane required");
  // Signed card reference: either a card URI or an inline key id. One of the two.
  check(isNonEmptyString(agent.card_uri, 512) || isNonEmptyString(agent.key_id, 128),
    "invalid_agent", "agent.card_uri or agent.key_id required (signed identity reference)");
  if (agent.card_uri !== undefined) {
    check(/^https:\/\/[^/]+(\/.*)?$/.test(agent.card_uri), "invalid_agent", "agent.card_uri must be https");
  }
  return Object.freeze({ lane: agent.lane, card_uri: agent.card_uri ?? null, key_id: agent.key_id ?? null });
}

function validateAttempt(attempt) {
  check(isPlainObject(attempt), "invalid_repro", "attempt must be an object");
  check(isNonEmptyString(attempt.goal, 2000), "invalid_repro", "attempt.goal required: what the agent tried to do");
  // The load-bearing gate: a machine-checkable request/response pair.
  check(isPlainObject(attempt.request), "invalid_repro", "attempt.request required (the request as sent)");
  check(isPlainObject(attempt.response), "invalid_repro", "attempt.response required (the response as received)");
  check(isNonEmptyString(attempt.request.method, 16), "invalid_repro", "attempt.request.method required");
  check(isNonEmptyString(attempt.request.path, 512), "invalid_repro", "attempt.request.path required");
  return Object.freeze({
    goal: attempt.goal,
    request: Object.freeze({ ...attempt.request }),
    response: Object.freeze({ ...attempt.response }),
  });
}

export function validateFeedback(input) {
  check(isPlainObject(input), "invalid_feedback", "body must be an object");
  const agent = validateAgent(input.agent);
  check(isPlainObject(input.endpoint), "invalid_feedback", "endpoint must be an object");
  check(isNonEmptyString(input.endpoint.method, 16), "invalid_feedback", "endpoint.method required");
  check(isNonEmptyString(input.endpoint.path, 512), "invalid_feedback", "endpoint.path required");
  const attempt = validateAttempt(input.attempt);
  check(isNonEmptyString(input.observed, 4000), "invalid_feedback", "observed required: what happened");
  check(isNonEmptyString(input.expected, 4000), "invalid_feedback", "expected required: what should have happened");
  check(SEVERITIES.includes(input.severity), "invalid_feedback",
    `severity must be one of ${SEVERITIES.join("|")}`);
  return Object.freeze({
    agent,
    endpoint: Object.freeze({ method: input.endpoint.method.toUpperCase(), path: input.endpoint.path,
      service: input.endpoint.service ?? "project-room" }),
    attempt, observed: input.observed, expected: input.expected, severity: input.severity,
  });
}

// Store: items + clusters + per-lane Mark ledger + lifecycle state.
// Caller-owned Maps, time injected.
//
// Authority (H-2): triage and outcome recording move Mark, so they are gated
// on caller-supplied authority:
//   - isReviewer(lane): who may triage / decide appeals. Enforced in
//     triage() and decideAppeal().
//   - isReleaseAuthority(lane): who may record "merged"/"adopted" outcomes.
//     Enforced in recordOutcome().
//   - verifyMergeRef(ref): optional sync hook verifying a "merged" ref
//     against the actual merge record (commit/PR). When absent, the release
//     authority gate is the protection; production wiring should verify refs.
// Each accepts a predicate function or an iterable of authorized lanes.
// When omitted, the legacy behavior applies (any non-empty lane string) —
// the HTTP route applies its own member/guest auth, and the store stays a
// pure library. Production wiring MUST configure reviewer and release
// authority from room roles; without it any room member can triage and mint
// Mark via self-reported merges.
// state: optional snapshot to restore (REL-25 durable persistence).
export function createFeedbackStore({ now, state, isReviewer, isReleaseAuthority, verifyMergeRef } = {}) {
  const clock = now ?? (() => Date.now());
  const toPredicate = (value, name) => {
    if (value === undefined) return lane => isNonEmptyString(lane, 64);
    if (typeof value === "function") return value;
    // NB: strings are iterable but are never a lane set — a bare string here
    // would silently become a set of characters, so it is rejected.
    if (typeof value !== "string" && value !== null && typeof value[Symbol.iterator] === "function") {
      const set = new Set(value);
      return lane => set.has(lane);
    }
    throw new FeedbackError("invalid_authority", `${name} must be a predicate or an iterable of lanes`);
  };
  const reviewerOk = toPredicate(isReviewer, "isReviewer");
  const releaseOk = toPredicate(isReleaseAuthority, "isReleaseAuthority");
  if (verifyMergeRef !== undefined && typeof verifyMergeRef !== "function") {
    throw new FeedbackError("invalid_authority", "verifyMergeRef must be a function");
  }
  const items = new Map();    // feedbackId -> item
  const clusters = new Map(); // dedupKey -> { key, firstId, count, severity, status, filedAt[], heat, priority }
  const marks = new Map();    // lane -> { balance, filings: [bool junk], suspended }
  const notifications = new Map(); // lane -> [{ seq, at, type, ... }] (drain-on-read)
  const reviewers = new Map();     // lane -> { decided, confirmed, wrong, stale }

  // Rehydration from a durable snapshot (server/feedback-persistence.mjs).
  // Still a pure module: the caller owns the bytes and passes them in; we
  // only read them. Entries arrive as plain objects (JSON round-trip), which
  // is exactly what the mutators below expect - frozen shapes are built at
  // the read boundary, never stored.
  const restore = (map, entries) => {
    if (!Array.isArray(entries)) return;
    for (const entry of entries) {
      if (!Array.isArray(entry) || entry.length !== 2) continue;
      map.set(entry[0], entry[1]);
    }
  };
  restore(items, state?.items);
  restore(clusters, state?.clusters);
  restore(marks, state?.marks);
  restore(notifications, state?.notifications);
  restore(reviewers, state?.reviewers);
  let seq = Number.isInteger(state?.seq) ? state.seq : 0;
  let notifSeq = Number.isInteger(state?.notifSeq) ? state.notifSeq : 0;

  const markFor = lane => {
    if (!marks.has(lane)) marks.set(lane, { balance: 10, filings: [], suspended: false });
    return marks.get(lane);
  };

  const reviewerFor = lane => {
    if (!reviewers.has(lane)) reviewers.set(lane, { decided: 0, confirmed: 0, wrong: 0, stale: 0 });
    return reviewers.get(lane);
  };

  // Room-native notifications: a lane polls GET /api/feedback/notifications.
  // Production mounting: mirror into the room's activity-inbox (journal entry
  // mentioning the filer lane) — see SPEC.md §7.1.
  const notify = (lane, type, data = {}) => {
    if (!notifications.has(lane)) notifications.set(lane, []);
    notifications.get(lane).push(Object.freeze({
      seq: ++notifSeq, at: new Date(clock()).toISOString(), type, ...data,
    }));
  };

  // Junk-rate suspension check, shared by triage and appeal-uphold.
  const checkSuspension = mark => {
    const recent = mark.filings.slice(-MARK_JUNK_SUSPEND_AFTER);
    const junkRate = recent.length ? recent.filter(Boolean).length / recent.length : 0;
    if (recent.length >= 5 && junkRate >= MARK_JUNK_SUSPEND_RATE) mark.suspended = true;
  };

  // Cluster velocity: filings in the trailing 24h.
  const heatOf = (cluster, nowMs) =>
    cluster.filedAt.reduce((n, t) => n + (nowMs - t <= 24 * 3600 * 1000 ? 1 : 0), 0);

  const applyVelocity = cluster => {
    const nowMs = clock();
    cluster.filedAt.push(nowMs);
    if (cluster.filedAt.length > CLUSTER_FILEDAT_CAP) {
      cluster.filedAt.splice(0, cluster.filedAt.length - CLUSTER_FILEDAT_CAP);
    }
    cluster.heat = heatOf(cluster, nowMs);
    if (cluster.heat >= CLUSTER_SEVERITY_BUMP_PER_DAY) {
      cluster.priority = "fast-track";
      // A "docs gap" hitting 25 agents/day is not a docs gap — it's a product bug.
      if (cluster.severity === "docs") cluster.escalatedSeverity = "bug";
      // A missing feature 25 agents/day trip over is demand signal, not just a wish.
      if (cluster.severity === "missing-feature") cluster.demandSignal = true;
    } else if (cluster.heat >= CLUSTER_FAST_TRACK_PER_DAY) {
      cluster.priority = "fast-track";
    }
  };

  // Promotion payload shared by triage-real and appeal-overturn.
  const buildPromotedTask = (item, cluster) => {
    const route = routeForSeverity(item.severity);
    const base = {
      title: `[feedback] ${item.severity}: ${item.endpoint.method} ${normalizePath(item.endpoint.path)}`,
      severity: item.severity,
      route, // task | proposal | docs-fix
      feedbackIds: Object.freeze([item.id]),
      clusterKey: item.clusterKey,
      clusterCount: cluster.count,
      repro: item.attempt,
    };
    if (route === "proposal") {
      // missing-feature never becomes a bug task: it becomes a structured
      // proposal/RFC the room can discuss, with the evidence attached.
      return Object.freeze({ ...base,
        proposal: Object.freeze({
          problem: item.observed,
          suggestedShape: item.expected,
          evidence: Object.freeze({ feedbackIds: base.feedbackIds, clusterKey: item.clusterKey,
            filers: cluster.count }),
        }),
      });
    }
    if (route === "docs-fix") {
      // Docs fixes ride the claims board as a small, short-leased task kind.
      return Object.freeze({ ...base, taskKind: "docs-fix", suggestedLease: "lease=2h" });
    }
    return Object.freeze(base);
  };

  const submit = rawInput => {
    const fb = validateFeedback(rawInput);
    // Scrub BEFORE dedup/storage: raw auth material is never persisted and
    // never reaches model input (triage cases carry hashes only). Scrubbing
    // first also improves clustering — same bug, different tokens, one cluster.
    const clean = {
      ...fb,
      attempt: scrubAttempt(fb.attempt),
      observed: scrubString(fb.observed),
      expected: scrubString(fb.expected),
    };
    const lane = clean.agent.lane;
    const mark = markFor(lane);
    check(!mark.suspended, "suspended", "filing suspended: junk rate too high — lane review required");
    check(mark.balance >= MARK_FILING_COST, "insufficient_mark",
      "insufficient Mark standing to file — earn standing with accepted feedback first");

    const key = dedupKey({ method: clean.endpoint.method, path: clean.endpoint.path,
      response: clean.attempt.response });

    // M-12: a filing matching a terminally-rejected cluster re-opens the
    // cluster as "new" instead of being absorbed as an untriageable
    // "duplicate" — otherwise a genuine regression is silently swallowed
    // with no path back to the triage queue.
    const existing = clusters.get(key);
    const reopening = existing && (existing.status === "rejected-junk" || existing.status === "rejected-user-error");

    // Duplicate path: merge into the cluster, cost nothing.
    if (existing && !reopening) {
      const cluster = existing;
      cluster.count += 1;
      cluster.lastSeenAt = new Date(clock()).toISOString();
      applyVelocity(cluster);
      const id = `fb-${(++seq).toString().padStart(6, "0")}`;
      const item = Object.freeze({ id, ...clean, status: "duplicate", clusterKey: key,
        createdAt: new Date(clock()).toISOString() });
      items.set(id, item);
      return Object.freeze({ outcome: "duplicate", item,
        cluster: Object.freeze({ ...cluster }) });
    }

    // New cluster (or a re-opened one): debit the Mark cost.
    mark.balance -= MARK_FILING_COST;
    const id = `fb-${(++seq).toString().padStart(6, "0")}`;
    const createdAt = new Date(clock()).toISOString();
    const item = Object.freeze({ id, ...clean, status: "new", clusterKey: key, createdAt });
    items.set(id, item);
    const cluster = reopening ? existing : { key, firstId: id, count: 1, severity: clean.severity,
      status: "new", createdAt, lastSeenAt: createdAt,
      filedAt: [], heat: 0, priority: "normal",
      escalatedSeverity: null, demandSignal: false };
    if (reopening) {
      cluster.status = "new";
      cluster.count += 1;
      cluster.lastSeenAt = createdAt;
    } else {
      clusters.set(key, cluster);
    }
    applyVelocity(cluster);
    return Object.freeze({ outcome: reopening ? "reopened" : "accepted", item,
      cluster: Object.freeze({ ...cluster }),
      markBalance: mark.balance });
  };

  const triage = (feedbackId, verdict, reviewerLane) => {
    check(["real", "junk", "user-error"].includes(verdict), "invalid_verdict", "verdict ∈ real|junk|user-error");
    check(isNonEmptyString(reviewerLane, 64), "invalid_reviewer", "reviewerLane required");
    // H-2: triage moves Mark (refund + reward on "real"), so the reviewer
    // must hold the reviewer role — any lane is not enough.
    check(reviewerOk(reviewerLane), "not_reviewer", "reviewerLane is not authorized to triage feedback");
    const item = items.get(feedbackId);
    check(item, "not_found", "feedback id not found");
    check(item.status === "new", "invalid_transition", `cannot triage item in status ${item.status}`);
    // No self-verification: a lane never triages its own filing (same rule
    // the settlement adapter enforces for release predicates).
    check(reviewerLane !== item.agent.lane, "invalid_reviewer",
      "reviewer cannot triage their own filing");
    const mark = markFor(item.agent.lane);
    const cluster = clusters.get(item.clusterKey);
    reviewerFor(reviewerLane).decided++;

    let promotedTask = null;
    const triagedAt = new Date(clock()).toISOString();
    if (verdict === "real") {
      mark.balance += MARK_FILING_COST + MARK_ACCEPT_REWARD; // refund + reward
      mark.filings.push(false);
      cluster.status = "promoted";
      // Severity routing (§7.6): bug/perf → claims-board task; missing-feature
      // → proposal/RFC; docs → short-leased docs-fix task.
      promotedTask = buildPromotedTask(item, cluster);
      notify(item.agent.lane, "promoted", { feedbackId, route: promotedTask.route,
        title: promotedTask.title });
    } else if (verdict === "junk") {
      mark.filings.push(true); // cost already debited at submit; kept.
      checkSuspension(mark);
      cluster.status = "rejected-junk";
    } else {
      mark.balance += MARK_FILING_COST; // honest mistake: refund
      mark.filings.push(false);
      cluster.status = "rejected-user-error";
    }
    notify(item.agent.lane, "triage", { feedbackId, verdict,
      appealable: verdict !== "real",
      appealWindowMs: verdict === "real" ? 0 : APPEAL_WINDOW_MS });
    const updated = Object.freeze({ ...item, status: verdict === "real" ? "promoted" : "rejected",
      verdict, reviewerLane, triagedAt,
      ...(verdict === "real" ? { promotedAt: triagedAt } : {}) });
    items.set(feedbackId, updated);
    return Object.freeze({ item: updated, cluster: Object.freeze({ ...cluster }),
      markBalance: mark.balance, suspended: mark.suspended, promotedTask });
  };

  // Appeals: one per filing, within 72h, decided by a DIFFERENT reviewer.
  // No appeal path = filers learn the system is rigged; unbounded appeals =
  // denial-of-triage. One priced appeal is the middle.
  const appeal = (feedbackId, appellantLane) => {
    const item = items.get(feedbackId);
    check(item, "not_found", "feedback id not found");
    check(item.status === "rejected", "not_appealable",
      `only rejected filings can be appealed (status: ${item.status})`);
    check(item.agent.lane === appellantLane, "not_filer", "only the filer can appeal");
    check(!item.appeal, "already_appealed", "one appeal per filing");
    check(clock() - Date.parse(item.triagedAt) <= APPEAL_WINDOW_MS, "appeal_window_closed",
      "appeal window (72h) closed");
    const mark = markFor(appellantLane);
    check(mark.balance >= MARK_APPEAL_COST, "insufficient_mark",
      "insufficient Mark standing to appeal");
    mark.balance -= MARK_APPEAL_COST;
    const updated = Object.freeze({ ...item, status: "appealed",
      appeal: Object.freeze({ by: appellantLane, at: new Date(clock()).toISOString() }) });
    items.set(feedbackId, updated);
    notify(item.reviewerLane, "appeal-filed", { feedbackId, appellant: appellantLane,
      note: "a different reviewer must decide this appeal" });
    return Object.freeze({ item: updated, markBalance: mark.balance });
  };

  const decideAppeal = (feedbackId, reviewerLane, decision) => {
    check(["uphold", "overturn"].includes(decision), "invalid_decision",
      "decision ∈ uphold|overturn");
    check(isNonEmptyString(reviewerLane, 64), "invalid_reviewer", "reviewerLane required");
    // H-2: deciding an appeal moves Mark (and can promote), so the decider
    // needs the reviewer role like any triage.
    check(reviewerOk(reviewerLane), "not_reviewer", "reviewerLane is not authorized to decide appeals");
    const item = items.get(feedbackId);
    check(item, "not_found", "feedback id not found");
    check(item.status === "appealed", "invalid_transition",
      `cannot decide appeal on item in status ${item.status}`);
    check(reviewerLane !== item.reviewerLane, "same_reviewer",
      "appeal must be decided by a different reviewer than the original");
    check(reviewerLane !== item.agent.lane, "invalid_reviewer",
      "filer cannot decide their own appeal");
    const decidedAt = new Date(clock()).toISOString();
    const filerMark = markFor(item.agent.lane);
    const origMark = markFor(item.reviewerLane);
    const origStats = reviewerFor(item.reviewerLane);

    if (decision === "uphold") {
      // Appeal denied: the cost is kept and the denied appeal counts toward
      // the filer's junk rate (appeal abuse is priced, not free).
      filerMark.filings.push(true);
      checkSuspension(filerMark);
      origStats.confirmed++;
      origMark.balance += MARK_REVIEWER_CONFIRMED;
      const updated = Object.freeze({ ...item, status: "appeal-upheld",
        appeal: Object.freeze({ ...item.appeal, decidedBy: reviewerLane, decision, decidedAt }) });
      items.set(feedbackId, updated);
      notify(item.agent.lane, "appeal-decided", { feedbackId, decision: "uphold",
        note: "verdict stands; appeal cost kept" });
      return Object.freeze({ item: updated, markBalance: filerMark.balance,
        suspended: filerMark.suspended });
    }

    // Overturn: the verdict flips to real. The filer is made whole (appeal
    // cost + filing cost refunded, promotion reward paid); the original
    // reviewer takes the mis-verdict deduction; the decider earned the catch.
    origStats.wrong++;
    origMark.balance -= MARK_REVIEWER_MISVERDICT;
    const deciderStats = reviewerFor(reviewerLane);
    deciderStats.decided++; deciderStats.confirmed++;
    markFor(reviewerLane).balance += MARK_REVIEWER_CONFIRMED;
    filerMark.balance += MARK_APPEAL_COST + MARK_FILING_COST + MARK_ACCEPT_REWARD;
    filerMark.filings.push(false);
    const cluster = clusters.get(item.clusterKey);
    cluster.status = "promoted";
    const promotedTask = buildPromotedTask(item, cluster);
    const updated = Object.freeze({ ...item, status: "promoted", verdict: "real",
      reviewerLane, // the decider owns the final verdict (and its future accuracy)
      promotedAt: decidedAt,
      appeal: Object.freeze({ ...item.appeal, decidedBy: reviewerLane, decision, decidedAt }) });
    items.set(feedbackId, updated);
    notify(item.agent.lane, "appeal-decided", { feedbackId, decision: "overturn",
      route: promotedTask.route, title: promotedTask.title });
    notify(item.reviewerLane, "verdict-overturned", { feedbackId, decidedBy: reviewerLane });
    return Object.freeze({ item: updated, cluster: Object.freeze({ ...cluster }),
      markBalance: filerMark.balance, promotedTask });
  };

  // Outcome recording: the loop-closer. When a promoted task's PR merges
  // (or a proposal is adopted), the filer gets the merge bonus and a public
  // attribution record, and the reviewer's verdict is confirmed. Returns the
  // attribution records for the ledger (SPEC.md §7.1).
  const recordOutcome = ({ feedbackIds, kind, ref, recordedBy } = {}) => {
    check(["merged", "adopted"].includes(kind), "invalid_outcome",
      "kind ∈ merged|adopted");
    check(isNonEmptyString(ref, 256), "invalid_outcome",
      "ref required (PR sha for merged, decision ref for adopted)");
    check(Array.isArray(feedbackIds) && feedbackIds.length > 0, "invalid_outcome",
      "feedbackIds required");
    // H-2: outcome recording mints Mark (merge bonus to the filer, confirmation
    // to the reviewer), so only a release authority may record it — a "merged"
    // verdict must never come from a self-reported ref by an arbitrary lane.
    check(isNonEmptyString(recordedBy, 64), "invalid_outcome", "recordedBy required");
    check(releaseOk(recordedBy), "not_release_authority", "recordedBy is not a release authority");
    if (kind === "merged" && verifyMergeRef !== undefined) {
      check(verifyMergeRef(ref), "unverified_merge_ref", "ref did not verify against a merge record");
    }
    const at = new Date(clock()).toISOString();
    const attributions = feedbackIds.map(id => {
      const item = items.get(id);
      check(item, "not_found", `feedback id not found: ${id}`);
      check(item.status === "promoted", "invalid_transition",
        `cannot record outcome on feedback in status ${item.status}`);
      const status = kind === "merged" ? "merged" : "adopted";
      const updated = Object.freeze({ ...item, status,
        outcome: Object.freeze({ kind, ref, recordedBy, at }) });
      items.set(id, updated);
      const filerMark = markFor(item.agent.lane);
      filerMark.balance += MARK_MERGE_BONUS;
      reviewerFor(item.reviewerLane).confirmed++;
      markFor(item.reviewerLane).balance += MARK_REVIEWER_CONFIRMED;
      notify(item.agent.lane, "feedback-shipped", { feedbackId: id, kind, ref,
        mergeBonus: MARK_MERGE_BONUS,
        note: kind === "merged"
          ? "your filing's PR merged — thanks for the repro"
          : "your proposal was adopted" });
      notify(item.reviewerLane, "verdict-confirmed", { feedbackId: id, kind, ref });
      return Object.freeze({ feedbackId: id, filerLane: item.agent.lane,
        reviewerLane: item.reviewerLane, kind, ref,
        route: routeForSeverity(item.severity), clusterKey: item.clusterKey,
        mergeBonus: MARK_MERGE_BONUS, at });
    });
    return Object.freeze({ attributions: Object.freeze(attributions) });
  };

  // Periodic settlement (room-watch style sweep, not per-request): verdicts
  // that survive the appeal window unchallenged confirm the reviewer;
  // promoted items that never ship go stale (precision signal, no Mark
  // penalty — a reviewer shouldn't pay for tasks nobody picked up).
  const settleVerdicts = () => {
    const nowMs = clock();
    let settled = 0, staled = 0;
    for (const [id, item] of items) {
      if (item.status === "rejected" && nowMs - Date.parse(item.triagedAt) > APPEAL_WINDOW_MS) {
        reviewerFor(item.reviewerLane).confirmed++;
        markFor(item.reviewerLane).balance += MARK_REVIEWER_CONFIRMED;
        items.set(id, Object.freeze({ ...item, status: "settled" }));
        settled++;
      } else if (item.status === "promoted" && item.promotedAt &&
          nowMs - Date.parse(item.promotedAt) > PROMOTED_STALE_MS) {
        reviewerFor(item.reviewerLane).stale++;
        items.set(id, Object.freeze({ ...item, status: "stale" }));
        notify(item.agent.lane, "promotion-stale", { feedbackId: id,
          note: "promoted 60d ago, never shipped — the pipeline, not you, is on trial (F4)" });
        staled++;
      }
    }
    return Object.freeze({ settled, staled });
  };

  // Triage queue: open clusters, fast-track (high heat) first.
  const triageQueue = () => [...clusters.values()]
    .filter(c => c.status === "new")
    .sort((a, b) =>
      ((b.priority === "fast-track") - (a.priority === "fast-track")) ||
      (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
    .map(c => Object.freeze({ ...c, filedAt: Object.freeze([...c.filedAt]) }));

  // Drain-on-read notifications for a lane (the room-native "did it ship?" poll).
  const drainNotifications = lane => {
    const list = notifications.get(lane) ?? [];
    notifications.set(lane, []);
    return Object.freeze(list.map(n => Object.freeze({ ...n })));
  };

  const reviewerStats = lane => {
    const r = reviewerFor(lane);
    return Object.freeze({ lane, decided: r.decided, confirmed: r.confirmed,
      wrong: r.wrong, stale: r.stale,
      accuracy: r.confirmed + r.wrong > 0
        ? r.confirmed / (r.confirmed + r.wrong) : null });
  };

  const clusterHeat = key => {
    const c = clusters.get(key);
    return c ? heatOf(c, clock()) : 0;
  };

  return Object.freeze({
    submit, triage, appeal, decideAppeal, recordOutcome, settleVerdicts,
    triageQueue, drainNotifications, reviewerStats, clusterHeat,
    get: id => items.get(id) ?? null,
    cluster: key => clusters.get(key) ? Object.freeze({ ...clusters.get(key),
      filedAt: Object.freeze([...clusters.get(key).filedAt]) }) : null,
    clusters: () => [...clusters.values()].map(c => Object.freeze({ ...c,
      filedAt: Object.freeze([...c.filedAt]) })),
    mark: lane => { const m = markFor(lane); return Object.freeze({ balance: m.balance, suspended: m.suspended,
      recentFilings: m.filings.length }); },
    size: () => items.size,
    // Serializable state for durable persistence. Snapshot, not a delta: the
    // store is small (bounded by CLUSTER_FILEDAT_CAP and drained
    // notifications) and one row per room writes atomically.
    snapshot: () => ({
      v: SNAPSHOT_VERSION,
      items: [...items.entries()],
      clusters: [...clusters.entries()],
      marks: [...marks.entries()],
      notifications: [...notifications.entries()],
      reviewers: [...reviewers.entries()],
      seq, notifSeq,
    }),
  });
}
