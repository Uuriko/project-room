// Fail-first regression test for W6-01.
// Unsupported HTTP methods on an existing resource must answer 405
// (RFC 9110 sec 15.5.6; codebase convention, e.g. /api/public-work/match),
// not 404. Currently FAILS (returns 404) — fix should make it pass.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRoomServer } from "../server/http.mjs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";

test("W6-01: unsupported methods on /api/account-rooms return 405", async () => {
  const fixture = await createAcceptanceFixture();
  const server = createRoomServer({ store: fixture.store });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const method of ["PUT", "PATCH", "DELETE", "OPTIONS"]) {
      const r = await fetch(base + "/api/account-rooms", { method });
      const body = await r.text();
      assert.equal(r.status, 405, `${method} returned ${r.status}: ${body.slice(0, 120)}`);
    }
  } finally {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(r => server.close(r));
    fixture.store.close();
  }
});
