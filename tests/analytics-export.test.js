import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { closedHour, exportAnalytics, hourWindow, nullSink } from "../server/analytics/export.mjs";
import { ensureAnalyticsSchema } from "../server/analytics/schema.mjs";

// The hourly NDJSON export is DISABLED (classification ruling, 2026-10-18:
// its line format carried raw account_id/actor_id to an external sink,
// breaching bright lines U1/U2/U5, and it had no driver or consumer).
// These tests pin the disabled contract: whatever sink is handed in,
// nothing is written, nothing is stamped, and the result reports disabled.

const AT = Date.parse("2026-09-30T15:30:00.000Z");

function seed(db) {
  ensureAnalyticsSchema(db);
  db.prepare(`INSERT INTO analytics_events(
    id, name, v, at, account_id, actor_kind, actor_id, source, source_detail, loop, props, weight, backfilled
  ) VALUES('aev_aaaaaaaaaaaaaaaaaaaa','signup',1,?,'acc_raw_1','human','act_raw_1','unknown','system','unknown','{"origin":"github"}',1,1)`).run(AT);
  db.prepare(`INSERT INTO analytics_events(
    id, name, v, at, account_id, actor_kind, actor_id, source, source_detail, loop, props, weight, backfilled
  ) VALUES('aev_bbbbbbbbbbbbbbbbbbbb','signup',1,?,'acc_raw_2','human','act_raw_2','unknown','system','unknown','{"origin":"github"}',1,1)`).run(AT);
}

function recordingSink() {
  const calls = [];
  return {
    kind: "r2",
    calls,
    async put(key, body) { calls.push({ key, body }); return { stored: true, key }; },
    async head() { return null; }
  };
}

test("export is disabled: a recording sink receives nothing and no rows are stamped", async () => {
  const db = new DatabaseSync(":memory:");
  seed(db);
  const sink = recordingSink();
  const result = await exportAnalytics(db, sink, { hour: AT, now: AT + 1000 });
  assert.deepEqual(result, { exported: 0, key: null, configured: false, disabled: true });
  assert.equal(sink.calls.length, 0, "disabled export must never call sink.put");
  assert.equal(db.prepare("SELECT count(*) AS n FROM analytics_events WHERE exported_at IS NOT NULL").get().n, 0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM analytics_daily WHERE metric='export_rows'").get().n, 0);
  db.close();
});

test("export is disabled with the null sink too, and rows stay unexported", async () => {
  const db = new DatabaseSync(":memory:");
  seed(db);
  const result = await exportAnalytics(db, nullSink(), { hour: AT });
  assert.equal(result.disabled, true);
  assert.equal(result.configured, false);
  assert.equal(result.exported, 0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM analytics_events WHERE exported_at IS NULL").get().n, 2);
  db.close();
});

test("hour window helpers still compute the closed hour", () => {
  const window = closedHour(AT);
  assert.equal(window.date, "2026-09-30");
  assert.equal(window.hour, "14");
  assert.equal(hourWindow(AT).hour, "15");
});
