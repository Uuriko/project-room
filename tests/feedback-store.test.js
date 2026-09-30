// Domain contracts for the /feedback endpoint's pure store
// (server/feedback-store.mjs): validation, the repro gate, dedup
// clustering, scrub-before-storage ordering, and the Mark-staked triage
// economy. This file is the primary owner of every contract below; the
// routes tests own only the transport risk (status codes, lane binding,
// rate limiting) and never re-assert economics.
import test from "node:test";
import assert from "node:assert/strict";
import {
  createFeedbackStore, validateFeedback, normalizePath, routeForSeverity, FeedbackError,
  MARK_FILING_COST, MARK_ACCEPT_REWARD, MARK_APPEAL_COST, MARK_MERGE_BONUS,
  MARK_REVIEWER_CONFIRMED, APPEAL_WINDOW_MS,
} from "../server/feedback-store.mjs";

const goodFiling = (over = {}) => ({
  agent: { lane: "jill", card_uri: "https://muse-room.example/.well-known/agent-card.json" },
  endpoint: { method: "POST", path: "/api/rooms/abc123/work-claims" },
  attempt: {
    goal: "claim work item w-9",
    request: { method: "POST", path: "/api/rooms/abc123/work-claims", body: { id: "w-9" } },
    response: { status: 422, body: { code: "invalid_claim_input" } },
  },
  observed: "422 invalid_claim_input on a well-formed claim",
  expected: "201 with the claimed item, per docs",
  severity: "bug",
  ...over,
});

const throwsCode = (fn, code) =>
  assert.throws(fn, e => e instanceof FeedbackError && e.code === code, `expected FeedbackError ${code}`);

test("accepts a well-formed filing", () => {
  const fb = validateFeedback(goodFiling());
  assert.equal(fb.severity, "bug");
  assert.equal(fb.endpoint.method, "POST");
});

test("the repro gate: missing response is 422, not triage", () => {
  const bad = goodFiling();
  bad.attempt = { goal: "x", request: { method: "GET", path: "/y" } };
  throwsCode(() => validateFeedback(bad), "invalid_repro");
});

test("the repro gate: missing request is 422", () => {
  const bad = goodFiling();
  bad.attempt = { goal: "x", response: { status: 500 } };
  throwsCode(() => validateFeedback(bad), "invalid_repro");
});

test("rejects bad severity and unsigned identity", () => {
  throwsCode(() => validateFeedback(goodFiling({ severity: "urgent!!!" })), "invalid_feedback");
  const noId = goodFiling(); noId.agent = { lane: "jill" };
  throwsCode(() => validateFeedback(noId), "invalid_agent");
  const httpCard = goodFiling(); httpCard.agent = { lane: "jill", card_uri: "http://evil.example/card" };
  throwsCode(() => validateFeedback(httpCard), "invalid_agent");
});

test("path normalization: volatile id segments do not split clusters", () => {
  assert.equal(normalizePath("/api/rooms/abc123/work-claims"), "/api/rooms/{id}/work-claims");
  assert.equal(normalizePath("/api/rooms/abc123/work-claims"), normalizePath("/api/rooms/xyz789/work-claims"));
  assert.ok(normalizePath("/api/rooms/abc/work-claims").includes("work-claims"));
});

test("same bug from different rooms dedups to one cluster", () => {
  const store = createFeedbackStore();
  const r1 = store.submit(goodFiling());
  const other = goodFiling();
  other.endpoint.path = "/api/rooms/zzz999/work-claims";
  other.attempt.request.path = "/api/rooms/zzz999/work-claims";
  const r2 = store.submit(other);
  assert.equal(r1.outcome, "accepted");
  assert.equal(r2.outcome, "duplicate");
  assert.equal(r1.item.clusterKey, r2.item.clusterKey);
  assert.equal(store.cluster(r1.item.clusterKey).count, 2);
});

