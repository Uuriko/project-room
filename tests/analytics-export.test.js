import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { strictR2Bucket } from "../cloudflare/platform-fakes.mjs";
import { dirSink, exportAnalytics, nullSink, r2Sink } from "../server/analytics/export.mjs";
import { ensureAnalyticsSchema } from "../server/analytics/schema.mjs";

const AT = Date.parse("2026-09-30T15:30:00.000Z");

function seed(db) {
  ensureAnalyticsSchema(db);
  db.prepare(`INSERT INTO analytics_events(
    id, name, v, at, actor_kind, source, source_detail, loop, props, weight, backfilled
  ) VALUES('aev_aaaaaaaaaaaaaaaaaaaa','signup',1,?,'human','unknown','system','unknown','{"origin":"github"}',1,1)`).run(AT);
  db.prepare(`INSERT INTO analytics_events(
    id, name, v, at, actor_kind, source, source_detail, loop, props, weight, backfilled
  ) VALUES('aev_bbbbbbbbbbbbbbbbbbbb','signup',1,?,'human','unknown','system','unknown','{"origin":"github"}',1,1)`).run(AT);
}

test("export writes one object per hour and row range, and a null sink leaves rows unexported", async t => {
  const dir = mkdtempSync(join(tmpdir(), "analytics-export-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = new DatabaseSync(":memory:");
  seed(db);
  const first = await exportAnalytics(db, dirSink(dir), { hour: AT, now: AT + 1000 });
  const second = await exportAnalytics(db, dirSink(dir), { hour: AT, now: AT + 2000 });
  assert.equal(first.key, "analytics/v1/date=2026-09-30/hour=15/aev_aaaaaaaaaaaaaaaaaaaa-aev_bbbbbbbbbbbbbbbbbbbb.ndjson");
  assert.equal(second.key, first.key);
  assert.equal(first.exported, 2);
  const body = readFileSync(join(dir, first.key), "utf8");
  assert.equal(body.trim().split("\n").length, 2);
  assert.equal(JSON.parse(body.trim().split("\n")[0]).props.origin, "github");
  assert.equal(db.prepare("SELECT count(*) AS n FROM analytics_events WHERE exported_at IS NOT NULL").get().n, 2);

  const fresh = new DatabaseSync(":memory:");
  seed(fresh);
  const skipped = await exportAnalytics(fresh, nullSink(), { hour: AT });
  assert.equal(skipped.configured, false);
  assert.equal(skipped.key, null);
  assert.equal(fresh.prepare("SELECT count(*) AS n FROM analytics_events WHERE exported_at IS NULL").get().n, 2);

  const bucket = strictR2Bucket();
  const remote = new DatabaseSync(":memory:");
  seed(remote);
  const uploaded = await exportAnalytics(remote, r2Sink(bucket), { hour: AT, now: AT + 1000 });
  const again = await exportAnalytics(remote, r2Sink(bucket), { hour: AT, now: AT + 1000 });
  assert.equal(again.key, uploaded.key);
  const head = await bucket.head(uploaded.key);
  assert.equal(head.size, body.length);
  const object = await bucket.get(uploaded.key);
  assert.equal(await object.text(), body);
  assert.throws(() => r2Sink({ put() {} }), /put and head/);
  db.close();
  fresh.close();
  remote.close();
});
