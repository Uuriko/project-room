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
import { collectPublicReceipts } from "../server/receipts-live.mjs";
import { projectPublicWorkReceipt } from "../server/public-read-model.mjs";

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
  assert.deepEqual(calls.json.body.counters, { resultsVerified: 0, resultsTierVerified: 0, receiptsIssued: 0, workAvailableNow: 0 });
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

test("frontDoorFacts: resultsTierVerified counts recorded tiers, enumerated from the read model", t => {
  const store = openStore(t);
  // One merge-verified claim receipt and one recorded-only claim receipt.
  seedReceipt(store, { id: `pwr_${"a".repeat(64)}`, title: "Merged claim", at: "2026-10-01T00:00:00.000Z", merged: true });
  seedReceipt(store, { id: `pwr_${"b".repeat(64)}`, title: "Recorded claim", at: "2026-10-02T00:00:00.000Z", merged: false });
  // Two public-work receipts: one whose record carries the system_checked
  // tier, one whose record carries no verification (the outcome composes
  // hash_only). Seeded the way the public-work tests seed: task row,
  // receipt row, then the projector.
  store.db.prepare(`INSERT INTO public_work_tasks
    (offer_id, namespace_key, room_id, terms_version, repository_url, repository_ref, files_json, generation, created_at)
    VALUES ('offer-1', 'commons', 'commons', 1, 'https://github.com/Uuriko/project-room', 'main', '["README.md"]', 1, 0)`)
    .run();
  const insertRecord = store.db.prepare("INSERT INTO public_work_receipts VALUES (?,?,?,?,?,?,?,?,?,?)");
  const seedPublicWork = (id, extra) => {
    const body = { schema: "public-work-receipt/1", receiptId: id, taskId: "offer-1", namespaceId: "commons",
      identityId: "ai_public", title: "Public work", createdAt: "2026-10-03T00:00:00.000Z",
      artifact: { sha256: "cd".repeat(32) }, ...extra };
    insertRecord.run(id, "offer-1", "commons", 1, "ai_public", "note", "cd".repeat(32), 4, JSON.stringify(body), 0);
    projectPublicWorkReceipt(store, body, "cd".repeat(32));
  };
  seedPublicWork(`pwr_${"c".repeat(64)}`, { verification: "system_checked", state: "verified" });
  seedPublicWork(`pwr_${"d".repeat(64)}`, {});
  // One public-work row with no stored record at all: no tier composes.
  store.db.prepare(`INSERT INTO public_receipts
    (id, title, source, origin_room_id, room_id, room_title, agents_json, humans_json, pull_request, merged_at, hashes_json, at, start_href)
    VALUES (?, 'Unrecorded public work', 'public-work', 'commons', 'commons', 'Commons', '["agent-a"]', '[]', NULL, NULL, '{}', '2026-10-04T00:00:00.000Z', 'https://room.trydemigod.com/?start=room')`)
    .run(`pwr_${"e".repeat(64)}`);

  // Expected value derived by enumerating the tiers of the same read
  // model the handler counts over — never a hardcoded counter value.
  const receipts = collectPublicReceipts(store);
  const tierCounts = new Map();
  for (const receipt of receipts) {
    if (typeof receipt.verification === "string") tierCounts.set(receipt.verification, (tierCounts.get(receipt.verification) ?? 0) + 1);
  }
  assert.deepEqual(Object.fromEntries(tierCounts), { system_checked: 1, hash_only: 1 },
    "the seeded tiers compose onto the read model as recorded");
  const expectedTierVerified = ["system_checked", "hash_only"]
    .reduce((sum, tier) => sum + (tierCounts.get(tier) ?? 0), 0);

  const calls = callFacts(store);
  assert.equal(calls.json.body.counters.resultsTierVerified, expectedTierVerified,
    "the tier counter equals the enumerated recorded tiers");
  assert.equal(calls.json.body.counters.resultsVerified, 1,
    "tier-carrying receipts never inflate the merge counter");
  assert.equal(calls.json.body.counters.receiptsIssued, receipts.length);
});
