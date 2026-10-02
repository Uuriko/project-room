// Hourly NDJSON export. AN-1b calls exportAnalytics from the hourly job.
// The object key is the hour plus the row range, so a re-run rewrites the
// same object. A null sink leaves exported_at null.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ensureAnalyticsSchema } from "./schema.mjs";

export function hourWindow(hour) {
  const stamp = typeof hour === "number" ? hour : Date.parse(hour ?? "");
  const when = Number.isFinite(stamp) ? stamp : Date.now() - 3600000;
  const date = new Date(when);
  const start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), date.getUTCHours());
  const label = new Date(start).toISOString();
  return {
    start,
    end: start + 3600000,
    date: label.slice(0, 10),
    hour: label.slice(11, 13)
  };
}

export function closedHour(now = Date.now()) {
  return hourWindow(now - 3600000);
}

function objectKey(window, firstId, lastId) {
  return `analytics/v1/date=${window.date}/hour=${window.hour}/${firstId}-${lastId}.ndjson`;
}

function lineOf(row) {
  return JSON.stringify({
    id: row.id,
    name: row.name,
    v: row.v,
    at: row.at,
    room_id: row.room_id,
    account_id: row.account_id,
    actor_kind: row.actor_kind,
    actor_id: row.actor_id,
    source: row.source,
    source_detail: row.source_detail,
    agent_client: row.agent_client,
    referrer_artifact_id: row.referrer_artifact_id,
    ref_member_id: row.ref_member_id,
    loop: row.loop,
    viewer_key: row.viewer_key,
    room_event_id: row.room_event_id,
    room_seq: row.room_seq,
    props: JSON.parse(row.props),
    weight: row.weight,
    backfilled: row.backfilled
  });
}

export function nullSink() {
  return {
    kind: "null",
    async put() { return { stored: false }; },
    async head() { return null; }
  };
}

export function dirSink(root) {
  return {
    kind: "dir",
    async put(key, body) {
      const path = join(root, key);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, body);
      return { stored: true, key };
    },
    async head(key) {
      return null;
    }
  };
}

// Uses only put and head. A missing method throws; this does not invent one.
export function r2Sink(bucket) {
  if (!bucket || typeof bucket.put !== "function" || typeof bucket.head !== "function") {
    throw new TypeError("R2 sink requires put and head");
  }
  return {
    kind: "r2",
    async put(key, body) {
      await bucket.put(key, body, { httpMetadata: { contentType: "application/x-ndjson" } });
      return { stored: true, key };
    },
    async head(key) {
      return bucket.head(key);
    }
  };
}

export async function exportAnalytics(db, sink, { hour, now = Date.now() } = {}) {
  ensureAnalyticsSchema(db);
  const target = sink ?? nullSink();
  if (target.kind === "null") {
    return { exported: 0, key: null, configured: false };
  }
  const window = hour == null ? closedHour(now) : hourWindow(hour);
  const rows = db.prepare(`SELECT * FROM analytics_events WHERE at>=? AND at<? ORDER BY id ASC`).all(window.start, window.end);
  if (!rows.length) return { exported: 0, key: null, configured: true, hour: window };
  const firstId = rows[0].id;
  const lastId = rows.at(-1).id;
  const key = objectKey(window, firstId, lastId);
  const body = rows.map(lineOf).join("\n") + "\n";
  await target.put(key, body);
  const stamped = now;
  db.prepare(`UPDATE analytics_events SET exported_at=? WHERE at>=? AND at<?`).run(stamped, window.start, window.end);
  db.prepare(`INSERT INTO analytics_daily(day, metric, value) VALUES(?,?,?)
    ON CONFLICT(day, metric) DO UPDATE SET value = excluded.value`).run(window.date, "export_rows", rows.length);
  db.prepare(`INSERT INTO analytics_daily(day, metric, value) VALUES(?,?,?)
    ON CONFLICT(day, metric) DO UPDATE SET value = excluded.value`).run(window.date, "last_export_hour", window.start);
  return { exported: rows.length, key, configured: true, hour: window };
}
