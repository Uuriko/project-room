// WAVE-500 G10 slice 5/50: approval-inbox HTTP mount.
//
// Two contracts, one file:
//  1. The /api/rooms/{roomId}/approvals* route surface resolves at the
//     transport boundary (not 404) and, while slice 4's
//     server/approval-inbox-routes.mjs is not merged, answers 503
//     approval_inbox_not_ready — the surface is stable from day one,
//     only the implementation is pending.
//  2. The route-docs gate passes: every template the mount adds is
//     documented in docs/openapi.yaml (and nothing documented is
//     unserved).
//
// NOTE for slice 4's landing: the moment server/approval-inbox-routes.mjs
// exists with a handleApprovalInbox export, the 503 assertions below become
// stale ON PURPOSE — update them to the real handler's status codes then.
// A red test here after slice 4 lands is the signal that this file was not
// updated, not that the handler is broken.
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { routeDocsDrift, routeSources, servedRouteTemplates, templateKey } from "../scripts/route-docs-check.mjs";

const TEMPLATES = [
  "/api/rooms/{}/approvals",
  "/api/rooms/{}/approvals/{}",
  "/api/rooms/{}/approvals/{}/decide",
];

async function boot(t) {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom("commons"));
  const owner = store.issueAccessKey("commons", "owner");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = async (method, path) => {
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: { Authorization: `Bearer ${owner}`, "Content-Type": "application/json" },
      body: ["POST", "PUT", "PATCH"].includes(method) ? "{}" : undefined,
    });
    return { status: response.status, body: await response.json() };
  };
  return { request };
}

test("approval inbox routes resolve and 503 approval_inbox_not_ready until slice 4 lands", async t => {
  const { request } = await boot(t);
  for (const [method, path] of [
    ["GET", "/api/rooms/commons/approvals"],
    ["POST", "/api/rooms/commons/approvals"],
    ["GET", "/api/rooms/commons/approvals/probe-id"],
    ["POST", "/api/rooms/commons/approvals/probe-id/decide"],
  ]) {
    const { status, body } = await request(method, path);
    assert.equal(status, 503, `${method} ${path}: expected 503, the route must be mounted`);
    assert.equal(body?.error?.code, "approval_inbox_not_ready", `${method} ${path}: stable not-ready code`);
  }
});

test("route-docs gate passes with the approval inbox templates documented", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const sources = routeSources(root);
  const served = servedRouteTemplates(sources);
  for (const template of TEMPLATES) {
    assert.ok(served.has(templateKey(template)), `served set includes ${template}`);
  }
  const { failures } = routeDocsDrift(sources);
  assert.deepEqual(failures, [], "route-docs gate has no drift");
});
