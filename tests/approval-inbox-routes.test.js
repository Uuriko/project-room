// Fail-first HTTP boundary for the approval inbox
// (server/approval-inbox-routes.mjs): member-only list/get, strict create
// policy gate, human-only decide, stable 401/403/404/409/422 codes.
// The mount function is the real boundary slice 5 wires into http.mjs,
// so every test goes through mountApprovalInboxRoutes — no test-only seam.
import test from "node:test";
import assert from "node:assert/strict";
import {
  mountApprovalInboxRoutes, matchApprovalRoute, createApprovalInboxRegistry,
} from "../server/approval-inbox-routes.mjs";

// Mirrors the repo's reject: throws, so the route's flow control works.
const helpers = (data) => {
  let captured = null;
  return {
    captured: () => captured,
    json: (_res, status, value) => { captured = { status, value }; return captured; },
    reject: (status, code, message) => { const e = new Error(message); e.status = status; e.code = code; throw e; },
    body: () => data,
  };
};

const human = (id = "john") => ({ member: { id, kind: "human" } });
const agent = (id = "jill") => ({ member: { id, kind: "agent" } });

const call = ({ method = "GET", path, data, auth = human(), registry, roomId = "room1" } = {}) => {
  const h = helpers(data);
  const req = { method, headers: {} };
  const url = new URL(path, "https://room.test");
  const result = mountApprovalInboxRoutes({ req, res: {}, url, store: {}, roomId, auth,
    registry: registry ?? createApprovalInboxRegistry(), helpers: { json: h.json, reject: h.reject, body: h.body } });
  return result;
};

const callErr = (opts) => {
  try { call(opts); assert.fail("expected a rejection"); }
  catch (e) { return e; }
};

const card = (over = {}) => ({
  kind: "money", title: "Spend $50 on Connects?", what: "Upwork buyer pipeline needs Connects to send proposals.",
  options: [
    { label: "Approve $50", consequence: "Proposals go out tonight" },
    { label: "Hold", consequence: "Pipeline stalls until decided" },
  ],
  ...over,
});

test("route classification: list, read, decide, and misses", () => {
  assert.deepEqual(matchApprovalRoute("/api/rooms/r1/approvals"), { route: "list", id: null });
  assert.deepEqual(matchApprovalRoute("/api/rooms/r1/approvals/abc"), { route: "read", id: "abc" });
  assert.deepEqual(matchApprovalRoute("/api/rooms/r1/approvals/abc/decide"), { route: "decide", id: "abc" });
  assert.equal(matchApprovalRoute("/api/rooms/r1/approvals/abc/decide/extra"), null);
  assert.equal(matchApprovalRoute("/api/rooms/r1/work-claims"), null);
});

test("no member → 401 unauthenticated", () => {
  const e = callErr({ path: "/api/rooms/r1/approvals", auth: {} });
  assert.equal(e.status, 401);
  assert.equal(e.code, "unauthenticated");
});

test("GET list starts empty → 200", () => {
  const { status, value } = call({ path: "/api/rooms/r1/approvals" });
  assert.equal(status, 200);
  assert.deepEqual(value.approvals, []);
  assert.equal(value.total, 0);
});

test("POST create → 201 with a pending card in the exact card shape", () => {
  const registry = createApprovalInboxRegistry();
  const { status, value } = call({ method: "POST", path: "/api/rooms/r1/approvals", data: card(), registry, auth: agent() });
  assert.equal(status, 201);
  assert.equal(value.status, "pending");
  assert.equal(value.kind, "money");
  assert.equal(value.title, "Spend $50 on Connects?");
  assert.equal(value.requestedBy, "jill");
  assert.equal(value.options.length, 2);
  assert.ok(value.id);
  assert.ok(value.createdAt);
  assert.equal(value.decision, null);
});

test("POST create with no options → 422 (policy gate: nothing to decide)", () => {
  const e = callErr({ method: "POST", path: "/api/rooms/r1/approvals", data: card({ options: [] }) });
  assert.equal(e.status, 422);
  assert.equal(e.code, "approval_invalid");
});

test("POST create with unknown kind → 422", () => {
  const e = callErr({ method: "POST", path: "/api/rooms/r1/approvals", data: card({ kind: "yolo" }) });
  assert.equal(e.status, 422);
  assert.equal(e.code, "approval_invalid");
});

test("POST create with a pre-set status → 422 (strict shape)", () => {
  const e = callErr({ method: "POST", path: "/api/rooms/r1/approvals", data: card({ status: "approved" }) });
  assert.equal(e.status, 422);
  assert.equal(e.code, "approval_invalid");
});

test("GET list filters by kind and status", () => {
  const registry = createApprovalInboxRegistry();
  call({ method: "POST", path: "/api/rooms/r1/approvals", data: card(), registry });
  call({ method: "POST", path: "/api/rooms/r1/approvals", data: card({ kind: "deploy", title: "Deploy now?" }), registry });
  const { value } = call({ path: "/api/rooms/r1/approvals?kind=deploy", registry });
  assert.equal(value.total, 1);
  assert.equal(value.approvals[0].kind, "deploy");
  const pending = call({ path: "/api/rooms/r1/approvals?status=pending", registry });
  assert.equal(pending.value.total, 2);
});