test("different error codes do not cluster together", () => {
  const store = createFeedbackStore();
  store.submit(goodFiling());
  const other = goodFiling();
  other.attempt.response = { status: 500, body: { code: "internal_error" } };
  const r2 = store.submit(other);
  assert.equal(r2.outcome, "accepted");
  assert.equal(store.clusters().length, 2);
});

test("duplicate flood: 100 identical filings → 1 cluster, 1 Mark debit", () => {
  const store = createFeedbackStore();
  let first;
  for (let i = 0; i < 100; i++) {
    const r = store.submit(goodFiling({ agent: { lane: "jill", card_uri: "https://muse-room.example/card" } }));
    if (i === 0) first = r;
  }
  assert.equal(store.clusters().length, 1);
  assert.equal(store.cluster(first.item.clusterKey).count, 100);
  assert.equal(store.mark("jill").balance, 10 - MARK_FILING_COST);
});

test("scrubbing happens before dedup and storage: different tokens, one cluster, no secret stored", () => {
  const store = createFeedbackStore();
  const a = goodFiling();
  a.attempt.request.body = { id: "w-9", token: "sk-aaaaaaaaaaaaaaaa" };
  const b = goodFiling();
  b.attempt.request.body = { id: "w-9", token: "sk-bbbbbbbbbbbbbbbb" };
  const r1 = store.submit(a);
  const r2 = store.submit(b);
  assert.equal(r1.item.clusterKey, r2.item.clusterKey, "same bug with different tokens clusters together");
  const stored = store.get(r1.item.id);
  assert.ok(!JSON.stringify(stored).includes("sk-"), "raw token must not reach storage");
});

test("filing costs 1 Mark; a real verdict refunds it and pays the reward", () => {
  const store = createFeedbackStore();
  const r = store.submit(goodFiling());
  assert.equal(store.mark("jill").balance, 10 - MARK_FILING_COST);
  const t = store.triage(r.item.id, "real", "reviewer-a");
  assert.equal(t.item.status, "promoted");
  assert.equal(store.mark("jill").balance, 10 + MARK_ACCEPT_REWARD);
});

test("junk keeps the filing cost; user-error refunds it", () => {
  const store = createFeedbackStore();
  const jf = goodFiling();
  const j = store.submit(jf);
  store.triage(j.item.id, "junk", "reviewer-a");
  assert.equal(store.mark("jill").balance, 10 - MARK_FILING_COST);
  const uf = goodFiling();
  uf.attempt.response = { status: 400, body: { code: "bad_request" } };
  const u = store.submit(uf);
  assert.equal(u.outcome, "accepted");
  store.triage(u.item.id, "user-error", "reviewer-a");
  assert.equal(store.mark("jill").balance, 10 - MARK_FILING_COST);
});

test("high junk rate suspends filing", () => {
  const store = createFeedbackStore();
  for (let i = 0; i < 5; i++) {
    const f = goodFiling({ agent: { lane: "spammer", key_id: "k" } });
    f.attempt.response = { status: 400 + i, body: { code: `junk_${i}` } };
    const r = store.submit(f);
    assert.equal(r.outcome, "accepted");
    store.triage(r.item.id, "junk", "reviewer-a");
  }
  assert.ok(store.mark("spammer").suspended);
  const f = goodFiling({ agent: { lane: "spammer", key_id: "k" } });
  f.attempt.response = { status: 499, body: { code: "junk_last" } };
  throwsCode(() => store.submit(f), "suspended");
});

test("insufficient Mark blocks filing", () => {
  const store = createFeedbackStore();
  // 10 Mark buys exactly 10 filings; the 11th must fail.
  for (let i = 0; i < 10; i++) {
    const f = goodFiling({ agent: { lane: "poor", key_id: "k" } });
    f.attempt.response = { status: 500 + i, body: { code: `err_${i}` } };
    store.submit(f);
  }
  const f = goodFiling({ agent: { lane: "poor", key_id: "k" } });
  f.attempt.response = { status: 599, body: { code: "err_last" } };
  throwsCode(() => store.submit(f), "insufficient_mark");
});

