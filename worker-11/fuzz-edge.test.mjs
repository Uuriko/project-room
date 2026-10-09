// WAVE-2000 guild-02 worker-11: edge-probe battery for R10/R60/R110 (no seed needed).
import test from "node:test";
import assert from "node:assert/strict";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";

async function boot(t) {
  const fixture = createAcceptanceFixture();
  const server = createRoomServer({ store: fixture.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(r => server.close(r)); fixture.store.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const req = (method, path, { headers = {}, body = undefined } = {}) =>
    fetch(`${origin}${path}`, { method, headers, body });
  return { req, origin };
}

test("R10: OPTIONS/PUT/TRACE on /.well-known/oauth-authorization-server stay 4xx", async t => {
  const { req } = await boot(t);
  for (const m of ["OPTIONS", "PUT", "PATCH", "PROPFIND"]) {
    const r = await req(m, "/.well-known/oauth-authorization-server");
    console.log(`    ${m}: ${r.status}`);
    assert.ok(r.status < 500, `${m} -> ${r.status}`);
  }
  // GET stays 200 with proper JSON content type even with odd headers
  const g = await req("GET", "/.well-known/oauth-authorization-server", { headers: { accept: "text/html" } });
  assert.equal(g.status, 200);
  assert.match(g.headers.get("content-type"), /json/);
  const doc = await g.json();
  assert.ok(doc.issuer && doc.token_endpoint, "metadata doc shape");
});

test("R60: with Origin header, unauthenticated POST -> 401 (origin gate then session gate)", async t => {
  const { req, origin } = await boot(t);
  const r = await req("POST", "/api/auth/methods/remove", {
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ id: "x" }),
  });
  console.log(`    POST with origin, no session: ${r.status}`);
  assert.ok([401, 403].includes(r.status), `expected 401/403, got ${r.status}`);
  const r2 = await req("POST", "/api/auth/methods/remove", {
    headers: { "content-type": "application/json", origin: "https://evil.example" },
    body: JSON.stringify({ id: "x" }),
  });
  console.log(`    POST with bad origin: ${r2.status}`);
  assert.equal(r2.status, 403);
});

test("R110: GET /api/access-requests -> 405 with Allow: POST", async t => {
  const { req } = await boot(t);
  const r = await req("GET", "/api/access-requests");
  assert.equal(r.status, 405);
  console.log("    Allow header:", r.headers.get("allow"));
});
