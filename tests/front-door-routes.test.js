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

test("the featured receipt skips internal QA and fleet test runs", async () => {
  const { featuredReceipt } = await import("../server/routes/front-door.mjs");
  const real = { id: "r3", title: "Docs link sweep: SWARM-PLUG-IN.md" };
  assert.equal(featuredReceipt([{ id: "r1", title: "FLEET-QA share journey: write the cold-open" }, { id: "r2", title: "QA: smoke" }, real]), real);
  assert.equal(featuredReceipt([{ id: "r1", title: "qa-grokbot room check" }]), null);
  assert.equal(featuredReceipt([]), null);
});

test("front-door provenance describes receipt units and samples the request clock", t => {
  const store = openStore(t);
  let now = Date.parse("2026-10-29T12:00:00.000Z");
  store.now = () => now;
  for (const letter of ["c", "d"]) seedReceipt(store, { id: `pwr_${letter.repeat(64)}`, title: "Same merged PR, separate receipt", at: "2026-10-01T00:00:00.000Z", merged: true });
  const first = callFacts(store).json.body;
  assert.equal(first.counters.resultsVerified, 2, "two receipts for one PR are not one unique merge");
  assert.equal(first.computedAt, new Date(now).toISOString());
  assert.equal(first.provenance.kind, "request-snapshot");
  assert.equal(first.provenance.counters.resultsVerified.unit, "merge-linked receipt");
  assert.equal(first.provenance.counters.resultsVerified.source, "/receipts");
  assert.match(first.provenance.counters.resultsVerified.definition, /not distinct pull requests/);
  assert.equal(first.provenance.counters.receiptsIssued.unit, "public receipt");
  assert.equal(first.provenance.counters.workAvailableNow.source, "/offers");
  now += 2500;
  const next = callFacts(store).json.body;
  assert.equal(next.computedAt, new Date(now).toISOString());
  assert.notEqual(next.computedAt, first.computedAt);
  assert.equal(next.latestReceipt.at, "2026-10-01T00:00:00.000Z");
});

test("public counter provenance does not include hidden receipts or private room identifiers", t => {
  const store = openStore(t);
  const hidden = `pwr_${"e".repeat(64)}`;
  seedReceipt(store, { id: hidden, title: "Private receipt title", at: "2026-10-01T00:00:00.000Z", merged: true });
  store.db.prepare("UPDATE public_receipts SET origin_room_id='private-room-sentinel',room_id='private-room-sentinel' WHERE id=?").run(hidden);
  store.db.prepare(`INSERT INTO room_directory_settings (room_id, discoverable, listed_at, updated_at, public_receipts)
    VALUES ('private-room-sentinel', 0, NULL, 0, 0)`).run();
  const before = callFacts(store).json.body;
  assert.equal(before.counters.receiptsIssued, 0);
  assert.equal(before.counters.resultsVerified, 0);
  assert.equal(before.latestReceipt, null);
  assert.ok(before.provenance);
  for (const secret of [hidden, "private-room-sentinel", "Private receipt title"]) assert.ok(!JSON.stringify(before).includes(secret));
  store.db.prepare("UPDATE room_directory_settings SET public_receipts=1 WHERE room_id='private-room-sentinel'").run();
  assert.equal(callFacts(store).json.body.counters.resultsVerified, 1, "explicit owner publication allows the existing public receipt");
  store.db.prepare("INSERT INTO public_unpublish (kind,target,at,by_account) VALUES ('receipt',?,0,'op')").run(hidden);
  assert.equal(callFacts(store).json.body.counters.receiptsIssued, 0, "operator removal remains effective");
});
