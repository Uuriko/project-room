// Dispositions for tests/purge-source-coverage.test.js.
//
// The purge-source-coverage test enumerates every CREATE TABLE in server/**
// source and requires each table to have exactly one disposition:
//
//   (a) a row in server/purge-registry.mjs (PURGE_TABLES) — no entry here;
//   (b) an EXECUTOR_DELETIONS entry below — the table is deleted (or its root
//       row is retired) by a named non-registry deletion mechanism, and the
//       test verifies the mechanism still exists by anchoring on a literal
//       string in the named source file;
//   (c) an EXEMPTIONS entry below — no purge disposition is needed, with the
//       reason recorded. An exemption is a declaration, not a shrug: keep the
//       reason current or the table moves to UNRESOLVED.
//
// UNRESOLVED is the coordinator's list: tables with no accepted disposition
// yet. Adding a table to UNRESOLVED requires coordinator sign-off and a
// listing in the PR body — it is how a gap is declared, never how it is
// hidden. The test pins the undispositioned set to exactly this list, so a
// newly added table fails the suite until it is dispositioned, and a stale
// entry fails as soon as the table gains a real disposition.
//
// Reasons seeded from the HUNT-ORPHANS census residue
// (hunt-2026-10-18/orphans.md §5–§6) and verified against source at the
// stacking base (PR #4150 head).

export const EXECUTOR_DELETIONS = Object.freeze({
  rooms: {
    file: "server/operator-purge.mjs",
    anchor: "DELETE FROM rooms WHERE id=?",
    mechanism:
      "The room root row is deleted by the operator purge executor itself, after every registry row for that room; the registry deliberately carries no self-row for the root.",
  },
  accounts: {
    file: "server/account-deletion.mjs",
    anchor: "UPDATE accounts SET active=0",
    mechanism:
      "Account purge runs the account-deletion executor: the account row is scrubbed and deactivated as a tombstone (disclosed executor category profile_tombstone) so retained audit rows stay attributable; its credentials and memberships are registry/executor deletes.",
  },
  oauth_provider_codes: {
    file: "server/account-deletion.mjs",
    anchor: "\"oauth_provider_codes\", \"oauth_provider_access_tokens\", \"oauth_provider_refresh_tokens\"",
    mechanism:
      "Deleted by the account-deletion executor's oauth_tokens category (deleteWhereIfExists by user_id). The registry-only audit originally missed this executor path; the executor is the deletion story.",
  },
  oauth_provider_access_tokens: {
    file: "server/account-deletion.mjs",
    anchor: "\"oauth_provider_codes\", \"oauth_provider_access_tokens\", \"oauth_provider_refresh_tokens\"",
    mechanism:
      "Deleted by the account-deletion executor's oauth_tokens category (deleteWhereIfExists by user_id). The registry-only audit originally missed this executor path; the executor is the deletion story.",
  },
  oauth_provider_refresh_tokens: {
    file: "server/account-deletion.mjs",
    anchor: "\"oauth_provider_codes\", \"oauth_provider_access_tokens\", \"oauth_provider_refresh_tokens\"",
    mechanism:
      "Deleted by the account-deletion executor's oauth_tokens category (deleteWhereIfExists by user_id). The registry-only audit originally missed this executor path; the executor is the deletion story.",
  },
  patrol_blocks: {
    file: "server/patrol.mjs",
    anchor: "DELETE FROM patrol_blocks WHERE room_id NOT IN",
    mechanism:
      "Patrol self-cleans blocks for rooms that no longer exist (gone-room sweep in server/patrol.mjs), so a room purge leaves nothing behind in this table.",
  },
  patrol_claims: {
    file: "server/patrol.mjs",
    anchor: "DELETE FROM patrol_claims WHERE room_id=?",
    mechanism:
      "Patrol deletes a room's claims itself when the room is removed (server/patrol.mjs per-room deletes), so a room purge leaves nothing behind in this table.",
  },
  patrol_messages: {
    file: "server/patrol.mjs",
    anchor: "DELETE FROM patrol_messages WHERE room_id=?",
    mechanism:
      "Patrol deletes a room's messages itself when the room is removed (server/patrol.mjs per-room deletes), so a room purge leaves nothing behind in this table.",
  },
});

