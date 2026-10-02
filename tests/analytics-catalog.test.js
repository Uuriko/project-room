import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  GROWTH_EVENT_NAMES, PROPS_MAX_BYTES, growthEventId, validateGrowthEvent
} from "../server/analytics/catalog.mjs";
import { ensureAnalyticsSchema } from "../server/analytics/schema.mjs";
import "../server/analytics/index.mjs";

function namesInCatalogSection() {
  const text = readFileSync(new URL("../docs/analytics/EVENTS.md", import.meta.url), "utf8");
  const start = text.indexOf("## 3. The catalog");
  const end = text.indexOf("## 4.");
  const names = new Set();
  for (const line of text.slice(start, end).split("\n")) {
    if (!line.startsWith("|")) continue;
    const cell = line.split("|")[1] ?? "";
    for (const match of cell.matchAll(/`([a-z][a-z0-9_]*)`/g)) names.add(match[1]);
  }
  return [...names].sort();
}

const row = (extra = {}) => ({
  name: "signup", v: 1, actor_kind: "human", source: "unknown", loop: "unknown",
  props: { origin: "github" }, ...extra
});

test("catalog names are the names in the event catalog section", () => {
  assert.deepEqual([...GROWTH_EVENT_NAMES].sort(), namesInCatalogSection());
});

test("validateGrowthEvent rejects unknown, reserved, oversized, and sensitive rows", () => {
  assert.equal(validateGrowthEvent(row()).ok, true);
  assert.deepEqual(validateGrowthEvent(row({ name: "not_an_event" })).errors, ["unknown event name"]);
  assert.equal(validateGrowthEvent(row({ name: "upgrade_viewed", props: {} })).ok, false);
  assert.equal(validateGrowthEvent(row({ name: "churned", actor_kind: "system", props: { churn_kind: "room_churned" } })).ok, false);
  assert.match(validateGrowthEvent(row({ props: { origin: "github", note: "x" } })).errors.join(" "), /unknown prop/);
  assert.match(validateGrowthEvent(row({ props: { email: "a@b.c" } })).errors.join(" "), /forbidden prop/);
  const huge = "x".repeat(PROPS_MAX_BYTES);
  assert.match(validateGrowthEvent(row({ props: { origin: huge } })).errors.join(" "), /2 KB/);
});

test("growth event ids are a stable hash of the source, name, and index", () => {
  const id = growthEventId("evt-1", "room_created", 0);
  assert.equal(id, growthEventId("evt-1", "room_created", 0));
  assert.notEqual(id, growthEventId("evt-1", "room_created", 1));
  assert.match(id, /^aev_[a-f0-9]{20}$/);
});

test("ensureAnalyticsSchema is idempotent", () => {
  const db = new DatabaseSync(":memory:");
  ensureAnalyticsSchema(db);
  ensureAnalyticsSchema(db);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'analytics_%' ORDER BY name").all().map(row => row.name);
  assert.deepEqual(tables, [
    "analytics_ctx", "analytics_daily", "analytics_events", "analytics_firsts", "analytics_room_cursor", "analytics_table_cursor"
  ]);
  db.close();
});
