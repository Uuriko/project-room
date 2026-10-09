// WAVE-2000 G02 worker-21 — FAIL-FIRST test.
// Finding: POST /api/agent-invites/preview (server/http.mjs:3038) returns 404 for a
// wrong method, while its sibling POST /api/referral-invites/preview (http.mjs:3026)
// and the rest of the dispatch chain answer 405 with an Allow header for known
// paths + wrong methods. A known resource with a disallowed method should be 405
// (RFC 9110 §15.5.6), not 404.
// Run: node --test worker-21/agent-invites-preview-method.test.mjs
// Currently FAILS (returns 404); passes once the 405 guard is added.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "w21-invite-preview-method-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return `http://127.0.0.1:${server.address().port}`;
}

async function request(origin, method, path, body) {
  const res = await fetch(`${origin}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Origin: origin },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, allow: res.headers.get("allow"), json };
}

test("POST /api/agent-invites/preview answers 405 (not 404) with Allow: GET", async t => {
  const origin = await serve(t);
  const res = await request(origin, "POST", "/api/agent-invites/preview?code=x", {});
  assert.equal(res.status, 405, `expected 405, got ${res.status} (${JSON.stringify(res.json)})`);
  assert.ok(res.allow && res.allow.includes("GET"), `Allow header should name GET, got ${res.allow}`);
  assert.equal(res.json?.error?.code ?? res.json?.code, "method_not_allowed");
});

test("DELETE /api/agent-invites/preview answers 405 (not 404)", async t => {
  const origin = await serve(t);
  const res = await request(origin, "DELETE", "/api/agent-invites/preview?code=x");
  assert.equal(res.status, 405, `expected 405, got ${res.status}`);
});

test("control: GET /api/referral-invites/preview already answers 405", async t => {
  const origin = await serve(t);
  const res = await request(origin, "GET", "/api/referral-invites/preview");
  assert.equal(res.status, 405);
  assert.ok(res.allow && res.allow.includes("POST"), `Allow header should name POST, got ${res.allow}`);
});
