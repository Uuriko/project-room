// Dashboard honesty pass (opps #24/#27/#28) — honesty invariants.
//
// Authoring gate (test-audit SKILL.md):
// 1. Observable contract: the dashboard's honesty section (a) never
//    mislabels lane activity — unconfigured attribution is flagged, never
//    silently folded; (b) never fabricates a USD number; (c) publishes
//    unmeasured falsifiers as rows instead of hiding them.
// 2. Credible regressions: a change that counts lane activity as organic
//    without the unconfigured flag; a hardcoded USD conversion; a
//    falsifier row dropped to make the dashboard look better.
// 3. No existing coverage: new module, new functions, new report section.
// 4. No production seam: functions take plain events/db; expectations are
//    hand-computed from the fixture inputs, never from the helpers.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { FIXED_MS, openRoom } from "./analytics-fixture.mjs";
import { backfillFile } from "../scripts/analytics-backfill.mjs";
import {
  dashboardHonestyReport,
  falsifierRows,
  laneActivitySplit,
  nonJohnFundedSettledPerWeek
} from "../server/analytics/dashboard-honesty.mjs";
import * as barrel from "../server/analytics/index.mjs";

const WEEK_ISO = "2026-09-28";
const AT = Date.parse(`${WEEK_ISO}T12:00:00.000Z`);

function event(name, actorKind, actorId) {
  return { name, at: AT, roomId: "alpha", actorKind, actorId, props: {}, weight: 1 };
}

function memoryDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE analytics_events (name TEXT, at INTEGER, room_id TEXT, actor_kind TEXT, actor_id TEXT, props TEXT, weight REAL)`);
  db.exec(`CREATE TABLE bounty_journal (room_id TEXT, at TEXT, kind TEXT, bounty_id TEXT, amount INTEGER)`);
  db.exec(`CREATE TABLE bounty_records (bounty_id TEXT PRIMARY KEY, room_id TEXT, state TEXT, state_changed_ms INTEGER, poster TEXT)`);
  return db;
}

test("lane split labels lane activity as testing, distinctly from organic", () => {
  const events = [
    event("claim_claimed", "agent", "lane1"),
    event("pr_merged", "agent", "lane1"),
    event("claim_claimed", "agent", "agent9"),
    event("claim_claimed", "agent", "agent9"),
    event("claim_claimed", "agent", "agent9"),
    event("claim_claimed", "human", "owner")
  ];
  const rows = laneActivitySplit({ events, now: FIXED_MS, laneActorIds: new Set(["lane1"]) });
  const week = rows.find(row => row.week === WEEK_ISO);
  assert.equal(week.laneActivityTesting, 2);
  assert.equal(week.organicAgentActivity, 3);
  assert.equal(week.humanActivity, 1);
  assert.equal(week.laneShareOfAgentActivity, 40.0);
  assert.equal(week.laneAttribution, "configured");
});

test("unconfigured lane attribution is flagged, never silently folded", () => {
  const events = [event("claim_claimed", "agent", "lane1"), event("claim_claimed", "agent", "lane1")];
  const rows = laneActivitySplit({ events, now: FIXED_MS });
  const week = rows.find(row => row.week === WEEK_ISO);
  assert.equal(week.laneActivityTesting, 0);
  assert.equal(week.laneAttribution, "unconfigured");
  // No lane share is claimed when attribution is unconfigured; the
  // falsifier row (below) reports status unconfigured, not a zero share.
  const db = memoryDb();
  const falsifiers = falsifierRows({ db, events, now: FIXED_MS });
  const lane = falsifiers.find(row => row.id === "lane_share_of_traction");
  assert.equal(lane.status, "unconfigured");
  assert.equal(lane.value, 0); // 0 counted, but status says unknown-not-zero
  assert.match(lane.note, /unknown, not zero/);
  db.close();
});

test("settled/week never fabricates USD and attributes posters honestly", () => {
  const db = memoryDb();
  const insertJournal = db.prepare("INSERT INTO bounty_journal (room_id, at, kind, bounty_id, amount) VALUES (?,?,?,?,?)");
  const insertRecord = db.prepare("INSERT INTO bounty_records (bounty_id, room_id, state, state_changed_ms, poster) VALUES (?,?,?,?,?)");
  insertRecord.run("b1", "alpha", "approved", AT, "john");
  insertRecord.run("b2", "alpha", "approved", AT, "buyer2");
  insertJournal.run("alpha", new Date(AT).toISOString(), "payout", "b1", 5000);
  insertJournal.run("alpha", new Date(AT).toISOString(), "payout", "b2", 3000);
  insertJournal.run("alpha", new Date(AT).toISOString(), "payout", null, 1000);
  insertJournal.run("alpha", new Date(AT).toISOString(), "fee", "b2", 30);

  const rows = nonJohnFundedSettledPerWeek({ db, now: FIXED_MS, johnActorIds: new Set(["john"]) });
  const week = rows.find(row => row.week === WEEK_ISO);
  assert.equal(week.nonJohnFundedUsdCents, null);
  assert.equal(week.usdStatus, "unmeasured");
  assert.equal(week.totalCreditsMillis, 9000);
  assert.equal(week.johnFundedCreditsMillis, 5000);
  assert.equal(week.nonJohnFundedCreditsMillis, 3000);
  assert.equal(week.unattributedCreditsMillis, 1000);
  assert.equal(week.johnAttribution, "configured");
  db.close();
});

test("unattributed posters stay out of both sides when john attribution is unconfigured", () => {
  const db = memoryDb();
  db.prepare("INSERT INTO bounty_journal (room_id, at, kind, bounty_id, amount) VALUES (?,?,?,?,?)")
    .run("alpha", new Date(AT).toISOString(), "payout", "b9", 7000);
  const rows = nonJohnFundedSettledPerWeek({ db, now: FIXED_MS });
  const week = rows.find(row => row.week === WEEK_ISO);
  assert.equal(week.nonJohnFundedCreditsMillis, null);
  assert.equal(week.johnAttribution, "unconfigured");
  assert.equal(week.totalCreditsMillis, 7000);
  db.close();
});

test("bond forfeit rate is measured from journal kinds", () => {
  const db = memoryDb();
  const insert = db.prepare("INSERT INTO bounty_journal (room_id, at, kind, bounty_id, amount) VALUES (?,?,?,?,?)");
  for (let i = 0; i < 4; i += 1) insert.run("alpha", new Date(AT).toISOString(), "bond-lock", `b${i}`, 1000);
  insert.run("alpha", new Date(AT).toISOString(), "bond-forfeit", "b0", 1000);
  const rows = falsifierRows({ db, events: [], now: FIXED_MS });
  const bond = rows.find(row => row.id === "bond_step_churn");
  assert.equal(bond.status, "measured");
  assert.equal(bond.value, 25.0);
  db.close();
});

test("no bond activity means unmeasured, not zero churn", () => {
  const db = memoryDb();
  const rows = falsifierRows({ db, events: [], now: FIXED_MS });
  const bond = rows.find(row => row.id === "bond_step_churn");
  assert.equal(bond.status, "unmeasured");
  assert.equal(bond.value, null);
  db.close();
});

test("stalled funded bounties are counted against the escrow falsifier", () => {
  const db = memoryDb();
  const insert = db.prepare("INSERT INTO bounty_records (bounty_id, room_id, state, state_changed_ms, poster) VALUES (?,?,?,?,?)");
  insert.run("s1", "alpha", "funded", AT - 20 * 86400000, "buyer1");
  insert.run("s2", "alpha", "funded", AT - 2 * 86400000, "buyer2");
  insert.run("s3", "alpha", "claimed", AT - 30 * 86400000, "buyer3");
  const rows = falsifierRows({ db, events: [], now: FIXED_MS });
  const stall = rows.find(row => row.id === "bounty_stall_funded");
  assert.equal(stall.status, "measured");
  assert.equal(stall.value, 1);
  assert.match(stall.note, /funded total=2/);
  db.close();
});

test("unmeasurable falsifiers are published as rows, not hidden", () => {
  const db = memoryDb();
  const rows = falsifierRows({ db, events: [], now: FIXED_MS });
  const ids = rows.map(row => row.id);
  for (const id of [
    "lane_share_of_traction",
    "non_john_funded_usd_settled_per_week",
    "bond_step_churn",
    "bounty_stall_funded",
    "onboarding_arrivals",
    "proposals_to_room_conversion",
    "shipping_vs_external_metrics",
    "content_published",
    "agent_activity_creates_demand"
  ]) {
    assert.ok(ids.includes(id), `falsifier row present: ${id}`);
  }
  const usd = rows.find(row => row.id === "non_john_funded_usd_settled_per_week");
  assert.equal(usd.value, null);
  assert.equal(usd.status, "unmeasured");
  for (const row of rows) {
    assert.ok(["measured", "unmeasured", "unconfigured"].includes(row.status), row.id);
    if (row.value === null) assert.notEqual(row.status, "measured", row.id);
    assert.ok(typeof row.measuredAt === "string" && row.measuredAt.length > 0, row.id);
  }
  db.close();
});

test("barrel exports resolve to the new functions", () => {
  for (const name of [
    "dashboardHonestyReport", "falsifierRows", "laneActivitySplit",
    "nonJohnFundedSettledPerWeek", "laneActorIdsFromEnv", "johnActorIdsFromEnv"
  ]) {
    assert.equal(typeof barrel[name], "function", name);
  }
  assert.deepEqual([...barrel.laneActorIdsFromEnv({ ANALYTICS_LANE_ACTOR_IDS: "lane1, lane2,, " })], ["lane1", "lane2"]);
  assert.deepEqual([...barrel.johnActorIdsFromEnv({})], []);
});

test("the backfill dashboard output carries the honesty section", async t => {
  const { file } = openRoom(t);
  const { report } = await backfillFile(file, { now: FIXED_MS });
  assert.ok(report.honesty, "honesty section present");
  assert.match(report.honesty.label, /opps #24\/#27\/#28/);
  assert.equal(report.honesty.laneActivity.length, 12);
  assert.equal(report.honesty.settledPerWeek.length, 12);
  assert.equal(report.honesty.falsifiers.length, 9);
  // Existing report shape untouched.
  assert.equal(report.weeks.length, 12);
  assert.deepEqual(report.missing, ["visits", "billing"]);
});
