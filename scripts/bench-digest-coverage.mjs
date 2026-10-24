// Paired SQL-only experiment. Fixture intentionally isolates journal coverage.
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES } from "../src/events.js";
import { seedDigestJournal } from "./digest-journal-fixture.mjs";
const store = new RoomStore(":memory:");
try {
  store.initialize(initialRoom());
  const window = seedDigestJournal(store, 100000), known = new Set(Object.values(EVENT_TYPES));
  const groupedSql = "SELECT json_extract(body,'$.type') AS type, COUNT(*) AS count FROM events WHERE room_id=? AND sequence>? AND sequence<=? GROUP BY json_extract(body,'$.type')";
  const baseline = since => {
    const result = {}; let total = 0;
    const count = store.db.prepare("SELECT COUNT(*) AS count FROM events WHERE room_id=? AND sequence>? AND sequence<=? AND json_extract(body,'$.type')=?");
    for (const type of known) { const n = count.get("commons", since, window.through, type).count; if (n) { result[type] = n; total += n; } }
    const all = store.db.prepare("SELECT COUNT(*) AS count FROM events WHERE room_id=? AND sequence>? AND sequence<=?").get("commons", since, window.through).count;
    if (all > total) result.other = all - total;
    return result;
  };
  const grouped = since => {
    const result = {};
    for (const row of store.db.prepare(groupedSql).all("commons", since, window.through)) {
      const key = known.has(row.type) ? row.type : "other";
      result[key] = (result[key] ?? 0) + row.count;
    }
    return result;
  };
  const results = [];
  for (const size of [20, 100000]) {
    const since = window.through - size;
    assert.deepEqual(grouped(since), baseline(since));
    const samples = { baseline: [], grouped: [] };
    for (let i = 0; i < 25; i++) {
      for (const name of i % 2 ? ["grouped", "baseline"] : ["baseline", "grouped"]) {
        const start = performance.now();
        store.readTransaction(() => (name === "baseline" ? baseline : grouped)(since));
        samples[name].push(performance.now() - start);
      }
    }
    const summary = Object.fromEntries(Object.entries(samples).map(([key, values]) => {
      const sorted = [...values].sort((a, b) => a - b);
      return [key, { p50Ms: sorted[12], p95Ms: sorted[23], samplesMs: values }];
    }));
    results.push({ window: size, ...summary, groupedPlan: store.db.prepare("EXPLAIN QUERY PLAN " + groupedSql).all("commons", since, window.through) });
  }
  console.log(JSON.stringify({ node: process.version, events: 100000, results }));
} finally { store.close(); }
