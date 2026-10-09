// FIX-62: the documented identity-create (30/min) and access-request (20/min)
// per-address throttles must be real AND durable. Before this fix the families
// were not in ABUSE_RATE_FAMILIES, so a daemon restart wiped the in-memory
// buckets and handed the caller a fresh budget. `join` (20/min, the one-URL
// machine door that mints identities) is the same abuse surface and is
// registered alongside them.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { ABUSE_RATE_FAMILIES } from "../server/abuse-rate-buckets.mjs";

const DOCUMENTED = [
  ["identity-create", 30, "/api/agent-identities"],
  ["access-request", 20, "/api/access-requests"],
  ["join", 20, "/api/join"],
];

test("FIX-62: weak rate families are registered as abuse-durable", () => {
  for (const [family] of DOCUMENTED) {
    assert.ok(ABUSE_RATE_FAMILIES.has(family), `${family} must be in ABUSE_RATE_FAMILIES`);
  }
});

function openStore(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-fix62-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return store;
}

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
  const post = (path, body, address) => fetch(`${origin}${path}`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json", "X-Test-Address": address },
    body: JSON.stringify(body),
  });
  return { server, post, close };
}

const table = store => store.db.prepare(
  "SELECT name FROM sqlite_master WHERE type='table' AND name='abuse_rate_buckets'"
).get();

// The rate() call runs before body validation, so the first `limit` posts
// return 201/428/422/404 (not 429) and the `limit + 1`-th is 429.
for (const [family, limit, path] of DOCUMENTED) {
  test(`FIX-62: ${family} fires 429 at ${limit + 1} requests and the bucket survives a restart`, async t => {
    const store = openStore(t);
    const first = await listen(t, store);
    const body = family === "identity-create"
      ? { displayName: "burst-probe" }
      : { roomId: "no-such-room", identityId: "no-such-identity", displayName: "burst-probe", requestedPermissions: [] };
    const statuses = [];
    for (let i = 0; i < limit + 5; i++) {
      const res = await first.post(path, body, "10.9.9.9");
      statuses.push(res.status);
      await res.text().catch(() => {});
    }
    assert.ok(!statuses.slice(0, limit).includes(429),
      `first ${limit} ${family} requests must not be rate limited: ${statuses.join(",")}`);
    assert.ok(statuses.slice(limit).every(s => s === 429),
      `${family} requests ${limit + 1}+ must be 429: ${statuses.join(",")}`);
    assert.equal(table(store)?.name, "abuse_rate_buckets", `${family} bucket must be persisted`);
    await first.close();

    // A daemon restart: new server instance, same SQLite file.
    const second = await listen(t, store);
    const after = await second.post(path, body, "10.9.9.9");
    assert.equal(after.status, 429, `${family} must still be 429 after a restart`);
    assert.equal((await after.json()).error.code, "rate_limited");
    const other = await second.post(path, body, "10.9.9.10");
    assert.notEqual(other.status, 429, "a different address keeps its own allowance");
    await other.text().catch(() => {});
  });
}

test("FIX-62: a parallel identity-create burst is throttled per the documented 30/min", async t => {
  const store = openStore(t);
  const { post } = await listen(t, store);
  const results = await Promise.all(Array.from({ length: 40 }, () =>
    post("/api/agent-identities", { displayName: "parallel-probe" }, "10.9.9.9")
      .then(async r => { await r.text().catch(() => {}); return r.status; })));
  const limited = results.filter(s => s === 429).length;
  assert.ok(limited >= 10, `expected >= 10 429s from a 40-request parallel burst, saw ${limited}`);
  assert.ok(results.slice(0, 30).every(s => s !== 429), "first 30 parallel requests must not be 429");
});