test("a lane cannot triage its own filing; cannot triage twice", () => {
  const store = createFeedbackStore();
  const r = store.submit(goodFiling());
  throwsCode(() => store.triage(r.item.id, "real", "jill"), "invalid_reviewer");
  store.triage(r.item.id, "real", "reviewer-a");
  throwsCode(() => store.triage(r.item.id, "junk", "reviewer-b"), "invalid_transition");
});

test("severity routing: bug/perf → task, missing-feature → proposal, docs → docs-fix", () => {
  const store = createFeedbackStore();
  const cases = [
    ["bug", "task"], ["perf", "task"], ["missing-feature", "proposal"], ["docs", "docs-fix"],
  ];
  for (const [severity, route] of cases) {
    const f = goodFiling({ severity, agent: { lane: `filer-${severity}`, key_id: "k" } });
    f.attempt.response = { status: 500, body: { code: `err-${severity}` } };
    const r = store.submit(f);
    const t = store.triage(r.item.id, "real", `reviewer-${severity}`);
    assert.equal(t.promotedTask.route, route, `${severity} must route to ${route}`);
    assert.equal(routeForSeverity(severity), route);
  }
  const proposal = store.get(store.submit(goodFiling({ severity: "missing-feature",
    agent: { lane: "f2", key_id: "k" },
    attempt: { goal: "g", request: { method: "GET", path: "/x" }, response: { status: 404, body: { code: "nope" } } } })).item.id);
  assert.ok(proposal, "proposal-route filing stored");
});

test("appeals: one per filing, 72h window, decided by a different lane", () => {
  let nowMs = Date.now();
  const store = createFeedbackStore({ now: () => nowMs });
  const r = store.submit(goodFiling());
  store.triage(r.item.id, "junk", "reviewer-a");
  const before = store.mark("jill").balance;
  const a = store.appeal(r.item.id, "jill");
  assert.equal(a.item.status, "appealed");
  assert.equal(store.mark("jill").balance, before - MARK_APPEAL_COST);
  // Second appeal is refused (status is already "appealed", not "rejected").
  throwsCode(() => store.appeal(r.item.id, "jill"), "not_appealable");
  // The original reviewer cannot decide their own appeal.
  throwsCode(() => store.decideAppeal(r.item.id, "reviewer-a", "uphold"), "same_reviewer");
  // The filer cannot decide their own appeal either.
  throwsCode(() => store.decideAppeal(r.item.id, "jill", "overturn"), "invalid_reviewer");
  // A different lane upholds: appeal cost kept, counts toward the junk rate.
  const d = store.decideAppeal(r.item.id, "reviewer-b", "uphold");
  assert.equal(d.item.status, "appeal-upheld");
  assert.equal(store.mark("jill").balance, before - MARK_APPEAL_COST);
});

test("overturned appeal makes the filer whole and dings the original reviewer", () => {
  const store = createFeedbackStore();
  const r = store.submit(goodFiling());
  store.triage(r.item.id, "junk", "reviewer-a");
  store.appeal(r.item.id, "jill");
  const d = store.decideAppeal(r.item.id, "reviewer-b", "overturn");
  assert.equal(d.item.status, "promoted");
  assert.equal(d.item.verdict, "real");
  assert.equal(store.mark("jill").balance, 10 + MARK_ACCEPT_REWARD,
    "filer is made whole: appeal cost + filing cost refunded, reward paid");
  const stats = store.reviewerStats("reviewer-a");
  assert.equal(stats.wrong, 1);
});

test("appeal window closes after 72h", () => {
  let nowMs = Date.now();
  const store = createFeedbackStore({ now: () => nowMs });
  const r = store.submit(goodFiling());
  store.triage(r.item.id, "junk", "reviewer-a");
  nowMs += APPEAL_WINDOW_MS + 1000;
  throwsCode(() => store.appeal(r.item.id, "jill"), "appeal_window_closed");
});

