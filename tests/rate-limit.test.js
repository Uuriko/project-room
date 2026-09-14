import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

// The rate-limit map used to refuse every NEW key with 429 once 2000 keys were
// live, so a busy minute (or one flood of foreign addresses) locked out every
// fresh login and join for up to a minute. Each key family is now bounded by
// least-recently-touched eviction instead, while per-key allowances stay put.

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-rate-limit-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  // Tests pick the visitor address per request, standing in for many clients.
  const server = createRoomServer({ store, resolveClientAddress: req => req.headers["x-test-address"] || "127.0.0.1" });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const login = address => fetch(`${origin}/api/session`, {
    method: "POST", headers: { Origin: origin, "Content-Type": "application/json", "X-Test-Address": address },
    body: JSON.stringify({ accessKey: "not-a-real-key" })
  });
  const slot = address => fetch(`${origin}/api/account-session`, { headers: { "X-Test-Address": address } });
  return { server, origin, login, slot };
}

test("a flood of foreign keys evicts old entries instead of locking out new callers", async t => {
  const { server, login, slot } = await serve(t);
  const flood = 2100;
  for (let batch = 0; batch < flood; batch += 100) {
    const statuses = await Promise.all(Array.from({ length: 100 }, (_, i) => login(`10.0.${Math.floor((batch + i) / 256)}.${(batch + i) % 256}`).then(r => r.status)));
    assert.ok(statuses.every(status => status === 401), `flood batch ${batch}: ${statuses.join(",")}`);
  }
  assert.ok(server.rateLimitKeys() <= 2000, `rate map bounded, saw ${server.rateLimitKeys()}`);
  const fresh = await login("192.168.1.1");
  assert.equal(fresh.status, 401, "a new login key is admitted, not refused as busy");
  const otherFamily = await slot("192.168.1.2");
  assert.equal(otherFamily.status, 200, "another key family is not starved by the login flood");
  assert.ok(server.rateLimitKeys() <= 2001, `rate map still bounded, saw ${server.rateLimitKeys()}`);
});

test("a single key is still limited after its allowance", async t => {
  const { login } = await serve(t);
  for (let i = 0; i < 10; i++) assert.equal((await login("10.9.9.9")).status, 401, `attempt ${i + 1}`);
  const limited = await login("10.9.9.9");
  assert.equal(limited.status, 429);
  assert.equal((await limited.json()).error.code, "rate_limited");
  assert.equal(limited.headers.get("x-ratelimit-limit"), "10");
  assert.equal(limited.headers.get("x-ratelimit-remaining"), "0");
  assert.equal((await login("10.9.9.10")).status, 401, "a different key keeps its own allowance");
});
