// GET /api/access-requests/:id was the one open route that bounded nothing by
// address. Every other open route calls rate() before doing any work.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";

test("polling an access request's status is bounded per address", async t => {
  const f = createAcceptanceFixture();
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${server.address().port}/api/access-requests/no-such-request?identityId=nobody`;
  const statuses = [];
  for (let i = 0; i < 61; i++) statuses.push((await fetch(url)).status);
  assert.ok(statuses.slice(0, 60).every(status => status === 404), "within the bound it answers as before");
  assert.equal(statuses[60], 429, "and past it the caller is told to slow down");
});
