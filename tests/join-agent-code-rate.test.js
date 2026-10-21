// GET /join/<code> looks an agent invite code up (a scrypt hash per call,
// see server/agent-invites.mjs codeHash) to decide whether to reroute it.
// That lookup must sit behind the same per-address limit as /a/<code>
// (30/min) and the preview API (20/min); otherwise /join is an unlimited,
// unauthenticated door to a deliberately slow, event-loop-blocking hash.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-join-rate-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  let previews = 0;
  const preview = store.invites.preview.bind(store.invites);
  store.invites.preview = code => { previews++; return preview(code); };
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { origin: `http://127.0.0.1:${server.address().port}`, ownerKey, previews: () => previews };
}

// Valid v2 shape (RM- + 16 Crockford symbols), never issued.
const guess = i => `RM-${String(i).padStart(16, "0")}`;

for (const accept of ["text/html", "*/*"]) {
  test(`/join/<code> invite lookups are rate limited per address (Accept: ${accept})`, async t => {
    const { origin, previews } = await serve(t);
    const statuses = [];
    for (let i = 0; i < 40; i++) {
      const res = await fetch(`${origin}/join/${guess(i)}`, { headers: { Accept: accept } });
      await res.arrayBuffer();
      statuses.push(res.status);
    }
    assert.ok(statuses.includes(429), `40 lookups from one address were never limited: ${[...new Set(statuses)]}`);
    assert.ok(previews() <= 30, `${previews()} scrypt lookups ran for 40 requests; the /a/ limit is 30`);
  });
}

test("a live code fetched without HTML still gets the /a/ steps, with one lookup", async t => {
  const { origin, ownerKey, previews } = await serve(t);
  const minted = await fetch(`${origin}/api/rooms/commons/agent-invites`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerKey}` },
    body: JSON.stringify({ profile: "contribute", expiresInMinutes: 30 }),
  }).then(r => r.json());
  const before = previews();
  const res = await fetch(`${origin}/join/${minted.code}`, { headers: { Accept: "*/*" } });
  const text = await res.text();
  assert.equal(res.status, 200);
  assert.match(text, new RegExp(minted.code));
  assert.equal(previews() - before, 1, "one GET should hash the code once, not twice");
});

// DEFECT-PLP-1: the bucket above was in-memory only, so on the deployed
// build every isolate handed out a fresh 30/min and the limit never bound
// (75 rapid well-formed lookups, 0 responses with status 429). The family
// is now in ABUSE_RATE_FAMILIES: the count persists in the store, so a
// second HTTP server over the same database — what an isolate restart or
// eviction is — inherits the spent budget instead of a fresh one.
async function servePair(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-join-rate-durable-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  let previews = 0;
  const preview = store.invites.preview.bind(store.invites);
  store.invites.preview = code => { previews++; return preview(code); };
  const listen = async () => {
    const server = createRoomServer({ store, resolveClientAddress: req => req.headers["x-test-address"] || "127.0.0.1" });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    return {
      origin: `http://127.0.0.1:${server.address().port}`,
      close: async () => {
        server.closeStreams();
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
      },
    };
  };
  t.after(async () => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, ownerKey, listen, previews: () => previews };
}

const fromAddress = address => ({ headers: { Accept: "*/*", "X-Test-Address": address } });

test("the shared lookup limit survives a restart over the same database", async t => {
  const { store, listen, previews } = await servePair(t);
  const first = await listen();
  const statuses = [];
  let limited;
  for (let i = 0; i < 40; i++) {
    const res = await fetch(`${first.origin}/a/${guess(i)}`, fromAddress("10.6.6.6"));
    await res.arrayBuffer();
    statuses.push(res.status);
    if (res.status === 429) limited = res;
  }
  assert.ok(limited, `40 lookups from one address were never limited: ${[...new Set(statuses)]}`);
  assert.equal(previews(), 30, "the first server still stops hashing at the limit");
  assert.equal(limited.headers.get("x-ratelimit-bucket"), "agent-connect", "the 429 names the shared bucket");
  const row = store.db.prepare("SELECT n FROM abuse_rate_buckets WHERE family='agent-connect' AND id=?")
    .get("agent-connect:10.6.6.6");
  assert.ok(row && row.n >= 30, `the spent budget persisted (row: ${JSON.stringify(row)})`);
  await first.close();

  const second = await listen();
  const spent = previews();
  for (const path of ["a", "join"]) {
    const res = await fetch(`${second.origin}/${path}/${guess(41)}`, fromAddress("10.6.6.6"));
    await res.arrayBuffer();
    assert.equal(res.status, 429, `after a restart, /${path} hands the same address a fresh budget`);
    assert.equal(res.headers.get("x-ratelimit-bucket"), "agent-connect");
  }
  assert.equal(previews(), spent, "refused lookups after a restart must not hash another code");
  const other = await fetch(`${second.origin}/a/${guess(42)}`, fromAddress("10.6.6.7"));
  await other.arrayBuffer();
  assert.notEqual(other.status, 429, "a different address keeps its own allowance");
  assert.equal(previews(), spent + 1);
  await second.close();
});

test("a live code still redeems after a restart, with one lookup", async t => {
  const { ownerKey, listen, previews } = await servePair(t);
  const first = await listen();
  const minted = await fetch(`${first.origin}/api/rooms/commons/agent-invites`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerKey}` },
    body: JSON.stringify({ profile: "contribute", expiresInMinutes: 30 }),
  }).then(r => r.json());
  const warm = await fetch(`${first.origin}/a/${minted.code}`, { headers: { Accept: "*/*" } });
  await warm.arrayBuffer();
  assert.equal(warm.status, 200);
  await first.close();

  const second = await listen();
  const before = previews();
  const res = await fetch(`${second.origin}/join/${minted.code}`, { headers: { Accept: "*/*" } });
  const text = await res.text();
  assert.equal(res.status, 200);
  assert.match(text, new RegExp(minted.code));
  assert.equal(previews() - before, 1, "one GET after a restart should hash the code once, not twice");
  await second.close();
});

test("/a and /join share one invite lookup budget", async t => {
  const { origin, previews } = await serve(t);
  for (let i = 0; i < 30; i++) {
    const path = i % 2 ? "a" : "join";
    const res = await fetch(`${origin}/${path}/${guess(i)}`, { headers: { Accept: "*/*" } });
    await res.arrayBuffer();
    assert.notEqual(res.status, 429, `request ${i + 1} consumed more than one slot`);
  }
  assert.equal(previews(), 30);
  for (const path of ["a", "join", "room/join"]) {
    const res = await fetch(`${origin}/${path}/${guess(31)}`, { headers: { Accept: "*/*" } });
    await res.arrayBuffer();
    assert.equal(res.status, 429);
  }
  assert.equal(previews(), 30, "rejected requests must not hash another code");
});
