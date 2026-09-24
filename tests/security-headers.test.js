import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "security-headers-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return `http://127.0.0.1:${server.address().port}`;
}

test("security headers: HSTS is sent on every response (#975)", async t => {
  const origin = await serve(t);
  const res = await fetch(`${origin}/api/health`);
  assert.equal(res.status, 200);
  // Node lowercases header names.
  assert.equal(
    res.headers.get("strict-transport-security"),
    "max-age=31536000; includeSubDomains",
    "HSTS header missing or wrong value on /api/health"
  );
});

test("security headers: sibling baseline headers still sent", async t => {
  const origin = await serve(t);
  const res = await fetch(`${origin}/api/health`);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("referrer-policy"), "no-referrer");
  assert.equal(res.headers.get("x-robots-tag"), "noindex, nofollow");
});
