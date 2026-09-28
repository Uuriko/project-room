// Transport boundary for the /feedback endpoint
// (server/feedback-routes.mjs, handleFeedbackCore): stable status codes,
// lane binding to the authenticated member, guest write denial, per-lane
// rate limiting, method checks, and the verdict/discovery shapes. This
// file owns the HTTP risk only — Mark economics, clustering, and the
// lifecycle live in tests/feedback-store.test.js and are never re-asserted
// here. handleFeedbackCore is the real boundary (used by handleFeedback),
// so no test-only seam is involved.
import test from "node:test";
import assert from "node:assert/strict";
import { handleFeedbackCore, createSubmitLimiter, createFeedbackStore } from "../server/feedback-routes.mjs";

const goodFiling = (lane = "jill") => ({
  agent: { lane, card_uri: "https://muse-room.example/.well-known/agent-card.json" },
  endpoint: { method: "POST", path: "/api/rooms/abc123/work-claims" },
  attempt: {
    goal: "claim work item w-9",
    request: { method: "POST", path: "/api/rooms/abc123/work-claims", body: { id: "w-9" } },
    response: { status: 422, body: { code: "invalid_claim_input" } },
  },
  observed: "422 on a well-formed claim",
  expected: "201 with the claimed item",
  severity: "bug",
});

// Mirrors the repo's reject: throws, so the core's flow control works.
const helpers = data => {
  let captured = null;
  return {
    captured: () => captured,
    json: (_res, status, value, head) => { captured = { status, value, head }; return captured; },
    reject: (status, code, message) => { const e = new Error(message); e.status = status; e.code = code; throw e; },
    body: () => data,
  };
};

const call = ({ method = "GET", route, id = null, data, lane = "jill", feedbackStore, limiter = createSubmitLimiter(), roomId = "room1" }) => {
  const h = helpers(data);
  const req = { method, headers: {} };
  const auth = lane === null ? {} : { member: { id: lane } };
  const result = handleFeedbackCore({ req, res: {}, store: undefined, roomId, auth,
    feedbackRoute: route, feedbackId: id, feedbackStore, limiter,
    helpers: { json: h.json, reject: h.reject, body: h.body } });
  return { result, error: null };
};

const callErr = opts => {
  try { call(opts); assert.fail("expected a rejection"); }
  catch (e) { return e; }
};

test("POST submit → 202 with feedback_id, outcome, and verdict_url", () => {
  const fb = createFeedbackStore();
  const { result } = call({ method: "POST", route: "submit", data: goodFiling(), feedbackStore: fb });
  assert.equal(result.status, 202);
  assert.match(result.value.feedback_id, /^fb-/);
  assert.equal(result.value.outcome, "accepted");
  assert.ok(result.value.verdict_url.includes(`/api/rooms/room1/feedback/${result.value.feedback_id}`));
  assert.ok(result.value.cluster_key);
});

test("duplicate submit → 202 with outcome duplicate", () => {
  const fb = createFeedbackStore();
  call({ method: "POST", route: "submit", data: goodFiling(), feedbackStore: fb });
  const { result } = call({ method: "POST", route: "submit", data: goodFiling(), feedbackStore: fb });
  assert.equal(result.status, 202);
  assert.equal(result.value.outcome, "duplicate");
});

test("malformed body → 422 with the machine code", () => {
  const fb = createFeedbackStore();
  const e = callErr({ method: "POST", route: "submit", data: { agent: { lane: "jill" } }, feedbackStore: fb });
  assert.equal(e.status, 422);
  assert.ok(["invalid_feedback", "invalid_agent", "invalid_repro"].includes(e.code));
});

test("missing repro pair → 422 invalid_repro", () => {
  const fb = createFeedbackStore();
  const bad = goodFiling();
  bad.attempt = { goal: "x", request: { method: "GET", path: "/y" } };
  const e = callErr({ method: "POST", route: "submit", data: bad, feedbackStore: fb });
  assert.equal(e.status, 422);
  assert.equal(e.code, "invalid_repro");
});

test("body-claimed lane that disagrees with the member → 403 lane_mismatch", () => {
  const fb = createFeedbackStore();
  const e = callErr({ method: "POST", route: "submit", data: goodFiling("mallory"), feedbackStore: fb, lane: "jill" });
  assert.equal(e.status, 403);
  assert.equal(e.code, "lane_mismatch");
});

test("unauthenticated (no member / bad lane) → 401", () => {
  const fb = createFeedbackStore();
  const e1 = callErr({ method: "POST", route: "submit", data: goodFiling(), feedbackStore: fb, lane: null });
  assert.equal(e1.status, 401);
  const e2 = callErr({ method: "GET", route: "list", feedbackStore: fb, lane: "not a lane!!" });
  assert.equal(e2.status, 401);
});

test("guest members cannot write but can read", () => {
  const fb = createFeedbackStore();
  const e = callErr({ method: "POST", route: "submit", data: goodFiling("guest-agent-abc"), feedbackStore: fb, lane: "guest-agent-abc" });
  assert.equal(e.status, 403);
  assert.equal(e.code, "guest_scope_denied");
  const { result } = call({ method: "GET", route: "list", feedbackStore: fb, lane: "guest-agent-abc" });
  assert.equal(result.status, 200);
});

test("per-lane rate limit → 429 after the bucket is exhausted", () => {
  const fb = createFeedbackStore();
  const limiter = createSubmitLimiter({ capacity: 2, refillPerHour: 0 });
  call({ method: "POST", route: "submit", data: goodFiling(), feedbackStore: fb, limiter });
  call({ method: "POST", route: "submit", data: goodFiling(), feedbackStore: fb, limiter });
  const e = callErr({ method: "POST", route: "submit", data: goodFiling(), feedbackStore: fb, limiter });
  assert.equal(e.status, 429);
  assert.equal(e.code, "rate_limited");
});

