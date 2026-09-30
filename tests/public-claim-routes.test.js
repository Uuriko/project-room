// Public claim HTTP route tests — the ONE public verb (John's directive 2026-09-30).
// Tests handlePublicClaims directly (no http.mjs wiring needed).
import test from "node:test";
import assert from "node:assert/strict";
import { handlePublicClaims, _publicClaimRegistry } from "../server/public-claim-routes.mjs";

// Minimal mock req/res.
const mockReq = (method, pathname, search = "") => ({
  method,
  url: pathname + search,
});

const mockRes = () => {
  const chunks = [];
  return {
    statusCode: null,
    headers: {},
    writeHead(status, headers) { this.statusCode = status; this.headers = headers; },
    end(data) { if (data) chunks.push(data); this.body = Buffer.concat(chunks.map(c => Buffer.from(c))).toString(); },
  };
};

const mockUrl = (pathname, search = "") => new URL(`http://localhost${pathname}${search}`);

const mockBody = (data) => async (req) => data;

const identity = { id: "ai_test999", displayName: "Route Test Agent" };

const call = async ({ method, pathname, search = "", bodyData = {}, ident = null }) => {
  const req = mockReq(method, pathname, search);
  const res = mockRes();
  const url = mockUrl(pathname, search);
  const handled = await handlePublicClaims({
    req, res, url,
    body: mockBody(bodyData),
    identity: ident,
  });
  return { handled, status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
};

test("GET /api/claims returns empty list (public, no auth)", async () => {
  _publicClaimRegistry()._clear();
  const { handled, status, body } = await call({ method: "GET", pathname: "/api/claims" });
  assert.equal(handled, true);
  assert.equal(status, 200);
  assert.equal(body.status, "ok");
  assert.ok(Array.isArray(body.claims));
});

test("POST /api/claims without identity → 401", async () => {
  _publicClaimRegistry()._clear();
  const { handled, status, body } = await call({
    method: "POST", pathname: "/api/claims",
    bodyData: { taskId: "T-1", scope: { description: "Test" } },
    ident: null,
  });
  assert.equal(handled, true);
  assert.equal(status, 401);
  assert.equal(body.code, "identity_required");
});

test("POST /api/claims with identity → 201", async () => {
  _publicClaimRegistry()._clear();
  const { handled, status, body } = await call({
    method: "POST", pathname: "/api/claims",
    bodyData: { taskId: "T-ROUTE-1", scope: { description: "Route test" }, leaseHours: 2 },
    ident: identity,
  });
  assert.equal(handled, true);
  assert.equal(status, 201);
  assert.equal(body.status, "ok");
  assert.ok(body.claim.id);
  assert.equal(body.claim.taskId, "T-ROUTE-1");
  assert.equal(body.claim.state, "active");
});

test("GET /api/claims/{id} returns the claim (public)", async () => {
  _publicClaimRegistry()._clear();
  const created = await call({
    method: "POST", pathname: "/api/claims",
    bodyData: { taskId: "T-ROUTE-2", scope: { description: "Get test" } },
    ident: identity,
  });
  const id = created.body.claim.id;
  const { handled, status, body } = await call({ method: "GET", pathname: `/api/claims/${id}` });
  assert.equal(handled, true);
  assert.equal(status, 200);
  assert.equal(body.claim.id, id);
});

test("GET /api/claims/{id} unknown → 404", async () => {
  _publicClaimRegistry()._clear();
  const { status, body } = await call({ method: "GET", pathname: "/api/claims/pc_nonexistent" });
  assert.equal(status, 404);
  assert.equal(body.code, "not_found");
});

test("POST /api/claims/{id}/complete → receipt, then GET /api/receipts/{id} verifies", async () => {
  _publicClaimRegistry()._clear();
  const created = await call({
    method: "POST", pathname: "/api/claims",
    bodyData: { taskId: "T-ROUTE-3", scope: { description: "Complete test" } },
    ident: identity,
  });
  const id = created.body.claim.id;
  const completed = await call({
    method: "POST", pathname: `/api/claims/${id}/complete`,
    bodyData: { summary: "Did the thing." },
    ident: identity,
  });
  assert.equal(completed.status, 200);
  assert.ok(completed.body.receipt);
  assert.ok(completed.body.receipt.receiptId);

  const receiptId = completed.body.receipt.receiptId;
  const { status, body } = await call({ method: "GET", pathname: `/api/receipts/${receiptId}` });
  assert.equal(status, 200);
  assert.equal(body.verified, true);
  assert.equal(body.receipt.receiptId, receiptId);
});

test("POST /api/claims/{id}/heartbeat renews lease", async () => {
  _publicClaimRegistry()._clear();
  const created = await call({
    method: "POST", pathname: "/api/claims",
    bodyData: { taskId: "T-ROUTE-4", scope: { description: "Heartbeat test" } },
    ident: identity,
  });
  const id = created.body.claim.id;
  const { status, body } = await call({
    method: "POST", pathname: `/api/claims/${id}/heartbeat`,
    ident: identity,
  });
  assert.equal(status, 200);
  assert.equal(body.claim.state, "active");
});

test("unmatched path returns false (falls through)", async () => {
  const { handled } = await call({ method: "GET", pathname: "/api/other" });
  assert.equal(handled, false);
});

// G-LOW-7: mount-state characterization for the public claim verb.
//
// LATENT GAP (documented, not fixed here): handlePublicClaims is implemented
// and unit-tested above, and it is registered in scripts/runtime-package.mjs,
// but it is NOT mounted in server/http.mjs — no route calls it, so the verb
// 404s for everyone in production. Mounting is blocked on jillianai's live
// claim on server/http.mjs (RC-2026-09-28-2870), which this lane must not
// touch. This test characterizes the CURRENT reality (unmounted) so the gap
// is loud instead of silent; when the mount lands, flip the first assertion
// to require the mount and delete the "not mounted" branch.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const httpSource = readFileSync(join(root, "server/http.mjs"), "utf8");
const runtimePackageSource = readFileSync(join(root, "scripts/runtime-package.mjs"), "utf8");

test("mount state: claim verb registered for packaging, mount pending in http.mjs", () => {
  // Packaging registration must hold: the route module ships in the bundle.
  assert.ok(runtimePackageSource.includes("server/public-claim-routes.mjs"),
    "public-claim-routes.mjs must stay registered in scripts/runtime-package.mjs");
  // Current reality: NOT mounted in http.mjs (latent gap G-LOW-7). Flip this
  // to assert.ok(...includes("handlePublicClaims")) when the mount lands.
  assert.ok(!httpSource.includes("handlePublicClaims"),
    "EXPECTED CURRENT GAP: handlePublicClaims is not mounted in server/http.mjs — flip this assertion when the mount lands");
});
