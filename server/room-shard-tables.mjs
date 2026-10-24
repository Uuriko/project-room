// Which SQLite tables move with one room.
//
// A table is "room" when every row is keyed by that room and is meaningless
// without its event log: the log itself, the commands that append it, the
// rooms projection and its bodies, messages, that room's work claims and
// work entities, its bounties, and the journals whose rows carry room_id.
// Accounts, sessions, credentials, grants, and anything ambiguous stay
// "directory" on invite-only-pilot. Tables in REPLAY_SKIPPED_TABLES are
// "skipped": a fresh Node store does not create them, and replay already
// refuses to invent a home for them.
//
// A table missing from all three sets throws. Copy will not guess.
import { REPLAY_SKIPPED_TABLES } from "./room-export.mjs";

export const ROOM_TABLE_KEYS = Object.freeze({
  bounty_disputes: "room_id",
  bounty_events: "room_id",
  bounty_flakes: "room_id",
  bounty_idempotency: "room_id",
  bounty_journal: "room_id",
  bounty_records: "room_id",
  bounty_reputation_packets: "room_id",
  bounty_review_packets: "room_id",
  bounty_rubric_versions: "room_id",
  bounty_sequences: "room_id",
  bounty_sybil_flags: "room_id",
  bounty_watchers: "room_id",
  commands: "room_id",
  events: "room_id",
  jev_shadow_decisions: "room_id",
  membership_delegation_journal: "room_id",
  membership_delegation_pending: "room_id",
  messages: "room_id",
  owner_delegate_journal: "room_id",
  projection_bodies: "room_id",
  projection_checkpoints: "room_id",
  rooms: "id",
  work_claim_config: "room_id",
  work_claim_history: "room_id",
  work_claims: "room_id",
  work_entities: "room_id",
});

export const DIRECTORY_TABLES = Object.freeze([
  "access_requests", "account_access_events", "account_credentials", "account_login_methods",
  "account_magic_codes", "account_passkey_credentials", "account_recovery_codes",
  "account_security_events", "account_session_slots", "account_setup", "account_terms", "accounts",
  "activity_events", "activity_fanout_failures", "agent_api_keys", "agent_autonomy_tiers",
  "agent_bonds", "agent_capability_grants", "agent_connection_operations", "agent_connections",
  "agent_directory_cards", "agent_hosts", "agent_identities", "agent_identity_rotation_receipts",
  "agent_identity_verification", "agent_invite_codes", "agent_invite_redeem_receipts",
  "agent_key_registry", "agent_push_configs", "agent_room_ownership", "agent_skill_cards",
  "agent_wake_polls", "agent_wake_signals", "agent_wants_work", "agent_webhook_deliveries",
  "agent_webhook_subs", "agent_work_wake_hosts", "agent_work_wakes", "board_vtwo_claims",
  "board_vtwo_events", "board_vtwo_idempotency", "board_vtwo_mirror", "buyer_signoff_loops",
  "buyer_signoff_requests", "collab_approvals", "collab_assignments", "collab_draft_locks",
  "collab_notes", "collab_routing_events", "credentials", "cursors", "demigod_contract_requests",
  "demigod_contracts", "demigod_offer_profiles", "demigod_offer_requests", "direct_channel_sends",
  "dm_consents", "gmail_linked_mailboxes", "gmail_mailboxes", "gmail_operations", "gmail_pending",
  "guest_invite_authority", "guest_invites", "guest_link_exchanges", "guest_members",
  "guest_selfserve", "guest_selfserve_idem", "handoff_envelopes", "human_push_preferences",
  "human_push_subscriptions", "identity_link_codes", "identity_links", "inbox_attachment_bytes",
  "inbox_handoff_rooms", "inbox_handoffs", "integrity_job_cursor", "integrity_room_state",
  "integrity_snapshot", "land_queue", "land_queue_idempotency", "member_accounts",
  "membership_delegation_grants", "membership_invitation_events", "membership_invitation_journal",
  "membership_invitations", "mention_observations", "mention_states", "message_replay_snapshots",
  "message_reports", "messages_backfill_blocks", "messages_backfill_cursor",
  "messages_backfill_state", "oauth_pending_states", "operator_actions", "owner_delegate_grants",
  "peer_dm_messages", "peer_dm_threads", "pending_channel_updates", "private_attention_commands",
  "private_attention_prefs", "private_email_commands", "private_email_connections",
  "private_email_folders", "private_inbox_commands", "private_inbox_drafts", "private_inbox_reads",
  "private_inbox_sources", "private_inbox_versions", "private_next_action_dismissals",
  "private_next_action_suppressions", "private_reminder_commands", "private_reminders",
  "private_update_commands", "private_update_marks", "project_offer_requests", "project_offers",
  "public_abuse_reports", "public_directory_entries", "public_read_model_backfill",
  "public_receipts", "public_rooms", "public_unpublish", "public_work_claim_writer_permit",
  "public_work_receipts", "public_work_requests", "public_work_review_requests",
  "public_work_review_versions", "public_work_reviews", "public_work_settlements",
  "public_work_successor_requests", "public_work_successors", "public_work_tasks",
  "quarantine_thread_splits", "read_horizons", "referral_chain_members", "referral_invite_keys",
  "referral_invites", "referrals", "request_runs", "room_access_auto_approve",
  "room_assistant_config", "room_assistant_ops", "room_assistant_runs", "room_attachments",
  "room_code_checks", "room_code_drops", "room_directory_settings", "room_mention_settings",
  "room_public_receipts_setting", "room_public_settings", "room_schema_stamp",
  "room_trial_requests", "room_trial_tasks", "room_verification_policy", "room_vetting_keys",
  "room_vetting_receipts", "saved_messages", "share_link_access", "share_link_codes",
  "share_link_join_redemptions", "share_link_joins", "share_links", "sla_breach_alerts",
  "spam_quarantine", "spend_authorizations", "spend_grant_terms", "spend_room_reservations",
  "squads", "stitch_identities", "stitch_links", "stitch_receipts", "stitch_revocations",
  "stitch_suggestions", "telegram_live_status", "thread_mutes", "wake_queue", "wake_queue_commands",
  "wake_queue_pause", "wake_queue_pause_by", "web_fetch_cache", "web_fetch_cache_rooms",
  "web_fetch_log", "web_research_log", "work_item_board_backfill",
  "work_item_board_divergence",
]);

