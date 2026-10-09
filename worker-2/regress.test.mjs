// WAVE-2000 guild-02 worker-2 — fail-first regression tests for shard 2/50.
// Shard handlers (server/http.mjs dispatch lines):
//   L953  writeSecurityTxt  (/.well-known/security.txt, /security.txt, /room/.well-known/security.txt)
//   L2317 /api/auth/github/link/start
//   L3170 /api/updates (GET/HEAD)
//
// F-W2-01: 405 from /api/auth/github/link/start omits the Allow header,
// violating RFC 9110 section 15.5.6 ("the origin server MUST generate an
// Allow header field in a 405 response"). Sibling handlers in the same
// dispatch table include it (security.txt -> "GET, HEAD"; /api/updates -> "GET").
// The F-W2-01 test FAILS on the current tree and must pass after the fix.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";

async function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), "w2regress-"));
  const store = new RoomStore(join(dir, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const identity = store.identities.create("Regression Agent");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(dir, { recursive: true, force: true });
  });
  return { origin: `http://127.0.0.1:${server.address().port}`, secret: identity.secret };
}

test("F-W2-01: 405 from /api/auth/github/link/start carries an Allow header naming GET", async t => {
  const { origin } = await setup(t);
  const res = await fetch(`${origin}/api/auth/github/link/start`, { method: "POST" });
  assert.equal(res.status, 405);
  const allow = res.headers.get("allow");
  assert.ok(allow, "405 response must include an Allow header (RFC 9110 15.5.6)");
  assert.ok(allow.split(",").map(s => s.trim()).includes("GET"), `Allow must name GET, got: ${allow}`);
  await res.text();
});

test("405 Allow headers stay consistent across the shard handlers (guards)", async t => {
  const { origin } = await setup(t);
  for (const [method, path, want] of [
    ["POST", "/.well-known/security.txt", ["GET", "HEAD"]],
    ["DELETE", "/api/updates", ["GET"]],
    ["PUT", "/api/updates", ["GET"]],
  ]) {
    const res = await fetch(`${origin}${path}`, { method });
    assert.equal(res.status, 405, `${method} ${path}`);
    const allow = (res.headers.get("allow") || "").split(",").map(s => s.trim());
    for (const m of want) assert.ok(allow.includes(m), `${method} ${path}: Allow must include ${m}`);
    await res.text();
  }
});

test("malformed /api/updates query values stay 422 (characterization)", async t => {
  const { origin, secret } = await setup(t);
  const auth = { Authorization: `Bearer ${secret}` };
  const bad = [
    "limit=abc", "limit=", "limit=0", "limit=-5", "limit=1.5", "limit=101",
    "limit=99999999999999999999", "limit=Infinity", "limit=1&limit=2",
    "state=archived", "state=", "state=Actionable",
    "kinds=nope", "kinds=,,,", "kinds=request,nope", "kinds=request&kinds=mention",
    "cursor=!!!not-base64!!!", "cursor=e30",
    "frobnicate=1", "a=1&b=2",
  ];
  for (const qs of bad) {
    const res = await fetch(`${origin}/api/updates?${qs}`, { headers: auth });
    assert.equal(res.status, 422, `?${qs} must be 422, got ${res.status}`);
    await res.text();
  }
});

test("unauthenticated /api/updates stays 401 across credential shapes", async t => {
  const { origin } = await setup(t);
  const cases = [
    ["no credentials", {}],
    ["forged well-formed secret", { Authorization: `Bearer pri_${"A".repeat(64)}` }],
    ["malformed bearer", { Authorization: "Bearer short" }],
    ["empty bearer", { Authorization: "Bearer " }],
    ["empty session cookie", { Cookie: "account_session=" }],
  ];
  for (const [name, headers] of cases) {
    const res = await fetch(`${origin}/api/updates`, { headers });
    assert.equal(res.status, 401, `${name}: expected 401, got ${res.status}`);
    await res.text();
  }
});
