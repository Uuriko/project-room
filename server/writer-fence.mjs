// Upgrade compatibility fence, not authentication against a database administrator.
// Older service connections do not register this function, so ordinary writes fail
// after the schema transaction commits, even if the connection predates migration.
export const STORE_SCHEMA_VERSION = 19;
export const WRITER_FUNCTION = "project_room_writer_v19";
const v6Tables = ["rooms", "events", "commands", "accounts", "member_accounts", "account_access_events",
  "credentials", "cursors", "projection_checkpoints", "account_credentials", "account_session_slots",
  "membership_invitations", "membership_invitation_events", "membership_invitation_journal"];
const v7Tables = [...v6Tables, "share_links", "share_link_joins"];
const v8Tables = [...v7Tables, "private_reminders", "private_reminder_commands"];
const v14Tables = [...v8Tables, "agent_connections", "agent_connection_operations"];
const v17Tables = [...v14Tables, "private_inbox_sources", "private_inbox_versions", "private_inbox_drafts", "private_inbox_commands"];
const tables = [...v17Tables, "private_email_connections", "private_email_folders", "private_email_commands"];
export const applicationTables = Object.freeze(tables);
export const fenceDefinitions = version => Object.freeze(({ 6: v6Tables, 7: v7Tables, 8: v8Tables, 9: v14Tables, 10: v14Tables, 11: v14Tables, 12: v14Tables, 13: v14Tables, 14: v14Tables, 15: v17Tables, 16: v17Tables, 17: v17Tables, 18: tables, 19: tables })[version].flatMap(table => ["INSERT", "UPDATE", "DELETE"].map(operation => {
  const name = `writer_v${version}_${table}_${operation.toLowerCase()}`;
  return Object.freeze({ name, sql: `CREATE TRIGGER ${name} BEFORE ${operation} ON ${table} BEGIN SELECT CASE WHEN project_room_writer_v${version}() IS NOT ${version} THEN RAISE(ABORT,'unsupported database writer') END; END` });
})));
export const writerFenceDefinitions = fenceDefinitions(STORE_SCHEMA_VERSION);

export function registerWriter(db) {
  db.function("project_room_writer_v6", () => 6); // Retained migration-era guards.
  db.function("project_room_writer_v7", () => 7);
  db.function("project_room_writer_v8", () => 8);
  db.function("project_room_writer_v9", () => 9);
  db.function("project_room_writer_v10", () => 10);
  db.function("project_room_writer_v11", () => 11);
  db.function("project_room_writer_v12", () => 12);
  db.function("project_room_writer_v13", () => 13);
  db.function("project_room_writer_v14", () => 14);
  db.function("project_room_writer_v15", () => 15);
  db.function("project_room_writer_v16", () => 16);
  db.function("project_room_writer_v17", () => 17);
  db.function("project_room_writer_v18", () => 18);
  db.function(WRITER_FUNCTION, () => STORE_SCHEMA_VERSION);
}

export function installWriterFence(db) {
  if (!db.isTransaction) throw new Error("Writer fence installation requires the migration transaction");
  for (const { name, sql } of writerFenceDefinitions) {
    const existing = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(name);
    if (!existing) db.exec(sql);
    else if (existing.sql !== sql) throw new Error("Database writer fence requires operator reconciliation");
  }
  db.exec(`PRAGMA user_version=${STORE_SCHEMA_VERSION}`);
}

export function verifyWriterFence(db, version = STORE_SCHEMA_VERSION) {
  const expected = new Map([6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19].filter(v => v <= version).flatMap(fenceDefinitions).map(def => [def.name, def.sql]));
  for (const row of db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name GLOB 'writer_v*'").all()) {
    if (expected.get(row.name) !== row.sql) throw new Error("Database writer fence requires operator reconciliation");
  }
  for (const { name, sql } of fenceDefinitions(version)) {
    if (db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(name)?.sql !== sql) {
      throw new Error("Database writer fence requires operator reconciliation");
    }
  }
}