export const EXEMPTIONS = Object.freeze({
  abuse_rate_buckets:
    "Ephemeral rate-limit windows keyed by family with an until_ms expiry: pruneAbuseRateBuckets deletes expired buckets and the consume path deletes spent ones (server/abuse-rate-buckets.mjs). No entity payload; nothing for a purge to own.",
  agent_bonds:
    "Relationship rows name identities that persist as revoked tombstones, so references resolve rather than dangle, and bond actions refuse revoked identities (server/bonds.mjs). Retained relationship graph (orphans census §5).",
  agent_wake_listener_leases:
    "Self-expiring: 60-second lease TTL, expired leases deleted by the heartbeat sweep (server/agent-heartbeats.mjs). Nothing survives its TTL for a purge to own (orphans census §5).",
  agent_wake_room_activity:
    "One upserted row per (agent, room) pair ever polled, carrying only last_polled_at. No content; growth bounded by pair count (orphans census §5).",
  agent_wake_signal_claims:
    "Claims are abandoned when their fencing lease dies; bounded by the same 60-second lease TTL as agent_wake_listener_leases (orphans census §5).",
  analytics_ctx:
    "Self-prunes by age/cap (server/analytics/context.mjs); no entity payload to purge (orphans census §5).",
  analytics_daily:
    "Aggregate counters with no entity payload; no per-room/account rows exist in it (orphans census §6, cleared).",
  analytics_firsts:
    "Aggregate first-event rows with no entity payload; no per-room/account rows exist in it (orphans census §6, cleared).",
  analytics_table_cursor:
    "Global analytics sync cursor keyed by source-table name (PRIMARY KEY source, server/analytics/schema.mjs). No room/account/identity rows exist in it, so no purge has a key to match.",
  board_vtwo_claims:
    "Retired board-v2 surface (routes answer 410); the table has no room_id column, so no room-keyed purge could ever reach it. Table removal is tracked in #3997 (orphans census §5).",
  board_vtwo_events:
    "Retired board-v2 surface (routes answer 410); the table has no room_id column, so no room-keyed purge could ever reach it. Table removal is tracked in #3997 (orphans census §5).",
  board_vtwo_idempotency:
    "Retired board-v2 surface (routes answer 410); the table has no room_id column, so no room-keyed purge could ever reach it. Table removal is tracked in #3997 (orphans census §5).",
  board_vtwo_mirror:
    "Retired board-v2 surface (routes answer 410); the table has no room_id column, so no room-keyed purge could ever reach it. Table removal is tracked in #3997 (orphans census §5).",
  claim_reputation_signals:
    "Signals keyed to tombstoned identity ids, which are never reused, so a dead identity's signals are inert inputs; readers key off live agents. History, not a dangling pointer (orphans census §5).",
  integrity_failures:
    "Durable record of isolated integrity failures, deleted per-record when the record next verifies clean (server/store.mjs); the sibling integrity_room_state self-cleans for gone rooms (orphans census §5).",
  integrity_job_cursor:
    "Singleton job bookkeeping (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), server/store.mjs). One global row; no entity rows exist in it.",
  integrity_snapshot:
    "Singleton integrity checksum row (id INTEGER PRIMARY KEY CHECK (id = 1), server/store.mjs). One global row; no entity rows exist in it.",
  oauth_pending_states:
    "Short-lived OAuth PKCE state: every create first deletes expired rows (expires_at sweep in server/store.mjs) and the table is hard-bounded at 100 rows by the create path.",
  oauth_provider_clients:
    "Expiring OAuth client registrations (expires_at, indexed): expired rows are bounded-deleted by pruneOAuthProvider (server/oauth-provider-store.mjs) and individual clients delete through the store. Not keyed to an account, so no purge has a key to match.",
  operator_actions:
    "Append-only operator audit log: schema triggers abort any UPDATE or DELETE (server/operator-actions.mjs). Retention is the audit policy, by design.",
  peer_dm_threads:
    "Thread rows name tombstoned identities, so references resolve rather than dangle; the messages themselves are purge-registry rows. Retained relationship graph (orphans census §5).",
  public_read_model_backfill:
    "Singleton backfill bookkeeping (id = 1: phase, cursor, done; server/public-read-model.mjs). One global row; no entity rows exist in it.",
  public_unpublish:
    "Retained by design: deleting these rows would re-expose unpublished content (documented in server/account-deletion.mjs; orphans census §5).",
  public_work_claim_writer_permit:
    "Singleton namespace permit flag (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), server/public-work-claim-fence.mjs). One global row; no entity rows exist in it.",
  request_replays:
    "Retained by design: a schema trigger aborts any delete (\"request replays are retained\", server/run-once.mjs; orphans census §5).",
  room_schema_stamp:
    "Singleton schema version stamp (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), server/store.mjs). One global row; no entity rows exist in it.",
  web_fetch_cache:
    "Shared URL fetch cache with an enforced maximum age: reads opportunistically delete everything older than the max age (server/web-fetch.mjs). Not keyed to any room, account, or identity.",
});

// Tables with no accepted disposition. Coordinator-owned: each entry must be
// listed in the PR body that introduces it, with the ruling it is waiting on.
export const UNRESOLVED = Object.freeze([
  "patrol_cursor",
  "patrol_findings",
  "public_abuse_reports",
]);