test("reviewer economics: +2 confirmed, −3 overturned; settlement confirms unchallenged verdicts", () => {
  let nowMs = Date.now();
  const store = createFeedbackStore({ now: () => nowMs });
  const r = store.submit(goodFiling());
  store.triage(r.item.id, "junk", "reviewer-a");
  assert.equal(store.mark("reviewer-a").balance, 10, "no reward yet — the verdict is not confirmed");
  nowMs += APPEAL_WINDOW_MS + 1000;
  const s = store.settleVerdicts();
  assert.equal(s.settled, 1);
  assert.equal(store.mark("reviewer-a").balance, 10 + MARK_REVIEWER_CONFIRMED);
  assert.equal(store.get(r.item.id).status, "settled");
});

test("outcome recording pays the filer +10 and confirms the reviewer", () => {
  const store = createFeedbackStore();
  const r = store.submit(goodFiling());
  store.triage(r.item.id, "real", "reviewer-a");
  const before = store.mark("jill").balance;
  const o = store.recordOutcome({ feedbackIds: [r.item.id], kind: "merged", ref: "PR #123", recordedBy: "reviewer-a" });
  assert.equal(o.attributions.length, 1);
  assert.equal(o.attributions[0].mergeBonus, MARK_MERGE_BONUS);
  assert.equal(store.mark("jill").balance, before + MARK_MERGE_BONUS);
  assert.equal(store.get(r.item.id).status, "merged");
  throwsCode(() => store.recordOutcome({ feedbackIds: [r.item.id], kind: "merged", ref: "PR #123", recordedBy: "reviewer-a" }), "invalid_transition");
});

test("promotions that never ship go stale (precision signal, no Mark penalty)", () => {
  let nowMs = Date.now();
  const store = createFeedbackStore({ now: () => nowMs });
  const r = store.submit(goodFiling());
  store.triage(r.item.id, "real", "reviewer-a");
  const reviewerBefore = store.mark("reviewer-a").balance;
  nowMs += 61 * 24 * 3600 * 1000;
  const s = store.settleVerdicts();
  assert.equal(s.staled, 1);
  assert.equal(store.get(r.item.id).status, "stale");
  assert.equal(store.mark("reviewer-a").balance, reviewerBefore, "staleness is not the reviewer's debt");
  const notes = store.drainNotifications("jill");
  assert.ok(notes.some(n => n.type === "promotion-stale"), "the filer is told the pipeline stalled");
});

test("notifications are drain-on-read", () => {
  const store = createFeedbackStore();
  const r = store.submit(goodFiling());
  store.triage(r.item.id, "junk", "reviewer-a");
  const first = store.drainNotifications("jill");
  assert.ok(first.length > 0, "triage notifies the filer");
  assert.ok(first.every(n => typeof n.seq === "number" && n.at), "notifications carry seq and timestamp");
  assert.deepEqual(store.drainNotifications("jill"), [], "second read is empty");
});

test("cluster velocity: heat ≥ 5/day fast-tracks the cluster", () => {
  let nowMs = Date.now();
  const store = createFeedbackStore({ now: () => nowMs });
  const r1 = store.submit(goodFiling());
  const key = r1.item.clusterKey;
  for (let i = 0; i < 4; i++) {
    nowMs += 3600 * 1000;
    store.submit(goodFiling());
  }
  const cluster = store.cluster(key);
  assert.equal(cluster.count, 5);
  assert.equal(cluster.priority, "fast-track");
  const queue = store.triageQueue();
  assert.equal(queue[0].key, key, "fast-tracked clusters sort first");
  assert.equal(store.clusterHeat(key), 5);
});

