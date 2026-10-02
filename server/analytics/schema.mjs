// Additive analytics tables. Outside the writer fence and not created from
// the store constructor. The tail, the export and the readers call
// ensureAnalyticsSchema. No schema version bump: CREATE TABLE IF NOT EXISTS only.

export const ANALYTICS_SCHEMA = `
CREATE TABLE IF NOT EXISTS analytics_events (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  v INT NOT NULL,
  at INT NOT NULL,
  room_id TEXT,
  account_id TEXT,
  actor_kind TEXT NOT NULL,
  actor_id TEXT,
  source TEXT NOT NULL,
  source_detail TEXT,
  agent_client TEXT,
  referrer_artifact_id TEXT,
  ref_member_id TEXT,
  loop TEXT NOT NULL,
  viewer_key TEXT,
  room_event_id TEXT,
  room_seq INT,
  props TEXT NOT NULL,
  weight INT NOT NULL DEFAULT 1,
  backfilled INT NOT NULL DEFAULT 0,
  exported_at INT
);
CREATE INDEX IF NOT EXISTS analytics_events_at ON analytics_events(at);
CREATE INDEX IF NOT EXISTS analytics_events_name_at ON analytics_events(name, at);
CREATE INDEX IF NOT EXISTS analytics_events_room_at ON analytics_events(room_id, at);
CREATE INDEX IF NOT EXISTS analytics_events_exported ON analytics_events(exported_at);
CREATE TABLE IF NOT EXISTS analytics_room_cursor (
  room_id TEXT PRIMARY KEY,
  last_seq INT NOT NULL,
  updated_at INT NOT NULL
);
CREATE TABLE IF NOT EXISTS analytics_table_cursor (
  source TEXT PRIMARY KEY,
  last_key TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS analytics_firsts (
  kind TEXT NOT NULL,
  scope TEXT NOT NULL,
  at INT NOT NULL,
  PRIMARY KEY (kind, scope)
);
CREATE TABLE IF NOT EXISTS analytics_daily (
  day TEXT NOT NULL,
  metric TEXT NOT NULL,
  value INT NOT NULL,
  PRIMARY KEY (day, metric)
);
CREATE TABLE IF NOT EXISTS analytics_ctx (
  event_id TEXT PRIMARY KEY,
  source TEXT,
  agent_client TEXT,
  ref TEXT,
  at INT
);
`;

export function ensureAnalyticsSchema(db) {
  db.exec(ANALYTICS_SCHEMA);
}

export function utcDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDaily(db, day, metric, delta = 1) {
  db.prepare(`INSERT INTO analytics_daily(day, metric, value) VALUES(?,?,?)
    ON CONFLICT(day, metric) DO UPDATE SET value = value + excluded.value`).run(day, metric, delta);
}

export function setDaily(db, day, metric, value) {
  db.prepare(`INSERT INTO analytics_daily(day, metric, value) VALUES(?,?,?)
    ON CONFLICT(day, metric) DO UPDATE SET value = excluded.value`).run(day, metric, value);
}

export function dailyValue(db, day, metric) {
  return db.prepare("SELECT value FROM analytics_daily WHERE day=? AND metric=?").get(day, metric)?.value ?? 0;
}

export function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

export function columnExists(db, table, column) {
  if (!tableExists(db, table)) return false;
  return db.prepare(`PRAGMA table_info(${table})`).all().some(row => row.name === column);
}
