// Upgrade compatibility fence, not authentication against a database administrator.
// Older service connections do not register this function, so ordinary writes fail
// after the schema transaction commits, even if the connection predates migration.
export const STORE_SCHEMA_VERSION = 7;
export const WRITER_FUNCTION = "project_room_writer_v7";
const tables = ["rooms", "events", "commands", "accounts", "member_accounts", "account_access_events",
  "credentials", "cursors", "projection_checkpoints", "account_credentials", "account_session_slots",
  "membership_invitations", "membership_invitation_events", "membership_invitation_journal", "share_links", "share_link_joins"];
export const writerFenceDefinitions = Object.freeze(tables.flatMap(table => ["INSERT", "UPDATE", "DELETE"].map(operation => {
  const name = `writer_v7_${table}_${operation.toLowerCase()}`;
  return Object.freeze({ name, sql: `CREATE TRIGGER ${name} BEFORE ${operation} ON ${table} BEGIN SELECT CASE WHEN ${WRITER_FUNCTION}() IS NOT 7 THEN RAISE(ABORT,'unsupported database writer') END; END` });
})));

export function registerWriter(db) {
  db.function("project_room_writer_v6", () => 6); // Retained migration-era guards.
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

export function verifyWriterFence(db) {
  for (const { name, sql } of writerFenceDefinitions) {
    if (db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(name)?.sql !== sql) {
      throw new Error("Database writer fence requires operator reconciliation");
    }
  }
}
