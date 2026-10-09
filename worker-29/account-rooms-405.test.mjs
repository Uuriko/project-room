// FAIL-FIRST test — WAVE-2000 GUILD-02 WORKER 29 finding.
// server/http.mjs:2050-2062 — /api/account-rooms handles GET and POST but has no
// explicit 405 guard for other methods, unlike sibling routes:
//   /api/referral-invites/preview (http.mjs:3032)  → 405 Allow: POST
//   /api/public/rooms/directory   (http.mjs:1729) → 405
//   /api/opportunities.json       (http.mjs:1829) → 405
// PUT/PATCH/DELETE/HEAD/OPTIONS on the existing /api/account-rooms resource
// currently fall through to 404 not_found. Expected: 405 method_not_allowed
// with an Allow header naming GET, POST.
// Run: node --test worker-29/account-rooms-405.test.mjs   (from the repo root)
// Currently FAILS (status is 404). Passes once a 405 guard is added.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createRoomServer } from "../server/http.mjs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";

let server, fixture, port;
const once = (opts, bodyText) => new Promise(resolve => {
  const req = http.request({ host: "127.0.0.1", port, agent: false, ...opts }, res => {
    let t = "";
    res.on("data", d => (t += d));
    res.on("end", () => resolve({ status: res.statusCode, allow: res.headers.allow, body: t }));
  });
  req.on("error", e => resolve({ status: "ERR", body: e.message }));
  if (bodyText) req.write(bodyText);
  req.end();
});

before(async () => {
  fixture = await createAcceptanceFixture();
  server = createRoomServer({ store: fixture.store });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  port = server.address().port;
});
after(async () => {
  try { server.closeStreams(); server.closeAllConnections(); await new Promise(r => server.close(r)); } catch {}
  try { fixture.store.close(); } catch {}
});

describe("POST/GET-only /api/account-rooms rejects other methods with 405", () => {
  for (const method of ["PUT", "PATCH", "DELETE"]) {
    it(`${method} /api/account-rooms → 405 method_not_allowed with Allow header`, async () => {
      const r = await once({ method, path: "/api/account-rooms" });
      assert.equal(r.status, 405, `expected 405, got ${r.status}: ${r.body.slice(0, 120)}`);
      assert.match(String(r.allow || ""), /GET/i, "Allow header must name GET");
      assert.match(String(r.allow || ""), /POST/i, "Allow header must name POST");
    });
  }
});
