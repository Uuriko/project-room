// Plug-in funnel metrics (lane 10): doc read -> identity mint -> room join ->
// first claim -> first receipt -> still active day 7.
//
// Fail-first coverage for server/plugin-funnel.mjs:
// - key derivation is stable, hex, and domain-separated (identity vs reader)
// - stage recording is first-reach-wins and never throws on bad input
// - the pure report computes counts, conversions, drop-offs, median
//   time-to-stage, weekly cohorts, and the day-7 active slice
// - the HTTP handler is read-only (405 on write) and JSON-safe
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  PLUGIN_FUNNEL_STAGES,
  DAY7_WINDOW_MS,
  ensurePluginFunnelSchema,
  funnelIdentityKey,
  funnelReaderKey,
  recordPluginFunnelStage,
  recordPluginFunnelReader,
  pluginFunnelReport,
  collectPluginFunnelInputs,
  handlePluginFunnelRequest,
} from "../server/plugin-funnel.mjs";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-10-07T17:00:00.000Z");

function memoryDb() {
  return new DatabaseSync(":memory:");
}

test("funnel keys are stable, hex, and domain-separated", () => {
  const a = funnelIdentityKey("id-1");
  assert.equal(a, funnelIdentityKey("id-1"));
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, funnelIdentityKey("id-2"));
  const reader = funnelReaderKey({ address: "1.2.3.4", session: "sess" });
  assert.equal(reader, funnelReaderKey({ address: "1.2.3.4", session: "sess" }));
  assert.match(reader, /^[0-9a-f]{64}$/);
  // A reader key must never collide with an identity key for the same raw value.
  assert.notEqual(reader, funnelIdentityKey("1.2.3.4"));
  assert.equal(funnelIdentityKey(""), null);
  assert.equal(funnelReaderKey({ address: "", session: null }), null);
});

test("recordPluginFunnelStage is first-reach-wins and never throws", () => {
  const db = memoryDb();
  ensurePluginFunnelSchema(db);
  ensurePluginFunnelSchema(db); // idempotent
  const t0 = NOW - 10 * DAY;
  recordPluginFunnelStage(db, { identityId: "id-1", stage: "identity_mint", atMs: t0 });
  recordPluginFunnelStage(db, { identityId: "id-1", stage: "identity_mint", atMs: t0 + 999 });
  recordPluginFunnelStage(db, { identityId: "id-1", stage: "room_join", atMs: t0 + DAY });
  // Bad inputs are no-ops, never throws (metrics must not break hot paths).
  recordPluginFunnelStage(db, { identityId: "", stage: "identity_mint" });
  recordPluginFunnelStage(db, { identityId: "id-1", stage: "bogus" });
  recordPluginFunnelStage(db, { stage: "identity_mint" });
  recordPluginFunnelStage(null, { identityId: "id-1", stage: "identity_mint" });
  const rows = db.prepare("SELECT identity_key AS k, stage, reached_at AS at FROM plugin_funnel_events ORDER BY stage").all();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].at, t0, "first reach sticks");
  assert.deepEqual(rows.map(r => r.stage), ["identity_mint", "room_join"]);
  db.close();
});

test("recordPluginFunnelReader records doc_read under a reader key", () => {
  const db = memoryDb();
  recordPluginFunnelReader(db, { address: "9.9.9.9", session: null, atMs: NOW - DAY });
  recordPluginFunnelReader(db, { address: "9.9.9.9", session: null, atMs: NOW });
  const rows = db.prepare("SELECT stage, count(*) AS n FROM plugin_funnel_events GROUP BY stage").all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].stage, "doc_read");
  assert.equal(rows[0].n, 1);
  db.close();
});