// Tables a room restore is willing to load. Directory and skipped names are
// omitted so replay's existing "store does not have this table" check
// refuses them. The tables stay in the file: room triggers still reference
// them, and dropping them makes a room-table delete fail.
export function roomTablesPresent(db) {
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all()
    .map(row => row.name);
  const kept = new Set();
  for (const name of names) if (tableHome(name) === "room") kept.add(name);
  return kept;
}

const directory = new Set(DIRECTORY_TABLES);
const skipped = new Set(REPLAY_SKIPPED_TABLES);

export function tableHome(name) {
  if (skipped.has(name)) return "skipped";
  if (Object.hasOwn(ROOM_TABLE_KEYS, name)) return "room";
  if (directory.has(name)) return "directory";
  throw new Error(`Unclassified SQLite table ${name}`);
}

export function roomKeyColumn(name) {
  const column = ROOM_TABLE_KEYS[name];
  if (!column) throw new Error(`Not a room table: ${name}`);
  return column;
}

// Live schema names, excluding sqlite_* bookkeeping. Throws when a table
// is new, renamed, or present while this module still calls it skipped.
export function assertShardClassification(names) {
  const live = [...names].filter(name => typeof name === "string" && !name.startsWith("sqlite_")).sort();
  const problems = [];
  const seen = new Set();
  for (const name of live) {
    if (seen.has(name)) problems.push(`duplicate live table ${name}`);
    seen.add(name);
    let home;
    try { home = tableHome(name); }
    catch (error) { problems.push(error.message); continue; }
    if (home === "skipped") problems.push(`${name} is skipped but a fresh store creates it`);
  }
  for (const name of Object.keys(ROOM_TABLE_KEYS)) {
    if (!seen.has(name)) problems.push(`room table ${name} is not in the live schema`);
  }
  for (const name of DIRECTORY_TABLES) {
    if (!seen.has(name)) problems.push(`directory table ${name} is not in the live schema`);
  }
  if (directory.size !== DIRECTORY_TABLES.length) problems.push("directory classification has duplicate names");
  if (problems.length) throw new Error(problems.join("\n"));
  return live;
}
