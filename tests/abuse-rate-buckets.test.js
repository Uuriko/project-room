// Abuse rate limits have to outlive Durable Object eviction. A second HTTP
// server over the same SQLite file is what a restart is.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { pruneAbuseRateBuckets, saveAbuseRateBucket } from "../server/abuse-rate-buckets.mjs";

function openStore(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-abuse-rate-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return store;
}

const table = store => store.db.prepare(
  "SELECT name FROM sqlite_master WHERE type='table' AND name='abuse_rate_buckets'"
).get();

async function listen(t, store) {
  const server = createRoomServer({ store, resolveClientAddress: req => req.headers["x-test-address"] || "127.0.0.1" });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const close = () => new Promise(resolve => {
    server.closeStreams();
    server.closeAllConnections();
    server.close(resolve);
  });
  t.after(close);
  const login = address => fetch(`${origin}/api/session`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json", "X-Test-Address": address },
    body: JSON.stringify({ accessKey: "not-a-real-key" })
  });
  return { server, login, close };
}

test("a login limit survives a restart over the same database", async t => {
  const store = openStore(t);
  assert.equal(table(store), undefined, "opening a room does not create the abuse table");
  const first = await listen(t, store);
  for (let i = 0; i < 10; i++) assert.equal((await first.login("10.9.9.9")).status, 401, `attempt ${i + 1}`);
  assert.equal(table(store).name, "abuse_rate_buckets");
  await first.close();

  const second = await listen(t, store);
  const limited = await second.login("10.9.9.9");
  assert.equal(limited.status, 429);
  assert.equal((await limited.json()).error.code, "rate_limited");
  assert.equal((await second.login("10.9.9.10")).status, 401, "a different address keeps its own allowance");
});

test("an expired bucket is ignored and a bounded prune removes it", async t => {
  const store = openStore(t);
  assert.equal(pruneAbuseRateBuckets(store.db, { now: Date.now(), limit: 10 }).pruned, 0);
  assert.equal(table(store), undefined, "prune does not create the table");
  const now = Date.now();
  saveAbuseRateBucket(store.db, "login:10.4.4.4", { n: 10, until: now - 1000 });
  const indexes = store.db.prepare(
    "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='abuse_rate_buckets'"
  ).all().map(row => row.name);
  assert.ok(indexes.includes("abuse_rate_buckets_until"));
  assert.ok(indexes.includes("abuse_rate_buckets_family_n"));
  saveAbuseRateBucket(store.db, "login:10.4.4.5", { n: 10, until: now + 60_000 });
  saveAbuseRateBucket(store.db, "login:10.4.4.6", { n: 10, until: now - 1000 });
  const { login } = await listen(t, store);
  assert.equal((await login("10.4.4.4")).status, 401, "an expired bucket does not count");
  assert.equal((await login("10.4.4.5")).status, 429, "a live bucket still limits");
  assert.equal(pruneAbuseRateBuckets(store.db, { now: Date.now(), limit: 1 }).pruned, 1);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM abuse_rate_buckets WHERE until_ms <= ?").get(Date.now()).n, 1);
  assert.ok(pruneAbuseRateBuckets(store.db, { now: Date.now(), limit: 100 }).pruned >= 1);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM abuse_rate_buckets WHERE until_ms <= ?").get(Date.now()).n, 0);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM abuse_rate_buckets WHERE id='login:10.4.4.5'").get().n, 1);
});
