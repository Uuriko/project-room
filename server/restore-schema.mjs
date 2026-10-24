// Runtime features create these tables lazily. A disaster-recovery target
// has not run those features yet, but their durable rows belong in its restore.
// Only application-owned DDL is accepted: never infer schema from backup rows.
import { wakeListenerLeaseSchema, wakeRoomActivitySchema } from "./agent-heartbeats.mjs";
import { PROJECTION_SHAPE_UPGRADES_SCHEMA } from "./legacy-message-shape.mjs";
import { ensurePatrolSchema } from "./patrol.mjs";
import { ensureOAuthProviderSchema, OAUTH_PROVIDER_TABLES } from "./oauth-provider-store.mjs";

// Restores may create these empty tables even when an older backup predates them.
export const RESTORE_RUNTIME_TABLES = Object.freeze([
  "agent_wake_listener_leases", "agent_wake_signal_claims", "agent_wake_room_activity",
  "projection_shape_upgrades", "integrity_failures", "patrol_cursor", "patrol_claims",
  "patrol_messages", "patrol_findings", "patrol_blocks", ...OAUTH_PROVIDER_TABLES
]);

export function ensureRestoreSchema(store, tables) {
  const needed = new Set(tables);
  const has = names => names.some(name => needed.has(name));
  // Do not expand older backups into every optional feature's schema. The extra
  // schema made Workers fail the whole-database quick_check with
  // SQLITE_NOMEM, even when those empty tables were not in the backup.
  if (has(["agent_wake_listener_leases", "agent_wake_signal_claims"])) store.db.exec(wakeListenerLeaseSchema);
  if (needed.has("agent_wake_room_activity")) store.db.exec(wakeRoomActivitySchema);
  if (needed.has("projection_shape_upgrades")) store.db.exec(PROJECTION_SHAPE_UPGRADES_SCHEMA);
  if (needed.has("integrity_failures")) store.ensureIntegrityFailures();
  if (has(["patrol_cursor", "patrol_claims", "patrol_messages", "patrol_findings", "patrol_blocks"])) ensurePatrolSchema(store);
  if (has(OAUTH_PROVIDER_TABLES)) ensureOAuthProviderSchema(store.db);
}
