// Direct coverage for server/routes/front-door.mjs (EXP-7 Variant B):
// the route-table rows and the facts handler exercised without HTTP, so
// the module itself — not only the served endpoint — carries a test
// reference. End-to-end hero/facts behavior over HTTP stays in
// tests/landing-hero-exp.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { FRONT_DOOR_ROUTES, frontDoorFacts } from "../server/routes/front-door.mjs";

function openStore(t) {
  const directory = mkdtempSync(join(tmpdir(), "front-door-routes-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return store;
}

function seedReceipt(store, { id, title, at, merged }) {
  store.db.prepare(`INSERT INTO public_receipts
    (id, title, source, origin_room_id, room_id, room_title, agents_json, humans_json, pull_request, merged_at, hashes_json, at, start_href)
    VALUES (?, ?, 'work-claim', 'commons', 'commons', 'Commons', '["agent-a"]', '["human-b"]', ?, ?, '{}', ?, 'https://room.trydemigod.com/?start=room')`)
    .run(id, title, merged ? "https://github.com/Uuriko/project-room/pull/1" : null, merged ? at : null, at);
}

// frontDoorFacts speaks the route-handler ctx contract; capture what it
// would send instead of standing up a server.
function callFacts(store, method = "GET") {
  const calls = { rates: [], headers: {}, json: null };
  const res = { setHeader: (name, value) => { calls.headers[name] = value; } };
  frontDoorFacts({
    remoteAddress: "203.0.113.7",
    store,
    req: { method },
    res,
    rate: (key, limit) => { calls.rates.push([key, limit]); },
    json: (target, status, body, headOnly) => { calls.json = { target, status, body, headOnly }; },
  });
  return calls;
}

test("front-door route rows: GET and HEAD on /api/public/front-door, open by design", () => {
  assert.deepEqual(FRONT_DOOR_ROUTES.map(row => [row.method, row.path, row.auth, row.scope]), [
    ["GET", "/api/public/front-door", "none", "public"],
    ["HEAD", "/api/public/front-door", "none", "public"],
  ]);
  for (const row of FRONT_DOOR_ROUTES) assert.equal(row.handler, frontDoorFacts);
});

test("frontDoorFacts: empty store reports honest zeros, no-store, rate-limited", t => {
  const calls = callFacts(openStore(t));
  assert.deepEqual(calls.rates, [["receipts:203.0.113.7", 120]]);
  assert.equal(calls.headers["Cache-Control"], "no-store");
  assert.equal(calls.json.status, 200);
  assert.equal(calls.json.headOnly, false);
  assert.equal(calls.json.body.schema, "project-room-front-door/1");
  assert.deepEqual(calls.json.body.counters, { resultsVerified: 0, receiptsIssued: 0, workAvailableNow: 0 });
  assert.equal(calls.json.body.latestReceipt, null);
});

test("frontDoorFacts: counters computed from the receipts; HEAD passes the head flag", t => {
  const store = openStore(t);
  seedReceipt(store, { id: `pwr_${"a".repeat(64)}`, title: "Older verified work", at: "2026-10-01T00:00:00.000Z", merged: true });
  seedReceipt(store, { id: `pwr_${"b".repeat(64)}`, title: "Newer recorded work", at: "2026-10-05T00:00:00.000Z", merged: false });
  const calls = callFacts(store, "HEAD");
  assert.equal(calls.json.headOnly, true);
  assert.equal(calls.json.body.counters.receiptsIssued, 2);
  assert.equal(calls.json.body.counters.resultsVerified, 1, "only the receipt with a server-recorded merge counts");
  assert.equal(calls.json.body.latestReceipt.title, "Newer recorded work");
  assert.equal(calls.json.body.latestReceipt.mergedAt, null);
  assert.equal(calls.json.body.latestReceipt.pullRequest, null);
  assert.deepEqual(calls.json.body.latestReceipt.agents, ["agent-a"]);
  assert.deepEqual(calls.json.body.latestReceipt.humans, ["human-b"]);
});