test("H-2: triage requires the reviewer role when authority is configured", () => {
  const store = createFeedbackStore({ isReviewer: ["reviewer-a"] });
  const r = store.submit(goodFiling());
  // The pre-fix store let any non-guest lane triage and move Mark.
  throwsCode(() => store.triage(r.item.id, "real", "mallory"), "not_reviewer");
  const t = store.triage(r.item.id, "real", "reviewer-a");
  assert.equal(t.item.verdict, "real");
});

test("H-2: appeal decisions require the reviewer role", () => {
  const store = createFeedbackStore({ isReviewer: ["reviewer-a", "reviewer-b"] });
  const r = store.submit(goodFiling());
  store.triage(r.item.id, "junk", "reviewer-a");
  store.appeal(r.item.id, "jill");
  throwsCode(() => store.decideAppeal(r.item.id, "mallory", "overturn"), "not_reviewer");
  const d = store.decideAppeal(r.item.id, "reviewer-b", "overturn");
  assert.equal(d.item.status, "promoted");
});

test("H-2: outcome recording requires a release authority (not a self-reported ref)", () => {
  const store = createFeedbackStore({ isReviewer: ["reviewer-a"], isReleaseAuthority: ["owner"] });
  const r = store.submit(goodFiling());
  store.triage(r.item.id, "real", "reviewer-a");
  // recordedBy is now required and must hold release authority.
  throwsCode(() => store.recordOutcome({ feedbackIds: [r.item.id], kind: "merged", ref: "PR #123" }), "invalid_outcome");
  throwsCode(
    () => store.recordOutcome({ feedbackIds: [r.item.id], kind: "merged", ref: "PR #123", recordedBy: "reviewer-a" }),
    "not_release_authority");
  const o = store.recordOutcome({ feedbackIds: [r.item.id], kind: "merged", ref: "PR #123", recordedBy: "owner" });
  assert.equal(o.attributions.length, 1);
  assert.equal(store.get(r.item.id).status, "merged");
});

test("H-2: a configured verifyMergeRef hook must verify merged refs", () => {
  const store = createFeedbackStore({
    isReviewer: ["reviewer-a"],
    isReleaseAuthority: ["owner"],
    verifyMergeRef: ref => ref === "PR #123",
  });
  const r1 = store.submit(goodFiling());
  store.triage(r1.item.id, "real", "reviewer-a");
  throwsCode(
    () => store.recordOutcome({ feedbackIds: [r1.item.id], kind: "merged", ref: "PR #999", recordedBy: "owner" }),
    "unverified_merge_ref");
  // Adopted outcomes are not merge refs: the hook is not consulted.
  const r2 = store.submit(goodFiling({
    endpoint: { method: "POST", path: "/api/rooms/abc123/other-endpoint" },
    attempt: {
      goal: "a distinct filing for the adopted path",
      request: { method: "POST", path: "/api/rooms/abc123/other-endpoint", body: {} },
      response: { status: 500, body: { error: "boom" } },
    },
  }));
  store.triage(r2.item.id, "real", "reviewer-a");
  const o = store.recordOutcome({ feedbackIds: [r2.item.id], kind: "adopted", ref: "decision-1", recordedBy: "owner" });
  assert.equal(store.get(r2.item.id).status, "adopted");
  assert.equal(o.attributions.length, 1);
});

test("H-2: authority config accepts predicates and rejects invalid values", () => {
  const store = createFeedbackStore({ isReviewer: lane => lane.endsWith("-reviewer") });
  const r = store.submit(goodFiling());
  throwsCode(() => store.triage(r.item.id, "real", "mallory"), "not_reviewer");
  store.triage(r.item.id, "real", "senior-reviewer");
  assert.throws(
    () => createFeedbackStore({ isReviewer: "reviewer-a" }),
    err => err.code === "invalid_authority");
  assert.throws(
    () => createFeedbackStore({ verifyMergeRef: "yes" }),
    err => err.code === "invalid_authority");
});
