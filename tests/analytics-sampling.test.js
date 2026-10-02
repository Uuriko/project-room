import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { insertAnalyticsBatch } from "../server/analytics/tail.mjs";
import { analyticsHealth } from "../server/analytics/metrics.mjs";
import { ensureAnalyticsSchema } from "../server/analytics/schema.mjs";
import { pruneAnalytics } from "../server/analytics/retention.mjs";

const NOW = Date.parse("2026-09-30T15:00:00.000Z");

function view(i) {
  return {
    name: "public_artifact_viewed", v: 1, at: NOW, actorKind: "anonymous",
    sourceKey: `view:${i}`, props: { artifact_kind: "receipt", is_bot: false }
  };
}

test("views stay unsampled under the cap, and over the cap their weights sum to the true count", async () => {
  const db = new DatabaseSync(":memory:");
  const under = await insertAnalyticsBatch(db, [view(1), view(2), view(3)], { now: NOW, dailyCap: 10 });
  assert.equal(under.sampledOut, 0);
  assert.equal(under.inserted, 3);
  const weights = db.prepare("SELECT weight FROM analytics_events").all().map(row => row.weight);
  assert.deepEqual(weights, [1, 1, 1]);

  const overDb = new DatabaseSync(":memory:");
  const views = [0, 1, 2, 3, 4].map(view);
  const over = await insertAnalyticsBatch(overDb, views, { now: NOW, dailyCap: 3 });
  assert.ok(over.sampledOut > 0);
  assert.ok(over.inserted < views.length);
  const sum = overDb.prepare("SELECT COALESCE(SUM(weight), 0) AS n FROM analytics_events").get().n;
  assert.equal(sum, views.length);
  db.close();
  overDb.close();
});

test("prune deletes only exported rows and records when unexported rows block it", () => {
  const db = new DatabaseSync(":memory:");
  ensureAnalyticsSchema(db);
  const insert = db.prepare(`INSERT INTO analytics_events(
    id, name, v, at, actor_kind, source, loop, props, weight, backfilled, exported_at
  ) VALUES(?,?,1,?,'anonymous','unknown','unknown','{}',1,0,?)`);
  insert.run("old-exported", "signup", NOW - 10_000, NOW);
  insert.run("new-exported", "signup", NOW - 100, NOW);
  insert.run("older-exported", "signup", NOW - 20_000, NOW);
  insert.run("unexported", "signup", NOW - 30_000, null);
  const pruned = pruneAnalytics(db, { now: NOW, maxRows: 2, retentionMs: 365 * 86400000 });
  const left = db.prepare("SELECT id FROM analytics_events ORDER BY id").all().map(row => row.id);
  assert.equal(left.includes("unexported"), true);
  assert.equal(left.length, 3);
  assert.ok(pruned.deleted >= 1);
  const blocked = pruneAnalytics(db, { now: NOW, maxRows: 1, retentionMs: 1 });
  assert.ok(blocked.pruneBlockedUnexported > 0);
  assert.equal(db.prepare("SELECT id FROM analytics_events WHERE id='unexported'").get().id, "unexported");
  const health = analyticsHealth(db, { now: NOW });
  assert.equal(health.pruneBlocked, true);
  db.close();
});
