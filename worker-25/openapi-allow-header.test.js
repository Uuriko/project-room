// WAVE-2000 guild-02 worker-25 — fail-first test.
// FINDING: non-GET/HEAD requests to /openapi.json return 405 WITHOUT an
// Allow header (server/http.mjs:1715), while the sibling POST-only route
// /api/share-links/join-agent sends `Allow: POST` on its 405 (http.mjs:2561).
// RFC 9110 section 15.5.6: a 405 response MUST include an Allow header.
// This test FAILS on current main (no Allow header) and PASSES once the
// reject carries { Allow: "GET, HEAD" }.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-openapi-allow-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(r => server.close(r)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return `http://127.0.0.1:${server.address().port}`;
}

test("non-GET/HEAD on /openapi.json returns 405 with an Allow header", async t => {
  const origin = await fixture(t);
  for (const method of ["POST", "PUT", "DELETE", "OPTIONS", "PATCH"]) {
    const res = await fetch(`${origin}/openapi.json`, { method });
    await res.text(); // drain
    assert.equal(res.status, 405, `${method} must be 405`);
    const allow = res.headers.get("allow");
    assert.ok(allow, `${method}: 405 response must carry an Allow header (RFC 9110 15.5.6)`);
    assert.match(allow, /GET/i, `${method}: Allow must name GET`);
    assert.match(allow, /HEAD/i, `${method}: Allow must name HEAD`);
  }
});
