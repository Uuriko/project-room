// Retention registry: one recorded retention disposition for every table
// created in server/** source. This file is the decision record the
// retention receipt used to gesture at with a bare "excluded" list
// (HUNT-SOAK S-4): before it existed, two log tables drained at
// <=1,200 rows/day each, the analytics and audit planners were plan-only
// in every scheduled path, and no table outside the two logs carried a
// recorded keep/delete decision at all.
//
// Three dispositions, exactly:
//
//   drain      — a live mechanism deletes rows under a stated rule.
//                rule.kind "age": the scheduled retention tick drains the
//                table itself (rows older than `days` by `timestampColumn`,
//                tie-broken by `idColumn`), looping batches until the
//                tick's budget deadline. rule.kind "mechanism": a named
//                function deletes the rows (companion prune, TTL sweep,
//                read/create-path sweep); the test anchors the function in
//                its file so the citation cannot rot silently.
//   keep       — retention does not delete this table, and the reason says
//                why (audit guarantee, singleton bookkeeping, aggregate
//                with no entity payload, a planner whose deletion is
//                deliberately not wired, ...). A keep is a decision, not
//                an omission: change it by editing the row, on the record.
//   purge-only — no scheduled retention; rows live exactly as long as
//                their parent entity and are deleted by room / identity /
//                account purge (server/purge-registry.mjs and the purge
//                executors). This is the correct disposition for product
//                state: retention is a telemetry-and-expiry tool, and
//                entity lifetime is owned by purge.
//
// tests/retention-source-coverage.test.js enumerates every CREATE TABLE in
// server/** source with the same enumerator as
// tests/purge-source-coverage.test.js and fails if a table has no row
// here, or a row names a table that no longer exists. A new table is not
// done until its disposition is recorded here.

const age = (table, days, idColumn, timestampColumn = "created_at") => Object.freeze({
  table, disposition: "drain",
  rule: Object.freeze({ kind: "age", days, timestampColumn, idColumn })
});
const mechanism = (table, name, file, anchor, detail) => Object.freeze({
  table, disposition: "drain",
  rule: Object.freeze({ kind: "mechanism", name, file, anchor, detail })
});
const keep = (table, reason) => Object.freeze({ table, disposition: "keep", reason });
const purgeOnly = (table, reason) => Object.freeze({ table, disposition: "purge-only", reason });
const purgeFamily = (reason, tables) => tables.map(table => purgeOnly(table, reason));

const PRODUCT_STATE =
  "Product state owned by the room, not telemetry: retention never age-deletes room content or collaboration state. Rows are deleted only by room purge (purge registry), which is the recorded lifetime decision for this table.";
const MONEY =
  "Money and settlement records: conservation, dispute and audit history must stay complete for the life of the room. Retention never age-deletes financial records; rows are deleted only by room purge (purge registry).";
const WORK =
  "Work records are the room's evidence of who did what and what was verified. Retention never age-deletes them; rows are deleted only by room purge (purge registry).";
const CREDENTIALS =
  "Credential and identity material: age-deleting it would silently log out or lock out the account. Lifetime is owned by the account/identity purge paths (purge registry and the account-deletion executor), never by a retention clock.";
const AGENT_RUNTIME =
  "Live agent runtime state: rows are meaningful exactly while their agent or room lives. Deleted by room or identity purge (purge registry); no retention clock applies.";
const PUBLIC_PROJECTION =
  "Public read-model projection: derived from room state and rebuilt by backfill, so its lifetime follows the room. Deleted by room purge (purge registry); retention does not age-delete published projections.";
const PRIVATE_DATA =
  "Private user data: retention must never age-delete private content. Deleted only by the owning account or room purge paths (purge registry, account-deletion executor).";
const OPS_JOURNAL =
  "Operational journal: the fleet's own audit trail for delegated or queued work. Retained for the life of the room or account it names; deleted only by purge (purge registry), never by a retention clock.";