test("suspended lane → 403 from the submit route", () => {
  const fb = createFeedbackStore();
  for (let i = 0; i < 5; i++) {
    const f = goodFiling("spammer");
    f.attempt.response = { status: 400 + i, body: { code: `junk_${i}` } };
    const id = call({ method: "POST", route: "submit", data: f, feedbackStore: fb, lane: "spammer" }).result.value.feedback_id;
    call({ method: "POST", route: "triage", id, data: { verdict: "junk" }, feedbackStore: fb, lane: "reviewer-a" });
  }
  const f = goodFiling("spammer");
  f.attempt.response = { status: 499, body: { code: "junk_last" } };
  const e = callErr({ method: "POST", route: "submit", data: f, feedbackStore: fb, lane: "spammer" });
  assert.equal(e.status, 403);
  assert.equal(e.code, "suspended");
});

test("GET list → 200 clusters plus the caller's Mark", () => {
  const fb = createFeedbackStore();
  call({ method: "POST", route: "submit", data: goodFiling(), feedbackStore: fb });
  const { result } = call({ method: "GET", route: "list", feedbackStore: fb });
  assert.equal(result.status, 200);
  assert.equal(result.value.roomId, "room1");
  assert.equal(result.value.clusters.length, 1);
  assert.equal(result.value.your_mark.balance, 9);
});

test("GET queue → 200 with fast-track ordering", () => {
  const fb = createFeedbackStore();
  call({ method: "POST", route: "submit", data: goodFiling(), feedbackStore: fb });
  const { result } = call({ method: "GET", route: "queue", feedbackStore: fb });
  assert.equal(result.status, 200);
  assert.equal(result.value.queue.length, 1);
});

test("GET notifications drains on read", () => {
  const fb = createFeedbackStore();
  const id = call({ method: "POST", route: "submit", data: goodFiling(), feedbackStore: fb }).result.value.feedback_id;
  call({ method: "POST", route: "triage", id, data: { verdict: "junk" }, feedbackStore: fb, lane: "reviewer-a" });
  const first = call({ method: "GET", route: "notifications", feedbackStore: fb }).result;
  assert.equal(first.status, 200);
  assert.ok(first.value.notifications.length > 0);
  const second = call({ method: "GET", route: "notifications", feedbackStore: fb }).result;
  assert.deepEqual(second.value.notifications, []);
});

test("GET item → 200 verdict shape; unknown id → 404", () => {
  const fb = createFeedbackStore();
  const id = call({ method: "POST", route: "submit", data: goodFiling(), feedbackStore: fb }).result.value.feedback_id;
  call({ method: "POST", route: "triage", id, data: { verdict: "real" }, feedbackStore: fb, lane: "reviewer-a" });
  const { result } = call({ method: "GET", route: "read", id, feedbackStore: fb });
  assert.equal(result.status, 200);
  assert.equal(result.value.feedback_id, id);
  assert.equal(result.value.status, "triaged");
  assert.equal(result.value.verdict, "real");
  assert.equal(result.value.route, "task");
  assert.ok(result.value.triaged_at);
  const e = callErr({ method: "GET", route: "read", id: "fb-999999", feedbackStore: fb });
  assert.equal(e.status, 404);
  assert.equal(e.code, "feedback_not_found");
});

test("triage lifecycle over HTTP: 200, then appeal 202, decision 200, outcome 200", () => {
  const fb = createFeedbackStore();
  const id = call({ method: "POST", route: "submit", data: goodFiling(), feedbackStore: fb }).result.value.feedback_id;
  const triaged = call({ method: "POST", route: "triage", id, data: { verdict: "junk" }, feedbackStore: fb, lane: "reviewer-a" }).result;
  assert.equal(triaged.status, 200);
  assert.equal(triaged.value.verdict, "junk");
  const appealed = call({ method: "POST", route: "appeal", id, feedbackStore: fb }).result;
  assert.equal(appealed.status, 202);
  assert.equal(appealed.value.status, "appealed");
  const decided = call({ method: "POST", route: "appeal-decision", id, data: { decision: "overturn" }, feedbackStore: fb, lane: "reviewer-b" }).result;
  assert.equal(decided.status, 200);
  assert.ok(decided.value.promoted_task, "overturn promotes the task");
  const outcome = call({ method: "POST", route: "outcome", id, data: { kind: "merged", ref: "PR #9" }, feedbackStore: fb, lane: "reviewer-b" }).result;
  assert.equal(outcome.status, 200);
  assert.equal(outcome.value.attributions.length, 1);
});

test("wrong method on a write route → 405", () => {
  const fb = createFeedbackStore();
  const e = callErr({ method: "GET", route: "triage", id: "fb-000001", feedbackStore: fb });
  assert.equal(e.status, 405);
});

test("unknown route → 404", () => {
  const fb = createFeedbackStore();
  const e = callErr({ method: "GET", route: "nope", feedbackStore: fb });
  assert.equal(e.status, 404);
});

test("triage with a bad verdict → 422 invalid_verdict", () => {
  const fb = createFeedbackStore();
  const id = call({ method: "POST", route: "submit", data: goodFiling(), feedbackStore: fb }).result.value.feedback_id;
  const e = callErr({ method: "POST", route: "triage", id, data: { verdict: "meh" }, feedbackStore: fb, lane: "reviewer-a" });
  assert.equal(e.status, 422);
  assert.equal(e.code, "invalid_verdict");
});
