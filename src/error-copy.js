// Human-readable error copy for the browser client (PRODUCT-200 BU-03).
//
// Every server error code that used to fall through to a generic
// "Unknown error" / "Request failed" now resolves to a specific,
// plain-language message with a recovery action. The sentences live in the
// strings catalog (strings/en.json, key `error.<code>`); this module only
// maps codes to keys so the i18n harness ratchet stays green.
import { uiText } from "./strings.js";

// Exact set of server error codes covered by the catalog's `error.<code>`
// keys (the UNKNOWN-ERROR fallthrough sweep).
export const ERROR_KEYS = new Set([
  "access_rejected",
  "account_exists",
  "account_not_found",
  "account_state_unchanged",
  "active_members",
  "attachment_conflict",
  "attachment_not_found",
  "attachment_quota",
  "attachment_too_large",
  "attachment_unavailable",
  "bond_active",
  "bond_not_found",
  "bond_proposed_by_peer",
  "budget_exceeded",
  "channel_connection_unavailable",
  "channel_not_found",
  "channel_sending_unavailable",
  "channel_sharing_unavailable",
  "channel_sync_unavailable",
  "channel_sync_unsupported",
  "channel_webhook_backlog",
  "channel_webhook_unavailable",
  "charter_integrity_error",
  "charter_not_found",
  "claim_conflict",
  "code_drop_not_found",
  "confirm_used",
  "conflicting_inbox_observation",
  "connection_changed",
  "conversation_record_too_large",
  "credential_still_live",
  "credential_too_old",
  "cursor_ahead",
  "cursor_changed",
  "cursor_not_found",
  "cursor_stale",
  "direct_send_not_found",
  "direct_send_settled",
  "discussion_history_changed",
  "dm_already_approved",
  "dm_no_pending_request",
  "dm_not_blocked",
  "dm_nothing_to_revoke",
  "email_connection_changed",
  "email_unverified",
  "face_not_enabled",
  "face_not_found",
  "grant_active",
  "guest_not_found",
  "guest_session_ended",
  "halt_active",
  "handoff_not_found",
  "human_push_device_limit",
  "identity_conflict",
  "identity_not_found",
  "identity_revoked",
  "inbox_attachment_not_found",
  "inbox_limit",
  "inbox_reply_already_sent",
  "inbox_result_not_found",
  "inbox_send_not_found",
  "inbox_send_started",
  "inbox_send_unresolved",
  "inbox_source_not_found",
  "inbox_source_origin_changed",
  "invalid_handoff_transition",
  "invalid_referral",
  "invalid_request",
  "invalid_url",
  "invitation_already_used",
  "invitation_authority_changed",
  "invitation_conflict",
  "invitation_expired",
  "invitation_not_found",
  "invitation_not_pending",
  "invitation_receipt_unavailable",
  "invitation_rejected",
  "invitation_revoked",
  "invitation_scope_invalid",
  "invitation_unavailable",
  "invite_already_used",
  "invite_ambiguous",
  "invite_authority_changed",
  "invite_expired",
  "invite_not_active",
  "invite_not_found",
  "invite_rejected",
  "invite_revoked",
  "invite_unavailable",
  "join_changed",
  "join_session_lost",
  "key_already_registered",
  "key_not_found",
  "land_item_not_found",
  "land_queue_full",
  "last_login_method",
  "last_unverified_email",
  "login_method_exists",
  "login_method_not_found",
  "managed_agent",
  "member_inactive",
  "member_not_found",
  "membership_conflict",
  "membership_ended",
  "mention_not_found",
  "message_deleted",
  "message_not_found",
  "nothing_to_request",
  "outside_agent_changed",
  "outside_agent_not_found",
  "peer_not_found",
  "pilot_limit",
  "plan_changed",
  "pr_not_found",
  "push_not_configured",
  "quarantine_already_reviewed",
  "quarantine_already_split",
  "quarantine_not_found",
  "quarantine_source_missing",
  "referral_depth_exceeded",
  "referral_rejected",
  "reminder_inactive",
  "reminder_limit",
  "reply_attempt_not_found",
  "reply_draft_unconfirmed",
  "reply_update_not_found",
  "reply_update_unresolved",
  "request_conflict",
  "result_not_found",
  "room_archived",
  "room_exists",
  "room_not_found",
  "round_limit_exceeded",
  "seat_taken",
  "secret_changed",
  "session_binding_changed",
  "slot_not_authenticated",
  "spend_allowance_exceeded",
  "squad_disbanded",
  "squad_exists",
  "squad_not_found",
  "thread_not_found",
  "token_conflict",
  "too_many_open_claims",
  "too_many_requests",
  "unknown_member",
  "unknown_quarantine",
  "unknown_target",
  "unsupported_agent_scope",
  "unsupported_content",
  "update_changed",
  "update_not_found",
  "wake_dead",
  "wake_limit",
  "wake_not_dead",
  "wake_not_leased",
  "work_resolved",
]);

const STATUS_KEYS = {
  400: "error.status.400",
  401: "error.status.401",
  403: "error.status.403",
  404: "error.status.404",
  405: "error.status.405",
  409: "error.status.409",
  410: "error.status.410",
  413: "error.status.413",
  415: "error.status.415",
  422: "error.status.422",
  428: "error.status.428",
  429: "error.status.429",
  500: "error.status.500",
  502: "error.status.502",
  503: "error.status.503",
  504: "error.status.504",
};

const catalogText = key => {
  try {
    return uiText(key);
  } catch {
    // A stale catalog must never break error display; fall through below.
    return null;
  }
};

// Resolve a thrown client error to the message a human should see.
// Precedence: specific catalog copy for the code, then the server's own
// message when it is specific, then a status-based sentence, then a final
// non-generic fallthrough. Never returns "Unknown error" or "Request failed".
export function humanErrorMessage({ status, code, message } = {}) {
  if (typeof code === "string" && ERROR_KEYS.has(code)) {
    const text = catalogText(`error.${code}`);
    if (text) return text;
  }
  const serverText = typeof message === "string" ? message.trim() : "";
  // qa1-r1 (2026-10-09, prod a82c8d43): the chat flood guard answers a fast
  // sender with agent protocol text ("on 429, wait Retry-After and retry").
  // A person should get the plain 429 sentence; specific 429 reasons (guest
  // seat limit, mint limit) still pass through.
  const agentProtocolText = Number(status) === 429 && /\bRetry-After\b/i.test(serverText);
  if (serverText && serverText !== "Request failed" && !agentProtocolText) return serverText;
  const statusText = catalogText(STATUS_KEYS[Number(status)]);
  if (statusText) return statusText;
  return catalogText("error.unknown") || "Something went wrong. Please try again.";
}
