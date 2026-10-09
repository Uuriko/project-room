// WORKER 27 fail-first test (WAVE-2000 guild-02 shard 26).
// Finding W27-01 (minor, advisory): the two POST-only routes in this shard
// answer wrong-method requests with 404 not_found instead of 405
// method_not_allowed. Sibling POST-only routes in server/http.mjs carry an
// explicit 405 guard with the stated design intent:
//   "a wrong method is 405 (Allow: POST), not a 404 unknown-route, so a
//    mistaken GET reads as a method error."  (see the
//    /api/share-links/join-agent guard, http.mjs)
// The OpenAPI docs for these two routes do not document 405, so this is a
// consistency nit, not a doc violation and not a security issue.
// This test currently FAILS (404 observed); it passes once the 405 guards land.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";

test("W27-01: POST-only shard routes reject wrong methods with 405, not 404", async t => {
  const f = await createAcceptanceFixture();
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close();
    if (f.directory) rmSync(f.directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const origin = base;
  for (const path of ["/api/auth/agent/rooms", "/api/share-links/join"]) {
    for (const method of ["GET", "PUT", "DELETE", "PATCH"]) {
      const r = await fetch(base + path, { method, headers: { origin } });
      await r.text().catch(() => {});
      assert.equal(r.status, 405, `${method} ${path}: expected 405, got ${r.status}`);
      const allow = r.headers.get("allow");
      assert.ok(allow && allow.includes("POST"), `${method} ${path}: Allow header should name POST, got ${allow}`);
    }
  }
});