test("pluginFunnelReport computes the funnel with drop-offs", () => {
  const key = funnelIdentityKey;
  const t0 = NOW - 20 * DAY;
  const stageEvents = [
    // Full journey: mint -> join -> claim -> receipt, still active.
    { identityKey: key("a"), stage: "identity_mint", reachedAt: t0 },
    { identityKey: key("a"), stage: "room_join", reachedAt: t0 + DAY },
    { identityKey: key("a"), stage: "first_claim", reachedAt: t0 + 2 * DAY },
    { identityKey: key("a"), stage: "first_receipt", reachedAt: t0 + 3 * DAY },
    // Drops after join.
    { identityKey: key("b"), stage: "identity_mint", reachedAt: t0 },
    { identityKey: key("b"), stage: "room_join", reachedAt: t0 + DAY },
    // Drops after mint.
    { identityKey: key("c"), stage: "identity_mint", reachedAt: t0 },
    // Too young for day-7 eligibility.
    { identityKey: key("d"), stage: "identity_mint", reachedAt: NOW - 2 * DAY },
    { identityKey: key("d"), stage: "room_join", reachedAt: NOW - DAY },
  ];
  const links = [
    { roomId: "r1", identityId: "a", memberId: "m-a" },
    { roomId: "r1", identityId: "b", memberId: "m-b" },
  ];
  // "a" posted a message yesterday -> day-7 active. "b" went quiet -> not.
  const messageActivity = [{ roomId: "r1", memberId: "m-a", atMs: NOW - DAY }];
  const claimActivity = [];
  const report = pluginFunnelReport({ stageEvents, links, messageActivity, claimActivity, nowMs: NOW });

  assert.equal(report.stages.identity_mint.count, 4);
  assert.equal(report.stages.room_join.count, 3);
  assert.equal(report.stages.first_claim.count, 1);
  assert.equal(report.stages.first_receipt.count, 1);
  assert.equal(report.conversions.mintToJoin.rate, 0.75);
  assert.equal(report.conversions.joinToClaim.rate, 0.3333);
  assert.equal(report.conversions.claimToReceipt.rate, 1);
  // Drop-off is the complement of the conversion rate.
  assert.equal(report.conversions.mintToJoin.dropoff, 0.25);

  // Day 7: a, b, c are eligible (>= 7d since mint); only a is active.
  assert.equal(report.day7.eligible, 3);
  assert.equal(report.day7.active, 1);
  assert.equal(report.day7.rate, 0.3333);

  // Median time-to-stage from mint.
  assert.equal(report.timeToStage.room_join.medianMs, DAY);
  assert.equal(report.timeToStage.first_claim.medianMs, 2 * DAY);
  assert.equal(report.timeToStage.first_receipt.medianMs, 3 * DAY);

  // Weekly cohort of the mint week carries all four mints.
  assert.equal(report.cohorts.length >= 1, true);
  const cohort = report.cohorts.find(c => c.minted === 3);
  assert.ok(cohort, "mint-week cohort present");
  assert.equal(cohort.day7Eligible, 3);
  assert.equal(cohort.day7Active, 1);

  // Definitions travel with the report so readers don't guess.
  assert.ok(report.definitions.identity_mint.includes("POST /api/agent-identities"));
});

test("pluginFunnelReport is empty-safe and JSON-safe", () => {
  const report = pluginFunnelReport({ nowMs: NOW });
  assert.equal(report.stages.identity_mint.count, 0);
  assert.equal(report.day7.eligible, 0);
  assert.equal(report.day7.active, 0);
  assert.equal(report.cohorts.length, 0);
  JSON.parse(JSON.stringify(report));
  const assertJsonSafe = (value, seen = new Set()) => {
    if (typeof value === "function") assert.fail("leaks a function");
    if (value !== null && typeof value === "object") {
      assert.ok(!seen.has(value), "cycle");
      seen.add(value);
      Object.values(value).forEach(v => assertJsonSafe(v, seen));
    }
  };
  assertJsonSafe(report);
});

test("doc_read readers are reported as a separate top-of-funnel population", () => {
  const stageEvents = [
    { identityKey: funnelReaderKey({ address: "1.1.1.1" }), stage: "doc_read", reachedAt: NOW - 9 * DAY },
    { identityKey: funnelReaderKey({ address: "2.2.2.2" }), stage: "doc_read", reachedAt: NOW - 8 * DAY },
    { identityKey: funnelIdentityKey("a"), stage: "identity_mint", reachedAt: NOW - 9 * DAY },
  ];
  const report = pluginFunnelReport({ stageEvents, nowMs: NOW });
  assert.equal(report.topOfFunnel.docReaders, 2);
  assert.equal(report.stages.identity_mint.count, 1);
  assert.ok(report.topOfFunnel.note.toLowerCase().includes("anonymous"));
});

test("claim activity counts toward day-7 active", () => {
  const t0 = NOW - 20 * DAY;
  const stageEvents = [
    { identityKey: funnelIdentityKey("a"), stage: "identity_mint", reachedAt: t0 },
    { identityKey: funnelIdentityKey("a"), stage: "room_join", reachedAt: t0 + DAY },
  ];
  const links = [{ roomId: "r1", identityId: "a", memberId: "m-a" }];
  const claimActivity = [{ roomId: "r1", memberId: "m-a", atMs: NOW - 2 * DAY }];
  const report = pluginFunnelReport({ stageEvents, links, messageActivity: [], claimActivity, nowMs: NOW });
  assert.equal(report.day7.eligible, 1);
  assert.equal(report.day7.active, 1);
});