test("GET list with unknown filter value → 422", () => {
  const e = callErr({ path: "/api/rooms/r1/approvals?kind=bogus" });
  assert.equal(e.status, 422);
  assert.equal(e.code, "approval_invalid");
});

test("GET unknown id → 404 approval_not_found", () => {
  const e = callErr({ path: "/api/rooms/r1/approvals/nope" });
  assert.equal(e.status, 404);
  assert.equal(e.code, "approval_not_found");
});

test("GET read returns the opened card", () => {
  const registry = createApprovalInboxRegistry();
  const created = call({ method: "POST", path: "/api/rooms/r1/approvals", data: card(), registry });
  const { status, value } = call({ path: `/api/rooms/r1/approvals/${created.value.id}`, registry });
  assert.equal(status, 200);
  assert.equal(value.id, created.value.id);
  assert.equal(value.status, "pending");
});

test("POST decide approve by a human → 200 approved with decision record", () => {
  const registry = createApprovalInboxRegistry();
  const created = call({ method: "POST", path: "/api/rooms/r1/approvals", data: card(), registry });
  const { status, value } = call({ method: "POST",
    path: `/api/rooms/r1/approvals/${created.value.id}/decide`,
    data: { decision: "approve", note: "ship it" }, registry, auth: human() });
  assert.equal(status, 200);
  assert.equal(value.status, "approved");
  assert.equal(value.decision.type, "approve");
  assert.equal(value.decision.by, "john");
  assert.equal(value.decision.note, "ship it");
  assert.ok(value.decision.at);
});

test("POST decide by an agent → 403 approval_not_human", () => {
  const registry = createApprovalInboxRegistry();
  const created = call({ method: "POST", path: "/api/rooms/r1/approvals", data: card(), registry });
  const e = callErr({ method: "POST", path: `/api/rooms/r1/approvals/${created.value.id}/decide`,
    data: { decision: "approve" }, registry, auth: agent() });
  assert.equal(e.status, 403);
  assert.equal(e.code, "approval_not_human");
});

test("POST decide with unknown decision → 422", () => {
  const registry = createApprovalInboxRegistry();
  const created = call({ method: "POST", path: "/api/rooms/r1/approvals", data: card(), registry });
  const e = callErr({ method: "POST", path: `/api/rooms/r1/approvals/${created.value.id}/decide`,
    data: { decision: "maybe" }, registry });
  assert.equal(e.status, 422);
  assert.equal(e.code, "approval_invalid");
});

test("POST decide twice → 409 approval_invalid_transition", () => {
  const registry = createApprovalInboxRegistry();
  const created = call({ method: "POST", path: "/api/rooms/r1/approvals", data: card(), registry });
  call({ method: "POST", path: `/api/rooms/r1/approvals/${created.value.id}/decide`,
    data: { decision: "deny-stop" }, registry });
  const e = callErr({ method: "POST", path: `/api/rooms/r1/approvals/${created.value.id}/decide`,
    data: { decision: "approve" }, registry });
  assert.equal(e.status, 409);
  assert.equal(e.code, "approval_invalid_transition");
});

test("POST decide deny-stop → rejected", () => {
  const registry = createApprovalInboxRegistry();
  const created = call({ method: "POST", path: "/api/rooms/r1/approvals", data: card(), registry });
  const { value } = call({ method: "POST", path: `/api/rooms/r1/approvals/${created.value.id}/decide`,
    data: { decision: "deny-stop", note: "too risky" }, registry });
  assert.equal(value.status, "rejected");
  assert.equal(value.decision.type, "deny-stop");
});

test("POST decide approve-session → approved, session-scoped", () => {
  const registry = createApprovalInboxRegistry();
  const created = call({ method: "POST", path: "/api/rooms/r1/approvals", data: card(), registry });
  const { value } = call({ method: "POST", path: `/api/rooms/r1/approvals/${created.value.id}/decide`,
    data: { decision: "approve-session" }, registry });
  assert.equal(value.status, "approved");
  assert.equal(value.decision.session, true);
});

test("expired pending card projects expired on read; decide → 409", () => {
  const registry = createApprovalInboxRegistry();
  const created = call({ method: "POST", path: "/api/rooms/r1/approvals",
    data: card({ expiresAt: new Date(Date.now() + 3600_000).toISOString() }), registry });
  const item = registry.get("room1", created.value.id);
  registry.set("room1", { ...item, expiresAt: new Date(Date.now() - 1000).toISOString() });
  const read = call({ path: `/api/rooms/r1/approvals/${created.value.id}`, registry });
  assert.equal(read.value.status, "expired");
  const e = callErr({ method: "POST", path: `/api/rooms/r1/approvals/${created.value.id}/decide`,
    data: { decision: "approve" }, registry });
  assert.equal(e.status, 409);
  assert.equal(e.code, "approval_expired");
});

test("POST decide unknown id → 404 approval_not_found", () => {
  const e = callErr({ method: "POST", path: "/api/rooms/r1/approvals/nope/decide", data: { decision: "approve" } });
  assert.equal(e.status, 404);
  assert.equal(e.code, "approval_not_found");
});

test("wrong method on decide → 405", () => {
  const e = callErr({ method: "GET", path: "/api/rooms/r1/approvals/abc/decide" });
  assert.equal(e.status, 405);
});
