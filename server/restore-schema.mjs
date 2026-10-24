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

export function ensureRestoreSchema(store) {
  store.db.exec(wakeListenerLeaseSchema);
  store.db.exec(wakeRoomActivitySchema);
  store.db.exec(PROJECTION_SHAPE_UPGRADES_SCHEMA);
  store.ensureIntegrityFailures();
  ensurePatrolSchema(store);
  ensureOAuthProviderSchema(store.db);
}
