// #1603: the unauthenticated /api/public/* surface is human-facing
// (browser address bar, curl). A 404 on an unregistered public path must
// read as plain language — never with MCP agent-tool names in hint/next.
// Agent routes keep their machine-readable shape (see the control test).
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";

async function live(t) {
  const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  const request = (path, { method = "GET" } = {}) => fetch(`${origin}${path}`, { method });
  return { request };
}

test("unregistered /api/public/* 404 is human-readable, with no agent-tool references", async t => {
  const { request } = await live(t);
  // curl-like: no auth, no HTML preference.
  const res = await request("/api/public/rooms");
  assert.equal(res.status, 404);
  const body = await res.json();
  // Canonical envelope is intact.
  assert.equal(body.error.code, "not_found");
  assert.equal(body.category, "not_found");
  assert.equal(body.status, "action_required");
  assert.equal(body.reason, "not_found");
  assert.match(body.operationId, /^op_[A-Za-z0-9_-]{8}$/);
  // Human-readable: a plain-language hint pointing at the real directory,
  // and no tool entries anywhere in the body.
  assert.equal(typeof body.hint, "string");
  assert.ok(body.hint.length > 0, "hint present");
  assert.match(body.hint, /\/api\/public\/rooms\/directory/);
  const blob = JSON.stringify(body);
  assert.ok(!blob.includes("\"tool\""), `no tool entries in the 404 body: ${blob}`);
});

test("unregistered non-public /api/* 404 keeps the machine-readable agent shape", async t => {
  const { request } = await live(t);
  const res = await request("/api/definitely-not-here");
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.error.code, "not_found");
  assert.ok(Array.isArray(body.next), "next[] preserved");
  assert.ok(body.next.some(step => step.tool === "room_check_access"),
    "agent 404 contract unchanged");
});

// #1603 (Instinct-3 review): the registered public receipt routes are
// human-facing too — a missing receipt must not name agent tools.
test("missing public-work receipt 404 is human-readable, with no agent-tool references", async t => {
  const { request } = await live(t);
  for (const path of ["/api/public-work/receipts/no-such-receipt", "/api/public-work/receipts/no-such-receipt/artifact"]) {
    const res = await request(path);
    assert.equal(res.status, 404, path);
    const body = await res.json();
    assert.equal(body.error.code, "public_receipt_not_found", path);
    assert.equal(typeof body.hint, "string", path);
    assert.ok(body.hint.length > 0, `hint present for ${path}`);
    const blob = JSON.stringify(body);
    assert.ok(!blob.includes("\"tool\""), `no tool entries in the 404 body for ${path}: ${blob}`);
    assert.ok(body.next.some(step => step.path === "/api/public-work/tasks"), `human next for ${path}`);
  }
});
