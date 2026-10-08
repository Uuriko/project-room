import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

// Wave-300 work item 1 (no-rearm penalty box): rate() in server/http.mjs.
// "login" buckets are durable (ABUSE_RATE_FAMILIES), so /api/session is the
// probe route: 10 admits (401, bad key), then 429s.

// Controllable clock: the server is in-process, so patching Date.now lets the
// test advance past the 60s rate window deterministically.
const realNow = Date.now;
let fakeNow = 0;
const useFakeClock = t => {
  fakeNow = realNow();
  Date.now = () => fakeNow;
  t.after(() => { Date.now = realNow; });
};
const advanceMs = ms => { fakeNow += ms; };

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-honest-bp-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const server = createRoomServer({ store, resolveClientAddress: req => req.headers["x-test-address"] || "127.0.0.1" });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const login = address => fetch(`${origin}/api/session`, {
    method: "POST", headers: { Origin: origin, "Content-Type": "application/json", "X-Test-Address": address },
    body: JSON.stringify({ accessKey: "not-a-real-key" })
  });
  const bucketRow = address => store.db
    .prepare("SELECT n, until_ms FROM abuse_rate_buckets WHERE id=?")
    .get(`login:${address}`) ?? null;
  return { login, bucketRow };
}

test("every 429 from rate() carries a Retry-After header with the seconds until window reset", async t => {
  useFakeClock(t);
  const { login } = await serve(t);
  const address = "10.8.8.8";
  for (let i = 0; i < 10; i++) assert.equal((await login(address)).status, 401, `attempt ${i + 1} admitted`);
  // The outer error handler stamps a blanket Retry-After: 60 on any 429; the
  // rate() refusal must override it with the true seconds until window reset.
  advanceMs(20_000);
  const refused = await login(address);
  assert.equal(refused.status, 429, "over the allowance: refused");
  const retryAfter = refused.headers.get("retry-after");
  assert.ok(retryAfter !== null, "429 carries Retry-After");
  assert.equal(retryAfter, "40",
    `Retry-After is the seconds until the window resets (60s window, 20s in), saw ${retryAfter}`);
  // Existing headers and body shape are unchanged (backward compat).
  assert.equal(refused.headers.get("x-ratelimit-limit"), "10");
  assert.equal(refused.headers.get("x-ratelimit-remaining"), "0");
  assert.ok(refused.headers.get("x-ratelimit-reset"), "X-RateLimit-Reset still present");
  assert.equal((await refused.json()).error.code, "rate_limited");
});

test("refused requests do not rewrite the durable abuse bucket", async t => {
  useFakeClock(t);
  const { login, bucketRow } = await serve(t);
  const address = "10.8.8.9";
  for (let i = 0; i < 10; i++) assert.equal((await login(address)).status, 401, `attempt ${i + 1} admitted`);
  const before = bucketRow(address);
  assert.ok(before, "bucket row persisted once the allowance was exhausted");
  assert.equal(before.n, 10, "durable count equals the allowance at exhaustion");
  for (let i = 0; i < 5; i++) assert.equal((await login(address)).status, 429, `reject ${i + 1}`);
  const after = bucketRow(address);
  assert.ok(after, "bucket row still present");
  assert.equal(after.n, before.n, "refused retries did not grow the durable count");
  assert.equal(after.until_ms, before.until_ms, "refused retries did not touch the window");
});

test("rejected retries do not re-arm the penalty window", async t => {
  useFakeClock(t);
  const { login } = await serve(t);
  const address = "10.8.8.10";
  for (let i = 0; i < 10; i++) assert.equal((await login(address)).status, 401, `attempt ${i + 1} admitted`);
  const firstRefusal = await login(address);
  assert.equal(firstRefusal.status, 429);
  const resetHeader = firstRefusal.headers.get("x-ratelimit-reset");
  for (let i = 0; i < 5; i++) {
    const refused = await login(address);
    assert.equal(refused.status, 429, `reject ${i + 1}`);
    assert.equal(refused.headers.get("x-ratelimit-reset"), resetHeader,
      "rejected retries did not extend the window");
  }
  advanceMs(61_000);
  const next = await login(address);
  assert.equal(next.status, 401,
    "admitted immediately once the window passes — rejects did not re-arm it");
});
