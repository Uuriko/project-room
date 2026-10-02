import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { collectPublicReceipts } from "../server/receipts-live.mjs";
import { workClaimReceiptDue, workItemReceiptDue } from "../server/analytics/map-room-event.mjs";
import { ensureAnalyticsSchema } from "../server/analytics/schema.mjs";
import { analyticsTailJob, runAnalyticsTail } from "../server/analytics/tail.mjs";
import { analyticsHealth as healthFromMetrics } from "../server/analytics/metrics.mjs";
import { FIXED_MS, LEAKS, openRoom } from "./analytics-fixture.mjs";

function rows(store) {
  return store.db.prepare("SELECT name, actor_kind, actor_id, props, source, backfilled, ref_member_id FROM analytics_events ORDER BY name").all();
}

test("the tail records a productive room once, hides private text, and survives a bad insert", async t => {
  const { store } = openRoom(t);
  const first = await runAnalyticsTail(store.db, { now: FIXED_MS, budgetMs: 5000 });
  assert.equal(first.errors, 0);
  assert.ok(first.rowsWritten > 0);
  const seen = rows(store);
  const byName = Object.fromEntries(seen.map(row => [row.name, row]));
  for (const name of ["room_created", "agent_connected", "agent_first_post", "claim_created", "claim_claimed", "pr_linked", "pr_merged", "claim_completed", "receipt_issued", "referral_converted", "invite_accepted", "signup"]) {
    assert.ok(byName[name], name);
  }
  assert.equal(byName.room_created.actor_kind, "human");
  assert.equal(byName.agent_connected.actor_kind, "agent");
  assert.equal(byName.signup.actor_kind, "human");
  assert.equal(JSON.parse(byName.signup.props).origin, "github");
  assert.equal(JSON.parse(byName.pr_linked.props).repo, "acme/demo");
  assert.equal(JSON.parse(byName.pr_linked.props).pr_number, 7);
  assert.equal(JSON.parse(byName.receipt_issued.props).receipt_kind, "wcr");
  assert.equal(byName.agent_connected.ref_member_id, "owner");
  assert.equal(seen.every(row => row.source === "unknown" && row.backfilled === 1), true);
  const dumped = JSON.stringify(seen);
  for (const leak of LEAKS) assert.equal(dumped.includes(leak), false, leak);

  const again = await runAnalyticsTail(store.db, { now: FIXED_MS, budgetMs: 5000 });
  assert.equal(again.rowsWritten, 0);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM analytics_events").get().n, seen.length);

  const before = store.db.prepare("SELECT sequence FROM rooms WHERE id='alpha'").get().sequence;
  store.db.prepare("UPDATE rooms SET sequence=1 WHERE id='alpha'").run();
  const rewound = await runAnalyticsTail(store.db, { now: FIXED_MS, budgetMs: 5000 });
  assert.equal(rewound.rowsWritten, 0);
  store.db.prepare("UPDATE rooms SET sequence=? WHERE id='alpha'").run(before);
  const restored = await runAnalyticsTail(store.db, { now: FIXED_MS, budgetMs: 5000 });
  assert.equal(restored.rowsWritten, 0);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM analytics_events").get().n, seen.length);

  const health = healthFromMetrics(store.db, { now: FIXED_MS, exportConfigured: false });
  assert.equal(JSON.stringify(health).includes("alpha"), false);
  assert.equal(health.rowsToday, seen.length);
  assert.equal(health.exportConfigured, false);
  assert.equal(typeof health.cursorLagRooms, "number");

  const skipped = await analyticsTailJob(store.db, { ANALYTICS_ENABLED: "0" });
  assert.equal(skipped.skipped, true);
});

test("a SQL failure in the tail is counted and does not escape", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE rooms (id TEXT PRIMARY KEY, sequence INTEGER NOT NULL, projection TEXT)");
  db.exec("INSERT INTO rooms VALUES('alpha', 1, '{}')");
  db.exec("CREATE TABLE events (room_id TEXT, sequence INTEGER, id TEXT, body TEXT)");
  db.prepare("INSERT INTO events VALUES('alpha', 1, 'e1', ?)").run(JSON.stringify({
    id: "e1", type: "room.created", actorId: "owner", roomId: "alpha", at: "2026-09-30T15:00:00.000Z",
    data: { roomId: "alpha", title: "Alpha", purpose: "work", ownerId: "owner" }
  }));
  ensureAnalyticsSchema(db);
  db.exec("CREATE TRIGGER abort_analytics BEFORE INSERT ON analytics_events BEGIN SELECT RAISE(ABORT, 'injected'); END");
  const result = await runAnalyticsTail(db, { now: FIXED_MS, budgetMs: 5000 });
  assert.equal(result.errors, 1);
  assert.equal(db.prepare("SELECT count(*) AS n FROM analytics_events").get().n, 0);
  db.close();
});

test("a done merged claim is a receipt in both the live list and the growth predicate", t => {
  const { store } = openRoom(t);
  const projection = structuredClone(store.room("alpha").state);
  projection.room.publicReceipts = { enabled: true, revision: 1, setById: "owner", setAt: "2026-09-30T15:00:00.000Z" };
  projection.workItems = {
    done: { id: "done", state: "completed", title: "LeakTitleZZ", receipt: { eventId: "r1" }, updatedAt: "2026-09-30T15:00:00.000Z" },
    open: { id: "open", state: "working", title: "LeakTitleZZ", receipt: null }
  };
  store.db.prepare("UPDATE rooms SET projection=? WHERE id='alpha'").run(JSON.stringify(projection));
  store.workClaims.set("alpha", {
    id: "claim1", title: "LeakTitleZZ", state: "done", owner: "agent1",
    pullRequest: { url: "https://github.com/acme/demo/pull/7", outcome: "merged" }
  });
  store.workClaims.set("alpha", { id: "claim2", title: "LeakTitleZZ", state: "done", owner: "agent1", pullRequest: { outcome: "closed", url: "https://github.com/acme/demo/pull/8" } });
  const published = collectPublicReceipts(store);
  const kinds = published.map(item => item.id.slice(0, 3));
  assert.ok(kinds.includes("wcr"));
  assert.ok(kinds.includes("wir"));
  const listed = store.workClaims.list("alpha");
  assert.equal(listed.filter(workClaimReceiptDue).length, published.filter(item => item.id.startsWith("wcr_")).length);
  assert.equal(workItemReceiptDue(projection.workItems.done), true);
  assert.equal(workItemReceiptDue(projection.workItems.open), false);
  assert.equal(published.some(item => item.title === "LeakTitleZZ" && item.id.startsWith("wcr_")), true);
});