export const RETENTION_DISPOSITIONS = Object.freeze([
  // ---- drain: age rules, executed by the scheduled retention tick ----
  age("web_fetch_log", 30, "request_id"),
  age("web_research_log", 30, "request_id"),

  // ---- drain: named mechanisms ----
  mechanism("abuse_rate_buckets", "pruneAbuseRateBuckets", "server/abuse-rate-buckets.mjs",
    "export function pruneAbuseRateBuckets",
    "Expired rate-limit windows (until_ms in the past) are deleted by the retention tick's companion prune, looped until the tick budget; the consume path also deletes spent buckets."),
  mechanism("oauth_provider_codes", "pruneOAuthProvider", "server/oauth-provider-store.mjs",
    "export function pruneOAuthProvider",
    "Expired authorisation codes are deleted by the retention tick's companion OAuth prune (bounded per call, looped until the tick budget)."),
  mechanism("oauth_provider_access_tokens", "pruneOAuthProvider", "server/oauth-provider-store.mjs",
    "export function pruneOAuthProvider",
    "Expired access tokens are deleted by the retention tick's companion OAuth prune (bounded per call, looped until the tick budget)."),
  mechanism("oauth_provider_refresh_tokens", "pruneOAuthProvider", "server/oauth-provider-store.mjs",
    "export function pruneOAuthProvider",
    "Expired refresh tokens are deleted by the retention tick's companion OAuth prune (bounded per call, looped until the tick budget)."),
  mechanism("oauth_provider_clients", "pruneOAuthProvider", "server/oauth-provider-store.mjs",
    "export function pruneOAuthProvider",
    "Expired client registrations are deleted by the retention tick's companion OAuth prune (bounded per call, looped until the tick budget); clients also delete individually through the store."),
  mechanism("agent_webhook_deliveries", "pruneWebhookDeliveries", "server/agent-plugin-store.mjs",
    "pruneWebhookDeliveries",
    "Terminal deliveries (delivered / dead-letter) beyond the newest 100 per subscription and older than 7 days are deleted by the retention tick's companion prune, looped until the tick budget. Pending and failed rows are never deleted here: they can still be attempted."),
  mechanism("web_fetch_cache", "read-path max-age sweep", "server/web-fetch.mjs",
    "DELETE FROM web_fetch_cache WHERE fetched_at<?",
    "Shared URL fetch cache: reads opportunistically delete everything older than the enforced maximum age, so the cache is self-limiting without a scheduled job."),
  mechanism("analytics_ctx", "writeAnalyticsContext", "server/analytics/context.mjs",
    "DELETE FROM analytics_ctx WHERE at < ?",
    "Analytics context spill self-prunes on write: rows older than a week, then the oldest past the 50k cap, are deleted by the write path itself."),
  mechanism("agent_wake_listener_leases", "heartbeat lease sweep", "server/agent-heartbeats.mjs",
    "DELETE FROM agent_wake_listener_leases",
    "Wake listener leases carry a 60-second TTL: expired leases are deleted by the heartbeat sweep and on release, so nothing survives its TTL."),
  mechanism("oauth_pending_states", "create-path expiry sweep", "server/store.mjs",
    "DELETE FROM oauth_pending_states WHERE expires_at <= ?",
    "Short-lived OAuth PKCE state: every create first deletes expired rows, and the create path hard-bounds the table at 100 rows."),
  mechanism("integrity_failures", "per-record verify-clean deletion", "server/store.mjs",
    "DELETE FROM integrity_failures WHERE step=? AND record_id=?",
    "A failure record is deleted when its record next verifies clean; a record that never re-verifies stays as the durable failure record. No age rule applies."),

  // ---- keep: recorded decisions not to delete ----
  keep("account_access_events",
    "Security audit rows stay, matching account deletion (purge registry retains them). An audit trail that a retention clock can shorten is not an audit trail."),
  keep("agent_identities",
    "The identity row stays as a revoked tombstone so references resolve rather than dangle (purge registry retains it); its secret no longer authenticates. Retention does not delete identity tombstones."),
  keep("operator_actions",
    "Append-only operator audit log: schema triggers abort any UPDATE or DELETE (server/operator-actions.mjs). Retention is the audit policy, by design."),
  keep("request_replays",
    "Retained by design: a schema trigger aborts any delete ('request replays are retained', server/run-once.mjs). The replay guard only works if the record is permanent."),
  keep("public_unpublish",
    "Retained by design: deleting these rows would re-expose unpublished content (documented in server/account-deletion.mjs). The unpublish record is the suppression."),
  keep("share_link_join_redemptions",
    "Immutable link-redemption journal: prevents cross-account replay and is retained alongside share_link_joins (purge registry retains it)."),
  keep("pending_channel_updates",
    "Channel update rows stay with the retained email connection they reference (purge registry retains them); deleting them would orphan the connection's pending state."),
  keep("private_email_commands",
    "Email import receipts are append-only and stay with the account tombstone (purge registry retains them). Receipts are the record of what was imported."),
  keep("private_email_connections",
    "Email connections stay so retained import receipts keep their parent (purge registry retains them)."),
  keep("private_email_folders",
    "Email folder rows stay with the retained connection they reference (purge registry retains them)."),
  keep("private_inbox_commands",
    "Inbox receipts are append-only and stay with the account tombstone (purge registry retains them). Account deletion does not erase the receipt trail."),
  keep("private_inbox_drafts",
    "Inbox drafts stay with the retained source versions they reference (purge registry retains them)."),
  keep("private_inbox_reads",
    "Inbox read markers stay with the retained sources they reference (purge registry retains them)."),
  keep("private_inbox_sources",
    "Inbox sources stay so retained receipt rows keep their parent (purge registry retains them)."),
  keep("private_inbox_versions",
    "Inbox source versions are append-only and stay with the account tombstone (purge registry retains them)."),
  keep("events",
    "The authoritative room event journal, and the audit-retention planner's input. Audit purge decisions (server/audit-retention.mjs) are computed over it but scheduled deletion is deliberately not wired: deleting journal rows would break replay and projections. Rows die only with room purge."),
  keep("analytics_events",
    "A retention policy exists (30d events / 365d aggregates in server/retention.mjs's planner) but scheduled deletion is deliberately NOT wired: the analytics pipeline's data classification is pending (ATLAS-DATA D-7/P-7) and its production driver is unidentified, so retention must not delete its source rows. Rows are deleted by account deletion and by room purge (purge registry). Wire deletion only after the classification ruling lands."),
  keep("analytics_daily",
    "Aggregate daily counters with no entity payload and no per-room or per-account rows (orphans census S6). Nothing for retention to drain; the counters are the long-lived funnel record."),
  keep("analytics_firsts",
    "Dead schema at main: defined and writer-fenced, but no writer and no reader anywhere (ATLAS-DATA D-6); the tail computes firsts in memory and discards them. Aggregate rows with no entity payload and no purge key. Retention records keep; wiring or deleting the table is the data programme's decision (P-6), not a retention clock's."),
  keep("analytics_table_cursor",
    "Global analytics sync cursor keyed by source-table name (one row per source table). Singleton bookkeeping; no entity rows exist in it."),
  keep("board_vtwo_claims",
    "Retired board-v2 surface (routes answer 410); the table has no room_id column, so no purge could ever reach it either. Table removal is tracked in #3997; until that lands, retention records keep."),
  keep("board_vtwo_events",
    "Retired board-v2 surface (routes answer 410); the table has no room_id column, so no purge could ever reach it either. Table removal is tracked in #3997; until that lands, retention records keep."),
  keep("board_vtwo_idempotency",
    "Retired board-v2 surface (routes answer 410); the table has no room_id column, so no purge could ever reach it either. Table removal is tracked in #3997; until that lands, retention records keep."),
  keep("board_vtwo_mirror",
    "Retired board-v2 surface (routes answer 410); the table has no room_id column, so no purge could ever reach it either. Table removal is tracked in #3997; until that lands, retention records keep."),
  keep("claim_reputation_signals",
    "Signals keyed to tombstoned identity ids, which are never reused, so a dead identity's signals are inert inputs; readers key off live agents. History, not a dangling pointer (orphans census S5)."),
  keep("agent_bonds",
    "Retained relationship graph: rows name identities that persist as revoked tombstones, so references resolve rather than dangle, and bond actions refuse revoked identities (server/bonds.mjs)."),
  keep("peer_dm_threads",
    "Retained relationship graph: thread rows name tombstoned identities, so references resolve rather than dangle; the messages themselves are purge-registry rows."),
  keep("agent_wake_room_activity",
    "One upserted row per (agent, room) pair ever polled, carrying only last_polled_at. No content; growth is bounded by the pair count (orphans census S5)."),
  keep("agent_wake_signal_claims",
    "Claim rows are freed in place when their fencing lease dies (releaseListenerLease / lease sweep update them for redelivery); they are never separately deleted and carry no payload beyond claim bookkeeping. The parent signals are purge-registry rows."),
  keep("integrity_job_cursor",
    "Singleton job bookkeeping (singleton INTEGER PRIMARY KEY CHECK (singleton = 1)). One global row; no entity rows exist in it."),
  keep("integrity_snapshot",
    "Singleton integrity checksum row (id INTEGER PRIMARY KEY CHECK (id = 1)). One global row; no entity rows exist in it."),
  keep("room_schema_stamp",
    "Singleton schema version stamp (singleton INTEGER PRIMARY KEY CHECK (singleton = 1)). One global row; no entity rows exist in it."),
  keep("public_read_model_backfill",
    "Singleton backfill bookkeeping (id = 1: phase, cursor, done). One global row; no entity rows exist in it."),
  keep("public_work_claim_writer_permit",
    "Singleton namespace permit flag (singleton INTEGER PRIMARY KEY CHECK (singleton = 1)). One global row; no entity rows exist in it."),
  keep("patrol_cursor",
    "Patrol's per-room scan cursor (room_id, sequence): patrol advances it as it scans, so its lifetime is patrol's own. No deletion path exists today and retention does not invent one; the purge-side disposition is separately unresolved (purge-source-coverage UNRESOLVED)."),
  keep("patrol_findings",
    "Patrol's durable detection record, including parked findings an operator may still act on. Finding lifecycle (resolve / park) is owned by patrol and the guardian surface; retention does not age-delete detection history. The purge-side disposition is separately unresolved (purge-source-coverage UNRESOLVED)."),
  keep("public_abuse_reports",
    "Operator moderation queue: a report is deleted by an operator decision, not by a clock. Retention records keep; the purge-side disposition is separately unresolved (purge-source-coverage UNRESOLVED)."),

  // ---- purge-only: individual rows with a sharper story ----
  purgeOnly("rooms",
    "The room root row: deleted by the operator purge executor itself, after every registry row for that room. Retention never touches the root of the entity graph."),
  purgeOnly("accounts",
    "The account root row: account purge runs the account-deletion executor, which scrubs and deactivates it as a tombstone so retained audit rows stay attributable. Retention never touches account roots."),
  purgeOnly("analytics_room_cursor",
    "Per-room analytics tail cursor: rewritten by the tail as it reads the room journal, and deleted by room purge (purge registry row). No retention clock; a cursor for a live room is load-bearing."),
  purgeOnly("claim_bond_shadow",
    "Claim-bond shadow measurement rows (server/analytics/claim-bond-shadow.mjs): a measurement instrument no scheduled mechanism runs (ATLAS-DATA). Deleted by room purge (purge registry row added by #4150); retention does not drain a shadow table."),
  purgeOnly("patrol_blocks",
    "Patrol self-cleans blocks for rooms that no longer exist (gone-room sweep in server/patrol.mjs) and deletes a room's blocks when the room is removed. That executor path is the lifetime; the retention tick does not touch patrol tables."),
  purgeOnly("patrol_claims",
    "Patrol deletes a room's claims itself when the room is removed (server/patrol.mjs per-room deletes). That executor path is the lifetime; the retention tick does not touch patrol tables."),
  purgeOnly("patrol_messages",
    "Patrol deletes a room's messages itself when the room is removed (server/patrol.mjs per-room deletes). That executor path is the lifetime; the retention tick does not touch patrol tables."),
  purgeOnly("integrity_room_state",
    "Per-room integrity state: deleted by room purge (purge registry), and the sibling integrity machinery self-cleans state for gone rooms. Retention does not drain the integrity surface."),
  purgeOnly("web_fetch_cache_rooms",
    "Per-room index rows for the shared fetch cache: the cache entries themselves are mechanism-drained by max age (web_fetch_cache), and these room links are deleted by room purge (purge registry)."),

  // ---- purge-only: families ----
  ...purgeFamily(MONEY, [
    "bounty_disputes", "bounty_events", "bounty_flakes", "bounty_idempotency",
    "bounty_journal", "bounty_records", "bounty_reputation_packets",
    "bounty_review_packets", "bounty_rubric_versions", "bounty_sequences",
    "bounty_sybil_flags", "bounty_watchers",
    "public_work_receipts", "public_work_requests", "public_work_review_requests",
    "public_work_reviews", "public_work_settlements", "public_work_successor_requests",
    "public_work_successors", "public_work_tasks"
  ]),
  ...purgeFamily(WORK, [
    "agent_wants_work", "buyer_signoff_loops", "buyer_signoff_requests",
    "demigod_contract_requests", "demigod_contracts", "demigod_offer_profiles",
    "demigod_offer_requests", "project_offer_requests", "project_offers",
    "room_trial_requests", "room_trial_tasks", "room_vetting_keys",
    "room_vetting_receipts", "work_claim_config", "work_claims",
    "work_item_board_backfill", "work_item_board_divergence"
  ]),
  ...purgeFamily(CREDENTIALS, [
    "account_credentials", "account_login_methods", "account_magic_codes",
    "account_passkey_credentials", "account_recovery_codes", "account_security_events",
    "account_session_slots", "account_setup", "account_terms",
    "agent_api_keys", "agent_identity_rotation_receipts", "agent_identity_verification",
    "agent_invite_codes", "agent_invite_redeem_receipts", "credentials",
    "guest_invite_authority", "identity_link_codes", "identity_links", "member_accounts"
  ]),
  ...purgeFamily(AGENT_RUNTIME, [
    "agent_autonomy_tiers", "agent_capability_grants", "agent_connection_operations",
    "agent_connections", "agent_directory_cards", "agent_hosts", "agent_key_registry",
    "agent_push_configs", "agent_room_ownership", "agent_skill_cards",
    "agent_wake_counters", "agent_wake_failures", "agent_wake_polls", "agent_wake_signals",
    "agent_webhook_subs", "agent_work_wake_hosts", "agent_work_wakes",
    "room_verification_policy", "wake_queue", "wake_queue_commands",
    "wake_queue_pause", "wake_queue_pause_by"
  ]),
  ...purgeFamily(PUBLIC_PROJECTION, [
    "public_directory_entries", "public_receipts", "public_rooms",
    "room_public_receipts_setting", "room_public_settings"
  ]),
  ...purgeFamily(PRIVATE_DATA, [
    "direct_channel_sends", "gmail_linked_mailboxes", "gmail_mailboxes",
    "gmail_operations", "gmail_pending", "inbox_attachment_bytes",
    "inbox_handoff_rooms", "inbox_handoffs", "peer_dm_messages",
    "stitch_identities", "stitch_links", "stitch_receipts", "stitch_revocations",
    "stitch_suggestions"
  ]),
  ...purgeFamily(OPS_JOURNAL, [
    "jev_shadow_decisions", "land_queue", "land_queue_idempotency",
    "membership_delegation_grants", "membership_delegation_journal",
    "membership_delegation_pending", "membership_invitation_journal",
    "owner_delegate_grants", "owner_delegate_journal", "quarantine_thread_splits",
    "request_runs", "sla_breach_alerts", "spam_quarantine"
  ]),
  ...purgeFamily(PRODUCT_STATE, [
    "access_requests", "activity_events", "activity_fanout_failures",
    "collab_approvals", "collab_assignments", "collab_draft_locks", "collab_notes",
    "collab_routing_events", "commands", "cursors", "dm_consents",
    "guest_invites", "guest_link_exchanges", "guest_members", "guest_selfserve",
    "guest_selfserve_idem", "handoff_envelopes", "human_push_preferences",
    "human_push_subscriptions", "membership_invitation_events", "membership_invitations",
    "mention_states", "message_reports", "messages", "messages_backfill_blocks",
    "messages_backfill_cursor", "messages_backfill_state", "private_attention_commands",
    "private_attention_prefs", "private_next_action_dismissals",
    "private_next_action_suppressions", "private_reminder_commands", "private_reminders",
    "private_update_commands", "private_update_marks", "projection_bodies",
    "projection_checkpoints", "projection_shape_upgrades", "read_horizons",
    "referral_chain_members", "referral_invite_keys", "referral_invites", "referrals",
    "room_access_auto_approve", "room_assistant_config", "room_assistant_ops",
    "room_assistant_runs", "room_attachments", "room_code_checks", "room_code_drops",
    "room_directory_settings", "room_mention_settings", "saved_messages",
    "share_link_access", "share_link_codes", "share_link_joins", "share_links",
    "spend_authorizations", "spend_grant_terms", "spend_room_reservations", "squads",
    "telegram_live_status", "thread_mutes"
  ])
]);

const byTable = new Map(RETENTION_DISPOSITIONS.map(row => [row.table, row]));

// The disposition recorded for one table, or undefined if the table has no
// row (tests/retention-source-coverage.test.js makes that unreachable for
// tables created in server/** source).
export function retentionDispositionFor(table) {
  return byTable.get(table);
}

// The tables the scheduled retention tick drains itself: registry rows
// whose rule is an age rule, in registry order.
export const RETENTION_AGE_DRAIN_TABLES = Object.freeze(
  RETENTION_DISPOSITIONS
    .filter(row => row.disposition === "drain" && row.rule.kind === "age")
    .map(row => Object.freeze({ table: row.table, days: row.rule.days, idColumn: row.rule.idColumn }))
);