test("handlePluginFunnelRequest refuses writes and reads aggregates", () => {
  const db = memoryDb();
  ensurePluginFunnelSchema(db);
  db.exec(`CREATE TABLE identity_links (room_id TEXT NOT NULL, identity_id TEXT NOT NULL, member_id TEXT NOT NULL, linked_at INTEGER NOT NULL, PRIMARY KEY (room_id, identity_id))`);
  db.exec(`CREATE TABLE events (room_id TEXT NOT NULL, sequence INTEGER NOT NULL, id TEXT NOT NULL UNIQUE, body TEXT NOT NULL, PRIMARY KEY(room_id, sequence))`);
  db.exec(`CREATE TABLE work_claims (room_id TEXT NOT NULL, claim_id TEXT NOT NULL, item_json TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (room_id, claim_id))`);
  const t0 = NOW - 10 * DAY;
  recordPluginFunnelStage(db, { identityId: "id-1", stage: "identity_mint", atMs: t0 });
  recordPluginFunnelStage(db, { identityId: "id-1", stage: "room_join", atMs: t0 + DAY });
  db.prepare("INSERT INTO identity_links(room_id,identity_id,member_id,linked_at) VALUES(?,?,?,?)").run("r1", "id-1", "m-1", t0 + DAY);
  const store = { db, now: () => NOW };

  const post = handlePluginFunnelRequest(store, { method: "POST" });
  assert.equal(post.status, 405);

  const get = handlePluginFunnelRequest(store, { method: "GET" });
  assert.equal(get.status, 200);
  assert.equal(get.body.stages.identity_mint.count, 1);
  assert.equal(get.body.stages.room_join.count, 1);
  assert.equal(get.body.day7.eligible, 1);
  assert.equal(get.body.day7.active, 0, "no recent activity recorded");
  JSON.parse(JSON.stringify(get.body));
  db.close();
});

test("collectPluginFunnelInputs reads the live tables", () => {
  const db = memoryDb();
  ensurePluginFunnelSchema(db);
  db.exec(`CREATE TABLE identity_links (room_id TEXT NOT NULL, identity_id TEXT NOT NULL, member_id TEXT NOT NULL, linked_at INTEGER NOT NULL, PRIMARY KEY (room_id, identity_id))`);
  db.exec(`CREATE TABLE events (room_id TEXT NOT NULL, sequence INTEGER NOT NULL, id TEXT NOT NULL UNIQUE, body TEXT NOT NULL, PRIMARY KEY(room_id, sequence))`);
  db.exec(`CREATE TABLE work_claims (room_id TEXT NOT NULL, claim_id TEXT NOT NULL, item_json TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (room_id, claim_id))`);
  const t0 = NOW - 10 * DAY;
  recordPluginFunnelStage(db, { identityId: "id-9", stage: "identity_mint", atMs: t0 });
  db.prepare("INSERT INTO identity_links(room_id,identity_id,member_id,linked_at) VALUES(?,?,?,?)").run("r1", "id-9", "m-9", t0);
  const envelope = JSON.stringify({ id: "e1", type: "message.posted", actorId: "m-9", roomId: "r1", at: new Date(NOW - DAY).toISOString(), data: {} });
  db.prepare("INSERT INTO events(room_id,sequence,id,body) VALUES(?,?,?,?)").run("r1", 1, "e1", envelope);
  db.prepare("INSERT INTO work_claims(room_id,claim_id,item_json,updated_at) VALUES(?,?,?,?)")
    .run("r1", "c1", JSON.stringify({ id: "c1", owner: "m-9" }), NOW - 2 * DAY);
  const store = { db, now: () => NOW };
  const inputs = collectPluginFunnelInputs(store, { nowMs: NOW });
  assert.equal(inputs.stageEvents.length, 1);
  assert.equal(inputs.links.length, 1);
  assert.equal(inputs.messageActivity.length, 1);
  assert.equal(inputs.claimActivity.length, 1);
  const report = pluginFunnelReport({ ...inputs, nowMs: NOW });
  assert.equal(report.day7.eligible, 1);
  assert.equal(report.day7.active, 1);
  db.close();
});

test("collectPluginFunnelInputs tolerates a store without the funnel table", () => {
  const db = memoryDb(); // no tables at all
  const store = { db, now: () => NOW };
  const inputs = collectPluginFunnelInputs(store, { nowMs: NOW });
  assert.deepEqual(inputs.stageEvents, []);
  const report = pluginFunnelReport({ ...inputs, nowMs: NOW });
  assert.equal(report.stages.identity_mint.count, 0);
  db.close();
});
