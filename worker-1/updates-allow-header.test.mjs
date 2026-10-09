// WAVE-2000 guild-02 worker-1 — fail-first test for a fuzzing finding.
// FINDING: GET /api/updates accepts HEAD (200, verified live) but the 405
// handler at server/http.mjs:3181 advertises `Allow: GET`, omitting HEAD.
// An RFC 9110 Allow header must list every method the resource supports.
// Repro (live): curl -X POST http://127.0.0.1:<port>/api/updates -> 405, Allow: GET
//               curl -I -H "Authorization: Bearer <identity-secret>" http://127.0.0.1:<port>/api/updates -> 200
// This test FAILS on the current code (Allow is "GET") and PASSES once the
// 405 handler advertises "GET, HEAD".
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";

async function listen(t) {
  const directory = mkdtempSync(join(tmpdir(), "w1-updates-allow-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function mintSecret(origin) {
  const res = await fetch(`${origin}/api/agent-identities`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ displayName: "w1-allow-test" }),
  });
  assert.equal(res.status, 201);
  const data = await res.json();
  assert.ok(typeof data.secret === "string" && data.secret.length > 0);
  return data.secret;
}

test("/api/updates 405 Allow header lists every supported method", async t => {
  const origin = await listen(t);
  const secret = await mintSecret(origin);

  // HEAD is a supported method on this resource: it must appear in Allow.
  const head = await fetch(`${origin}/api/updates`, {
    method: "HEAD",
    headers: { Authorization: `Bearer ${secret}` },
  });
  assert.equal(head.status, 200, "HEAD /api/updates should be 200 for an authenticated caller");

  // A disallowed method returns 405 with an Allow header naming the supported ones.
  const post = await fetch(`${origin}/api/updates`, { method: "POST" });
  assert.equal(post.status, 405);
  const allow = post.headers.get("allow");
  assert.ok(allow, "405 response must carry an Allow header");
  const methods = allow.split(",").map(m => m.trim().toUpperCase());
  assert.ok(methods.includes("GET"), `Allow must include GET (got ${allow})`);
  assert.ok(methods.includes("HEAD"), `Allow must include HEAD since HEAD /api/updates returns 200 (got ${allow})`);
});
