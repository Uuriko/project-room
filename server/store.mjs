import { gmailSchema } from './gmail-mailbox.mjs';
import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes, randomUUID } from "node:crypto";
// ServiceError lives in server/service-error.mjs (shared, cycle-free); the
// local import keeps the binding in scope (e.g. for StorageUnavailableError
// below) and it is re-exported so every existing
// `import { ServiceError } from "./store.mjs"` resolves to the exact same
// class object and all `instanceof` checks behave identically.
import { ServiceError } from "./service-error.mjs";
import { createRoomFloodGuard } from "./room-flood-guard.mjs";
export { ServiceError };
import {
  applyEvent, emptyRoomState, event, EVENT_TYPES as T, WORK_STATES, INVITATION_ROLE_POLICIES,
  INVITATION_ROLE_POLICY_VERSION, INVITATION_ROLES,
  MEMBERSHIP_AUTHORITY_POLICY_VERSION, validId, memberCan, ROOM_POLICY_FIELDS, DEFAULT_CHANNEL_ID,
  TRUST_OFF_CODE, trustOffMessage, firstBlockedWakeTarget,
  MAX_MESSAGE_BODY_CHARS, MAX_MESSAGE_COMMAND_BYTES
} from "../src/events.js";
import { PIN_COMMAND_SHAPES, isPinned } from "../src/events.js";
import { applyEventWithGrowth, growthCollector } from "../src/growth-emit.js";
import { buildReturnBrief, resolveHistoryWindow, RETURN_BRIEF_DEFAULT_LIMIT } from "./return-brief.mjs";
import { enforceSpendAllowance } from "./spend-allowance.mjs";
import { ensureAutonomyTiersSchema, enforceAutonomyTiers } from "./autonomy-tiers.mjs";
import { canonicalInvitationData, invitationJournalEntry, invitationJournalSchema, replayInvitationJournal } from "./invitation-journal.mjs";
import { invitationJoinedEvent, assertInvitationMembershipEvidence } from "./invitation-evidence.mjs";
import { STORE_SCHEMA_VERSION, registerWriter, installWriterFence, verifyWriterFence } from "./writer-fence.mjs";
import { migrateRoomLifecycleV28, verifyRoomLifecycle, refuseArchivedWrite, createAccountRoom, accountRoomEntry, ACCOUNT_ROOM_SELECT, archivedAtOf } from "./room-lifecycle.mjs";
import { ShareLinks, shareLinkSchema, shareLinkCodeSchema } from "./share-links.mjs";
import { DmConsents, dmConsentSchema } from "./dm-consents.mjs";
import { Bonds, bondSchema, isPeerPrivateEvent, peerEventVisible } from "./bonds.mjs";
import { PublicFace, roomPublicFaceSchema } from "./public-face.mjs";
import { RoomDirectory, roomDirectorySchema } from "./room-directory.mjs";
import { conflictingClaim } from "./claim-scopes.mjs";
import { Reminders, reminderSchema } from "./reminders.mjs";
import { Notifications } from "./notifications.mjs";
import { Moderation, moderationSchema, mutedEvent } from "./moderation.mjs";
import { RequestRuns, requestRunSchema } from "./request-runs.mjs";
import { WakeQueue, wakeQueueSchema, wakeQueuePauseSchema } from "./wake-queue.mjs";
import { Attention, attentionSchema } from "./attention.mjs";
import { NextActions, nextActionsSchema } from "./next-actions.mjs"; // RC-2026-09-25-911: ranked per-agent next actions.
import { ChannelUpdateJournal, channelJournalSchema } from "./channel-journal.mjs";
import { SpamQuarantineJournal, spamQuarantineSchema, migrateSpamQuarantineColumns } from "./spam-quarantine-journal.mjs";
import { JevShadowJournal, jevShadowSchema } from "./jev-shadow-journal.mjs";
import { QuarantineThreadSplits, quarantineThreadSplitSchema } from "./quarantine-thread-splits.mjs";
import { SlaBreachAlertJournal, slaBreachAlertSchema } from "./sla-breach-journal.mjs";
import { InboxCollabStore, inboxCollabSchema } from "./inbox-collab-store.mjs"; // Lane C inbox collaboration (task RC-2026-09-18-011).
import { InboxHandoffJournal, inboxHandoffRoomSchema, inboxHandoffSchema } from "./inbox-handoff.mjs";
import { HandoffEnvelopeJournal, handoffEnvelopeSchema } from "./work-handoff.mjs"; // RC-2026-09-19-062: typed handoff envelopes.
import { buildRoomContext } from "./room-context.mjs";
import { AgentPluginStore, agentPluginSchema } from "./agent-plugin-store.mjs";
import { accessRequestSchema } from "./access-requests.mjs";
import { membershipDelegationSchema, MembershipDelegation } from "./membership-delegation.mjs";
import { agentRoomSchema } from "./agent-rooms.mjs";
import { directSendSchema } from "./inbox-outbox.mjs";
import { inboxStitchSchema } from "./inbox-stitch-store.mjs";
import { ensureAttachmentSchema, verifyAttachmentSchema } from "./attachment-schema.mjs";
import { RoomAttachmentBytes } from "./room-attachment-bytes.mjs";
import { InboxAttachmentBytes, inboxAttachmentBytesSchema } from "./inbox-attachment-bytes.mjs";
import { BountyEscrow, bountyEscrowSchema, convergeBountyDeployedSchema } from "./bounty-escrow.mjs"; // Escrowed bounties, agent work exchange slice 1.
import { selectedWorkContext, currentWorkRecord } from "./work-context.mjs";
import { workItemChanges } from "../src/workflow.js";
import { discussionWindow, selectedWorkDiscussion } from "./work-discussion.mjs";
import { AgentConnections, agentConnectionSchema } from "./agent-connections.mjs";
import { GuestAgentLinks, isRoomAccessToken, isGuestAgentMemberId } from "./guest-agent-links.mjs";
import { GuestInvites, guestInviteSchema } from "./guest-invites.mjs";
import { WebFetch, webFetchSchema, migrateWebFetchLogColumns } from "./web-fetch.mjs";
import { WebResearch, webResearchSchema } from "./web-research.mjs"; // RC-2026-09-24-310: knowledge router (additive)
import { AgentIdentities, agentIdentitySchema, ensureIdentitySecretSchema, ensureIdentityLinkCodeSchema, isIdentitySecret } from "./agent-identities.mjs";
import { AgentKeyRegistry, agentKeyRegistrySchema } from "./agent-key-registry.mjs"; // Integration map slice 9: agent public-key registry.
import { API_KEY_PREFIX } from "./agent-api-keys.mjs";
import { AgentHeartbeats, agentHeartbeatSchema } from "./agent-heartbeats.mjs"; // RC-2026-09-18-051: wakeable agent presence.
import { LandQueue, landQueueSchema, migrateLandQueueColumns } from "./land-queue.mjs";
import { MembersDirectory, membersDirectorySchema } from "./members-directory.mjs"; // RC-2026-09-24-202: members directory + skill cards.
import {
  MENTION_TIMEOUT_MS_DEFAULT, MENTION_TIMEOUT_MS_MIN, MENTION_TIMEOUT_MS_MAX,
  assertTransitionMention, resolveMentionTargetsInText, mentionStateSchema,
} from "./mention-lifecycle.mjs"; // #658: mention lifecycle state machine + schema.
import { activitySchema, recordActivityEvents } from "./activity.mjs"; // Attention: activity feed, read horizons, saved messages, thread mutes.
import { AgentInvites, agentInviteSchema } from "./agent-invites.mjs";
import { ReferralInvites, referralInviteSchema } from "./referral-invites.mjs";
import { ThreadMutes, threadMutesSchema } from "./thread-mutes.mjs"; // Per-thread mutes: private side table, additive.
import { Referrals, referralSchema } from "./referrals.mjs";
import { AccountLoginMethods, accountLoginMethodsSchema } from "./account-login-methods.mjs";
import { verifyTextCompletion, selectedWorkResult } from "./text-results.mjs";
import { verifyCompletionEvidence, EvidenceError } from "./signed-evidence.mjs"; // Integration map slice 5: signed external evidence for work.completed.
import { evaluateReceipt } from "./jev-receipts.mjs"; // Jev-harness receipt gate (docs/JEV-GATES.md): pure scorer, no imports of its own.
import { charterContext, charterFromEvent } from "../src/room-charter.js";
import { REPLY_FIELDS, REPLY_POLICY_VERSION, replyPostMode } from "../src/reply-requests.js";
import { ReplyRequests } from "./reply-requests.mjs";
import { validateHelpData } from "../src/work-help.js";
import { auditWorkHelp } from "./work-help.mjs";
import { HELP_OFFER_OPENED, HELP_OFFER_UPDATED, validateHelpOfferData } from "../src/help-offers.js";
import { classifyCommand } from "./action-classes.mjs";
import { presenceState, PRESENCE_UNREACHABLE_AFTER_MS } from "../src/presence-state.js"; // #660: agent presence/working states.
import {
  isSessionStatus, isTerminalSession, sessionRecord, listWorkItemSessions, sessionCommandType, sessionWorker,
  sessionClaimConflict,
  validateSessionBudget, budgetLimitExceeded, roundLimitExceeded, SESSION_HEARTBEAT_STALE_MS,
  validateAttemptEnvironment, validateAttemptOutputs, ensureWorkControlDefaults
} from "../src/work-item-session.js";
import { Inbox, inboxSchema, inboxReadSchema } from "./inbox.mjs";
import { EmailImport, emailImportSchema } from "./email-import.mjs";

// ServiceError is defined in server/service-error.mjs and re-exported by
// store.mjs; see the import at the top of this file.
// Exhausted or unwritable storage (disk full, quota, read-only file or
// database, I/O errors) is one typed refusal. The failing transaction has
// already been rolled back, so no partial write exists, and the driver text
// stays in `cause` on the server: clients see only the stable code.
export class StorageUnavailableError extends ServiceError {
  constructor(cause = null) {
    super(503, "storage_unavailable", "Storage is unavailable; no success is claimed", { "Retry-After": "30" });
    this.cause = cause;
  }
}
// SQLite primary result codes: READONLY, IOERR, FULL, CANTOPEN (WAL/shm files).
const storageFailureSqlite = new Set([8, 10, 13, 14]);
const storageFailureSystem = new Set(["ENOSPC", "EDQUOT", "EROFS", "EIO"]);
const storageFailureText = /database or disk is full|attempt to write a readonly database|disk I\/O error|unable to open database file|no space left on device|read-only file system/i;
export function isStorageUnavailable(error) {
  if (!error || typeof error !== "object") return false;
  if (error instanceof StorageUnavailableError) return true;
  if (Number.isInteger(error.errcode) && storageFailureSqlite.has(error.errcode & 0xff)) return true;
  if (typeof error.code === "string" && storageFailureSystem.has(error.code)) return true;
  return storageFailureText.test(String(error.errstr ?? error.message ?? ""));
}
export const STORAGE_FAILURE_THRESHOLD = 3;
// Legacy projections stored before channels existed gain #general, so a stored
// projection, a retained checkpoint and a fresh replay all describe the same
// room. Mirrors ensureDefaultChannel in src/events.js. Returns true when it
// added one, which is how the open-time repair knows to persist.
//
// This is one function because it was previously two ideas and one
// implementation: the open-time repair backfilled rooms.projection, the
// checkpoint replay did not, and a room whose checkpoint predated channels
// therefore rebuilt without one while its stored projection had one. That
// disagreement fails auditRecovery, which gates backupRoom across every room.
function ensureDefaultChannelState(state) {
  if (!state?.room) return false;
  state.channels ??= {};
  if (state.channels[DEFAULT_CHANNEL_ID]) return false;
  state.channels[DEFAULT_CHANNEL_ID] = {
    id: DEFAULT_CHANNEL_ID,
    name: DEFAULT_CHANNEL_ID,
    createdBy: state.room.ownerId,
    createdAt: state.room.createdAt ?? null,
    archivedAt: null
  };
  return true;
}

const fail = (status, code, message) => { throw new ServiceError(status, code, message); };
// F5: the bounded pilot caps in one place. The room write paths below enforce
// them; server/usage-summary.mjs reports them with the remaining headroom.
export const PILOT_LIMITS = Object.freeze({ eventsPerRoom: 10000, membersPerRoom: 100, workItemsPerRoom: 500, projectionBytes: 4 * 1024 * 1024 });
const hash = text => createHash("sha256").update(text).digest("hex");
const key = () => randomBytes(32).toString("base64url");
// RC-2026-09-18-012: presented agent API-key credentials ("rak_"+secret).
// The bearer() regex in server/http.mjs gates the shape; this predicate
// routes verified keys into the agent-identity auth branch below.
const isApiKeyToken = token => typeof token === "string" && token.startsWith(API_KEY_PREFIX);
// Channel-fixture threads conventionally carry a "<channel>:" prefix
// (sms:, messenger:, email:); anything else reports no channel rather
// than guessing — threadIds stay opaque everywhere else.
const channelOfThreadId = threadId => {
  const match = /^(sms|messenger|email|room):/.exec(typeof threadId === "string" ? threadId : "");
  return match ? match[1] : null;
};
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : value && typeof value === "object" ? `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}` : JSON.stringify(value);
export const provisionalAccountPrefix = "acct-legacy-";
const provisionalAccountId = (roomId, memberId) => `${provisionalAccountPrefix}${hash(`${roomId}\0${memberId}`).slice(0, 32)}`;
const accountView = row => row ? { id: row.id, active: Boolean(row.active), revision: row.revision, authEpoch: row.auth_epoch } : null;
// RC-2026-09-19-078: account profile columns (display name / avatar) and
// the first-run onboarding flag converge on existing databases via ALTER
// TABLE — the same additive pattern as migrateSpamQuarantineColumns and
// ensureIdentitySecretSchema. Existing rows backfill display_name/avatar_url
// NULL and onboarded 1, so legacy accounts are not forced through
// first-run onboarding; createAccount inserts new accounts with
// onboarded 0.
function ensureAccountProfileSchema(db) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='accounts'").get()) return;
  const columns = new Set(db.prepare("SELECT name FROM pragma_table_info('accounts')").all().map(r => r.name));
  if (!columns.has("display_name")) db.exec("ALTER TABLE accounts ADD COLUMN display_name TEXT");
  if (!columns.has("avatar_url")) db.exec("ALTER TABLE accounts ADD COLUMN avatar_url TEXT");
  if (!columns.has("onboarded")) db.exec("ALTER TABLE accounts ADD COLUMN onboarded INTEGER NOT NULL DEFAULT 1");
  // RC-2026-09-19-088: ever_had_room tracks whether the account has ever held
  // a room membership, so the default-room endpoint never resurrects a room
  // for someone who deliberately left (or was removed from) all of theirs.
  if (!columns.has("ever_had_room")) {
    db.exec("ALTER TABLE accounts ADD COLUMN ever_had_room INTEGER NOT NULL DEFAULT 0");
    // Backfill: accounts with a current membership have had a room. Defensive:
    // if member_accounts is absent (partial migration), the column defaults
    // to 0 and the endpoint treats the account as new (safe direction).
    try {
      db.exec("UPDATE accounts SET ever_had_room=1 WHERE id IN (SELECT account_id FROM member_accounts)");
    } catch { /* member_accounts absent; leave default 0 */ }
  }
  // Note: ever_had_room is maintained by markAccountHadRoom() at each
  // member_accounts INSERT (application-level, not a trigger — D1 trigger
  // DDL inside the upgrade transaction breaks the v8→v35 rollback gate).
}
const DISPLAY_NAME_LIMIT = 64;
const AVATAR_URL_LIMIT = 2048;
const normalizeDisplayName = value => {
  if (typeof value !== "string") fail(422, "invalid_profile", "displayName must be a string");
  const name = value.trim();
  if (name.length === 0 || name.length > DISPLAY_NAME_LIMIT) fail(422, "invalid_profile", `displayName must be 1..${DISPLAY_NAME_LIMIT} characters`);
  return name;
};
const normalizeAvatarUrl = value => {
  if (typeof value !== "string") fail(422, "invalid_profile", "avatarUrl must be a string");
  if (value === "") return null; // empty string clears the avatar
  if (value.length > AVATAR_URL_LIMIT) fail(422, "invalid_profile", `avatarUrl must be at most ${AVATAR_URL_LIMIT} characters`);
  let protocol = null;
  try { protocol = new URL(value).protocol; } catch { protocol = null; }
  if (protocol !== "https:") fail(422, "invalid_profile", "avatarUrl must be an https URL");
  return value;
};
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const redemptionPattern = /^(?:[A-Za-z0-9_-]{43}|[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const invitationStatus = (row, now) => row.status === "pending" && row.expires_at <= now ? "expired" : row.status;
const invitationView = (row, now, { includeScope = false } = {}) => ({
  id: row.id,
  roomId: row.room_id,
  displayName: row.intended_display_name,
  role: row.intended_role,
  expiresAt: row.expires_at,
  revision: row.revision,
  status: invitationStatus(row, now),
  ...(includeScope ? {
    intendedAccountId: row.intended_account_id,
    intendedMemberId: row.intended_member_id,
    permissions: JSON.parse(row.intended_permissions_json),
    invitedByMemberId: row.issuer_member_id
  } : {})
});
const oauthPendingSchema = `
  -- OAuth PKCE pending states (google/github). Must survive Worker isolate
  -- eviction between the provider redirect and the callback, so they live in
  -- SQLite instead of server memory. Short-lived (10min); pruned on write.
  CREATE TABLE IF NOT EXISTS oauth_pending_states (
    state_hash TEXT PRIMARY KEY,
    provider TEXT NOT NULL CHECK(provider IN ('google','github')),
    slot_token TEXT NOT NULL,
    expected_revision INTEGER NOT NULL CHECK(expected_revision>=0),
    verifier TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    link INTEGER NOT NULL DEFAULT 0 CHECK(link IN (0,1)),
    used INTEGER NOT NULL DEFAULT 0 CHECK(used IN (0,1)),
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS oauth_pending_states_expires ON oauth_pending_states(expires_at);
`;

const invitationSchema = `
  CREATE TABLE IF NOT EXISTS account_credentials (
    hash TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id),
    account_auth_epoch INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0,1)),
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS account_credential_account ON account_credentials(account_id);
  CREATE TABLE IF NOT EXISTS account_session_slots (
    hash TEXT PRIMARY KEY,
    revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0),
    account_id TEXT REFERENCES accounts(id),
    account_auth_epoch INTEGER,
    parent_credential_hash TEXT REFERENCES account_credentials(hash),
    expires_at INTEGER NOT NULL,
    authenticated_until INTEGER,
    created_at INTEGER NOT NULL,
    CHECK(
      (account_id IS NULL AND account_auth_epoch IS NULL AND parent_credential_hash IS NULL AND authenticated_until IS NULL)
      OR
      (account_id IS NOT NULL AND account_auth_epoch IS NOT NULL AND parent_credential_hash IS NOT NULL AND authenticated_until IS NOT NULL AND authenticated_until<=expires_at)
    )
  );
  CREATE INDEX IF NOT EXISTS account_session_slot_account ON account_session_slots(account_id);
  ${oauthPendingSchema}
  CREATE TABLE IF NOT EXISTS membership_invitations (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE CHECK(length(token_hash)=64),
    room_id TEXT NOT NULL REFERENCES rooms(id),
    intended_account_id TEXT NOT NULL REFERENCES accounts(id),
    intended_member_id TEXT NOT NULL,
    intended_display_name TEXT NOT NULL,
    intended_role TEXT NOT NULL CHECK(intended_role IN ('moderator','member','guest')),
    intended_permissions_json TEXT NOT NULL CHECK(json_valid(intended_permissions_json) AND json_type(intended_permissions_json)='array'),
    role_policy_version INTEGER NOT NULL CHECK(role_policy_version=${INVITATION_ROLE_POLICY_VERSION}),
    issuer_account_id TEXT REFERENCES accounts(id),
    issuer_member_id TEXT NOT NULL,
    issuer_account_auth_epoch INTEGER CHECK((issuer_account_id IS NULL) = (issuer_account_auth_epoch IS NULL)),
    issuer_member_revision INTEGER NOT NULL,
    issue_request_id TEXT NOT NULL,
    issue_fingerprint TEXT NOT NULL CHECK(length(issue_fingerprint)=64),
    revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0),
    status TEXT NOT NULL CHECK(status IN ('pending','accepted','revoked')),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    accepted_at INTEGER,
    accepted_by_account_id TEXT REFERENCES accounts(id),
    redemption_id TEXT,
    joined_event_id TEXT UNIQUE REFERENCES events(id),
    revoked_at INTEGER,
    revoked_by_account_id TEXT REFERENCES accounts(id),
    revoked_by_member_id TEXT,
    revoke_reason TEXT,
    CHECK(expires_at>created_at),
    CHECK(
      (status='pending' AND revision=0 AND accepted_at IS NULL AND accepted_by_account_id IS NULL AND redemption_id IS NULL AND joined_event_id IS NULL AND revoked_at IS NULL AND revoked_by_account_id IS NULL AND revoked_by_member_id IS NULL AND revoke_reason IS NULL)
      OR
      (status='accepted' AND revision=1 AND accepted_at IS NOT NULL AND accepted_by_account_id=intended_account_id AND redemption_id IS NOT NULL AND joined_event_id IS NOT NULL AND revoked_at IS NULL AND revoked_by_account_id IS NULL AND revoked_by_member_id IS NULL AND revoke_reason IS NULL)
      OR
      (status='revoked' AND revision=1 AND accepted_at IS NULL AND accepted_by_account_id IS NULL AND redemption_id IS NULL AND joined_event_id IS NULL AND revoked_at IS NOT NULL AND revoked_by_member_id IS NOT NULL AND revoke_reason IS NOT NULL)
      -- v36: revoked_by_account_id is NULL when the revoking owner acted on
      -- an accountless identity bearer (agent-owned room); the member id and
      -- the journal audit event carry the authority, mirroring the v35
      -- agent-issuer pattern for issuer_account_id.
    )
  );
  CREATE UNIQUE INDEX IF NOT EXISTS membership_invitation_issue_request ON membership_invitations(room_id,issuer_account_id,issue_request_id);
  CREATE UNIQUE INDEX IF NOT EXISTS membership_invitation_agent_issue_request ON membership_invitations(room_id,issuer_member_id,issue_request_id) WHERE issuer_account_id IS NULL;
  CREATE INDEX IF NOT EXISTS membership_invitation_target ON membership_invitations(room_id,intended_account_id,intended_member_id);
  CREATE TABLE IF NOT EXISTS membership_invitation_events (
    invitation_id TEXT NOT NULL REFERENCES membership_invitations(id),
    sequence INTEGER NOT NULL CHECK(sequence>0),
    type TEXT NOT NULL CHECK(type IN ('issued','accepted','revoked')),
    actor_account_id TEXT REFERENCES accounts(id),
    actor_member_id TEXT,
    actor_auth_epoch INTEGER,
    actor_session_revision INTEGER,
    invitation_revision INTEGER NOT NULL,
    at INTEGER NOT NULL,
    room_event_id TEXT REFERENCES events(id),
    reason TEXT,
    PRIMARY KEY(invitation_id,sequence)
  );
  CREATE TRIGGER IF NOT EXISTS membership_invitation_scope_immutable
    BEFORE UPDATE OF token_hash,room_id,intended_account_id,intended_member_id,intended_display_name,intended_role,intended_permissions_json,role_policy_version,issuer_account_id,issuer_member_id,issuer_account_auth_epoch,issuer_member_revision,issue_request_id,issue_fingerprint,created_at,expires_at
    ON membership_invitations BEGIN SELECT RAISE(ABORT,'invitation scope is immutable'); END;
  CREATE TRIGGER IF NOT EXISTS membership_invitation_events_append_only_update BEFORE UPDATE ON membership_invitation_events BEGIN SELECT RAISE(ABORT,'invitation audit is append-only'); END;
  CREATE TRIGGER IF NOT EXISTS membership_invitation_events_append_only_delete BEFORE DELETE ON membership_invitation_events BEGIN SELECT RAISE(ABORT,'invitation audit is append-only'); END;
`;
const compact = state => ({ ...state, eventLog: [], seenEvents: {}, seenIdempotencyKeys: {} });
const sessionEventMatchesRequest = (event, request) => event?.data?.workItemId === request.workItemId
  && (request.action === "request_stop" ? event.type === T.SESSION_STOP_REQUESTED
    : event.type === T.SESSION_STARTED ? request.status === "processing"
      : (event.type === T.SESSION_STATUS_CHANGED || event.type === T.SESSION_STOPPED) && event.data.status === request.status)
  && (event?.data?.environment ?? null) === (request.environment ?? null)
  && JSON.stringify(event?.data?.outputs ?? null) === JSON.stringify(request.outputs ?? null);
// Platform differences stay at the database boundary; identity, invitation and
// command rules below are shared by every runtime. The default remains Node.
const nodeReadTransactions = new WeakSet();
const nodeStorage = {
  version: db => db.prepare("PRAGMA user_version").get().user_version,
  setVersion: (db, version) => db.exec(`PRAGMA user_version=${version}`),
  hasSchema: db => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' LIMIT 1").get()),
  changes: db => db.prepare("SELECT total_changes() AS n").get().n,
  configure(db, readOnly) {
    db.exec(readOnly ? "PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;"
      : "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000;");
  },
  registerWriter, installWriterFence, verifyWriterFence,
  transaction(db, fn, readOnly) {
    if (db.isTransaction) {
      if (!readOnly && nodeReadTransactions.has(db)) throw new Error("Cannot write inside a read-only transaction");
      return fn();
    }
    const queryOnly = readOnly ? db.prepare("PRAGMA query_only").get().query_only : null;
    db.exec(readOnly ? "BEGIN" : "BEGIN IMMEDIATE");
    try {
      if (readOnly) { db.exec("PRAGMA query_only=ON"); nodeReadTransactions.add(db); }
      const result = fn(); db.exec("COMMIT"); return result;
    }
    catch (error) {
      // SQLITE_FULL and I/O failures already rolled the transaction back;
      // a second ROLLBACK would replace the real error with "no transaction".
      if (db.isTransaction) { try { db.exec("ROLLBACK"); } catch { /* already rolled back */ } }
      throw error;
    }
    finally { if (readOnly) { nodeReadTransactions.delete(db); db.exec(`PRAGMA query_only=${queryOnly}`); } }
  }
};
const work = "workItemId expectedRevision";
const shapes = {
  [T.ROOM_CHARTER_UPDATED]: "expectedRevision purpose outputs boundaries escalation",
  [T.ROOM_POLICY_SET]: ROOM_POLICY_FIELDS.join(" "),
  [T.ROOM_SPEND_ALLOWANCE_SET]: "allowanceCents periodDays",
  [T.ROOM_TRUST_SET]: "enabled",
  [T.ROOM_ARCHIVED]: "reason",
  [T.OWNERSHIP_TRANSFERRED]: "toMemberId reason",
  [T.MEMBER_ADDED]: "memberId displayName kind permissions accountableHumanId identityId agentType referredBy",
  [T.MEMBER_ACCESS_CHANGED]: "memberId expectedMemberRevision permissions active",
  [T.MEMBER_STATUS_UPDATED]: "memberId message",
  [T.NOTIFICATION_PREFERENCES_SET]: "preferences",
  [T.MEMBER_MUTE_SET]: "memberId muted",
  [T.MESSAGE_POSTED]: `messageId body channelId workItemId replyToId toMemberId packetId basisRevision allowOlderBasis alsoSendToChannel ${REPLY_FIELDS.join(" ")}`,
  [T.MESSAGE_EDITED]: "messageId body expectedMessageRevision",
  [T.MESSAGE_DELETED]: "messageId expectedMessageRevision reason",
  [T.REPLY_REQUEST_CANCELLED]: "requestMessageId expectedRequestRevision reason",
  [T.MESSAGE_REACTION_SET]: "messageId reaction active",
  ...PIN_COMMAND_SHAPES,
  [T.CHANNEL_CREATED]: "channelId name",
  [T.CHANNEL_RENAMED]: "channelId name",
  [T.CHANNEL_ARCHIVED]: "channelId",
  [T.WORK_PROPOSED]: "workItemId title definitionOfDone accountableMemberId verifierMemberId independentVerificationRequired ownerDecisionRequired humanDecisionMakerId mode sourceMessageId labels",
  [T.WORK_ACCEPTED]: work,
  [T.WORK_HELP_UPDATED]: `${work} expectedHelpRevision status scope expiresAt`,
  [HELP_OFFER_OPENED]: `${work} offerId expectedHelpRevision helpEventId plan`,
  [HELP_OFFER_UPDATED]: `${work} offerId expectedOfferRevision status reason expectedHelpRevision helpEventId externalActivityUnverified`,
  [T.WORK_STARTED]: `${work} resolvedBlocker`,
  [T.WORK_BLOCKED]: `${work} reason nextAction`,
  [T.WORK_BLOCKER_RESOLVED]: `${work} resolution`,
  [T.WORK_COMPLETED]: `${work} summary evidenceUrl evidenceVersion nextAction checksClaimed producerId externalProducer evidenceKind evidenceMessageId evidenceMessageEventId previousCompletionEventId segments signedEvidence`,
  [T.WORK_SUPERSEDED]: `${work} supersededByWorkItemId reason`,
  [T.WORK_HANDOFF_RECORDED]: `${work} doneSummary evidenceUrl evidenceVersion nextAction limitReason haltAll`,
  [T.WORK_HALT_CLEARED]: "memberId haltEventId note",
  [T.CLAIM_ACQUIRED]: `${work} repository ref paths expiresAt`,
  [T.CLAIM_RELEASED]: work,
  [T.CLAIM_RENEWED]: `${work} progressMessageId expiresAt`,
  [T.VERIFICATION_RECORDED]: `${work} result completionEventId evidenceVersion summary nextAction`,
  [T.OWNER_DECISION_RECORDED]: `${work} decision completionEventId evidenceVersion reason sourceMessageId`,
  [T.DECISION_RECORDED]: "sourceMessageId statement note",
  [T.SESSION_STARTED]: `${work} budget environment`,
  [T.SESSION_STATUS_CHANGED]: `${work} status spendCents rounds toolCalls suspendReason resumeApproved`,
  [T.SESSION_STOP_REQUESTED]: work,
  [T.SESSION_STOPPED]: `${work} status spendCents rounds toolCalls budgetEnforced reason limit outputs`,
  [T.CAPABILITIES_ADVERTISED]: "capabilities",
  "bond.propose": "to scopes note",
  "bond.accept": "bondId scopes",
  "bond.decline": "bondId",
  "bond.revoke": "bondId",
  "bond.list": "",
  [T.DM_POSTED]: "to body messageId"
};

// W4-44 H2: the classified command surface, exported for the
// action-class completeness test (every key must carry a class).
export const COMMAND_TYPES = Object.freeze(Object.keys(shapes));

// An unknown type names the closest real types, so "message.post" or
// "message.reacted" points at message.posted / message.reaction_set
// instead of a bare "invalid type".
function unknownCommandTypeMessage(type) {
  const given = typeof type === "string" ? type.slice(0, 64) : "";
  const family = given.split(".")[0];
  const distance = (a, b) => {
    const row = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      let prev = row[0]; row[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const next = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
        prev = row[j]; row[j] = next;
      }
    }
    return row[b.length];
  };
  const types = Object.keys(shapes);
  const sameFamily = family ? types.filter(t => t.split(".")[0] === family) : [];
  // Prefer a same-family type sharing the verb's stem (reacted -> reaction_set).
  const stem = (given.split(".")[1] ?? "").slice(0, 5);
  const stemmed = stem.length >= 4 ? sameFamily.find(t => t.split(".")[1].startsWith(stem)) : undefined;
  const closest = stemmed ?? (given ? [...types].sort((a, b) => distance(given, a) - distance(given, b))[0] : null);
  const suggestion = closest && (closest === stemmed || distance(given, closest) <= Math.max(3, Math.floor(closest.length / 3))) ? ` Did you mean "${closest}"?` : "";
  const listed = sameFamily.length ? ` ${family} types: ${sameFamily.join(", ")}.` : ` Types include ${types.filter(t => t.startsWith("message.")).join(", ")}.`;
  return `Unknown command type${given ? ` "${given}"` : ""}.${suggestion}${listed}`;
}

export function validateCommand(command) {
  if (!command || Array.isArray(command) || typeof command !== "object" || Object.keys(command).some(k => !["id", "type", "data", "causationId"].includes(k))) fail(422, "invalid_command", "Supply only id, type, data, and optional causationId");
  if (!validId(command.id)) fail(422, "invalid_command", "Invalid command id or type");
  if (!Object.hasOwn(shapes, command.type)) fail(422, "invalid_command", unknownCommandTypeMessage(command.type));
  try { classifyCommand(command.type); } catch { fail(422, "invalid_command", "Unclassified command type"); }
  if (command.causationId != null && !validId(command.causationId)) fail(422, "invalid_command", "Invalid causationId");
  if (!command.data || Array.isArray(command.data) || typeof command.data !== "object") fail(422, "invalid_command", "Data must be an object");
  // Agents guess data.text. Name data.body before the generic unexpected-field refusal.
  const messageBody = "message.posted requires data.body (a string), not text";
  if (command.type === T.MESSAGE_POSTED && Object.hasOwn(command.data, "text")) fail(422, "invalid_command", messageBody);
  const allowed = shapes[command.type].split(" ");
  for (const [name, value] of Object.entries(command.data)) {
    if (!allowed.includes(name)) fail(422, "invalid_command", `Unexpected field: ${name}`);
    if (value === null) continue;
    const type = ["expectedRevision", "expectedMemberRevision", "expectedMessageRevision", "basisRevision", "expectedRequestRevision", "contextSequence", "expectedHelpRevision", "expectedOfferRevision", "spendCents", "allowanceCents", "periodDays", "rounds", "toolCalls"].includes(name) ? "number" : ["active", "independentVerificationRequired", "ownerDecisionRequired", "allowOlderBasis", "externalActivityUnverified", "haltAll", "budgetEnforced", "muted", "resumeApproved", "alsoSendToChannel", "enabled", ...ROOM_POLICY_FIELDS].includes(name) ? "boolean" : ["permissions", "paths", "checksClaimed", "capabilities", "segments", "labels", "scopes"].includes(name) ? "array" : name === "outputs" ? "outputs" : ["preferences", "budget", "signedEvidence"].includes(name) ? "object" : "string";
    if (type === "array" ? !Array.isArray(value) : type === "object" ? !(value && typeof value === "object" && !Array.isArray(value)) : type === "outputs" ? !(typeof value === "string" || (Array.isArray(value) && value.every(v => typeof v === "string"))) : typeof value !== type) fail(422, "invalid_command", `Invalid field: ${name}`);
  }
  if (command.type === T.MESSAGE_POSTED && (typeof command.data.body !== "string" || !command.data.body.trim())) fail(422, "invalid_command", messageBody);
  const messageBodyCommand = command.type === T.MESSAGE_POSTED || command.type === T.MESSAGE_EDITED;
  if (messageBodyCommand && typeof command.data.body === "string" && command.data.body.length > MAX_MESSAGE_BODY_CHARS)
    fail(422, "invalid_command", `body must be at most ${MAX_MESSAGE_BODY_CHARS} characters`);
  // Message commands carry a long body. Every other command stays at 16 KiB.
  if (Buffer.byteLength(JSON.stringify(command)) > (messageBodyCommand ? MAX_MESSAGE_COMMAND_BYTES : 16384)) fail(413, "too_large", "Command is too large");
  if (command.type === T.MESSAGE_POSTED) {
    try { replyPostMode(command.data); } catch (error) { fail(422, "invalid_command", error.message); }
  }
  // F2: every new owner decision must cite the public room message carrying
  // its rationale. The reducer validates the cited message when present so
  // pre-requirement history still replays; the command gate below is what
  // makes the source mandatory going forward.
  if (command.type === T.OWNER_DECISION_RECORDED
    && (typeof command.data.sourceMessageId !== "string" || !command.data.sourceMessageId.trim())) {
    fail(422, "decision_source_required", "Post the rationale in the room first, then record the decision with its message id");
  }
  // Lease-renewal check-ins: every renewal must cite the holder's public
  // progress message. The reducer validates the cited message when present;
  // the command gate below is what makes the citation mandatory going forward.
  if (command.type === T.CLAIM_RENEWED
    && (typeof command.data.progressMessageId !== "string" || !command.data.progressMessageId.trim())) {
    fail(422, "claim_renewal_source_required", "Post a progress update in the room first, then renew the claim with its message id");
  }
  if (command.type === T.WORK_HELP_UPDATED) {
    try { validateHelpData(command.data); } catch (error) { fail(422, "invalid_command", error.message); }
  }
  if ([HELP_OFFER_OPENED, HELP_OFFER_UPDATED].includes(command.type)) {
    try { validateHelpOfferData(command.type, command.data); } catch (error) { fail(422, "invalid_command", error.message); }
  }
  if (command.type === T.SESSION_STATUS_CHANGED && !isSessionStatus(command.data.status)) {
    fail(422, "invalid_command", "Choose a session status");
  }
  if (command.type === T.SESSION_STOPPED && !isTerminalSession(command.data.status)) {
    fail(422, "invalid_command", "Stopped session status must be done or failed");
  }
}

// RC-2026-09-18-052: the agent inbox is the agent's to-do list, so every
// item type names its next action. The most common first move is replying
// to a DM (the sender's memberId goes back into toMemberId on the
// message.posted command); assignments and routing mentions point at
// their own read/resolve routes. An empty inbox says what it will carry.
const inboxNext = (roomId, directMessages, assignments, mentions, directMentions = [], bondProposals = [], peerMessages = []) => {
  const steps = [];
  if (directMentions.length > 0) {
    const latest = directMentions.find(mention => mention.state !== "timed_out") ?? directMentions[0];
    const timing = latest.state === "timed_out" ? "overdue " : "";
    const outcome = latest.state === "timed_out"
      ? "Replying removes it from your waiting inbox; the timeout remains in history."
      : "Replying to that message marks the mention responded.";
    steps.push(Object.freeze({
      action: "reply-mention",
      method: "POST",
      path: `/api/rooms/${roomId}/commands`,
      description: latest.private
        ? `Answer the ${timing}private @mention from member ${latest.from} privately: send { id: <uuid>, type: "message.posted", data: { messageId: <uuid>, body: "your answer", replyToId: "${latest.replyToId}", toMemberId: "${latest.replyToMemberId}" } }. Leaving out toMemberId would post your answer to the whole room. ${outcome} Send your identity secret as the Bearer token.`
        : `Answer the ${timing}@mention from member ${latest.from}: send { id: <uuid>, type: "message.posted", data: { messageId: <uuid>, body: "your answer", replyToId: "${latest.replyToId}" } }. ${outcome} An unrelated post does not. Send your identity secret as the Bearer token.`,
    }));
  }
  if (directMessages.length > 0) {
    const latest = directMessages[0];
    steps.push(Object.freeze({
      action: "reply-dm",
      method: "POST",
      path: `/api/rooms/${roomId}/commands`,
      description: `Reply to the DM from member ${latest.from}: send { id: <uuid>, type: "message.posted", data: { messageId: <uuid>, body: "your reply", toMemberId: "${latest.from}" } }. Send your identity secret as the Bearer token.`,
    }));
  }
  if (assignments.length > 0) {
    steps.push(Object.freeze({
      action: "read-assignments",
      method: "GET",
      path: `/api/rooms/${roomId}/collab/assignments`,
      description: "List your open work assignments with full thread context.",
    }));
  }
  if (mentions.length > 0) {
    const routingId = mentions[0].routingId;
    steps.push(Object.freeze({
      action: "resolve-mention",
      method: "POST",
      path: `/api/rooms/${roomId}/collab/routing/${routingId}/resolve`,
      description: "Mark the routed @agent mention as handled once you have acted on it.",
    }));
  }
  if (bondProposals.length > 0) {
    const latest = bondProposals[0];
    steps.push(Object.freeze({
      action: "accept-bond",
      method: "POST",
      path: `/api/rooms/${roomId}/commands`,
      description: `Accept bond ${latest.bondId} from ${latest.fromIdentityId}: send { id: <uuid>, type: "bond.accept", data: { bondId: "${latest.bondId}" } }. Accepted scopes cannot exceed the proposal. Friend content stays untrusted.`,
    }));
  }
  if (peerMessages.length > 0) {
    const latest = peerMessages[0];
    steps.push(Object.freeze({
      action: "reply-peer-dm",
      method: "POST",
      path: `/api/rooms/${roomId}/commands`,
      description: `Reply on the peer DM (untrusted friend content): send { id: <uuid>, type: "dm.posted", data: { messageId: <uuid>, body: "your reply", to: "${latest.fromIdentityId}" } }. Requires an active bond with peer.dm.`,
    }));
  }
  if (steps.length === 0) {
    steps.push(Object.freeze({
      action: "watch-inbox",
      description: "Your inbox is empty. It will carry direct @mentions waiting for your answer, targeted room DMs, peer DMs from bonded agents, bond proposals, work assignments, and open @agent routing mentions.",
    }));
  }
  return steps;
};

// RC-2026-09-18-054: presence guidance — who is around and how to reach
// them (DM via the message.posted command with toMemberId).
const presenceNext = (roomId, memberIds) => {
  if (memberIds.length > 0) {
    return [Object.freeze({
      action: "dm-member",
      method: "POST",
      path: `/api/rooms/${roomId}/commands`,
      description: `DM a member directly: send { id: <uuid>, type: "message.posted", data: { messageId: <uuid>, body: "hello", toMemberId: "${memberIds[0]}" } }. Send your identity secret as the Bearer token.`,
    })];
  }
  return [Object.freeze({
    action: "watch-presence",
    description: "Nobody is online right now. Presence lists online members and who is holding work sessions.",
  })];
};

// RC-2026-09-18-055: capabilities guidance — who can do the work and how
// to hand it over (thread assignment to a member).
const capabilitiesNext = (roomId, assignees) => {
  if (assignees.length > 0) {
    const first = assignees[0];
    return [Object.freeze({
      action: "delegate-work",
      method: "POST",
      path: `/api/rooms/${roomId}/collab/assignments`,
      description: `Assign a thread to ${first.id}: send { threadId: "<thread>", assignee: { kind: "${first.kind}", id: "${first.id}" } }. Send your identity secret as the Bearer token.`,
    })];
  }
  return [Object.freeze({
    action: "advertise-capabilities",
    description: "No members advertise capabilities yet. Members publish theirs with the capabilities.advertised command.",
  })];
};

// RC-2026-09-18-057: work-sessions guidance — seeing open work is half
// the loop; the other half is the atomic claim (set_status -> processing).
const workSessionsNext = (roomId, sessions) => {
  if (sessions.length > 0) {
    const first = sessions[0];
    return [Object.freeze({
      action: "claim-session",
      method: "POST",
      path: `/api/rooms/${roomId}/work-sessions`,
      description: `Claim "${first.workItemId}": send { requestId: "<uuid>", workItemId: "${first.workItemId}", expectedRevision: ${first.revision ?? 0}, action: "set_status", status: "processing" }. Send your identity secret as the Bearer token.`,
    })];
  }
  return [Object.freeze({
    action: "register-work-item",
    method: "POST",
    path: `/api/rooms/${roomId}/work-claims`,
    description: "No work sessions are open. Register a work item first: POST { id: \"<slug>\", title: \"<task>\", note: \"<context>\" } to this path, then claim it with the claim-session action above.",
  })];
};

// Agent members a message.posted would wake: @mentions resolved the same way
// as wake-on-mention (member id and display name, not identity aliases) plus
// a DM addressed to an agent. Order is first appearance. The sender is never a target.
function agentWakeTargets(state, senderMemberId, data) {
  const members = state?.members ?? {};
  const targets = new Map();
  const agents = Object.fromEntries(Object.entries(members).filter(([, member]) => member?.kind === "agent"));
  const body = typeof data?.body === "string" ? data.body : "";
  for (const memberId of resolveMentionTargetsInText(agents, {}, body, senderMemberId)) {
    if (!targets.has(memberId)) targets.set(memberId, "mention");
  }
  const dmId = typeof data?.toMemberId === "string" ? data.toMemberId : "";
  const dm = dmId ? members[dmId] : null;
  if (dm && dm.active !== false && dm.kind === "agent" && dmId !== senderMemberId && !targets.has(dmId)) {
    targets.set(dmId, "dm");
  }
  return targets;
}

function agentWakeTargetIds(state, senderMemberId, data) {
  return [...agentWakeTargets(state, senderMemberId, data).keys()];
}

export class RoomStore {
  constructor(filename, { now = () => Date.now(), readOnly = false, database, storagePlatform = nodeStorage, storageFailureThreshold = STORAGE_FAILURE_THRESHOLD, stitch = null } = {}) {
    if (!Number.isInteger(storageFailureThreshold) || storageFailureThreshold < 1) throw new Error("Storage failure threshold must be a positive integer");
    // Cross-channel thread stitching (task #19): stitch is the frozen
    // { salt, epoch, enabled, bindings } triple from stitchConfigFromEnv, or
    // null to leave the stitcher inert (the default: no stitch rows, no
    // stitched views, import untouched). Inert null is the normal boot
    // without STITCHING_ENABLED + a valid salt.
    if (stitch !== null && !(typeof stitch === "object" && Buffer.isBuffer(stitch.salt) && stitch.salt.length === 32
      && typeof stitch.epoch === "string" && /^v[0-9]+$/.test(stitch.epoch) && stitch.enabled === true)) {
      throw new Error("stitch must be null or a stitchConfigFromEnv() triple");
    }
    // Consecutive storage refusals; readiness (server/http.mjs) turns 503 at
    // the threshold and recovers on the next committed write.
    this.storageFailureThreshold = storageFailureThreshold;
    this.storageFailures = 0;
    this.now = now;
    this.roomFlood = createRoomFloodGuard({ now: () => this.now() });
    this.db = database ?? new DatabaseSync(filename, { readOnly });
    this.storagePlatform = storagePlatform;
    this.shareLinks = new ShareLinks(this);
    this.identities = new AgentIdentities(this);
    this.delegation = new MembershipDelegation(this);
    this.keyRegistry = new AgentKeyRegistry(this); // Slice 9: Ed25519 public-key registry (bound at identity issuance).
    this.invites = new AgentInvites(this);
    this.referralInvites = new ReferralInvites(this);
    this.referrals = new Referrals(this);
    this.accountLogins = new AccountLoginMethods(this);
    this.reminders = new Reminders(this);
    this.notifications = new Notifications(this);
    this.moderation = new Moderation(this);
    this.wakeQueue = new WakeQueue(this);
    this.attention = new Attention(this);
    this.nextActions = new NextActions(this); // RC-2026-09-25-911: ranked next-actions (private dismissals/suppressions).
    this.readOnly = readOnly;
    this.agentConnections = new AgentConnections(this);
    this.guestAgentLinks = new GuestAgentLinks(this);
    this.guestInvites = new GuestInvites(this);
    this.webFetch = new WebFetch(this);
    this.webResearch = new WebResearch(this); // RC-2026-09-24-310: knowledge router (additive)
    this.replyRequests = new ReplyRequests(this);
    this.requestRuns = new RequestRuns(this);
    this.dmConsents = new DmConsents(this);
    this.bonds = new Bonds(this);
    this.threadMutes = new ThreadMutes(this); // Per-thread mutes (private side table).
    this.roomAttachments = new RoomAttachmentBytes(this); // room_attachments bytes (stage, list, download, discard, commit).
    this.inboxAttachments = new InboxAttachmentBytes(this); // identity-scoped inbox attachment bytes (put, list, get, discard).
    this.publicFace = new PublicFace(this);
    this.roomDirectory = new RoomDirectory(this);
    this.inbox = new Inbox(this, { stitch });
    this.email = new EmailImport(this);
    this.connections = this.email; // Every channel connection (email, Telegram) shares the importer.
    this.channelUpdates = new ChannelUpdateJournal(this); // B20: durable webhook update journal.
    this.spamQuarantine = new SpamQuarantineJournal(this); // Durable spam-guard quarantine journal (PR #554 queue, now restart-safe).
    this.jevShadow = new JevShadowJournal(this); // Jev-harness shadow-decision journal (docs/JEV-GATES.md): append-only measurement, never enforced.
this.quarantineSplits = new QuarantineThreadSplits(this); // Thread-split records for the quarantine review UI (owner "split" action).
this.slaBreachAlerts = new SlaBreachAlertJournal(this); // Task 26: durable in-app sink for SLA-breach deliver.
    this.handoffs = new InboxHandoffJournal(this); // Task 23: durable agent handoff journal.
    this.handoffEnvelopes = new HandoffEnvelopeJournal(this); // RC-2026-09-19-062: typed handoff envelope journal.
    this.collab = new InboxCollabStore(this); // Lane C inbox collaboration journals (task RC-2026-09-18-011).
    this.agentPlugin = new AgentPluginStore(this); // Lane D: scoped API keys, directory cards, webhook subs (RC-2026-09-18-010).
    this.agentHeartbeats = new AgentHeartbeats(this); // RC-2026-09-18-051: wakeable agent presence (durable host heartbeats + wake queue).
    this.landQueue = new LandQueue(this);
    this.membersDirectory = new MembersDirectory(this); // RC-2026-09-24-202: members directory + evidence-backed skill cards.
    this.bountyEscrow = new BountyEscrow(this, { now: () => this.now() }); // Escrowed bounties, agent work exchange slice 1.
    const version = this.storagePlatform.version(this.db);
    // Supported schema versions are the contiguous range 0..STORE_SCHEMA_VERSION.
    // A hand-maintained list dropped v26 when the version bumped to 27,
    // which 500'd every room whose Durable Object was still on v26.
    const supported = new Set([...Array(STORE_SCHEMA_VERSION + 1).keys()]);
    const hasSchema = version === 0 && this.storagePlatform.hasSchema(this.db);
    if (!supported.has(version) || hasSchema) {
      this.db.close();
      throw new Error(version > STORE_SCHEMA_VERSION ? "Database schema is newer than this service" : "Database schema version is unsupported");
    }
    if (readOnly) {
      try {
        if (version !== STORE_SCHEMA_VERSION) throw new Error(`Read-only invitation audit requires schema v${STORE_SCHEMA_VERSION}; migrate a backed-up database through the service first`);
        this.storagePlatform.configure(this.db, true);
        this.storagePlatform.verifyWriterFence(this.db);
        this.verifyInvitationAudit();
        this.shareLinks.verify();
        this.reminders.verifySchema();
        // Wake queue (W4-45) and attention preference (W4-46) tables are purely
        // additive at v27, so a backup taken before them is still a valid v27
        // file. Read-only never migrates, so verify them only when present.
        this.wakeQueue.verifySchema({ allowAbsent: true });
        this.requestRuns.verifySchema({ allowAbsent: true });
        this.wakeQueue.verifyPauseSchema({ allowAbsent: true });
        this.attention.verifySchema({ allowAbsent: true });
        this.nextActions.verifySchema({ allowAbsent: true }); // RC-2026-09-25-911: next-action tables additive, read-only never migrates.
        this.agentConnections.verify();
        this.verifyHelpHistory();
        this.inbox.verify();
        // Stitch tables are additive at v34: a backup taken before them is
        // still a valid file. Read-only never migrates, so verify them only
        // when present.
        this.inbox.stitcher.verifySchema({ allowAbsent: true });
        this.email.verify();
        // The webhook update journal (B20) is purely additive at v27, so a
        // backup taken before it is still a valid v27 file; read-only never
        // migrates, so verify it only when present.
        this.channelUpdates.verifySchema({ allowAbsent: true });
        this.handoffs.verifySchema({ allowAbsent: true }); // Task 23: purely additive, like the channel journal.
        this.handoffEnvelopes.verifySchema({ allowAbsent: true }); // RC-2026-09-19-062: typed envelopes additive, read-only never migrates.
        this.collab.verifySchema({ allowAbsent: true }); // Lane C collab tables: purely additive, read-only never migrates.
        this.agentPlugin.verifySchema({ allowAbsent: true }); // Lane D plug-in tables: additive, read-only never migrates.
        this.agentHeartbeats.verifySchema({ allowAbsent: true }); // RC-2026-09-18-051: heartbeat tables additive, read-only never migrates.
        this.inboxAttachments.verifySchema({ allowAbsent: true }); // Identity inbox attachment bytes: additive, read-only never migrates.
        this.guestInvites.verifySchema({ allowAbsent: true }); // RC-2026-09-23-100: guest-invite tables additive, read-only never migrates.
        this.webFetch.verifySchema({ allowAbsent: true }); // RC-2026-09-23-102: web-fetch cache/journal additive, read-only never migrates.
        this.webResearch.verifySchema({ allowAbsent: true }); // RC-2026-09-24-310: research journal additive, read-only never migrates.
        this.quarantineSplits.verifySchema({ allowAbsent: true }); // Quarantine thread splits: additive, read-only never migrates.
        verifyRoomLifecycle(this);
        this.moderation.verifySchema({ allowAbsent: true }); // E4 message reports: additive at v27 as well.
        this.bountyEscrow.verifySchema({ allowAbsent: true }); // Escrowed bounties: additive, read-only never migrates.
        return;
      } catch (error) { this.db.close(); throw error; }
    }
    this.storagePlatform.configure(this.db, false);
    this.storagePlatform.registerWriter(this.db);
    try { this.transaction(() => {
    // Reread under the write lock: another startup may have upgraded while we waited.
    if (this.storagePlatform.version(this.db) !== version) throw new Error("Database changed during startup; retry with the current service");
    if (version >= 6) this.storagePlatform.verifyWriterFence(this.db, version);
    if (version > 0 && version < 12) {
      // Legacy fixture import allowed ignored scalar fields. Never reinterpret a
      // previously stored policy marker, even when it is null or behind a checkpoint.
      const collision = this.db.prepare("SELECT 1 FROM events WHERE json_extract(body,'$.type')='message.posted' AND json_type(body,'$.data.requestPolicyVersion') IS NOT NULL LIMIT 1").get()
        || this.db.prepare("SELECT 1 FROM rooms WHERE json_type(projection,'$.replyRequests') IS NOT NULL LIMIT 1").get();
      const checkpointCollision = version >= 2 && this.db.prepare("SELECT 1 FROM projection_checkpoints WHERE json_type(projection,'$.replyRequests') IS NOT NULL LIMIT 1").get();
      if (collision || checkpointCollision) throw new Error("Legacy reply request marker requires operator reconciliation");
    }
    if (version > 0 && version < 13) {
      const collision = table => this.db.prepare(`SELECT 1 FROM ${table}, json_each(projection,'$.workItems') AS item WHERE json_type(item.value,'$.helpWanted') IS NOT NULL LIMIT 1`).get();
      if (collision("rooms") || version >= 2 && collision("projection_checkpoints")
        || this.db.prepare("SELECT 1 FROM events WHERE json_extract(body,'$.type')='work.help_updated' LIMIT 1").get()) throw new Error("Legacy help invitation field requires operator reconciliation");
    }
    if (version > 0 && version < 14) {
      const collision = table => this.db.prepare(`SELECT 1 FROM ${table} WHERE json_type(projection,'$.helpOffers') IS NOT NULL LIMIT 1`).get();
      if (collision("rooms") || version >= 2 && collision("projection_checkpoints")
        || this.db.prepare("SELECT 1 FROM events WHERE json_extract(body,'$.type') IN ('work.help_offer_opened','work.help_offer_updated') LIMIT 1").get()) throw new Error("Legacy help offer field requires operator reconciliation");
    }
    if (version === 0) { this.db.exec(`
      CREATE TABLE rooms (id TEXT PRIMARY KEY, sequence INTEGER NOT NULL, projection TEXT NOT NULL, archived_at TEXT);
      CREATE TABLE events (room_id TEXT NOT NULL REFERENCES rooms(id), sequence INTEGER NOT NULL, id TEXT NOT NULL UNIQUE, body TEXT NOT NULL, PRIMARY KEY(room_id, sequence));
      CREATE TABLE commands (room_id TEXT NOT NULL REFERENCES rooms(id), actor_id TEXT NOT NULL, id TEXT NOT NULL, fingerprint TEXT NOT NULL, sequence INTEGER NOT NULL, PRIMARY KEY(room_id, actor_id, id), FOREIGN KEY(room_id, sequence) REFERENCES events(room_id, sequence));
      CREATE TABLE accounts (id TEXT PRIMARY KEY, active INTEGER NOT NULL CHECK(active IN (0,1)), revision INTEGER NOT NULL, auth_epoch INTEGER NOT NULL, origin TEXT NOT NULL, created_at INTEGER NOT NULL, display_name TEXT, avatar_url TEXT, onboarded INTEGER NOT NULL DEFAULT 1, ever_had_room INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE member_accounts (room_id TEXT NOT NULL REFERENCES rooms(id), member_id TEXT NOT NULL, account_id TEXT NOT NULL REFERENCES accounts(id), origin TEXT NOT NULL, PRIMARY KEY(room_id,member_id), UNIQUE(room_id,account_id));
      CREATE TABLE account_access_events (account_id TEXT NOT NULL REFERENCES accounts(id), revision INTEGER NOT NULL, active INTEGER NOT NULL CHECK(active IN (0,1)), auth_epoch INTEGER NOT NULL, reason TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(account_id,revision));
      CREATE TABLE credentials (hash TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id), member_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('access','session')), parent_hash TEXT REFERENCES credentials(hash), expires_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, account_id TEXT REFERENCES accounts(id), account_auth_epoch INTEGER);
      CREATE INDEX credential_member ON credentials(room_id, member_id);
      CREATE INDEX credential_account ON credentials(account_id);
      CREATE TABLE cursors (room_id TEXT NOT NULL REFERENCES rooms(id), member_id TEXT NOT NULL, sequence INTEGER NOT NULL, PRIMARY KEY(room_id, member_id));
      CREATE TABLE projection_checkpoints (room_id TEXT PRIMARY KEY REFERENCES rooms(id), sequence INTEGER NOT NULL, projection TEXT NOT NULL);
      ${invitationSchema}
      ${agentIdentitySchema}
      ${accountLoginMethodsSchema}
      ${agentInviteSchema}
      ${referralInviteSchema}
      ${referralSchema}`);
      this.storagePlatform.setVersion(this.db, 4);
    }
    if (version > 0 && version < 26 && (
      this.db.prepare("SELECT 1 FROM events WHERE json_extract(body,'$.type')='work.completed' AND json_type(body,'$.data.externalProducer') IS NOT NULL LIMIT 1").get()
      || this.db.prepare("SELECT 1 FROM rooms,json_tree(rooms.projection) WHERE json_tree.key='externalProducer' LIMIT 1").get()
      || version >= 2 && this.db.prepare("SELECT 1 FROM projection_checkpoints,json_tree(projection_checkpoints.projection) WHERE json_tree.key='externalProducer' LIMIT 1").get()))
      throw new Error("Pre-v26 outside credit history requires operator reconciliation");
    this.repairProjectionProvenance({ upgradeV1: version === 1 });
    if (version === 1 || version === 2) this.migrateIdentityV3(version);
    if (version === 1 || version === 2 || version === 3) this.migrateInvitationsV4();
      if (version < 5) this.migrateInvitationJournalV5();
      if (version < 7) this.db.exec(shareLinkSchema);
      if (version < 8) this.db.exec(reminderSchema);
      if (version < 9) this.db.exec(agentConnectionSchema);
      if (version < 15) this.db.exec(inboxSchema);
      if (version < 18) this.db.exec(emailImportSchema);
      if (version < 21 && this.db.prepare("SELECT 1 FROM private_inbox_commands WHERE json_extract(request_json,'$.action') LIKE 'reply.%' OR json_type(receipt_json,'$.attempt') IS NOT NULL LIMIT 1").get())
        throw new Error("Pre-v21 reply history requires operator reconciliation");
      if (version < 22 && this.db.prepare("SELECT 1 FROM private_inbox_commands WHERE json_extract(request_json,'$.action') IN ('reply.observed','reply.review') OR json_type(receipt_json,'$.attempt.observation') IS NOT NULL OR json_type(receipt_json,'$.attempt.review') IS NOT NULL LIMIT 1").get())
        throw new Error("Pre-v22 reply review history requires operator reconciliation");
      if (version < 23 && this.db.prepare("SELECT 1 FROM private_inbox_commands WHERE json_extract(request_json,'$.action') LIKE 'reply.update.%' OR json_type(receipt_json,'$.update') IS NOT NULL LIMIT 1").get())
        throw new Error("Pre-v23 reply update history requires operator reconciliation");
      if (version < 24 && this.db.prepare("SELECT 1 FROM private_inbox_commands WHERE json_extract(request_json,'$.action')='reply.update.acknowledged' OR json_type(receipt_json,'$.update.acknowledgment') IS NOT NULL OR json_extract(receipt_json,'$.update.status')='update_acknowledged' LIMIT 1").get())
        throw new Error("Pre-v24 reply acknowledgment history requires operator reconciliation");
      if (version < 25 && this.db.prepare("SELECT 1 FROM private_inbox_commands WHERE json_extract(request_json,'$.action') IN ('reply.update.inspected','reply.update.review') OR json_type(receipt_json,'$.update.inspection') IS NOT NULL OR json_type(receipt_json,'$.update.review') IS NOT NULL OR json_type(receipt_json,'$.update.resolvedAt') IS NOT NULL OR json_extract(receipt_json,'$.update.status')='resolved' LIMIT 1").get())
        throw new Error("Pre-v25 reply resolution history requires operator reconciliation");
      if (version < 27) this.migrateAgentIdentitiesV27();
      // RC-2026-09-19-055: identity-secret revoked_at converges on existing
      // databases via ALTER TABLE; old rows backfill NULL and keep reading
      // as "not revoked". Follows the spam-quarantine column pattern (PR #562).
      ensureIdentitySecretSchema(this.db);
      // RC-2026-09-24-210: identity link codes (proof-of-possession for
      // identityId enrollment) converge the same additive way — IF NOT
      // EXISTS is idempotent, no schema version bump, intentionally
      // outside the writer fence (see unfencedAdditiveTables).
      ensureIdentityLinkCodeSchema(this.db);
      // Graduated autonomy tiers (#928 rescope): purely additive table —
      // IF NOT EXISTS is idempotent, no schema version bump. Replaces the
      // slice 1/3 agent_operator_controls table (module removed).
      ensureAutonomyTiersSchema(this.db);
      // RC-2026-09-19-078: account profile (display_name/avatar_url) and
      // onboarding flag converge the same additive way; no version bump.
      ensureAccountProfileSchema(this.db);
      // Integration map slice 9: the agent public-key registry is purely
      // additive — IF NOT EXISTS is idempotent, no schema version bump,
      // and the table is intentionally outside the writer fence (see
      // unfencedAdditiveTables). Applied here (not only in createRoomServer)
      // so store-only fixtures and the recovery audit see it.
      this.db.exec(agentKeyRegistrySchema);
      // RC-2026-09-23-106: agent browser sessions record the identity secret
      // hash at creation time. If the secret is rotated or revoked, sessions
      // minted with the old secret are rejected at authenticate() time.
      // Additive column; existing rows backfill NULL (no secret binding).
      if (!this.db.prepare("SELECT 1 FROM pragma_table_info('credentials') WHERE name='identity_secret_hash'").get()) {
        this.db.exec("ALTER TABLE credentials ADD COLUMN identity_secret_hash TEXT");
      }
      if (!this.db.prepare("SELECT 1 FROM pragma_table_info('rooms') WHERE name='archived_at'").get()) migrateRoomLifecycleV28(this);
      // v35: share-link and invitation issuer columns go nullable so an agent
      // room owner (no account) can be recorded honestly as the issuer.
      // SQLite cannot relax NOT NULL in place, so both tables are rebuilt.
      // Fresh databases are created in the v35 shape already; skip the
      // rebuild for them.
      if (version > 0 && version < 35) this.migrateShareLinkAgentIssuerV35();
      // v36: the revoked-state CHECK goes nullable for revoked_by_account_id
      // so an agent room owner (no account) can revoke invitations, not just
      // issue them (#597). SQLite cannot relax a CHECK in place, so the
      // invitation tables are rebuilt. Fresh databases are created in the
      // v36 shape already; skip the rebuild for them.
      if (version > 0 && version < 36) this.migrateInvitationAgentRevokeV36();
      // Short human invite codes alias share_links. After the v35 rebuild so
      // the FK targets the live table. Purely additive, no version bump,
      // intentionally outside the writer fence.
      this.db.exec(shareLinkCodeSchema);
      // Agent invite codes are purely additive (no data migration, no fence
      // impact), so no schema version bump: IF NOT EXISTS is idempotent here
      // and the v0 block above covers fresh databases.
      this.db.exec(agentInviteSchema);
      // Signed referral invites: purely additive (no data migration, no
      // fence impact); the ledger is written only by the mint/redeem paths
      // and holds no credential data (tokens are bearer strings, never
      // stored).
      this.db.exec(referralInviteSchema);
      // Backfill the cap for members admitted before this field existed. An
      // unmatched row stays NULL and the mint path refuses it fail-closed.
      const chainColumns = new Set(this.db.prepare("PRAGMA table_info(referral_chain_members)").all().map(c => c.name));
      if (!chainColumns.has("max_depth")) this.db.exec("ALTER TABLE referral_chain_members ADD COLUMN max_depth INTEGER");
      this.db.exec(`UPDATE referral_chain_members SET max_depth = (
        SELECT ri.max_depth FROM referral_invites ri
        WHERE ri.room_id = referral_chain_members.room_id
          AND ri.redeemed_member_id = referral_chain_members.member_id
          AND ri.status = 'redeemed' LIMIT 1
      ) WHERE max_depth IS NULL`);
      // Referral attribution (invite/access-request joins): purely additive —
      // no migration, no fence impact; referrals are only written by the join
      // paths, and the table holds no credential data.
      this.db.exec(referralSchema);
      // Wake queue rows are purely additive (no data migration, no fence
      // impact), so no schema version bump: IF NOT EXISTS is idempotent here.
      this.db.exec(wakeQueueSchema);
      // The pause surface (W4-48) is purely additive as well.
      this.db.exec(wakeQueuePauseSchema);
      // Attention preferences are purely additive as well (W4-46).
      this.db.exec(attentionSchema);
      // RC-2026-09-25-911: next-action dismissals/suppressions are purely
      // additive as well: IF NOT EXISTS is idempotent, no schema version bump.
      this.db.exec(nextActionsSchema);
      // RC-2026-09-18-051: wakeable agent presence — host heartbeats and the
      // wake-signal queue are purely additive as well: IF NOT EXISTS is
      // idempotent, no schema version bump.
      this.db.exec(agentHeartbeatSchema);
      // Land queue: purely additive, no schema version bump, outside the
      // writer fence. The table is the source of truth; land.updated events
      // are thin wake receipts and do not copy the row into the projection.
      this.db.exec(landQueueSchema);
      migrateLandQueueColumns(this.db);
      // Identity-scoped inbox attachment bytes: purely additive, no schema
      // version bump, outside the writer fence. Account-session descriptor
      // routes are unchanged and still do not retain provider bytes.
      this.db.exec(inboxAttachmentBytesSchema);
      this.inboxAttachments.verifySchema();
      // RC-2026-09-24-202: members directory skill cards are purely additive
      // as well: IF NOT EXISTS is idempotent, no schema version bump.
      this.db.exec(membersDirectorySchema);
      // The channel webhook update journal (B20) follows the same additive pattern.
      this.db.exec(channelJournalSchema);
      // The spam-guard quarantine journal is purely additive as well:
      // IF NOT EXISTS is idempotent, no schema version bump, and the table is
      // intentionally outside the writer fence (see unfencedAdditiveTables).
      this.db.exec(spamQuarantineSchema);
      // Jev-harness shadow-decision journal: purely additive like the
      // quarantine journal above — IF NOT EXISTS is idempotent, no schema
      // version bump, outside the writer fence (append-only measurement).
      this.db.exec(jevShadowSchema);
      // Consent-bound DMs and the public read-only face: purely additive
      // side tables (no events, no projection impact), same pattern.
      this.db.exec(dmConsentSchema);
      // Agent bonds and peer DMs: additive identity-pair tables. Receipts
      // also land on the room ledger as participant-visible events.
      this.db.exec(bondSchema);
      this.db.exec(roomPublicFaceSchema);
      // #605: opt-in public room directory (owner toggles discoverability;
      // purely additive side table, no events, no projection impact).
      this.db.exec(roomDirectorySchema);
      // RC-2026-09-23-100: guest invites (GX-… public handoff) — purely
      // additive side tables (no events, no projection impact), same pattern.
      this.db.exec(guestInviteSchema);
      // RC-2026-09-23-102: web-fetch page cache + per-request journal — purely
      // additive side tables (no events, no projection impact), same pattern.
      this.db.exec(webFetchSchema);
      migrateWebFetchLogColumns(this.db);
      // RC-2026-09-24-310: web-research per-request journal — purely additive
      // side table (no events, no projection impact), same pattern.
      this.db.exec(webResearchSchema);
      // #658: mention lifecycle tracking. Purely additive side tables (no
      // events, no projection impact): IF NOT EXISTS is idempotent, no
      // schema version bump, intentionally outside the writer fence.
      this.db.exec(mentionStateSchema);
      // Attention (mark unread / save for later / activity feed): purely
      // additive side tables (no events, no projection impact): IF NOT
      // EXISTS is idempotent, no schema version bump, intentionally outside
      // the writer fence.
      this.db.exec(activitySchema);
      // Per-thread mutes. Purely additive side table (no events, no
      // projection impact): IF NOT EXISTS is idempotent, no schema version
      // bump, intentionally outside the writer fence. DDL matches the
      // attention slice's table so the two converge on merge.
      this.db.exec(threadMutesSchema);
      // Gap #2 (PR #562): explicit account_id/source_id columns converge on
      // existing databases via ALTER TABLE; old rows backfill NULL and keep
      // reading as { accountId: null, sourceId: null }.
      migrateSpamQuarantineColumns(this.db);
// Quarantine thread-split records are purely additive as well:
      // IF NOT EXISTS is idempotent, no schema version bump, and the table is
      // intentionally outside the writer fence (see unfencedAdditiveTables).
      this.db.exec(quarantineThreadSplitSchema);
// The SLA-breach alert journal (task 26) follows the same additive pattern:
      this.db.exec(slaBreachAlertSchema);
      // The agent handoff journal (task 23) follows the same additive pattern:
      // IF NOT EXISTS is idempotent, no schema version bump, and the table is
      // intentionally outside the writer fence (see unfencedAdditiveTables).
      this.db.exec(inboxHandoffSchema);
      this.db.exec(inboxHandoffRoomSchema); // Which room a collab-route handoff was made in; see server/inbox-handoff.mjs.
      // The typed handoff envelope journal (RC-2026-09-19-062) follows the
      // same additive pattern: IF NOT EXISTS is idempotent, no schema version
      // bump, and the table is intentionally outside the writer fence
      // (see unfencedAdditiveTables).
      this.db.exec(handoffEnvelopeSchema);
      // Lane D agent plug-in tables (RC-2026-09-18-010): scoped API keys,
      // directory cards, webhook subscriptions. Same additive pattern —
      // IF NOT EXISTS is idempotent, no schema version bump, intentionally
      // outside the writer fence (see unfencedAdditiveTables).
      this.db.exec(agentPluginSchema);
      this.agentPlugin.load();
      // Lane C inbox collaboration tables (task RC-2026-09-18-011) follow the
      // same additive pattern: IF NOT EXISTS is idempotent, no schema version
      // bump, and the tables are intentionally outside the writer fence (see
      // unfencedAdditiveTables in server/writer-fence.mjs).
      this.db.exec(inboxCollabSchema);
      // Per-source read markers are purely additive (no data migration): IF NOT
      // EXISTS is idempotent here. The table is intentionally outside the writer
      // fence (see unfencedAdditiveTables in server/writer-fence.mjs) so
      // same-schema packaged fallbacks that predate it still verify.
      this.db.exec(inboxReadSchema);
      this.db.exec(moderationSchema); // Message reports (issue #6 E4): purely additive, same pattern.
      // Escrowed bounties (agent work exchange, slice 1): purely additive,
      // intentionally outside the writer fence (see unfencedAdditiveTables in
      // server/writer-fence.mjs) so same-schema packaged fallbacks that
      // predate it still verify. Slice 1 shipped to production before the
      // receipt_id/track columns (#778, integration-map candidate #2), so
      // converge deployed databases first: ALTER TABLE cannot rewrite the
      // stored CREATE TABLE text that verifySchema compares.
      convergeBountyDeployedSchema(this.db);
      this.db.exec(bountyEscrowSchema);
      // Self-serve agent access requests: purely additive, intentionally outside
      // the writer fence (see unfencedAdditiveTables). Applied here (not only in
      // createRoomServer) so store-only fixtures and the recovery audit see it.
      this.db.exec(accessRequestSchema);
      // "Who referred you?" free text on access requests (referral
      // attribution): converge deployed databases that predate the column.
      {
        const cols = new Set(this.db.prepare("PRAGMA table_info(access_requests)").all().map(c => c.name));
        if (!cols.has("referred_by")) this.db.exec("ALTER TABLE access_requests ADD COLUMN referred_by TEXT");
      }
      // Owner-granted membership administration for agent identities
      // (RC-2026-09-18-038): purely additive, intentionally outside the
      // writer fence like access_requests — older writers have no code path
      // to the table, and the grant journal's grant→revoke transitions plus
      // the owner-only grant rule are the integrity gate.
      this.db.exec(membershipDelegationSchema);
      this.db.exec(agentRoomSchema);
      // Multi-method login tables (slice 1): purely additive, intentionally
      // outside the writer fence like access_requests above — older writers
      // have no code path to them, and method rows are always scoped to an
      // existing account.
      this.db.exec(accountLoginMethodsSchema);
      // Existing v35 databases predate persistent OAuth state. Converge this
      // unfenced additive table on every open, not only invitation migration.
      this.db.exec(oauthPendingSchema);
      this.db.exec(gmailSchema);
      this.db.exec(requestRunSchema);
      this.requestRuns.verifySchema();
      // Direct channel-send journal: purely additive, intentionally outside
      // the writer fence (see unfencedAdditiveTables). Applied here (not only in
      // createRoomServer) so store-only fixtures and the recovery audit see it.
      this.db.exec(directSendSchema);
      // Cross-channel thread stitching (task #19): hash-only identity index.
      // Purely additive, intentionally outside the writer fence like the
      // journals above — older writers have no code path to these tables.
      this.db.exec(inboxStitchSchema);
      ensureAttachmentSchema(this.db); // Converge the deployed v28-v33 attachment lineage before installing v34 fences.
      // Idempotent: recreates fences for tables the additive schemas just
      // (re)created, and refuses a file whose existing triggers drifted.
      this.storagePlatform.installWriterFence(this.db);
      this.storagePlatform.verifyWriterFence(this.db);
      this.verifyInvitationAudit();
      this.shareLinks.verify();
      this.reminders.verifySchema();
      this.wakeQueue.verifySchema();
      this.wakeQueue.verifyPauseSchema();
      this.attention.verifySchema();
      this.moderation.verifySchema();
      this.bountyEscrow.verifySchema(); // Escrowed bounties: additive at v36, verified like the other journals.
      // A lease whose holder died with the process is expired back to pending
      // here, so a restart preserves the intent exactly once (W4-45 done-when).
      if (!this.readOnly) this.wakeQueue.recover(this.now());
      this.agentConnections.verify();
      this.verifyHelpHistory();
      this.inbox.verify();
      this.email.verify();
      verifyAttachmentSchema(this.db);
      this.channelUpdates.verifySchema();
      this.channelUpdates.verify();
      this.quarantineSplits.verifySchema();
      this.quarantineSplits.verify();
      verifyRoomLifecycle(this);
    }); } catch (error) { this.db.close(); throw error; }
  }

  verifyHelpHistory() {
    return this.readTransaction(() => {
      for (const row of this.db.prepare("SELECT id,projection FROM rooms ORDER BY id").all()) {
        const history = this.db.prepare("SELECT sequence,body FROM events WHERE room_id=? ORDER BY sequence").all(row.id);
        const checkpoint = this.db.prepare("SELECT sequence,projection FROM projection_checkpoints WHERE room_id=?").get(row.id);
        auditWorkHelp(JSON.parse(row.projection), history, checkpoint);
      }
    });
  }

  // v2 had only Room-local member identities. Give each historical human membership its
  // own provisional account: matching member ids or display names across Rooms are not proof
  // that they are the same person. Existing credential bytes remain valid and become bound to
  // that exact provisional account and epoch. Historical Room events stay byte-identical.
  migrateIdentityV3(sourceVersion) {
    this.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, active INTEGER NOT NULL CHECK(active IN (0,1)), revision INTEGER NOT NULL, auth_epoch INTEGER NOT NULL, origin TEXT NOT NULL, created_at INTEGER NOT NULL, display_name TEXT, avatar_url TEXT, onboarded INTEGER NOT NULL DEFAULT 1);
        CREATE TABLE IF NOT EXISTS member_accounts (room_id TEXT NOT NULL REFERENCES rooms(id), member_id TEXT NOT NULL, account_id TEXT NOT NULL REFERENCES accounts(id), origin TEXT NOT NULL, PRIMARY KEY(room_id,member_id), UNIQUE(room_id,account_id));
        CREATE TABLE IF NOT EXISTS account_access_events (account_id TEXT NOT NULL REFERENCES accounts(id), revision INTEGER NOT NULL, active INTEGER NOT NULL CHECK(active IN (0,1)), auth_epoch INTEGER NOT NULL, reason TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(account_id,revision));
      `);
      const columns = new Set(this.db.prepare("PRAGMA table_info(credentials)").all().map(column => column.name));
      if (!columns.has("account_id")) this.db.exec("ALTER TABLE credentials ADD COLUMN account_id TEXT REFERENCES accounts(id)");
      if (!columns.has("account_auth_epoch")) this.db.exec("ALTER TABLE credentials ADD COLUMN account_auth_epoch INTEGER");
      this.db.exec("CREATE INDEX IF NOT EXISTS credential_account ON credentials(account_id)");
      const origin = `legacy-v${sourceVersion}`;
      const insertAccount = this.db.prepare("INSERT OR IGNORE INTO accounts(id,active,revision,auth_epoch,origin,created_at,onboarded) VALUES(?,1,0,0,?,?,1)");
      const insertBinding = this.db.prepare("INSERT OR IGNORE INTO member_accounts(room_id,member_id,account_id,origin) VALUES(?,?,?,?)");
      for (const { id: roomId, projection } of this.db.prepare("SELECT id,projection FROM rooms ORDER BY id").all()) {
        const state = JSON.parse(projection);
        for (const member of Object.values(state.members ?? {}).filter(candidate => candidate?.kind === "human")) {
          const accountId = provisionalAccountId(roomId, member.id);
          insertAccount.run(accountId, origin, this.now());
          insertBinding.run(roomId, member.id, accountId, origin);
        }
      }
      const conflicts = this.db.prepare(`SELECT c.hash FROM credentials c JOIN member_accounts m ON m.room_id=c.room_id AND m.member_id=c.member_id
        WHERE c.account_id IS NOT NULL AND c.account_id<>m.account_id LIMIT 1`).get();
      if (conflicts) fail(409, "identity_conflict", "Existing credential has a conflicting account binding");
      this.db.exec(`UPDATE credentials SET
        account_id=(SELECT account_id FROM member_accounts m WHERE m.room_id=credentials.room_id AND m.member_id=credentials.member_id),
        account_auth_epoch=(SELECT a.auth_epoch FROM member_accounts m JOIN accounts a ON a.id=m.account_id WHERE m.room_id=credentials.room_id AND m.member_id=credentials.member_id)
        WHERE EXISTS (SELECT 1 FROM member_accounts m WHERE m.room_id=credentials.room_id AND m.member_id=credentials.member_id)`);
      this.storagePlatform.setVersion(this.db, 3);
    });
  }
  migrateInvitationsV4() {
    this.transaction(() => {
      this.db.exec(invitationSchema);
      this.storagePlatform.setVersion(this.db, 4);
    });
  }
  // Round-2 #101: multi-room agent identities. Additive tables only; no
  // existing data is touched.
  migrateAgentIdentitiesV27() {
    this.transaction(() => {
      this.db.exec(agentIdentitySchema);
      this.storagePlatform.setVersion(this.db, 27);
    });
  }
  migrateInvitationJournalV5() {
    this.transaction(() => {
      this.db.exec(invitationJournalSchema);
      for (const record of this.db.prepare("SELECT * FROM membership_invitations ORDER BY id").all()) {
        this.appendInvitationJournal(record, "legacy-v4-baseline");
        this.verifyInvitationRecord(record.id);
      }
      this.storagePlatform.setVersion(this.db, 5);
    });
  }
  migrateShareLinkAgentIssuerV35() {
    // SQLite cannot relax a NOT NULL constraint in place: rebuild the tables
    // with nullable issuer columns. Column order is unchanged, so
    // INSERT..SELECT copies every row verbatim; no existing issuer data is
    // NULL today. Parents are rebuilt before children (each child once), and
    // legacy tables drop only after nothing references them: with
    // PRAGMA foreign_keys=ON, ALTER TABLE RENAME rewrites child FK targets to
    // the legacy name, so the final drops must come last. The no-delete /
    // no-update triggers ride the renames and are recreated by re-running the
    // idempotent schema blocks (CREATE..IF NOT EXISTS); the implicit DELETE
    // that DROP TABLE performs does not fire triggers.
    this.transaction(() => {
      const db = this.db;
      db.exec("ALTER TABLE share_links RENAME TO share_links_legacy_v34");
      db.exec(`CREATE TABLE share_links (
        id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE CHECK(length(token_hash)=64),
        room_id TEXT NOT NULL REFERENCES rooms(id), issuer_account_id TEXT REFERENCES accounts(id),
        issuer_member_id TEXT NOT NULL, issuer_auth_epoch INTEGER CHECK((issuer_account_id IS NULL) = (issuer_auth_epoch IS NULL)), issuer_member_revision INTEGER NOT NULL,
        request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL CHECK(expires_at>created_at), max_joins INTEGER NOT NULL CHECK(max_joins BETWEEN 1 AND 25),
        revoked_at INTEGER, revoked_by_member_id TEXT,
        CHECK((revoked_at IS NULL AND revoked_by_member_id IS NULL) OR (revoked_at IS NOT NULL AND revoked_by_member_id IS NOT NULL)),
        UNIQUE(room_id,issuer_account_id,request_id)
      )`);
      db.exec("INSERT INTO share_links SELECT * FROM share_links_legacy_v34");
      db.exec("ALTER TABLE membership_invitations RENAME TO membership_invitations_legacy_v34");
      db.exec(`CREATE TABLE membership_invitations (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE CHECK(length(token_hash)=64),
        room_id TEXT NOT NULL REFERENCES rooms(id),
        intended_account_id TEXT NOT NULL REFERENCES accounts(id),
        intended_member_id TEXT NOT NULL,
        intended_display_name TEXT NOT NULL,
        intended_role TEXT NOT NULL CHECK(intended_role IN ('moderator','member','guest')),
        intended_permissions_json TEXT NOT NULL CHECK(json_valid(intended_permissions_json) AND json_type(intended_permissions_json)='array'),
        role_policy_version INTEGER NOT NULL CHECK(role_policy_version=${INVITATION_ROLE_POLICY_VERSION}),
        issuer_account_id TEXT REFERENCES accounts(id),
        issuer_member_id TEXT NOT NULL,
        issuer_account_auth_epoch INTEGER,
        issuer_member_revision INTEGER NOT NULL,
        issue_request_id TEXT NOT NULL,
        issue_fingerprint TEXT NOT NULL CHECK(length(issue_fingerprint)=64),
        revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0),
        status TEXT NOT NULL CHECK(status IN ('pending','accepted','revoked')),
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        accepted_at INTEGER,
        accepted_by_account_id TEXT REFERENCES accounts(id),
        redemption_id TEXT,
        joined_event_id TEXT UNIQUE REFERENCES events(id),
        revoked_at INTEGER,
        revoked_by_account_id TEXT REFERENCES accounts(id),
        revoked_by_member_id TEXT,
        revoke_reason TEXT,
        CHECK(expires_at>created_at),
        CHECK(
          (status='pending' AND revision=0 AND accepted_at IS NULL AND accepted_by_account_id IS NULL AND redemption_id IS NULL AND joined_event_id IS NULL AND revoked_at IS NULL AND revoked_by_account_id IS NULL AND revoked_by_member_id IS NULL AND revoke_reason IS NULL)
          OR
          (status='accepted' AND revision=1 AND accepted_at IS NOT NULL AND accepted_by_account_id=intended_account_id AND redemption_id IS NOT NULL AND joined_event_id IS NOT NULL AND revoked_at IS NULL AND revoked_by_account_id IS NULL AND revoked_by_member_id IS NULL AND revoke_reason IS NULL)
          OR
          (status='revoked' AND revision=1 AND accepted_at IS NULL AND accepted_by_account_id IS NULL AND redemption_id IS NULL AND joined_event_id IS NULL AND revoked_at IS NOT NULL AND revoked_by_account_id IS NOT NULL AND revoked_by_member_id IS NOT NULL AND revoke_reason IS NOT NULL)
        )
      )`);
      db.exec("INSERT INTO membership_invitations SELECT * FROM membership_invitations_legacy_v34");
      db.exec("ALTER TABLE membership_invitation_events RENAME TO membership_invitation_events_legacy_v34");
      db.exec(`CREATE TABLE membership_invitation_events (
        invitation_id TEXT NOT NULL REFERENCES membership_invitations(id),
        sequence INTEGER NOT NULL CHECK(sequence>0),
        type TEXT NOT NULL CHECK(type IN ('issued','accepted','revoked')),
        actor_account_id TEXT REFERENCES accounts(id),
        actor_member_id TEXT,
        actor_auth_epoch INTEGER,
        actor_session_revision INTEGER,
        invitation_revision INTEGER NOT NULL,
        at INTEGER NOT NULL,
        room_event_id TEXT REFERENCES events(id),
        reason TEXT,
        PRIMARY KEY(invitation_id,sequence)
      )`);
      db.exec("INSERT INTO membership_invitation_events SELECT * FROM membership_invitation_events_legacy_v34");
      db.exec("ALTER TABLE membership_invitation_journal RENAME TO membership_invitation_journal_legacy_v34");
      // Triggers keep their names across the rename; drop them so the schema
      // block below can recreate them on the new table.
      db.exec("DROP TRIGGER IF EXISTS membership_invitation_journal_no_update");
      db.exec("DROP TRIGGER IF EXISTS membership_invitation_journal_no_delete");
      db.exec(invitationJournalSchema); // Standalone block: exact table + triggers.
      db.exec("INSERT INTO membership_invitation_journal SELECT * FROM membership_invitation_journal_legacy_v34");
      db.exec("ALTER TABLE share_link_joins RENAME TO share_link_joins_legacy_v34");
      db.exec(`CREATE TABLE share_link_joins (
        link_id TEXT NOT NULL REFERENCES share_links(id), invitation_id TEXT NOT NULL UNIQUE REFERENCES membership_invitations(id),
        slot_hash TEXT NOT NULL REFERENCES account_session_slots(hash), redemption_id TEXT NOT NULL,
        session_revision INTEGER NOT NULL, fingerprint TEXT NOT NULL,
        PRIMARY KEY(link_id,slot_hash,redemption_id)
      )`);
      db.exec("INSERT INTO share_link_joins SELECT * FROM share_link_joins_legacy_v34");
      // Children first, then the parents nothing references anymore.
      db.exec("DROP TABLE share_link_joins_legacy_v34");
      db.exec("DROP TABLE membership_invitation_events_legacy_v34");
      db.exec("DROP TABLE membership_invitation_journal_legacy_v34");
      db.exec("DROP TABLE share_links_legacy_v34");
      db.exec("DROP TABLE membership_invitations_legacy_v34");
      // Recreate every index/trigger the renames carried away (all IF NOT
      // EXISTS), including the new agent-issuer partial unique indexes.
      db.exec(shareLinkSchema);
      db.exec(invitationSchema);
      this.storagePlatform.setVersion(this.db, 35);
    });
  }
  migrateInvitationAgentRevokeV36() {
    // v36: agent-owner invitation revocation. The revoked-state CHECK required
    // revoked_by_account_id IS NOT NULL, so an accountless agent owner could
    // issue invitations (v35) but never revoke them — half of the owner
    // invitation-administration capability (#597). SQLite cannot relax a CHECK
    // in place: rebuild membership_invitations with the relaxed constraint.
    // The revoker is recorded honestly: revoked_by_account_id is NULL only
    // when the revoking owner acted on an accountless identity bearer, with
    // the member id and the journal audit event carrying the authority
    // (mirrors the v35 agent-issuer pattern). Children are rebuilt so their
    // FKs target the live parent table, following
    // migrateShareLinkAgentIssuerV35: with PRAGMA foreign_keys=ON, ALTER TABLE
    // RENAME rewrites child FK targets to the legacy name, so the final drops
    // must come last and children drop before the parent.
    this.transaction(() => {
      const db = this.db;
      db.exec("ALTER TABLE share_link_joins RENAME TO share_link_joins_legacy_v35");
      db.exec("ALTER TABLE membership_invitation_events RENAME TO membership_invitation_events_legacy_v35");
      db.exec("ALTER TABLE membership_invitation_journal RENAME TO membership_invitation_journal_legacy_v35");
      db.exec("ALTER TABLE membership_invitations RENAME TO membership_invitations_legacy_v35");
      db.exec(invitationSchema); // Standalone block: exact tables + triggers, with the v36 CHECK.
      db.exec("INSERT INTO membership_invitations SELECT * FROM membership_invitations_legacy_v35");
      db.exec("INSERT INTO membership_invitation_events SELECT * FROM membership_invitation_events_legacy_v35");
      db.exec("DROP TRIGGER IF EXISTS membership_invitation_journal_no_update");
      db.exec("DROP TRIGGER IF EXISTS membership_invitation_journal_no_delete");
      db.exec(invitationJournalSchema); // Standalone block: exact table + triggers.
      db.exec("INSERT INTO membership_invitation_journal SELECT * FROM membership_invitation_journal_legacy_v35");
      db.exec(`CREATE TABLE share_link_joins (
        link_id TEXT NOT NULL REFERENCES share_links(id), invitation_id TEXT NOT NULL UNIQUE REFERENCES membership_invitations(id),
        slot_hash TEXT NOT NULL REFERENCES account_session_slots(hash), redemption_id TEXT NOT NULL,
        session_revision INTEGER NOT NULL, fingerprint TEXT NOT NULL,
        PRIMARY KEY(link_id,slot_hash,redemption_id)
      )`);
      db.exec("INSERT INTO share_link_joins SELECT * FROM share_link_joins_legacy_v35");
      // Children first, then the parent nothing references anymore.
      db.exec("DROP TABLE share_link_joins_legacy_v35");
      db.exec("DROP TABLE membership_invitation_events_legacy_v35");
      db.exec("DROP TABLE membership_invitation_journal_legacy_v35");
      db.exec("DROP TABLE membership_invitations_legacy_v35");
      // Recreate every index/trigger the renames carried away (all IF NOT EXISTS).
      db.exec(invitationSchema);
      this.storagePlatform.setVersion(this.db, 36);
    });
  }
  appendInvitationJournal(record, kind) {
    const rows = this.db.prepare("SELECT * FROM membership_invitation_journal WHERE invitation_id=? ORDER BY sequence").all(record.id);
    const audits = this.db.prepare("SELECT * FROM membership_invitation_events WHERE invitation_id=? ORDER BY sequence").all(record.id);
    const entry = invitationJournalEntry(record, audits, kind, this.now(), rows.at(-1));
    try { replayInvitationJournal([...rows, entry]); }
    catch { fail(503, "invitation_integrity_error", "Invitation record requires operator reconciliation"); }
    this.db.prepare("INSERT INTO membership_invitation_journal(invitation_id,sequence,body,checksum) VALUES(?,?,?,?)")
      .run(entry.invitation_id, entry.sequence, entry.body, entry.checksum);
  }
  verifyInvitationRecord(invitationId) {
    try {
      const stored = this.db.prepare("SELECT * FROM membership_invitations WHERE id=?").get(invitationId);
      const journal = this.db.prepare("SELECT * FROM membership_invitation_journal WHERE invitation_id=? ORDER BY sequence").all(invitationId);
      const replayed = replayInvitationJournal(journal);
      const audits = this.db.prepare("SELECT * FROM membership_invitation_events WHERE invitation_id=? ORDER BY sequence").all(invitationId);
      if (canonicalInvitationData(stored) !== canonicalInvitationData(replayed.record)
        || canonicalInvitationData(audits) !== canonicalInvitationData(replayed.audits)) throw new Error("Projection differs from journal");
      if (stored.status === "accepted") {
        const linked = this.db.prepare("SELECT id,sequence,body,room_id FROM events WHERE id=?").get(stored.joined_event_id);
        const binding = this.db.prepare("SELECT account_id,origin FROM member_accounts WHERE room_id=? AND member_id=?").get(stored.room_id, stored.intended_member_id);
        const { sequence, members } = this.roomAuthority(stored.room_id);
        assertInvitationMembershipEvidence(stored, linked, binding, { sequence, state: { members } });
      }
      return replayed;
    } catch { fail(503, "invitation_integrity_error", "Invitation record requires operator reconciliation"); }
  }
  verifyInvitationAudit() {
    return this.readTransaction(() => {
      const records = this.db.prepare("SELECT id FROM membership_invitations ORDER BY id").all();
      if (this.db.prepare("SELECT 1 FROM membership_invitation_journal j LEFT JOIN membership_invitations i ON i.id=j.invitation_id WHERE i.id IS NULL LIMIT 1").get()) {
        fail(503, "invitation_integrity_error", "Invitation record requires operator reconciliation");
      }
      const result = { consistent: true, invitations: records.length, legacyBaselines: 0, journalEntries: 0 };
      for (const { id } of records) {
        const verified = this.verifyInvitationRecord(id);
        result.legacyBaselines += Number(verified.legacyBaseline);
        result.journalEntries += verified.journalSequence;
      }
      return result;
    });
  }
  verifyInvitedMembership(roomId, member) {
    const accepted = this.db.prepare("SELECT id FROM membership_invitations WHERE room_id=? AND intended_member_id=? AND status='accepted'").get(roomId, member.id);
    const binding = this.db.prepare("SELECT origin FROM member_accounts WHERE room_id=? AND member_id=?").get(roomId, member.id);
    const fromBinding = binding?.origin?.startsWith("invitation:") ? binding.origin.slice("invitation:".length) : null;
    const fromProjection = member.membershipOrigin?.kind === "invitation" ? member.membershipOrigin.invitationId : null;
    const invitationId = accepted?.id ?? fromBinding ?? fromProjection;
    if (!invitationId) return;
    const verified = this.verifyInvitationRecord(invitationId);
    if (verified.record.status !== "accepted" || verified.record.room_id !== roomId || verified.record.intended_member_id !== member.id) {
      fail(503, "invitation_integrity_error", "Invitation record requires operator reconciliation");
    }
  }
  // RC-2026-09-23: stale-member listing for the zombie-member cleanup.
  // Token-free and read-only: for the trusted local operator
  // (scripts/room-hygiene.mjs member-sweep), like verifyInvitationAudit.
  // Lists ACTIVE members whose last observed activity (last command `at`,
  // work-session heartbeat, or member.added) is older than `days` (default
  // 30), or never observed. Read-only: the operator reviews the list and
  // deactivates via the owner path; nothing here writes.
  staleMembers(roomId, { days = 30, now = null } = {}) {
    return this.readTransaction(() => {
      const { members } = this.roomAuthority(roomId);
      const room = this.room(roomId);
      const nowMs = now ?? this.now();
      const cutoff = nowMs - days * 24 * 60 * 60 * 1000;
      // Event `at` values are ISO strings; parse to ms for comparison.
      const asMs = value => {
        if (typeof value === "number" && Number.isFinite(value)) return value;
        if (typeof value === "string") { const ms = Date.parse(value); return Number.isFinite(ms) ? ms : 0; }
        return 0;
      };
      const heartbeats = new Map();
      for (const item of Object.values(room.state.workItems ?? {})) {
        const session = sessionRecord(item);
        if (session.worker_member_id && session.heartbeat_at) {
          const ms = asMs(session.heartbeat_at);
          const prev = heartbeats.get(session.worker_member_id) ?? 0;
          if (ms > prev) heartbeats.set(session.worker_member_id, ms);
        }
      }
      const lastCommandAt = new Map(this.db.prepare(
        `SELECT json_extract(body,'$.actorId') AS actor, max(json_extract(body,'$.at')) AS at
         FROM events WHERE room_id=? GROUP BY actor`
      ).all(roomId).filter(row => row.actor).map(row => [row.actor, asMs(row.at)]));
      const addedAt = new Map(this.db.prepare(
        `SELECT json_extract(body,'$.data.memberId') AS member, MIN(json_extract(body,'$.at')) AS at
         FROM events WHERE room_id=? AND json_extract(body,'$.type')='member.added' GROUP BY member`
      ).all(roomId).filter(row => row.member).map(row => [row.member, asMs(row.at)]));
      const stale = [];
      for (const [memberId, member] of Object.entries(members)) {
        if (member.active === false) continue;
        const lastSeenAt = Math.max(lastCommandAt.get(memberId) ?? 0, heartbeats.get(memberId) ?? 0, addedAt.get(memberId) ?? 0) || null;
        if (lastSeenAt === null || lastSeenAt < cutoff) {
          stale.push({ memberId, displayName: member.displayName ?? memberId, kind: member.kind ?? "unknown",
            lastSeenAt, daysSinceSeen: lastSeenAt === null ? null : Math.floor((nowMs - lastSeenAt) / 86400000) });
        }
      }
      stale.sort((a, b) => (a.lastSeenAt ?? 0) - (b.lastSeenAt ?? 0));
      return { roomId, days, cutoff, now: nowMs, stale,
        activeCount: Object.values(members).filter(m => m.active !== false).length };
    });
  }
  // Deterministic upgrade repair: persisted projections are not replayed on startup. Recover
  // proposers and authenticated completion reporters from their own authoritative envelopes,
  // then backfill verification independence only where explicit producer attribution proves it.
  // The legacy reducer guessed that every reporter was also the producer, so legacy receipts
  // deliberately migrate to explicit unknown producer attribution unless their event carried
  // the newer producerId field. Idempotent current projections are left untouched.
  repairProjectionProvenance({ upgradeV1 = false } = {}) {
    this.transaction(() => {
      // A v1 projection was produced under v1 transition rules. Preserve its repaired,
      // conservative form as an immutable recovery checkpoint; all later v2 events replay
      // normally from there. This keeps legacy event bodies byte-for-byte append-only without
      // weakening the current reducer to accept rules that no longer apply.
      this.db.exec("CREATE TABLE IF NOT EXISTS projection_checkpoints (room_id TEXT PRIMARY KEY REFERENCES rooms(id), sequence INTEGER NOT NULL, projection TEXT NOT NULL)");
      const findEvents = this.db.prepare("SELECT body FROM events WHERE room_id=? ORDER BY sequence");
      const saveCheckpoint = this.db.prepare("INSERT INTO projection_checkpoints(room_id,sequence,projection) VALUES(?,?,?)");
      for (const { id, sequence, projection } of this.db.prepare("SELECT id, sequence, projection FROM rooms ORDER BY id").all()) {
        const state = JSON.parse(projection);
        const missing = Object.values(state.workItems ?? {}).filter(item => item && !Object.hasOwn(item, "proposedById"));
        const workItems = Object.values(state.workItems ?? {}).filter(item => item && typeof item === "object");
        const legacyReceipts = workItems.flatMap(item => [...(item.receiptHistory ?? []), item.receipt].filter(Boolean))
          .filter(receipt => !Object.hasOwn(receipt, "reportedById") || !Object.hasOwn(receipt, "producerId") || !Object.hasOwn(receipt, "producerAttribution"));
        const legacyVerifications = workItems.flatMap(item => [...(item.verificationHistory ?? []), item.verification].filter(Boolean)
          .map(verification => ({ item, verification })))
          .filter(({ verification }) => !Object.hasOwn(verification, "independenceConfirmed"));
        const approvalsToCheck = workItems.filter(item => item.decision?.decision === "approved");
        const legacySupersededClaims = workItems.filter(item => item.state === "superseded" && item.claim?.status === "active");
        const hasInvalidSupersession = item => {
          if (item.state !== "superseded" || !item.supersededBy) return false;
          const visited = new Set([item.id]);
          let nextId = item.supersededBy;
          while (nextId) {
            if (visited.has(nextId)) return true;
            visited.add(nextId);
            const next = state.workItems[nextId];
            if (!next) return true;
            nextId = next.supersededBy;
          }
          return false;
        };
        const invalidSupersessions = workItems.filter(hasInvalidSupersession);
        const proposers = new Map();
        const completions = new Map();
        const verifications = new Map();
        const decisions = new Map();
        const supersessions = new Map();
        for (const row of findEvents.all(id)) {
          const parsed = JSON.parse(row.body);
          if (parsed.type === T.WORK_PROPOSED && parsed.data?.workItemId && !proposers.has(parsed.data.workItemId)) proposers.set(parsed.data.workItemId, parsed.actorId ?? null);
          if (parsed.type === T.WORK_COMPLETED && parsed.id) completions.set(parsed.id, parsed);
          if (parsed.type === T.VERIFICATION_RECORDED && parsed.id) verifications.set(parsed.id, parsed);
          if (parsed.type === T.OWNER_DECISION_RECORDED && parsed.id) decisions.set(parsed.id, parsed);
          if (parsed.type === T.WORK_SUPERSEDED && parsed.data?.workItemId) supersessions.set(parsed.data.workItemId, parsed);
        }
        let changed = false;
        // Phase 2 channels: legacy projections (stored before channels existed)
        // gain #general so the stored projection matches a replay. Mirrors
        // ensureDefaultChannel in src/events.js.
        if (ensureDefaultChannelState(state)) changed = true;
        for (const item of missing) {
          const proposer = proposers.get(item.id);
          if (proposer) { item.proposedById = proposer; changed = true; }
        }
        for (const receipt of legacyReceipts) {
          const completion = completions.get(receipt.eventId);
          const producerId = completion?.data && Object.hasOwn(completion.data, "producerId") ? completion.data.producerId : null;
          receipt.reportedById = completion?.actorId ?? null;
          receipt.producerId = producerId ?? null;
          receipt.producerAttribution = producerId == null ? "unknown" : "reported";
          changed = true;
        }
        for (const { item, verification } of legacyVerifications) {
          const receipt = [...(item.receiptHistory ?? []), item.receipt].filter(Boolean)
            .find(candidate => candidate.eventId === verification.completionEventId && candidate.evidenceVersion === verification.evidenceVersion);
          const verificationEvent = verifications.get(verification.eventId);
          const producerKnown = receipt?.producerAttribution === "reported" && receipt.producerId != null;
          const verifierAuthenticated = verificationEvent?.actorId === verification.verifierId && verificationEvent.actorId === item.verifierMemberId;
          const exactReceipt = verificationEvent?.data?.completionEventId === receipt?.eventId && verificationEvent?.data?.evidenceVersion === receipt?.evidenceVersion;
          verification.independenceConfirmed = producerKnown && verifierAuthenticated && exactReceipt && receipt.producerId !== verificationEvent.actorId;
          changed = true;
        }
        for (const item of approvalsToCheck) {
          const receipt = item.receipt, verification = item.verification, decision = item.decision;
          const decisionEvent = decisions.get(decision.eventId);
          const approvalStillCurrent = item.state === "completed";
          const approvalProvenanceSatisfied = decision.actorId === item.humanDecisionMakerId
            && decision.completionEventId === receipt?.eventId
            && decision.evidenceVersion === receipt?.evidenceVersion
            && decisionEvent?.actorId === decision.actorId
            && decisionEvent?.data?.workItemId === item.id
            && decisionEvent?.data?.decision === "approved"
            && decisionEvent?.data?.completionEventId === receipt?.eventId
            && decisionEvent?.data?.evidenceVersion === receipt?.evidenceVersion
            && decisionEvent?.data?.reason === decision.reason;
          const independentGateSatisfied = !item.independentVerificationRequired || (
            verification?.result === "pass" && verification.independenceConfirmed === true
            && verification.verifierId === item.verifierMemberId
            && verification.completionEventId === receipt?.eventId
            && verification.evidenceVersion === receipt?.evidenceVersion
            && receipt?.producerAttribution === "reported" && receipt.producerId != null
            && receipt.producerId !== verification.verifierId
          );
          const confirmed = approvalStillCurrent && approvalProvenanceSatisfied && independentGateSatisfied;
          if (!confirmed) {
            item.decisionHistory ||= [];
            const invalidatedByRepair = !approvalStillCurrent ? "approval_not_current"
              : !approvalProvenanceSatisfied ? "approval_provenance_unconfirmed"
              : "producer_independence_unconfirmed";
            item.decisionHistory.push({
              ...decision,
              historical: true,
              invalidatedByRepair,
              ...(!approvalStillCurrent ? { invalidatedState: item.state } : {})
            });
            item.decision = null;
            changed = true;
          }
        }
        for (const item of legacySupersededClaims) {
          const supersession = supersessions.get(item.id);
          item.claim.status = "superseded";
          item.claim.supersededAt = supersession?.at ?? item.updatedAt;
          changed = true;
        }
        for (const item of invalidSupersessions) {
          item.supersessionRepair = { previousTargetId: item.supersededBy, reason: "invalid_legacy_link" };
          item.supersededBy = null;
          changed = true;
        }
        if (changed) this.db.prepare("UPDATE rooms SET projection=? WHERE id=?").run(JSON.stringify(state), id);
        if (upgradeV1) saveCheckpoint.run(id, sequence, JSON.stringify(state));
      }
      // v2 marks the producer/reporter/verification-independence projection contract.
      // Commit its marker atomically with every v1 projection repair so older binaries
      // either see untouched v1 or reject the fully upgraded database.
      if (upgradeV1) this.storagePlatform.setVersion(this.db, 2);
    });
  }
  close() { this.db.close(); }
  transaction(fn) {
    // Nested startup helpers share the outer migration transaction and its rollback.
    const outermost = !this.db.isTransaction;
    // Only a commit that changed rows proves storage is writable again; an
    // idempotent replay commits nothing. Measured only while degraded.
    const before = outermost && this.storageFailures > 0 ? this.storagePlatform.changes?.(this.db) : null;
    let result;
    try { result = this.storagePlatform.transaction(this.db, fn, false); }
    catch (error) { throw this.storageFailure(error, outermost); }
    if (before !== null && (before === undefined || this.storagePlatform.changes(this.db) !== before)) this.storageRecovered();
    return result;
  }
  readTransaction(fn) {
    const outermost = !this.db.isTransaction;
    // Shared across storage platforms: opportunistic auth migrations must
    // not turn a read into a write (including nested read transactions).
    this.readTransactionDepth = (this.readTransactionDepth ?? 0) + 1;
    try { return this.storagePlatform.transaction(this.db, fn, true); }
    catch (error) { throw this.storageFailure(error, outermost); }
    finally { this.readTransactionDepth -= 1; }
  }
  // Maps one storage failure to the typed refusal and counts it. Only the
  // outermost transaction counts, so one nested failure is one refusal;
  // server/http.mjs calls this for errors raised outside any transaction.
  storageFailure(error, outermost = true) {
    if (!isStorageUnavailable(error)) return error;
    if (outermost && ++this.storageFailures === this.storageFailureThreshold) {
      console.warn(`room storage unavailable after ${this.storageFailures} consecutive failures; readiness now 503`);
    }
    return error instanceof StorageUnavailableError ? error : new StorageUnavailableError(error);
  }
  storageRecovered() {
    if (this.storageFailures >= this.storageFailureThreshold) console.warn("room storage recovered after a committed write; readiness now 200");
    this.storageFailures = 0;
  }
  storageStatus() {
    return { failures: this.storageFailures, threshold: this.storageFailureThreshold, unavailable: this.storageFailures >= this.storageFailureThreshold };
  }
  room(roomId) {
    const row = this.db.prepare("SELECT * FROM rooms WHERE id=?").get(roomId);
    if (!row) fail(404, "room_not_found", "Room not found");
    return { sequence: row.sequence, state: JSON.parse(row.projection) };
  }
  roomAuthority(roomId) {
    // Fresh storage read, not an authorization cache. Keep membership provenance
    // intact without decoding conversation, work history or the Room brief in JS.
    const row = this.db.prepare("SELECT sequence,json_extract(projection,'$.room.ownerId','$.members') AS authority FROM rooms WHERE id=?").get(roomId);
    if (!row) fail(404, "room_not_found", "Room not found");
    const authority = JSON.parse(row.authority);
    const [ownerId, members] = Array.isArray(authority) ? authority : [];
    if (typeof ownerId !== "string" || !members || typeof members !== "object")
      fail(500, "projection_corrupt", "Room projection is missing authority fields");
    return { sequence: row.sequence, ownerId, members };
  }
  rebuildProjection(roomId, through = null) {
    const room = this.room(roomId);
    through ??= room.sequence;
    if (!Number.isSafeInteger(through) || through < 0 || through > room.sequence) throw new Error("Invalid historical room boundary");
    const checkpoint = this.db.prepare("SELECT sequence,projection FROM projection_checkpoints WHERE room_id=?").get(roomId);
    let state = checkpoint ? JSON.parse(checkpoint.projection) : emptyRoomState();
    let sequence = checkpoint?.sequence ?? 0;
    // Work controls predate some stored projections and their checkpoints:
    // backfill the round/tool-call counters, suspension cause, and receipt
    // segments before replaying, so a checkpoint with no later events still
    // rebuilds to the current shape (mirrors ensureDefaultChannel).
    ensureWorkControlDefaults(state);
    ensureDefaultChannelState(state);
    if (sequence > through) throw new Error("Historical room boundary predates the retained checkpoint");
    const rows = this.db.prepare("SELECT sequence,body FROM events WHERE room_id=? AND sequence>? AND sequence<=? ORDER BY sequence").all(roomId, sequence, through);
    for (const row of rows) {
      if (row.sequence !== sequence + 1) throw new Error("Event sequence is not contiguous");
      state = applyEvent(state, JSON.parse(row.body));
      sequence = row.sequence;
    }
    if (sequence !== through) throw new Error("Event sequence does not reach the room projection");
    return { sequence, state: compact(state) };
  }
  // Administrative bootstrap, never exposed over HTTP. Historical demo events are test fixtures only.
  initialize(events) {
    return this.transaction(() => {
      const state = events.reduce(applyEvent, emptyRoomState());
      this.db.prepare("INSERT INTO rooms(id,sequence,projection,archived_at) VALUES(?,?,?,?)").run(state.room.id, events.length, JSON.stringify(compact(state)), archivedAtOf(state));
      const insert = this.db.prepare("INSERT INTO events VALUES(?,?,?,?)");
      events.forEach((e, i) => insert.run(state.room.id, i + 1, e.id, JSON.stringify(e)));
      return state.room.id;
    });
  }
  account(accountId) {
    if (!validId(accountId)) fail(422, "invalid_account", "Invalid account id");
    const row = this.db.prepare("SELECT * FROM accounts WHERE id=?").get(accountId);
    if (!row) fail(404, "account_not_found", "Account not found");
    return accountView(row);
  }
  accountForMember(roomId, memberId) {
    const row = this.db.prepare("SELECT a.* FROM member_accounts m JOIN accounts a ON a.id=m.account_id WHERE m.room_id=? AND m.member_id=?").get(roomId, memberId);
    return accountView(row);
  }
  createAccount(accountId, origin = "local-provisioning") {
    if (!validId(accountId) || accountId.startsWith(provisionalAccountPrefix)) fail(422, "invalid_account", "Invalid or reserved account id");
    if (typeof origin !== "string" || !origin.trim() || origin.length > 128) fail(422, "invalid_account", "A bounded account origin is required");
    return this.transaction(() => {
      if (this.db.prepare("SELECT 1 FROM accounts WHERE id=?").get(accountId)) fail(409, "account_exists", "Account already exists");
      // New accounts start un-onboarded (onboarded=0) so they land on the
      // first-run onboarding step (RC-2026-09-19-078).
      this.db.prepare("INSERT INTO accounts(id,active,revision,auth_epoch,origin,created_at,onboarded) VALUES(?,1,0,0,?,?,0)").run(accountId, origin.trim(), this.now());
      return this.account(accountId);
    });
  }
  // RC-2026-09-19-078: account-level profile (display name / avatar). Reads
  // tolerate pre-migration databases where the columns do not exist yet
  // (account() keeps its exact legacy shape; profile fields live here).
  accountProfile(accountId) {
    const row = this.db.prepare("SELECT * FROM accounts WHERE id=?").get(accountId);
    if (!row) fail(404, "account_not_found", "Account not found");
    return {
      id: row.id,
      displayName: row.display_name ?? null,
      avatarUrl: row.avatar_url ?? null,
      onboardingComplete: row.onboarded == null || row.onboarded !== 0,
    };
  }
  updateAccountProfile(accountId, patch) {
    if (patch === null || typeof patch !== "object" || Array.isArray(patch)) fail(422, "invalid_profile", "A profile patch object is required");
    const keys = Object.keys(patch);
    if (keys.length === 0) fail(422, "invalid_profile", "Supply displayName and/or avatarUrl");
    for (const key of keys) {
      if (key !== "displayName" && key !== "avatarUrl") fail(422, "invalid_profile", `Unknown profile field "${key}"`);
    }
    return this.transaction(() => {
      this.account(accountId); // 404 when missing
      const sets = [], values = [];
      if (Object.hasOwn(patch, "displayName")) { sets.push("display_name=?"); values.push(normalizeDisplayName(patch.displayName)); }
      if (Object.hasOwn(patch, "avatarUrl")) { sets.push("avatar_url=?"); values.push(normalizeAvatarUrl(patch.avatarUrl)); }
      this.db.prepare(`UPDATE accounts SET ${sets.join(", ")} WHERE id=?`).run(...values, accountId);
      return this.accountProfile(accountId);
    });
  }
  // RC-2026-09-19-078: first-run onboarding. createAccount leaves new
  // accounts with onboarded=0; they land on GET /api/account/onboarding
  // until POST /api/account/onboarding/complete marks them done.
  onboardingState(accountId) {
    const profile = this.accountProfile(accountId);
    return {
      accountId: profile.id,
      completed: profile.onboardingComplete,
      steps: [
        { id: "set-profile", title: "Choose a display name",
          detail: "How other members will see you in rooms.", done: profile.displayName !== null },
        { id: "review-signin", title: "Review your sign-in methods",
          detail: "Check which sign-in methods are linked to this account.", done: this.accountLogins.listMethods(accountId).length > 0 },
      ],
    };
  }
  completeOnboarding(accountId) {
    return this.transaction(() => {
      this.account(accountId); // 404 when missing
      this.db.prepare("UPDATE accounts SET onboarded=1 WHERE id=?").run(accountId);
      return this.onboardingState(accountId);
    });
  }
  issueAccountAccessKey(accountId, lifetimeMs = 7 * 86400000) {
    return this.transaction(() => {
      const account = this.account(accountId);
      if (!account.active) fail(403, "access_denied", "Active account required");
      if (!Number.isSafeInteger(lifetimeMs) || lifetimeMs <= 0 || lifetimeMs > 30 * 86400000) fail(422, "invalid_expiry", "Account access keys expire within 30 days");
      this.db.prepare("UPDATE account_credentials SET revoked=1 WHERE account_id=?").run(accountId);
      this.db.prepare("UPDATE account_session_slots SET revision=revision+1,account_id=NULL,account_auth_epoch=NULL,parent_credential_hash=NULL,authenticated_until=NULL WHERE account_id=?").run(accountId);
      return this.insertAccountCredential(accountId, this.now() + lifetimeMs);
    });
  }
  insertAccountCredential(accountId, expiresAt) {
    const count = this.db.prepare("SELECT count(*) AS n FROM account_credentials WHERE account_id=?").get(accountId).n;
    if (count >= 5000) fail(409, "pilot_limit", "Account credential retention limit reached; administrator maintenance required");
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= this.now()) fail(422, "invalid_credential", "Invalid account credential");
    const account = this.account(accountId);
    if (!account.active) fail(403, "access_denied", "Active account required");
    const token = key();
    this.db.prepare("INSERT INTO account_credentials(hash,account_id,account_auth_epoch,expires_at,created_at) VALUES(?,?,?,?,?)")
      .run(hash(token), accountId, account.authEpoch, expiresAt, this.now());
    return token;
  }
  authenticateAccountAccessKey(token) {
    if (typeof token !== "string" || !tokenPattern.test(token)) fail(401, "unauthenticated", "Sign in with an active account key");
    const row = this.db.prepare(`SELECT c.*,a.active AS account_active,a.revision AS account_revision,a.auth_epoch AS current_account_auth_epoch
      FROM account_credentials c JOIN accounts a ON a.id=c.account_id WHERE c.hash=?`).get(hash(token));
    if (!row || row.revoked || row.expires_at <= this.now() || row.account_active !== 1 || row.account_auth_epoch !== row.current_account_auth_epoch) {
      fail(401, "unauthenticated", "Account key expired, revoked, or account access ended");
    }
    return {
      account: { id: row.account_id, active: true, revision: row.account_revision, authEpoch: row.current_account_auth_epoch },
      member: null, roomId: null, credentialHash: row.hash, credentialScope: "account-access", kind: "access", expiresAt: row.expires_at,
      csrf: null, sessionBinding: null, sessionRevision: null
    };
  }
  createAccountSessionSlot(lifetimeMs = 30 * 86400000) {
    if (!Number.isSafeInteger(lifetimeMs) || lifetimeMs <= 0 || lifetimeMs > 90 * 86400000) fail(422, "invalid_expiry", "Account session slots expire within 90 days");
    return this.transaction(() => {
      const now = this.now();
      this.db.prepare("DELETE FROM account_session_slots WHERE expires_at <= ? AND NOT EXISTS (SELECT 1 FROM share_link_joins WHERE slot_hash=account_session_slots.hash)").run(now);
      if (this.db.prepare("SELECT count(*) AS n FROM account_session_slots WHERE expires_at > ?").get(now).n >= 10000) fail(409, "pilot_limit", "Account session slot limit reached; administrator maintenance required");
      const token = key();
      this.db.prepare("INSERT INTO account_session_slots(hash,revision,expires_at,created_at) VALUES(?,0,?,?)").run(hash(token), now + lifetimeMs, now);
      return { token, session: this.accountSessionSlot(token) };
    });
  }
  // OAuth PKCE pending states: persisted in SQLite so the provider callback
  // survives Worker isolate eviction between start and callback. Short-lived.
  oauthPendingStateCreate({ provider, stateHash, slotToken, expectedRevision, verifier, expiresAt, link }) {
    if (provider !== "google" && provider !== "github") fail(422, "invalid_provider", "OAuth provider must be google or github");
    return this.transaction(() => {
      const now = this.now();
      this.db.prepare("DELETE FROM oauth_pending_states WHERE expires_at <= ?").run(now);
      this.db.prepare("DELETE FROM oauth_pending_states WHERE provider=? AND slot_token=?").run(provider, slotToken);
      if (this.db.prepare("SELECT count(*) AS n FROM oauth_pending_states").get().n >= 100) fail(429, "oauth_busy", "Too many pending OAuth flows; try again shortly");
      this.db.prepare(`INSERT INTO oauth_pending_states
        (state_hash,provider,slot_token,expected_revision,verifier,expires_at,link,used,created_at)
        VALUES(?,?,?,?,?,?,?,0,?)`)
        .run(stateHash, provider, slotToken, expectedRevision, verifier, expiresAt, link ? 1 : 0, now);
    });
  }
  oauthPendingStateGet(provider, stateHash) {
    const row = this.db.prepare("SELECT * FROM oauth_pending_states WHERE provider=? AND state_hash=?").get(provider, stateHash);
    if (!row) return null;
    if (row.used || row.expires_at <= this.now()) {
      this.db.prepare("DELETE FROM oauth_pending_states WHERE provider=? AND state_hash=?").run(provider, stateHash);
      return null;
    }
    return {
      slotToken: row.slot_token, expectedRevision: row.expected_revision,
      verifier: row.verifier, expiresAt: row.expires_at, link: row.link === 1,
    };
  }
  oauthPendingStateConsume(provider, stateHash) {
    return this.transaction(() => {
      const entry = this.oauthPendingStateGet(provider, stateHash);
      if (!entry) return null;
      this.db.prepare("UPDATE oauth_pending_states SET used=1 WHERE provider=? AND state_hash=?").run(provider, stateHash);
      return entry;
    });
  }
  oauthPendingStateDelete(provider, stateHash) {
    this.db.prepare("DELETE FROM oauth_pending_states WHERE provider=? AND state_hash=?").run(provider, stateHash);
  }
  accountSessionSlot(token) {
    if (typeof token !== "string" || !tokenPattern.test(token)) fail(401, "unauthenticated", "Invalid account session slot");
    const row = this.db.prepare("SELECT * FROM account_session_slots WHERE hash=?").get(hash(token));
    if (!row || row.expires_at <= this.now()) fail(401, "unauthenticated", "Account session slot expired");
    return {
      account: null, member: null, roomId: null, credentialHash: row.hash, credentialScope: "account-session", kind: "session",
      expiresAt: row.expires_at, authenticatedUntil: null, sessionRevision: row.revision,
      csrf: hash(`account-csrf:${token}:${row.revision}`),
      sessionBinding: hash(`account-session-binding:${token}:${row.revision}`)
    };
  }
  sessionOwnership(auth) {
    return {
      account: auth.account,
      member: auth.member,
      roomId: auth.roomId,
      csrf: auth.csrf,
      sessionBinding: auth.sessionBinding,
      sessionRevision: auth.sessionRevision,
      expiresAt: auth.expiresAt
    };
  }
  loginAccountSession(slotToken, accountAccessKey, expectedRevision, { revokeRoomToken = null, rotateSlot = false } = {}) {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) fail(422, "invalid_session_revision", "A current account session revision is required");
    return this.transaction(() => {
      const slot = this.accountSessionSlot(slotToken);
      if (slot.sessionRevision !== expectedRevision) fail(409, "stale_session_revision", "Account session changed; refresh before signing in");
      const access = this.authenticateAccountAccessKey(accountAccessKey);
      const revision = expectedRevision + 1;
      this.db.prepare(`UPDATE account_session_slots SET revision=?,account_id=?,account_auth_epoch=?,parent_credential_hash=?,authenticated_until=?
        WHERE hash=? AND revision=?`).run(revision, access.account.id, access.account.authEpoch, access.credentialHash, Math.min(slot.expiresAt, access.expiresAt, this.now() + 8 * 3600000), slot.credentialHash, expectedRevision);
      // Switching browser identity and retiring its former Room credential are one
      // commit. A storage failure must not report a rejected login after switching.
      if (revokeRoomToken !== null) {
        if (typeof revokeRoomToken !== "string" || !tokenPattern.test(revokeRoomToken)) fail(422, "invalid_credential", "Invalid prior Room credential");
        this.revoke(revokeRoomToken);
      }
      // QAS-702 (RC-2026-09-19-069): session-fixation rotation, atomic with
      // the login (same transaction). Either the fresh token carries the
      // authenticated session and the pre-login token is dead, or the login
      // fails and nothing is upgraded. Mirrors loginAccountSessionWithMethod.
      if (rotateSlot) return this.rotateAccountSessionSlot(slotToken);
      return this.authenticateAccountSession(slotToken);
    });
  }
  // Slice 1 shared primitive: every login method (password, magic link, OAuth,
  // passkey, recovery code) upgrades the anonymous account-session slot into an
  // authenticated account session once its own verification has passed. `method`
  // is a short audit descriptor: { kind, ref } (ref is a public handle such as
  // the login-methods row id, never a secret).
  loginAccountSessionWithMethod(slotToken, accountId, expectedRevision, { method, revokeRoomToken = null, rotateSlot = false } = {}) {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) fail(422, "invalid_session_revision", "A current account session revision is required");
    if (method == null || typeof method !== "object" || typeof method.kind !== "string" || method.kind.trim() === "") fail(422, "invalid_login_method", "A verified login method is required");
    if (typeof accountId !== "string" || !validId(accountId)) fail(422, "invalid_account_id", "A valid account is required");
    return this.transaction(() => {
      const slot = this.accountSessionSlot(slotToken);
      if (slot.sessionRevision !== expectedRevision) fail(409, "stale_session_revision", "Account session changed; refresh before signing in");
      const account = this.account(accountId);
      if (!account.active) fail(403, "access_denied", "Active account required");
      const revision = expectedRevision + 1;
      const authenticatedUntil = Math.min(slot.expiresAt, this.now() + 8 * 3600000);
      const parentCredentialHash = hash(this.insertAccountCredential(accountId, authenticatedUntil));
      this.db.prepare(`UPDATE account_session_slots SET revision=?,account_id=?,account_auth_epoch=?,parent_credential_hash=?,authenticated_until=?
        WHERE hash=? AND revision=?`).run(revision, accountId, account.authEpoch, parentCredentialHash, authenticatedUntil, slot.credentialHash, expectedRevision);
      if (revokeRoomToken !== null) {
        if (typeof revokeRoomToken !== "string" || !tokenPattern.test(revokeRoomToken)) fail(422, "invalid_credential", "Invalid prior Room credential");
        this.revoke(revokeRoomToken);
      }
      // QAS-702 (RC-2026-09-19-069): session-fixation rotation. The login
      // and the rotation commit atomically: either the fresh token carries
      // the authenticated session and the old token is dead, or the login
      // fails and nothing is upgraded.
      if (rotateSlot) return this.rotateAccountSessionSlot(slotToken);
      return this.authenticateAccountSession(slotToken);
    });
  }
  // QAS-702 (RC-2026-09-19-069): mint a fresh account-session slot token
  // carrying the slot's current state and invalidate the old token, so a
  // token planted before login can never authenticate afterwards. Only an
  // authenticated slot rotates; the revision, account, credential link,
  // and lifetimes carry over unchanged, so the client sees no state jump.
  // Safe to call inside an outer transaction (login) or standalone.
  rotateAccountSessionSlot(slotToken) {
    return this.transaction(() => {
      const slot = this.accountSessionSlot(slotToken); // 401 on unknown/expired token
      const row = this.db.prepare("SELECT * FROM account_session_slots WHERE hash=?").get(slot.credentialHash);
      if (!row || row.account_id === null) fail(409, "slot_not_authenticated", "Only an authenticated session slot can rotate its token");
      const token = key();
      this.db.prepare(`INSERT INTO account_session_slots
        (hash,revision,account_id,account_auth_epoch,parent_credential_hash,expires_at,authenticated_until,created_at)
        VALUES(?,?,?,?,?,?,?,?)`)
        .run(hash(token), row.revision, row.account_id, row.account_auth_epoch, row.parent_credential_hash,
          row.expires_at, row.authenticated_until, this.now());
      if (this.db.prepare("SELECT 1 FROM share_link_joins WHERE slot_hash=? LIMIT 1").get(slot.credentialHash)) {
        // Invitation receipts are immutable and retain this foreign key.
        // Leave an expired, unauthenticated tombstone: the old token cannot
        // resolve or authenticate, while its historical receipt stays valid.
        this.db.prepare(`UPDATE account_session_slots SET revision=revision+1,account_id=NULL,account_auth_epoch=NULL,
          parent_credential_hash=NULL,authenticated_until=NULL,expires_at=? WHERE hash=?`).run(this.now(), slot.credentialHash);
      } else {
        this.db.prepare("DELETE FROM account_session_slots WHERE hash=?").run(slot.credentialHash);
      }
      return { token, session: this.authenticateAccountSession(token) };
    });
  }
  // Google sign-in upgrades an account session slot the same way an access-key
  // login does, but the account is provisioned from the verified Google subject
  // (never the email address). The login is recorded as an account credential
  // so the slot's parent-credential link stays intact; the credential token is
  // never exposed.
  loginAccountSessionWithGoogle(slotToken, googleSub, expectedRevision, { revokeRoomToken = null } = {}) {
    if (typeof googleSub !== "string" || !/^[1-9][0-9]{0,254}$/.test(googleSub)) fail(422, "invalid_google_subject", "A verified Google subject is required");
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) fail(422, "invalid_session_revision", "A current account session revision is required");
    return this.transaction(() => {
      const slot = this.accountSessionSlot(slotToken);
      if (slot.sessionRevision !== expectedRevision) fail(409, "stale_session_revision", "Account session changed; refresh before signing in");
      const accountId = `google:${googleSub}`;
      const existing = this.db.prepare("SELECT id, active, auth_epoch FROM accounts WHERE id=?").get(accountId);
      let accountAuthEpoch;
      if (!existing) {
        this.createAccount(accountId, "google");
        accountAuthEpoch = 0;
      } else {
        if (existing.active !== 1) fail(403, "access_denied", "Active account required");
        accountAuthEpoch = existing.auth_epoch;
      }
      const revision = expectedRevision + 1;
      // The slot table requires a parent credential when an account is set.
      // Record the Google login as an account credential (the token is never
      // exposed; the verified Google subject is the credential).
      const authenticatedUntil = Math.min(slot.expiresAt, this.now() + 8 * 3600000);
      const parentCredentialHash = hash(this.insertAccountCredential(accountId, authenticatedUntil));
      this.db.prepare(`UPDATE account_session_slots SET revision=?,account_id=?,account_auth_epoch=?,parent_credential_hash=?,authenticated_until=?
        WHERE hash=? AND revision=?`).run(revision, accountId, accountAuthEpoch, parentCredentialHash,
        authenticatedUntil, slot.credentialHash, expectedRevision);
      if (revokeRoomToken !== null) {
        if (typeof revokeRoomToken !== "string" || !tokenPattern.test(revokeRoomToken)) fail(422, "invalid_credential", "Invalid prior Room credential");
        this.revoke(revokeRoomToken);
      }
      return this.authenticateAccountSession(slotToken);
    });
  }
  logoutAccountSession(slotToken, expectedRevision) {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) fail(422, "invalid_session_revision", "A current account session revision is required");
    return this.transaction(() => {
      const slot = this.accountSessionSlot(slotToken);
      if (slot.sessionRevision !== expectedRevision) fail(409, "stale_session_revision", "Account session changed; refresh before signing out");
      const changed = this.db.prepare(`UPDATE account_session_slots SET revision=revision+1,account_id=NULL,account_auth_epoch=NULL,parent_credential_hash=NULL,authenticated_until=NULL
        WHERE hash=? AND revision=?`).run(slot.credentialHash, expectedRevision).changes;
      if (changed !== 1) fail(409, "stale_session_revision", "Account session changed; refresh before signing out");
      return this.accountSessionSlot(slotToken);
    });
  }
  authenticateAccountSession(token, roomId = null, expectedSessionBinding = null) {
    if (typeof token !== "string" || !tokenPattern.test(token)) fail(401, "unauthenticated", "Invalid account session");
    const row = this.db.prepare(`SELECT s.*,c.revoked AS parent_revoked,c.expires_at AS parent_expiry,c.account_id AS parent_account_id,c.account_auth_epoch AS parent_account_auth_epoch,
      a.active AS account_active,a.revision AS account_revision,a.auth_epoch AS current_account_auth_epoch
      FROM account_session_slots s LEFT JOIN account_credentials c ON c.hash=s.parent_credential_hash LEFT JOIN accounts a ON a.id=s.account_id WHERE s.hash=?`).get(hash(token));
    const invalid = !row || row.expires_at <= this.now() || row.account_id === null || row.authenticated_until <= this.now()
      || row.parent_revoked !== 0 || row.parent_expiry <= this.now() || row.parent_account_id !== row.account_id || row.parent_account_auth_epoch !== row.account_auth_epoch
      || row.account_active !== 1 || row.account_auth_epoch !== row.current_account_auth_epoch;
    if (invalid) fail(401, "unauthenticated", "Account session expired, revoked, or account access ended");
    const sessionBinding = hash(`account-session-binding:${token}:${row.revision}`);
    if (expectedSessionBinding !== null && expectedSessionBinding !== sessionBinding) fail(409, "session_binding_changed", "Account session changed; discard the stale response or stream");
    const auth = {
      account: { id: row.account_id, active: true, revision: row.account_revision, authEpoch: row.current_account_auth_epoch },
      member: null, roomId: null, credentialHash: row.hash, credentialScope: "account-session", kind: "session",
      expiresAt: Math.min(row.expires_at, row.authenticated_until), authenticatedUntil: row.authenticated_until, sessionRevision: row.revision,
      csrf: hash(`account-csrf:${token}:${row.revision}`), sessionBinding
    };
    if (roomId === null) return auth;
    if (!validId(roomId)) fail(422, "invalid_room", "Invalid Room id");
    const binding = this.db.prepare("SELECT member_id FROM member_accounts WHERE room_id=? AND account_id=?").get(roomId, auth.account.id);
    if (!binding) fail(403, "access_denied", "This account has no membership in that Room");
    const member = this.roomAuthority(roomId).members[binding.member_id];
    if (!member || member.kind !== "human" || member.active === false) fail(403, "access_denied", "Active human Room membership required");
    this.verifyInvitedMembership(roomId, member);
    return { ...auth, member, roomId };
  }
  accountRooms(token, binding, { after = null } = {}) {
    if (after !== null && !validId(after)) fail(422, "invalid_room", "Invalid room continuation");
    // Pure read: a write transaction here would fail on a read-only or
    // write-locked database and count toward the readiness 503 threshold.
    return this.readTransaction(() => {
      const auth = this.authenticateAccountSession(token, null, binding);
      const rows = this.db.prepare("SELECT room_id FROM member_accounts WHERE account_id=? AND room_id>? ORDER BY room_id LIMIT 51")
        .all(auth.account.id, after ?? "");
      const rooms = [];
      for (const row of rows.slice(0, 50)) {
        try {
          const access = this.authenticateAccountSession(token, row.room_id, binding);
          rooms.push(accountRoomEntry(this.db.prepare(ACCOUNT_ROOM_SELECT).get(row.room_id), access.member.id));
        } catch (error) { if (error.status !== 403) throw error; }
      }
      return { contractVersion: 1, viewer: { accountId: auth.account.id, authEpoch: auth.account.authEpoch,
        sessionRevision: auth.sessionRevision, sessionBinding: auth.sessionBinding },
        rooms, nextCursor: rows.length > 50 ? rows[49].room_id : null };
    });
  }
  createAccountRoom(token, binding, request) { return createAccountRoom(this, token, binding, request); }
  // RC-2026-09-19-088: records that the account has held a room, so the
  // default-room endpoint never resurrects a room for someone who left all
  // of theirs. Application-level (not a trigger) — D1 trigger DDL inside
  // the upgrade transaction breaks the v8→v35 rollback gate.
  markAccountHadRoom(accountId) {
    this.db.prepare("UPDATE accounts SET ever_had_room=1 WHERE id=?").run(accountId);
  }
  ensureHumanAccountBinding(roomId, memberId, requestedAccountId = null, origin = "local-provisioning") {
    const members = this.room(roomId).state.members;
    const member = validId(memberId) && Object.hasOwn(members, memberId) && members[memberId];
    if (!member || member.kind !== "human") fail(422, "invalid_account_binding", "Only a human Room member can bind to an account");
    if (requestedAccountId !== null && !validId(requestedAccountId)) fail(422, "invalid_account", "Invalid account id");
    const existing = this.db.prepare("SELECT account_id FROM member_accounts WHERE room_id=? AND member_id=?").get(roomId, memberId);
    if (existing) {
      if (requestedAccountId !== null && existing.account_id !== requestedAccountId) fail(409, "identity_conflict", "Room membership already belongs to another account");
      return this.account(existing.account_id);
    }
    if (requestedAccountId?.startsWith(provisionalAccountPrefix)) fail(422, "invalid_account", "Provisional account ids are reserved for one Room membership");
    const accountId = requestedAccountId === null ? provisionalAccountId(roomId, memberId) : requestedAccountId;
    if (requestedAccountId === null && this.db.prepare("SELECT 1 FROM accounts WHERE id=?").get(accountId)) fail(409, "identity_conflict", "Provisional account id is already reserved");
    this.db.prepare(`${requestedAccountId === null ? "INSERT" : "INSERT OR IGNORE"} INTO accounts(id,active,revision,auth_epoch,origin,created_at) VALUES(?,1,0,0,?,?)`).run(accountId, origin, this.now());
    try { this.db.prepare("INSERT INTO member_accounts(room_id,member_id,account_id,origin) VALUES(?,?,?,?)").run(roomId, memberId, accountId, origin); }
    catch (error) {
      if (/UNIQUE constraint failed/.test(error.message)) fail(409, "identity_conflict", "Account already has a different membership in this Room");
      throw error;
    }
    this.markAccountHadRoom(accountId);
    return this.account(accountId);
  }
  bindHumanAccount(roomId, memberId, accountId) {
    return this.transaction(() => this.ensureHumanAccountBinding(roomId, memberId, accountId));
  }
  // #643: invitation-administration authentication. The room owner acts on any
  // credential (share-links-style owner-capability exemption); everyone else
  // must present an account session, as before. An accountless owner — e.g.
  // an agent identity bearer — is returned with account null, and issuance /
  // stats / revocation record the owner identity honestly (schema v36).
  authenticateInvitationAdmin(token, roomId, expectedSessionBinding = null) {
    const auth = this.authenticate(token, roomId, expectedSessionBinding);
    const ownerId = this.room(roomId).state.room.ownerId;
    if (auth.member?.id === ownerId) return auth;
    if (!auth.account || auth.kind !== "session") fail(403, "account_session_required", "Invitation administration requires an account browser session");
    return auth;
  }
  issueInvitation(accountSessionToken, roomId, details) {
    const {
      requestId, token, intendedAccountId, intendedMemberId, displayName, role, expiresAt,
      expectedIssuerMemberRevision, expectedSessionBinding
    } = details ?? {};
    if (!validId(roomId) || !validId(requestId) || !tokenPattern.test(token ?? "") || !validId(intendedAccountId) || !validId(intendedMemberId)) {
      fail(422, "invalid_invitation", "Invitation requires valid Room, request, token, account, and member identifiers");
    }
    if (typeof displayName !== "string" || !displayName.trim() || displayName.length > 256 || !Object.hasOwn(INVITATION_ROLES, role)) {
      fail(422, "invalid_invitation", "Invitation requires a bounded display name and known human role");
    }
    if (!Number.isSafeInteger(expiresAt) || !Number.isSafeInteger(expectedIssuerMemberRevision) || expectedIssuerMemberRevision < 0) {
      fail(422, "invalid_invitation", "Invitation requires an expiry and current issuer member revision");
    }
    // The session binding is required for account sessions; an accountless
    // owner bearer carries no session to bind.
    if (expectedSessionBinding != null && (typeof expectedSessionBinding !== "string" || !/^[a-f0-9]{64}$/.test(expectedSessionBinding))) fail(422, "invalid_session_binding", "Current account session binding required");
    const tokenHash = hash(token);
    const permissions = [...INVITATION_ROLES[role]];
    const fingerprint = hash(canonical({ roomId, requestId, tokenHash, intendedAccountId, intendedMemberId, displayName: displayName.trim(), role, permissions, expiresAt, expectedIssuerMemberRevision }));
    return this.transaction(() => {
      // #643: the room owner issues on any credential; anyone else needs an
      // account session with manage_members, as before.
      const issuer = this.authenticateInvitationAdmin(accountSessionToken, roomId, expectedSessionBinding ?? null);
      if (issuer.account && typeof expectedSessionBinding !== "string") fail(422, "invalid_session_binding", "Current account session binding required");
      if (!issuer.member.permissions.includes("manage_members")) fail(403, "access_denied", "Current membership administration grant required");
      // Idempotency scope follows the issuer identity: account-scoped for
      // account sessions, member-scoped for an accountless owner (partial
      // unique index membership_invitation_agent_issue_request).
      const prior = issuer.account
        ? this.db.prepare("SELECT * FROM membership_invitations WHERE room_id=? AND issuer_account_id=? AND issue_request_id=?").get(roomId, issuer.account.id, requestId)
        : this.db.prepare("SELECT * FROM membership_invitations WHERE room_id=? AND issuer_account_id IS NULL AND issuer_member_id=? AND issue_request_id=?").get(roomId, issuer.member.id, requestId);
      if (prior) {
        this.verifyInvitationRecord(prior.id);
        if (prior.issue_fingerprint !== fingerprint) fail(409, "idempotency_conflict", "Invitation request ID already used for different scope");
        return { invitation: invitationView(prior, this.now(), { includeScope: true }), duplicate: true };
      }
      const now = this.now();
      if (expiresAt <= now || expiresAt > now + 30 * 86400000) fail(422, "invalid_expiry", "Invitations expire within 30 days");
      if (issuer.member.revision !== expectedIssuerMemberRevision) fail(409, "stale_member_revision", "Issuer membership changed; review the invitation again");
      const room = this.room(roomId);
      if (issuer.member.id !== room.state.room.ownerId && permissions.some(permission => !issuer.member.permissions.includes(permission))) {
        fail(403, "access_denied", "A membership administrator cannot offer authority they do not hold");
      }
      const targetAccount = this.account(intendedAccountId);
      if (!targetAccount.active) fail(403, "access_denied", "Invitation target account is inactive");
      if (Object.hasOwn(room.state.members, intendedMemberId)) fail(409, "membership_conflict", "That Room member already exists");
      if (this.db.prepare("SELECT 1 FROM member_accounts WHERE room_id=? AND account_id=?").get(roomId, intendedAccountId)) fail(409, "membership_conflict", "That account already has a membership in this Room");
      if (this.db.prepare(`SELECT 1 FROM membership_invitations WHERE room_id=? AND status='pending' AND expires_at>? AND (intended_member_id=? OR intended_account_id=?) LIMIT 1`)
        .get(roomId, now, intendedMemberId, intendedAccountId)) fail(409, "invitation_conflict", "An active invitation already reserves that Room identity");
      if (this.db.prepare("SELECT 1 FROM membership_invitations WHERE token_hash=?").get(tokenHash)
        || this.db.prepare("SELECT 1 FROM credentials WHERE hash=?").get(tokenHash)
        || this.db.prepare("SELECT 1 FROM account_credentials WHERE hash=?").get(tokenHash)
        || this.db.prepare("SELECT 1 FROM account_session_slots WHERE hash=?").get(tokenHash)) fail(409, "token_conflict", "Invitation token is already registered");
      const invitationId = randomUUID();
      this.db.prepare(`INSERT INTO membership_invitations(
        id,token_hash,room_id,intended_account_id,intended_member_id,intended_display_name,intended_role,intended_permissions_json,role_policy_version,
        issuer_account_id,issuer_member_id,issuer_account_auth_epoch,issuer_member_revision,issue_request_id,issue_fingerprint,revision,status,created_at,expires_at
      ) VALUES(?,?,?,?,?,?,?,?,?, ?,?,?,?,?,?,0,'pending',?,?)`).run(
        invitationId, tokenHash, roomId, intendedAccountId, intendedMemberId, displayName.trim(), role, JSON.stringify(permissions),
        INVITATION_ROLE_POLICY_VERSION,
        // v35/v36: an accountless owner is recorded honestly with null
        // account/epoch, never a fabricated account id.
        issuer.account?.id ?? null, issuer.member.id, issuer.account?.authEpoch ?? null, issuer.member.revision, requestId, fingerprint, now, expiresAt
      );
      this.db.prepare(`INSERT INTO membership_invitation_events(
        invitation_id,sequence,type,actor_account_id,actor_member_id,actor_auth_epoch,actor_session_revision,invitation_revision,at,room_event_id,reason
      ) VALUES(?,1,'issued',?,?,?,?,0,?,NULL,NULL)`).run(invitationId, issuer.account?.id ?? null, issuer.member.id, issuer.account?.authEpoch ?? null, issuer.sessionRevision ?? 0, now);
      const row = this.db.prepare("SELECT * FROM membership_invitations WHERE id=?").get(invitationId);
      this.appendInvitationJournal(row, "issued");
      return { invitation: invitationView(row, now, { includeScope: true }), duplicate: false };
    });
  }
  previewInvitation(token) {
    if (typeof token !== "string" || !tokenPattern.test(token)) fail(404, "invitation_unavailable", "Invitation is unavailable");
    return this.readTransaction(() => {
      const row = this.db.prepare("SELECT i.*,r.projection FROM membership_invitations i JOIN rooms r ON r.id=i.room_id WHERE i.token_hash=?").get(hash(token));
      if (!row) fail(404, "invitation_unavailable", "Invitation is unavailable");
      this.verifyInvitationRecord(row.id);
      const room = JSON.parse(row.projection);
      let status = invitationStatus(row, this.now());
      if (status === "pending") {
        const issuerAccount = row.issuer_account_id === null ? null
          : this.db.prepare("SELECT active,auth_epoch FROM accounts WHERE id=?").get(row.issuer_account_id);
        const targetAccount = this.db.prepare("SELECT active FROM accounts WHERE id=?").get(row.intended_account_id);
        const issuerBinding = this.db.prepare("SELECT account_id FROM member_accounts WHERE room_id=? AND member_id=?").get(row.room_id, row.issuer_member_id);
        const issuerMember = room.members?.[row.issuer_member_id];
        // Agent-issued invitations carry no account: they were minted under the
        // owner's identity bearer, so authority rests on the member still
        // being active, unrevised, and still the room owner. Ordinary
        // invitations keep the account checks.
        const issuerOk = row.issuer_account_id === null
          ? Boolean(issuerMember) && issuerMember.active !== false && issuerMember.revision === row.issuer_member_revision
            && room.room?.ownerId === row.issuer_member_id
          : Boolean(issuerAccount) && issuerAccount.active === 1 && issuerAccount.auth_epoch === row.issuer_account_auth_epoch
            && issuerBinding?.account_id === row.issuer_account_id;
        const issuerPrivileged = room.room?.ownerId === row.issuer_member_id || issuerMember?.permissions.includes("manage_members");
        if (!issuerOk || targetAccount?.active !== 1 || !issuerMember || issuerMember.active === false
          || issuerMember.revision !== row.issuer_member_revision || !issuerPrivileged) status = "stale";
      }
      // Onboarding Slice 4: pre-auth preview answers "is this worth an
      // account?" — human+agent member counts, no identity data.
      const roster = Object.values(room.members ?? {});
      const memberCounts = {
        humans: roster.filter(member => member?.kind === "human").length,
        agents: roster.filter(member => member?.kind === "agent").length,
      };
      return {
        ...invitationView(row, this.now()),
        status,
        memberId: row.intended_member_id,
        permissions: JSON.parse(row.intended_permissions_json),
        invitedByDisplayName: room.members?.[row.issuer_member_id]?.displayName ?? "Room administrator",
        roomTitle: room.room?.title ?? "Project Room",
        roomPurpose: room.room?.purpose ?? "",
        memberCounts,
      };
    });
  }
  // Round-2 #108: invite-link analytics. Aggregate conversion stats for the
  // room's invitations, restricted to members who can manage memberships.
  invitationStats(token, roomId, expectedSessionBinding) {
    return this.readTransaction(() => {
      // #643: the room owner reads stats on any credential; anyone else
      // needs an account session with manage_members, as before.
      const actor = this.authenticateInvitationAdmin(token, roomId, expectedSessionBinding ?? null);
      if (!actor.member.permissions.includes("manage_members")) fail(403, "access_denied", "Membership administration grant required");
      const rows = this.db.prepare("SELECT status,expires_at,created_at,accepted_at FROM membership_invitations WHERE room_id=?").all(roomId);
      const now = this.now();
      const counts = { pending: 0, accepted: 0, revoked: 0, expired: 0 };
      for (const row of rows) {
        const status = row.status === "pending" && row.expires_at <= now ? "expired" : row.status;
        counts[status] = (counts[status] ?? 0) + 1;
      }
      const issued = rows.length;
      const decided = counts.accepted + counts.revoked + counts.expired;
      return {
        roomId, issued, ...counts,
        conversionRate: decided ? Math.round(1000 * counts.accepted / decided) / 10 : null
      };
    });
  }
  revokeInvitation(accountSessionToken, invitationId, { expectedRevision, reason, expectedSessionBinding, expectedRoomId = null } = {}) {
    if (!validId(invitationId) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || typeof reason !== "string" || !reason.trim() || reason.length > 4096) {
      fail(422, "invalid_invitation_change", "Invitation revocation requires its current revision and a reason");
    }
    // The session binding is required for account sessions; an accountless
    // owner bearer carries no session to bind.
    if (expectedSessionBinding != null && (typeof expectedSessionBinding !== "string" || !/^[a-f0-9]{64}$/.test(expectedSessionBinding))) fail(422, "invalid_session_binding", "Current account session binding required");
    if (expectedRoomId !== null && !validId(expectedRoomId)) fail(422, "invalid_room", "Invalid Room id");
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM membership_invitations WHERE id=?").get(invitationId);
      if (!row || (expectedRoomId !== null && row.room_id !== expectedRoomId)) fail(404, "invitation_not_found", "Invitation not found in this Room");
      // #643: the room owner revokes on any credential; anyone else needs an
      // account session with manage_members, as before.
      const actor = this.authenticateInvitationAdmin(accountSessionToken, row.room_id, expectedSessionBinding ?? null);
      if (actor.account && typeof expectedSessionBinding !== "string") fail(422, "invalid_session_binding", "Current account session binding required");
      if (!actor.member.permissions.includes("manage_members")) fail(403, "access_denied", "Current membership administration grant required");
      this.verifyInvitationRecord(row.id);
      if (row.revision !== expectedRevision) fail(409, "stale_invitation_revision", "Invitation changed; refresh before revoking it");
      if (row.status !== "pending") fail(409, "invitation_not_pending", "Only a pending invitation can be revoked");
      const revision = row.revision + 1, now = this.now();
      // v36: an accountless owner revoker is recorded honestly with a null
      // account, never a fabricated account id.
      const changed = this.db.prepare(`UPDATE membership_invitations SET revision=?,status='revoked',revoked_at=?,revoked_by_account_id=?,revoked_by_member_id=?,revoke_reason=?
        WHERE id=? AND revision=? AND status='pending'`).run(revision, now, actor.account?.id ?? null, actor.member.id, reason.trim(), invitationId, expectedRevision).changes;
      if (changed !== 1) fail(409, "stale_invitation_revision", "Invitation changed; refresh before revoking it");
      this.db.prepare(`INSERT INTO membership_invitation_events(
        invitation_id,sequence,type,actor_account_id,actor_member_id,actor_auth_epoch,actor_session_revision,invitation_revision,at,room_event_id,reason
      ) VALUES(?,2,'revoked',?,?,?,?,?,?,NULL,?)`).run(invitationId, actor.account?.id ?? null, actor.member.id, actor.account?.authEpoch ?? null, actor.sessionRevision ?? 0, revision, now, reason.trim());
      const revoked = this.db.prepare("SELECT * FROM membership_invitations WHERE id=?").get(invitationId);
      this.appendInvitationJournal(revoked, "revoked");
      return { invitation: invitationView(revoked, now, { includeScope: true }), duplicate: false };
    });
  }
  acceptInvitation(accountSessionToken, token, { redemptionId, expectedRevision, expectedSessionBinding } = {}) {
    if (typeof token !== "string" || !tokenPattern.test(token) || typeof redemptionId !== "string" || !redemptionPattern.test(redemptionId) || expectedRevision !== 0) {
      fail(422, "invalid_invitation_acceptance", "Invitation acceptance requires its token, redemption ID, and expected revision zero");
    }
    if (typeof expectedSessionBinding !== "string" || !/^[a-f0-9]{64}$/.test(expectedSessionBinding)) fail(422, "invalid_session_binding", "Current account session binding required");
    return this.transaction(() => {
      const accountSession = this.authenticateAccountSession(accountSessionToken, null, expectedSessionBinding);
      const row = this.db.prepare("SELECT * FROM membership_invitations WHERE token_hash=?").get(hash(token));
      if (!row) fail(404, "invitation_unavailable", "Invitation is unavailable");
      if (row.intended_account_id !== accountSession.account.id) fail(403, "invitation_account_mismatch", "Invitation belongs to a different account");
      this.verifyInvitationRecord(row.id);
      if (row.status === "accepted") {
        if (row.redemption_id !== redemptionId) fail(409, "invitation_already_used", "Invitation was already accepted by this account through another request");
        const auth = this.authenticateAccountSession(accountSessionToken, row.room_id, expectedSessionBinding);
        const stored = this.db.prepare("SELECT body,sequence FROM events WHERE id=? AND room_id=?").get(row.joined_event_id, row.room_id);
        if (!stored || auth.member.id !== row.intended_member_id) fail(409, "invitation_receipt_unavailable", "Accepted invitation cannot be reconciled safely");
        return { invitation: invitationView(row, this.now(), { includeScope: true }), sequence: stored.sequence, event: JSON.parse(stored.body), session: this.sessionOwnership(auth), duplicate: true };
      }
      if (row.status === "revoked") fail(410, "invitation_revoked", "Invitation was revoked");
      if (row.revision !== expectedRevision) fail(409, "stale_invitation_revision", "Invitation changed; preview it again");
      const now = this.now();
      if (now >= row.expires_at) fail(410, "invitation_expired", "Invitation expired");
      const room = this.room(row.room_id);
      const issuerAccount = row.issuer_account_id === null ? null
        : this.db.prepare("SELECT active,auth_epoch FROM accounts WHERE id=?").get(row.issuer_account_id);
      const issuerBinding = this.db.prepare("SELECT account_id FROM member_accounts WHERE room_id=? AND member_id=?").get(row.room_id, row.issuer_member_id);
      const issuerMember = room.state.members[row.issuer_member_id];
      // Agent-issued invitations carry no account: authority rests on the
      // member still being active, unrevised, and still the room owner
      // (see previewInvitation). Ordinary invitations keep the account
      // checks.
      const issuerOk = row.issuer_account_id === null
        ? Boolean(issuerMember) && issuerMember.active !== false && issuerMember.revision === row.issuer_member_revision
          && room.state.room.ownerId === row.issuer_member_id
        : Boolean(issuerAccount) && issuerAccount.active === 1 && issuerAccount.auth_epoch === row.issuer_account_auth_epoch
          && issuerBinding?.account_id === row.issuer_account_id;
      if (!issuerOk || !issuerMember || issuerMember.active === false
        || issuerMember.revision !== row.issuer_member_revision
        || !(room.state.room.ownerId === row.issuer_member_id || issuerMember.permissions.includes("manage_members"))) {
        fail(409, "invitation_authority_changed", "Inviter authority changed; ask a current Room administrator for a new invitation");
      }
      if (Object.hasOwn(room.state.members, row.intended_member_id)
        || this.db.prepare("SELECT 1 FROM member_accounts WHERE room_id=? AND (member_id=? OR account_id=?) LIMIT 1").get(row.room_id, row.intended_member_id, row.intended_account_id)) {
        fail(409, "membership_conflict", "Invitation target already has a Room identity");
      }
      const permissions = JSON.parse(row.intended_permissions_json);
      const rolePolicy = INVITATION_ROLE_POLICIES[row.role_policy_version];
      const rolePermissions = rolePolicy?.[row.intended_role];
      if (!rolePermissions || permissions.length !== rolePermissions.length || permissions.some((permission, index) => permission !== rolePermissions[index])) {
        fail(409, "invitation_scope_invalid", "Stored invitation grants no longer match its immutable role policy");
      }
      if (room.sequence >= PILOT_LIMITS.eventsPerRoom || Object.keys(room.state.members).length >= PILOT_LIMITS.membersPerRoom) fail(409, "pilot_limit", "Bounded pilot capacity reached; no data was changed");
      refuseArchivedWrite(room.state);
      const incoming = invitationJoinedEvent({ ...row, joined_event_id: randomUUID(), accepted_at: now, redemption_id: redemptionId });
      let state;
      try { state = compact(applyEventWithGrowth(room.state, incoming, growthCollector).state); }
      catch (error) { fail(409, "invitation_rejected", error.message); }
      const projection = JSON.stringify(state);
      if (Buffer.byteLength(projection) > PILOT_LIMITS.projectionBytes) fail(409, "pilot_limit", "Room projection limit reached; no data was changed");
      const sequence = room.sequence + 1;
      this.db.prepare("INSERT INTO events VALUES(?,?,?,?)").run(row.room_id, sequence, incoming.id, JSON.stringify(incoming));
      this.db.prepare("UPDATE rooms SET sequence=?,projection=? WHERE id=?").run(sequence, projection, row.room_id);
      this.db.prepare("INSERT INTO member_accounts(room_id,member_id,account_id,origin) VALUES(?,?,?,?)")
        .run(row.room_id, row.intended_member_id, row.intended_account_id, `invitation:${row.id}`);
      this.markAccountHadRoom(row.intended_account_id);
      const changed = this.db.prepare(`UPDATE membership_invitations SET revision=1,status='accepted',accepted_at=?,accepted_by_account_id=?,redemption_id=?,joined_event_id=?
        WHERE id=? AND revision=0 AND status='pending'`).run(now, accountSession.account.id, redemptionId, incoming.id, row.id).changes;
      if (changed !== 1) fail(409, "stale_invitation_revision", "Invitation changed while it was being accepted");
      this.db.prepare(`INSERT INTO membership_invitation_events(
        invitation_id,sequence,type,actor_account_id,actor_member_id,actor_auth_epoch,actor_session_revision,invitation_revision,at,room_event_id,reason
      ) VALUES(?,2,'accepted',?,?,?,?,1,?,?,NULL)`).run(row.id, accountSession.account.id, row.intended_member_id, accountSession.account.authEpoch, accountSession.sessionRevision, now, incoming.id);
      this.appendInvitationJournal(this.db.prepare("SELECT * FROM membership_invitations WHERE id=?").get(row.id), "accepted");
      const authorized = this.authenticateAccountSession(accountSessionToken, row.room_id, expectedSessionBinding);
      return {
        invitation: invitationView(this.db.prepare("SELECT * FROM membership_invitations WHERE id=?").get(row.id), now, { includeScope: true }),
        sequence, event: incoming, session: this.sessionOwnership(authorized), duplicate: false
      };
    });
  }
  changeAccountAccess(accountId, { expectedRevision, active, reason }) {
    if (!validId(accountId)) fail(422, "invalid_account", "Invalid account id");
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || typeof active !== "boolean" || typeof reason !== "string" || !reason.trim() || reason.length > 4096) fail(422, "invalid_account_change", "Account change requires a current revision, active state, and reason");
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM accounts WHERE id=?").get(accountId);
      if (!row) fail(404, "account_not_found", "Account not found");
      if (row.revision !== expectedRevision) fail(409, "stale_account_revision", "Stale account revision");
      if (Boolean(row.active) === active) fail(409, "account_state_unchanged", "Account already has that access state");
      const revision = row.revision + 1, authEpoch = row.auth_epoch + 1, at = this.now();
      this.db.prepare("UPDATE accounts SET active=?,revision=?,auth_epoch=? WHERE id=?").run(active ? 1 : 0, revision, authEpoch, accountId);
      this.db.prepare("UPDATE credentials SET revoked=1 WHERE account_id=?").run(accountId);
      this.agentConnections.revokeAccount(accountId);
      this.db.prepare("UPDATE account_credentials SET revoked=1 WHERE account_id=?").run(accountId);
      this.db.prepare("UPDATE account_session_slots SET revision=revision+1,account_id=NULL,account_auth_epoch=NULL,parent_credential_hash=NULL,authenticated_until=NULL WHERE account_id=?").run(accountId);
      this.db.prepare("INSERT INTO account_access_events(account_id,revision,active,auth_epoch,reason,at) VALUES(?,?,?,?,?,?)").run(accountId, revision, active ? 1 : 0, authEpoch, reason.trim(), at);
      if (!active) this.reminders.retireAccount(accountId);
      return this.account(accountId);
    });
  }
  issueAccessKey(roomId, memberId, lifetimeMs = 7 * 86400000, accountId = null) {
    return this.transaction(() => {
      const members = this.room(roomId).state.members;
      const member = validId(memberId) && Object.hasOwn(members, memberId) && members[memberId];
      if (!member || member.active === false) fail(403, "access_denied", "Active member required");
      if (!Number.isSafeInteger(lifetimeMs) || lifetimeMs <= 0 || lifetimeMs > 30 * 86400000) fail(422, "invalid_expiry", "Access keys expire within 30 days");
      if (member.kind === "human") {
        const account = this.ensureHumanAccountBinding(roomId, memberId, accountId);
        if (!account.active) fail(403, "access_denied", "Active account required");
      } else if (accountId !== null) fail(422, "invalid_account_binding", "Agent credentials are not human account credentials");
      this.db.prepare("UPDATE credentials SET revoked=1 WHERE room_id=? AND member_id=?").run(roomId, memberId);
      return this.insertCredential(roomId, memberId, "access", null, this.now() + lifetimeMs);
    });
  }
  insertCredential(roomId, memberId, kind, parent, expiresAt, identitySecretHash = null) {
    if (this.agentConnections.row(roomId, memberId)) fail(409, "managed_agent", "Replace this agent's key through its room connection");
    const count = this.db.prepare("SELECT count(*) AS n FROM credentials WHERE room_id=?").get(roomId).n;
    if (count >= 5000) fail(409, "pilot_limit", "Credential retention limit reached; administrator maintenance required");
    const member = this.room(roomId).state.members[memberId];
    if (!member) fail(403, "access_denied", "Room member required");
    const account = member.kind === "human" ? this.ensureHumanAccountBinding(roomId, memberId) : null;
    if (account && !account.active) fail(403, "access_denied", "Active account required");
    const token = key();
    this.db.prepare("INSERT INTO credentials(hash,room_id,member_id,kind,parent_hash,expires_at,account_id,account_auth_epoch,identity_secret_hash) VALUES(?,?,?,?,?,?,?,?,?)").run(hash(token), roomId, memberId, kind, parent, expiresAt, account?.id ?? null, account?.authEpoch ?? null, identitySecretHash);
    return token;
  }
  authenticate(token, roomId, expectedSessionBinding = null, { allowAccountSession = true } = {}) {
    // Round-2 #101: multi-room agent identities. One identity secret works in
    // every room the identity is linked to; rooms keep sovereignty via link/unlink.
    // RC-2026-09-18-012: scoped API keys ("rak_"+secret) authenticate the
    // AGENT identity bound at issue, with its stored scopes. account stays
    // null — a key can never grant human-account access, so account-session
    // gates (e.g. /api/inbox/*) remain unreachable to keys.
    if (isApiKeyToken(token)) {
      const record = this.agentPlugin.verifyPresentedApiKey(token);
      if (!record) fail(401, "unauthenticated", "Unknown, revoked, or expired API key");
      const resolved = roomId ? this.identities.resolveIdentityLink(record.identityId, roomId) : null;
      if (!resolved) fail(401, "unauthenticated", "API key identity has no access to this room");
      return {
        account: null, member: resolved.member, roomId, identityId: resolved.identityId,
        credentialHash: hash(token), credentialScope: "room", kind: "api-key",
        apiKeyId: record.keyId, apiKeyScopes: Object.freeze([...record.scopes]),
        expiresAt: null, csrf: null, sessionBinding: null
      };
    }
    if (isIdentitySecret(token)) {
      const resolved = this.identities.resolveIdentityAuth(token, roomId);
      if (!resolved) fail(401, "unauthenticated", "Unknown identity or no access to this room");
      return {
        account: null, member: resolved.member, roomId, identityId: resolved.identityId,
        credentialHash: hash(token), credentialScope: "room", kind: "identity",
        expiresAt: null, csrf: null, sessionBinding: null
      };
    }
    if (typeof token !== "string" || !isRoomAccessToken(token)) {
      fail(401, "unauthenticated", token == null || token === ""
        ? "No credential. Agents can self-mint an identity at POST /api/agent-identities."
        : "Sign in with an active room key or agent identity secret");
    }
    const row = this.db.prepare(`SELECT c.*, p.revoked AS parent_revoked, p.expires_at AS parent_expiry, p.account_id AS parent_account_id, p.account_auth_epoch AS parent_account_auth_epoch,
      m.account_id AS bound_account_id, a.active AS account_active, a.revision AS account_revision, a.auth_epoch AS current_account_auth_epoch
      FROM credentials c LEFT JOIN credentials p ON p.hash=c.parent_hash
      LEFT JOIN member_accounts m ON m.room_id=c.room_id AND m.member_id=c.member_id
      LEFT JOIN accounts a ON a.id=m.account_id WHERE c.hash=?`).get(hash(token));
    if (!row) {
      if (allowAccountSession && this.db.prepare("SELECT 1 FROM account_session_slots WHERE hash=?").get(hash(token))) return this.authenticateAccountSession(token, roomId ?? null, expectedSessionBinding);
      fail(401, "unauthenticated", "Session or key expired or revoked");
    }
    if (row.revoked || row.expires_at <= this.now() || (row.parent_hash && (row.parent_revoked !== 0 || row.parent_expiry <= this.now()))) fail(401, "unauthenticated", "Session or key expired or revoked");
    if (roomId && row.room_id !== roomId) fail(403, "access_denied", "This credential does not grant access to that room");
    const members = this.roomAuthority(row.room_id).members;
    const member = Object.hasOwn(members, row.member_id) && members[row.member_id];
    if (!member || member.active === false) fail(403, "access_denied", "Room membership is inactive");
    this.verifyInvitedMembership(row.room_id, member);
    let account = null;
    if (member.kind === "human") {
      const invalidAccount = !row.account_id || row.account_id !== row.bound_account_id || row.account_active !== 1
        || row.account_auth_epoch !== row.current_account_auth_epoch
        || (row.parent_hash && (row.parent_account_id !== row.account_id || row.parent_account_auth_epoch !== row.account_auth_epoch));
      if (invalidAccount) fail(401, "unauthenticated", "Session or key expired, revoked, or account access ended");
      account = { id: row.account_id, active: true, revision: row.account_revision, authEpoch: row.current_account_auth_epoch };
    } else if (row.account_id !== null || row.account_auth_epoch !== null) fail(401, "unauthenticated", "Agent credential has an invalid human account binding");
    if (member.kind === "agent") this.agentConnections.assertCredential(row);
    // RC-2026-09-23-106: agent browser sessions are bound to the identity
    // secret hash at creation time. If the secret was rotated or revoked
    // since, the session is rejected.
    if (row.identity_secret_hash !== null && row.identity_secret_hash !== undefined) {
      const linkRow = this.db.prepare("SELECT identity_id AS identityId FROM identity_links WHERE room_id=? AND member_id=?").get(row.room_id, row.member_id);
      if (!linkRow) fail(401, "unauthenticated", "Agent session identity link not found");
      const secretRow = this.db.prepare("SELECT secret_hash AS secretHash, revoked_at AS revokedAt FROM agent_identities WHERE identity_id=?").get(linkRow.identityId);
      if (!secretRow || secretRow.revokedAt !== null || secretRow.secretHash !== row.identity_secret_hash) {
        fail(401, "unauthenticated", "Agent identity secret was rotated or revoked; sign in again");
      }
    }
    const auth = {
      account, member, roomId: row.room_id, credentialHash: row.hash, credentialScope: "room", kind: row.kind, expiresAt: row.expires_at,
      csrf: row.kind === "session" ? hash(`csrf:${token}`) : null,
      sessionBinding: row.kind === "session" ? hash(`session-binding:${token}`) : null
    };
    if (expectedSessionBinding !== null && expectedSessionBinding !== auth.sessionBinding) fail(409, "session_binding_changed", "Session changed; discard the stale response or stream");
    return auth;
  }
  createSession(accessKey) {
    return this.transaction(() => {
      const auth = this.authenticate(accessKey);
      if (auth.credentialScope !== "room" || auth.kind !== "access" || auth.member.kind !== "human") fail(403, "access_denied", "Browser sessions require a human Room access key");
      const token = this.insertCredential(auth.roomId, auth.member.id, "session", auth.credentialHash, Math.min(auth.expiresAt, this.now() + 8 * 3600000));
      return { token, session: this.authenticate(token) };
    });
  }
  // Join-flow browser session. After a successful self-serve join the new
  // agent member's browser needs a working session — the join page's "open
  // the room" link would otherwise strand them with a secret but no session.
  // Narrowly scoped: agent-kind only, room-bound, 8-hour expiry like human
  // browser sessions. The session carries exactly the member's permissions —
  // no more, no less — and the invite redemption (or first-room creation) in
  // the same request is the authorization, so callers must only invoke it for
  // the member minted there. Invite profiles are agent-safe by construction,
  // so invite sessions can never mint admin rights.
  createJoinSession(roomId, memberId) {
    return this.transaction(() => {
      const member = this.room(roomId).state.members[memberId];
      if (!member || member.active === false) fail(403, "access_denied", "Room member required");
      if (member.kind !== "agent") fail(403, "access_denied", "Join sessions are for agent joins");
      const expiresAt = this.now() + 8 * 3600000;
      const token = this.insertCredential(roomId, memberId, "session", null, expiresAt);
      return { token, expiresAt };
    });
  }
  // Creates a browser session for an agent identity linked to a room member.
  // The identity secret must already be verified by the caller via
  // identities.authenticateIdentitySecret. The session is scoped to
  // the room and member, with the same 8-hour expiry as human sessions.
  createAgentSession(identityId, roomId) {
    return this.transaction(() => {
      const link = this.identities.resolveIdentityLink(identityId, roomId);
      if (!link) fail(403, "access_denied", "This agent identity is not linked to that room");
      if (link.member.kind !== "agent") fail(403, "access_denied", "Browser sessions require an agent room member");
      // RC-2026-09-23-106: bind the session to the current secret hash.
      // If the secret is rotated or revoked, authenticate() rejects sessions
      // carrying the old hash.
      const secretRow = this.db.prepare("SELECT secret_hash AS secretHash FROM agent_identities WHERE identity_id=?").get(identityId);
      const token = this.insertCredential(roomId, link.member.id, "session", null, this.now() + 8 * 3600000, secretRow?.secretHash ?? null);
      return { token, session: this.authenticate(token) };
    });
  }
  revoke(token) { this.db.prepare("UPDATE credentials SET revoked=1 WHERE hash=?").run(hash(token)); }
  snapshot(token, roomId, expectedSessionBinding = null, view = "full", helpContext = false, offerContext = false) {
    // One read transaction keeps sequence, projection, and audit tail at the same commit.
    return this.readTransaction(() => {
      const auth = this.authenticate(token, roomId, expectedSessionBinding);
      if (!["full", "work"].includes(view)) fail(422, "invalid_snapshot_view", "Choose a supported snapshot view");
      if (typeof helpContext !== "boolean" || helpContext && view !== "work") fail(422, "invalid_help_context", "Help discovery requires the current work view");
      if (typeof offerContext !== "boolean" || offerContext && view !== "full") fail(422, "invalid_offer_context", "Browser offers require the full room view");
      const room = this.room(roomId);
      if (view === "work") return { snapshotView: "work", snapshotVersion: 1, roomId, sequence: room.sequence,
        ...(helpContext ? { helpContextVersion: 1, evaluatedAt: new Date(this.now()).toISOString() } : {}),
        state: { room: room.state.room, members: room.state.members,
          workItems: Object.fromEntries(Object.entries(room.state.workItems).map(([id, item]) => [id, currentWorkRecord(item)])) },
        charter: charterContext(room.state.room), viewerId: auth.member.id, viewerAccountId: auth.account?.id ?? null,
        viewerAuthEpoch: auth.account?.authEpoch ?? null, viewerSessionBinding: auth.sessionBinding, viewerSessionRevision: auth.sessionRevision ?? null };
      const rows = this.db.prepare("SELECT body FROM events WHERE room_id=? ORDER BY sequence DESC LIMIT 100").all(roomId);
      const cursor = this.db.prepare("SELECT sequence FROM cursors WHERE room_id=? AND member_id=?").get(roomId, auth.member.id)?.sequence ?? 0;
      return { ...room, roomId, ...(offerContext ? { offerContextVersion: 1 } : {}), charter: charterContext(room.state.room), replyRequestContractVersion: REPLY_POLICY_VERSION, state: { ...room.state, eventLog: rows.reverse().map(r => JSON.parse(r.body)) }, cursor, viewerId: auth.member.id, viewerAccountId: auth.account?.id ?? null, viewerAuthEpoch: auth.account?.authEpoch ?? null, viewerSessionBinding: auth.sessionBinding, viewerSessionRevision: auth.sessionRevision ?? null };
    });
  }

  workItemHistory(token, roomId, workItemId, expectedSessionBinding = null, since = null) {
    // F3: derived, read-time change list for one work item from its own revision
    // events. Never a write; the event log stays the only record.
    return this.readTransaction(() => {
      this.authenticate(token, roomId, expectedSessionBinding);
      const room = this.room(roomId);
      const item = room.state.workItems[workItemId];
      if (!item) fail(404, "work_not_found", "Choose an existing work item");
      if (since !== null && (!Number.isSafeInteger(since) || since < 0 || since > item.revision)) fail(422, "invalid_history_basis", "Choose a revision this work item has reached");
      const rows = this.db.prepare("SELECT body FROM events WHERE room_id=? AND json_extract(body,'$.data.workItemId')=? ORDER BY sequence").all(roomId, workItemId);
      const changes = workItemChanges(rows.map(row => JSON.parse(row.body)));
      return { historyVersion: 1, workItemId, revision: item.revision,
        changes: since === null ? changes : changes.filter(change => change.revision > since) };
    });
  }

  charter(token, roomId, { revision, expectedSessionBinding = null } = {}) {
    return this.readTransaction(() => {
      const auth = this.authenticate(token, roomId, expectedSessionBinding), room = this.room(roomId);
      if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 0)) fail(422, "invalid_charter_revision", "Choose an instructions version");
      const current = charterContext(room.state.room);
      const selected = revision ?? current.revision;
      if (selected > current.revision) fail(404, "charter_not_found", "That instructions version is unavailable");
      let charter = selected === current.revision ? current.charter : null;
      if (selected > 0 && selected !== current.revision) {
        // Return one bounded event, not all discussion bodies or every version.
        // Full retained-history/checkpoint validation belongs to the recovery audit.
        const rows = this.db.prepare("SELECT body FROM events WHERE room_id=? AND json_extract(body,'$.type')=? AND json_extract(body,'$.data.expectedRevision')=? LIMIT 2").all(roomId, T.ROOM_CHARTER_UPDATED, selected - 1);
        if (rows.length !== 1) fail(404, "charter_not_found", "That instructions version is unavailable");
        const parsedEvent = JSON.parse(rows[0].body);
        if (parsedEvent.roomId !== roomId || parsedEvent.actorId !== room.state.room.ownerId) fail(409, "charter_integrity_error", "Instructions history requires reconciliation");
        charter = charterFromEvent(parsedEvent, { revision: selected - 1 });
      }
      return { contractVersion: 1, roomId, evaluatedThrough: room.sequence, currentRevision: current.revision, currentEventId: current.eventId,
        ...charterContext({ charter }), viewerId: auth.member.id, viewerAccountId: auth.account?.id ?? null,
        viewerAuthEpoch: auth.account?.authEpoch ?? null, viewerSessionBinding: auth.sessionBinding, viewerSessionRevision: auth.sessionRevision ?? null };
    });
  }
  workSessions(token, roomId, { status = null, expectedSessionBinding = null } = {}) {
    return this.readTransaction(() => {
      const auth = this.authenticate(token, roomId, expectedSessionBinding);
      if (status != null && !isSessionStatus(status)) fail(422, "invalid_session_status", "Choose one session status");
      const room = this.room(roomId);
      const sessions = listWorkItemSessions(room.state.workItems, status, { members: room.state.members, nowMs: this.now() });
      return {
        contractVersion: 1, roomId, evaluatedThrough: room.sequence, viewerId: auth.member.id,
        sessions,
        // RC-2026-09-18-057: seeing open work is half the loop — name the
        // atomic claim (set_status -> processing on a queued card).
        next: Object.freeze(workSessionsNext(roomId, sessions)),
      };
    });
  }
  mutateWorkSession(token, roomId, request, expectedSessionBinding = null) {
    if (!request || Array.isArray(request) || typeof request !== "object") fail(422, "invalid_session_action", "Supply the session action fields");
    const keys = Object.keys(request);
    // W4-46 H5: a starting claim may declare a budget; any status change may
    // report cumulative spend, rounds, and tool calls. Both are optional;
    // nothing else is accepted. suspendReason/resumeApproved are system-set —
    // a caller that smuggles them in is rejected, not silently honoured.
    const required = ["requestId", "workItemId", "action",
      ...(request.action === "set_status" ? ["status"] : [])];
    const optional = ["expectedRevision", ...(request.action === "set_status" ? ["budget", "spendCents", "rounds", "toolCalls", "environment", "outputs"] : [])];
    if (required.some(key => !keys.includes(key)) || keys.some(key => ![...required, ...optional].includes(key))) {
      fail(422, "invalid_session_action", "Supply requestId, workItemId, and set_status or request_stop. expectedRevision is optional");
    }
    if (!validId(request.requestId) || !validId(request.workItemId)
      || (request.expectedRevision !== undefined && (!Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0))
      || !["set_status", "request_stop"].includes(request.action)) {
      fail(422, "invalid_session_action", "Supply requestId, workItemId, and set_status or request_stop. expectedRevision is optional");
    }
    if (request.action === "set_status" && !isSessionStatus(request.status)) fail(422, "invalid_session_status", "Choose a session status");
    if (request.spendCents !== undefined && (!Number.isSafeInteger(request.spendCents) || request.spendCents < 0))
      fail(422, "invalid_session_spend", "spendCents must be a non-negative integer of cents");
    // RC-2026-09-19-063: cumulative worker reports — rounds of the work loop
    // and tool calls made. Monotonic on the applier; the trip-wire counts the
    // number reported on this very mutation, not only stored history.
    if (request.rounds !== undefined && (!Number.isSafeInteger(request.rounds) || request.rounds < 0))
      fail(422, "invalid_session_rounds", "rounds must be a non-negative integer");
    if (request.toolCalls !== undefined && (!Number.isSafeInteger(request.toolCalls) || request.toolCalls < 0))
      fail(422, "invalid_session_tool_calls", "toolCalls must be a non-negative integer");
    // W4-46 H5: the budget trip-wire fires before anything else touches the
    // session — any interaction with a runaway session stops it first. A
    // spend report on this mutation counts: the limit trips on the number
    // the worker just declared, not only on stored history.
    // RC-2026-09-19-063: the round limit pauses instead of stopping — the
    // session auto-suspends and the worker must report and wait for the
    // owner. The tool-call limit stops like spend: calls are consumed cost.
    // Both run in their own committing transaction OUTSIDE the mutation's:
    // the forced stop/suspend must stay in the log even though the caller's
    // mutation below is rejected (a nested savepoint would roll back).
    const tripped = this.transaction(() => {
      const roomState = this.room(roomId).state;
      const item = roomState.workItems[request.workItemId];
      if (!item) fail(404, "work_not_found", "Work item not found in this Room");
      const session = sessionRecord(item);
      const pendingRounds = request.rounds ?? session.round_count;
      const pendingToolCalls = request.toolCalls ?? session.tool_calls;
      const pendingSpend = request.spendCents ?? session.spend_cents;
      // A session already paused by its round limit stays paused until the
      // owner resumes it — the resume gate below owns that path, so the wire
      // does not re-fire here.
      const alreadyPaused = session.status === "suspended" && session.suspended_by === "round_limit";
      if (!alreadyPaused && !isTerminalSession(session.status) && roundLimitExceeded(item, pendingRounds)) {
        try {
          this.command(token, roomId, { id: `rounds-${request.requestId}`, type: T.SESSION_STATUS_CHANGED,
            data: { workItemId: request.workItemId, expectedRevision: item.revision, status: "suspended",
              suspendReason: "round_limit" } }, expectedSessionBinding);
        } catch {
          // The 409 below still carries the reason; the worker's next
          // heartbeat completes the pause.
        }
        return { kind: "rounds" };
      }
      const toolWire = !isTerminalSession(session.status) && session.budget?.maxToolCalls != null
        && pendingToolCalls > session.budget.maxToolCalls ? "maxToolCalls" : null;
      const wire = (toolWire ?? budgetLimitExceeded(item, this.now()))
        || (!isTerminalSession(session.status) && session.budget?.maxSpendCents != null && pendingSpend !== null
          && pendingSpend > session.budget.maxSpendCents ? "maxSpendCents" : null);
      if (wire) {
        try {
          this.command(token, roomId, { id: `budget-${request.requestId}`, type: T.SESSION_STOPPED,
            data: { workItemId: request.workItemId, expectedRevision: item.revision, status: "failed",
              budgetEnforced: true, reason: "budget_exceeded", limit: wire,
              ...(request.toolCalls !== undefined ? { toolCalls: request.toolCalls } : {}),
              ...(request.rounds !== undefined ? { rounds: request.rounds } : {}) } }, expectedSessionBinding);
        } catch {
          // The 409 below still carries the reason; the worker's next
          // heartbeat completes the stop.
        }
        return { kind: "budget", limit: wire };
      }
      return null;
    });
    if (tripped?.kind === "rounds") fail(409, "round_limit_exceeded", "Session paused: the round limit was exceeded. The next mention or post resumes it");
    if (tripped?.kind === "budget") fail(409, "budget_exceeded", `Session budget exceeded (${tripped.limit}); the session was stopped`);
    return this.transaction(() => {
      const auth = this.authenticate(token, roomId, expectedSessionBinding);
      const prior = this.db.prepare("SELECT e.sequence,e.body FROM commands c JOIN events e ON e.room_id=c.room_id AND e.sequence=c.sequence WHERE c.room_id=? AND c.actor_id=? AND c.id=?").get(roomId, auth.member.id, request.requestId);
      if (prior) {
        const parsedEvent = JSON.parse(prior.body);
        if (!sessionEventMatchesRequest(parsedEvent, request)) fail(409, "idempotency_conflict", "Command ID already used for different content");
        return { sequence: prior.sequence, event: parsedEvent, duplicate: true };
      }
      const roomState = this.room(roomId).state;
      const item = roomState.workItems[request.workItemId];
      if (!item) fail(404, "work_not_found", "Work item not found in this Room");
      // RC-2026-09-19-063: a round-limit pause resumes only with owner (or
      // claim-manager) approval. The approved resume bypasses the
      // anti-collision check below — the owner is deliberately taking over
      // the paused session — and the applier keeps the original worker so
      // they can continue after the owner reviews their report.
      let resumeApproved = false;
      if (request.action === "set_status" && ["active", "processing"].includes(request.status)) {
        const sess = sessionRecord(item);
        if (sess.status === "suspended" && sess.suspended_by === "round_limit") {
          const isOwner = roomState.room.ownerId === auth.member.id;
          if (!isOwner && !memberCan(roomState, auth.member.id, "manage_claims"))
            fail(409, "round_limit_exceeded", "Session is paused by its round limit. The next mention or post resumes it");
          resumeApproved = true;
        }
      }
      if (request.action === "set_status" && !resumeApproved && !memberCan(roomState, auth.member.id, "manage_claims")) {
        // Structural anti-collision: a live claim belongs to its worker.
        // expectedRevision is the compare-and-swap token (checked when the
        // command is applied). A stale heartbeat means the worker went away
        // and the same claim command can take the item. request_stop stays
        // open — it is a signal, not a claim change.
        const conflict = sessionClaimConflict(item, auth.member.id, this.now());
        if (conflict) fail(409, "session_claimed", conflict);
      }
      let type;
      try { type = sessionCommandType(item, request.action, request.status); }
      catch (error) { fail(422, "invalid_session_action", error.message); }
      let budget = null;
      if (request.budget !== undefined) {
        if (type !== T.SESSION_STARTED) fail(422, "invalid_session_budget", "A budget is declared when the session starts");
        try { budget = validateSessionBudget(request.budget); }
        catch (error) { fail(422, "invalid_session_budget", error.message); }
      }
      if (type === T.SESSION_STARTED) {
        const started = sessionRecord(item);
        if (budget?.maxAttempts && started.attempt_count + 1 > budget.maxAttempts)
          fail(409, "budget_exceeded", `Attempt ${started.attempt_count + 1} exceeds the attempt budget of ${budget.maxAttempts}`);
        // The concurrency bound follows the worker: the new claim's declaration
        // wins, otherwise the tightest bound the worker already declared on a
        // live session applies. Undeclared everywhere stays "unknown".
        const others = Object.values(roomState.workItems ?? {}).filter(other =>
          other.id !== item.id && !isTerminalSession(sessionRecord(other).status)
          && sessionRecord(other).worker_member_id === auth.member.id);
        const declared = others.map(other => sessionRecord(other).budget?.maxConcurrent ?? null).filter(v => v !== null);
        const cap = budget?.maxConcurrent ?? (declared.length ? Math.min(...declared) : null);
        if (cap !== null && others.length >= cap)
          fail(409, "budget_exceeded", `Concurrency budget of ${cap} reached (${others.length} active)`);
      }
      // G1: the attempt contract. A start may declare its environment; a stop
      // may record output references. Both are optional and validated.
      if (request.environment !== undefined && type !== T.SESSION_STARTED)
        fail(422, "invalid_session_environment", "An environment is declared when the session starts");
      if (request.outputs !== undefined && type !== T.SESSION_STOPPED)
        fail(422, "invalid_session_outputs", "Output references are recorded when the session stops");
      let environment = null, outputs = null;
      try { environment = validateAttemptEnvironment(request.environment); }
      catch (error) { fail(422, "invalid_session_environment", error.message); }
      try { outputs = validateAttemptOutputs(request.outputs); }
      catch (error) { fail(422, "invalid_session_outputs", error.message); }
      const data = { workItemId: request.workItemId };
      if (request.expectedRevision !== undefined) data.expectedRevision = request.expectedRevision;
      if (type === T.SESSION_STATUS_CHANGED || type === T.SESSION_STOPPED) data.status = request.status;
      if (type === T.SESSION_STARTED && budget) data.budget = budget;
      if (type === T.SESSION_STARTED && environment) data.environment = environment;
      if (type === T.SESSION_STOPPED && outputs) data.outputs = outputs;
      if (request.spendCents !== undefined && type !== T.SESSION_STOP_REQUESTED) data.spendCents = request.spendCents;
      if (request.rounds !== undefined && type !== T.SESSION_STOP_REQUESTED) data.rounds = request.rounds;
      if (request.toolCalls !== undefined && type !== T.SESSION_STOP_REQUESTED) data.toolCalls = request.toolCalls;
      if (resumeApproved) data.resumeApproved = true;
      return this.command(token, roomId, { id: request.requestId, type, data }, expectedSessionBinding);
    });
  }
  // Who is around: the active roster, plus live SSE watchers and fresh
  // session claims. lastSeenAt is last command `at` or session heartbeat.
  // Derived from existing data — no new tables, no people-data store.
  presence(token, roomId, watcherMemberIds, expectedSessionBinding = null) {
    return this.readTransaction(() => {
      this.authenticate(token, roomId, expectedSessionBinding);
      const { members, ownerId } = this.roomAuthority(roomId);
      const room = this.room(roomId);
      const now = this.now();
      const working = new Map();
      const heartbeats = new Map();
      for (const item of Object.values(room.state.workItems ?? {})) {
        const session = sessionRecord(item);
        if (session.worker_member_id && session.heartbeat_at) {
          const prev = heartbeats.get(session.worker_member_id);
          if (!prev || session.heartbeat_at > prev) heartbeats.set(session.worker_member_id, session.heartbeat_at);
        }
        const worker = sessionWorker(item, now);
        if (!worker) continue;
        if (!working.has(worker)) working.set(worker, []);
        working.get(worker).push({ workItemId: item.id, title: item.title, heartbeat_at: item.heartbeat_at });
      }
      const lastCommandAt = new Map(this.db.prepare(
        `SELECT json_extract(body,'$.actorId') AS actor, max(json_extract(body,'$.at')) AS at
         FROM events WHERE room_id=? GROUP BY actor`
      ).all(roomId).filter(row => row.actor).map(row => [row.actor, row.at]));
      const addedAt = new Map(this.db.prepare(
        `SELECT json_extract(body,'$.data.memberId') AS member, MIN(json_extract(body,'$.at')) AS at
         FROM events WHERE room_id=? AND json_extract(body,'$.type')='member.added' GROUP BY member`
      ).all(roomId).filter(row => row.member).map(row => [row.member, row.at]));
      const watching = new Set((watcherMemberIds ?? []).filter(memberId => members[memberId]?.active !== false));
      // RC-2026-09-18-051: additive host presence for agent members.
      const identityLinkOf = this.db.prepare("SELECT identity_id AS identityId FROM identity_links WHERE room_id=? AND member_id=?");
      // #660: raw host status per member. status is "online"|"offline"|null
      // (null = no registered host); identityId is the linked agent identity.
      const hostStatusOf = memberId => {
        const m = members[memberId];
        if (!m || m.kind !== "agent" || m.active === false) return { identityId: null, status: null, lastSeenAt: null };
        const link = identityLinkOf.get(roomId, memberId);
        if (!link) return { identityId: null, status: null, lastSeenAt: null };
        const status = this.agentHeartbeats.statusOf(link.identityId);
        // Unregistered (no host) stays null so RC-051 clients keep the
        // "no presence field or absent" contract. Roster still lists the member.
        if (status.status === "unregistered") return { identityId: link.identityId, status: null, lastSeenAt: null };
        return { identityId: link.identityId, status: status.status, lastSeenAt: status.lastSeenAt };
      };
      const agentPresence = memberId => {
        const host = hostStatusOf(memberId);
        if (host.status === null) return null;
        return { status: host.status, lastSeenAt: host.lastSeenAt };
      };
      // #660: unreachable threshold is 60 min or 3x the host heartbeat
      // interval, whichever is smaller.
      const unreachableAfterMs = Math.min(
        PRESENCE_UNREACHABLE_AFTER_MS,
        3 * this.agentHeartbeats.staleAfterMs
      );
      const listed = Object.values(members)
        .filter(m => m && m.active !== false)
        .map(m => {
          const lastSeenAt = [lastCommandAt.get(m.id), heartbeats.get(m.id), addedAt.get(m.id)].filter(Boolean).sort().at(-1) ?? null;
          const host = hostStatusOf(m.id);
          const workingOn = working.get(m.id) ?? [];
          const isWatching = watching.has(m.id);
          return {
            memberId: m.id, displayName: m.displayName, kind: m.kind,
            watching: isWatching, workingOn,
            lastSeenAt, statusMessage: m.statusMessage ?? null,
            presence: agentPresence(m.id),
            // #660: derived working state + owner/scope projection (additive).
            state: presenceState({
              kind: m.kind,
              hasActiveSession: workingOn.length > 0,
              watching: isWatching,
              hostStatus: host.status,
              hostLastSeenAt: host.lastSeenAt,
              lastCommandAt: lastCommandAt.get(m.id) ?? null,
              lastSeenAt,
              unreachableAfterMs,
              now,
            }),
            isOwner: m.id === ownerId,
            scopes: Array.isArray(m.permissions) ? [...m.permissions] : [],
            ownerIdentityId: m.kind === "agent" ? host.identityId : null,
          };
        })
        .sort((a, b) => a.memberId < b.memberId ? -1 : 1);
      // RC-2026-09-18-054: next[] follows who is actually around — watching,
      // holding work, or in a live presence state (a host heartbeat inside
      // the live window) — not the idle roster. A pull-only agent that
      // heartbeated a minute ago is around even when nobody is watching
      // its stream; the old filter called that "nobody online".
      const onlineIds = listed.filter(m => m.watching || m.workingOn.length > 0
        || m.state === "listening" || m.state === "working").map(m => m.memberId);
      return {
        members: listed,
        next: Object.freeze(presenceNext(roomId, onlineIds)),
      };
    });
  }
  capabilities(token, roomId, bindingOrOptions = null, options = {}) {
    // 3rd arg may be the legacy session binding or an options object.
    const opts = bindingOrOptions && typeof bindingOrOptions === "object" ? bindingOrOptions : options;
    const expectedSessionBinding = opts.expectedSessionBinding ?? (typeof bindingOrOptions === "string" || bindingOrOptions === null ? bindingOrOptions : null);
    const search = opts.search ?? null;
    if (search !== null && (typeof search !== "string" || !search.trim() || search.length > 80)) fail(422, "invalid_search", "Search is 1 to 80 characters");
    return this.readTransaction(() => {
      this.authenticate(token, roomId, expectedSessionBinding);
      const { members } = this.roomAuthority(roomId);
      const needle = search?.toLowerCase();
      // RC-2026-09-18-051: additive host presence for agent members.
      const identityLinkOf = this.db.prepare("SELECT identity_id AS identityId FROM identity_links WHERE room_id=? AND member_id=?");
      const agentPresence = m => {
        if (!m || m.kind !== "agent" || m.active === false) return null;
        const link = identityLinkOf.get(roomId, m.id);
        if (!link) return null;
        const status = this.agentHeartbeats.statusOf(link.identityId);
        return { status: status.status, lastSeenAt: status.lastSeenAt };
      };
      const listed = Object.values(members)
        .filter(m => m && m.active !== false && Array.isArray(m.capabilities) && m.capabilities.length > 0)
        .filter(m => !needle || m.capabilities.some(c => c.toLowerCase().includes(needle)))
        .sort((a, b) => a.id < b.id ? -1 : 1);
      return { members: listed.map(m => ({ memberId: m.id, displayName: m.displayName, kind: m.kind,
          capabilities: m.capabilities, presence: agentPresence(m) })),
        // RC-2026-09-18-055: finding who can do the work is half the
        // delegation loop — name how to hand it over. The first listed
        // member is a concrete assignee example.
        next: Object.freeze(capabilitiesNext(roomId, listed.map(m => ({ id: m.id, kind: m.kind })))),
      };
    });
  }
  // Round-2 #105: onboarding funnel metrics. provisionedAt = member.added,
  // firstClaimAt = first work.accepted by the member, firstResultAt = first
  // work.completed by the member. Nulls mean "hasn't happened yet".
  // Round-2 #106: JSONL event-log export for audit/portability. Streams
  // {sequence, event} lines; the consumer replays them in order for #107.
  *exportEvents(token, roomId, expectedSessionBinding = null) {
    this.authenticate(token, roomId, expectedSessionBinding);
    const sequence = this.room(roomId).sequence;
    const stmt = this.db.prepare("SELECT sequence,body FROM events WHERE room_id=? AND sequence>? ORDER BY sequence LIMIT 1000");
    let after = 0;
    for (;;) {
      const rows = stmt.all(roomId, after);
      if (!rows.length) break;
      for (const r of rows) yield { sequence: r.sequence, event: JSON.parse(r.body) };
      after = rows.at(-1).sequence;
      if (after >= sequence) break;
    }
  }
  // Round-2 #107: rehydrate a room from a #106 JSONL export. Owner-only and
  // destructive — it replaces the room's event log. Each line is validated
  // (dense sequences, matching roomId, well-formed event) and the projection
  // is rebuilt by replaying applyEvent from empty state, so a corrupt export
  // fails before anything is written.
  importEvents(token, roomId, lines, expectedSessionBinding = null) {
    return this.transaction(() => {
      const auth = this.authenticate(token, roomId, expectedSessionBinding);
      const { ownerId } = this.roomAuthority(roomId);
      if (auth.member.id !== ownerId) fail(403, "owner_required", "Only the room owner can import history");
      refuseArchivedWrite(this.room(roomId).state);
      if (!Array.isArray(lines) || !lines.length || lines.length > 10000) fail(422, "invalid_import", "Import is 1 to 10000 event lines");
      const events = lines.map((line, i) => {
        if (!line || typeof line !== "object" || line.sequence !== i + 1) fail(422, "invalid_import", `Line ${i + 1} breaks the event sequence`);
        const e = line.event;
        if (!e || typeof e !== "object" || e.roomId !== roomId || !e.type || !e.actorId || !e.at || !e.id) fail(422, "invalid_import", `Line ${i + 1} is not a well-formed event`);
        return e;
      });
      let state;
      try { state = compact(events.reduce(applyEvent, emptyRoomState())); }
      catch (error) { fail(422, "invalid_import", `Export does not replay: ${error.message}`); }
      if (new Set(events.map(e => e.id)).size !== events.length) fail(422, "invalid_import", "Import has duplicate event ids");
      // Dependent rows reference event ids/sequences; a history replacement
      // drops them. Pending invitations are lost on restore (documented).
      this.db.prepare("DELETE FROM commands WHERE room_id=?").run(roomId);
      this.db.prepare("DELETE FROM membership_invitation_events WHERE invitation_id IN (SELECT id FROM membership_invitations WHERE room_id=?)").run(roomId);
      this.db.prepare("DELETE FROM membership_invitations WHERE room_id=?").run(roomId);
      // Reader cursors point into the old history; reset them.
      this.db.prepare("DELETE FROM cursors WHERE room_id=?").run(roomId);
      // The projection checkpoint is a replay accelerator over the old
      // history — a stale checkpoint would corrupt rebuildProjection, so
      // replace it with one taken from the imported state.
      this.db.prepare("DELETE FROM projection_checkpoints WHERE room_id=?").run(roomId);
      this.db.prepare("DELETE FROM events WHERE room_id=?").run(roomId);
      const insert = this.db.prepare("INSERT INTO events VALUES(?,?,?,?)");
      events.forEach((e, i) => insert.run(roomId, i + 1, e.id, JSON.stringify(e)));
      this.db.prepare("UPDATE rooms SET sequence=?,projection=?,archived_at=? WHERE id=?").run(events.length, JSON.stringify(state), archivedAtOf(state), roomId);
      this.db.prepare("INSERT INTO projection_checkpoints(room_id,sequence,projection) VALUES(?,?,?)").run(roomId, events.length, JSON.stringify(state));
      return { imported: events.length, sequence: events.length };
    });
  }
  // Round-2 #112: threaded replies. Returns the root message plus its
  // reply tree (messages whose replyToId chains back to the root).
  messageThread(token, roomId, messageId, expectedSessionBinding = null) {
    return this.readTransaction(() => {
      this.authenticate(token, roomId, expectedSessionBinding);
      const { members } = this.roomAuthority(roomId);
      const room = this.room(roomId);
      const root = room.state.messages.find(m => m.id === messageId);
      if (!root) fail(404, "message_not_found", "Message not found");
      const byParent = new Map();
      for (const m of room.state.messages) {
        if (!m.replyToId) continue;
        if (!byParent.has(m.replyToId)) byParent.set(m.replyToId, []);
        byParent.get(m.replyToId).push(m);
      }
      const attach = message => ({
        ...message,
        author: members[message.authorId]?.displayName ?? message.authorId,
        replies: (byParent.get(message.id) ?? []).map(attach)
      });
      return { roomId, thread: attach(root) };
    });
  }
  // Round-2 #113: full-text search over messages and work items.
  // Substring match, case-insensitive; deleted messages are excluded.
  // kind=pinned narrows to messages in state.pins (issue #6 B2), in message
  // order like the other kinds. Backlog 11: messages by an author the caller
  // muted (E4) are excluded for every kind, server-side (mutedEvent), so
  // agents and other API readers match the UI.
  search(token, roomId, query, kind = "all", expectedSessionBinding = null) {
    if (typeof query !== "string" || !query.trim() || query.length > 80) fail(422, "invalid_search", "Search is 1 to 80 characters");
    if (!["all", "messages", "work", "pinned"].includes(kind)) fail(422, "invalid_search", "kind is all, messages, work, or pinned");
    return this.readTransaction(() => {
      const auth = this.authenticate(token, roomId, expectedSessionBinding);
      const room = this.room(roomId);
      const needle = query.trim().toLowerCase();
      const result = { roomId, query: query.trim(), messages: [], workItems: [] };
      if (kind === "all" || kind === "messages" || kind === "pinned") {
        for (const m of room.state.messages ?? []) {
          if (m.body == null) continue; // tombstone
          if (kind === "pinned" && !isPinned(room.state, m.id)) continue;
          if (mutedEvent(room.state, auth.member?.id, { actorId: m.authorId })) continue; // muted author (E4), every kind
          if (m.body.toLowerCase().includes(needle)) {
            result.messages.push({ id: m.id, authorId: m.authorId, body: m.body, createdAt: m.createdAt, workItemId: m.workItemId });
          }
        }
      }
      if (kind === "all" || kind === "work") {
        for (const w of Object.values(room.state.workItems ?? {})) {
          const haystack = `${w.title ?? ""} ${w.description ?? ""} ${w.definitionOfDone ?? ""}`.toLowerCase();
          if (haystack.includes(needle)) {
            result.workItems.push({ id: w.id, title: w.title, state: w.state, accountableMemberId: w.accountableMemberId });
          }
        }
      }
      return result;
    });
  }
  // Round-2 #118: provider heartbeat dashboard. Per-provider liveness
  // derived from work-session heartbeats: live / stale / idle, plus what
  // each provider is currently working on. Members-only read.
  providerHeartbeats(token, roomId, expectedSessionBinding = null) {
    return this.readTransaction(() => {
      this.authenticate(token, roomId, expectedSessionBinding);
      const { members } = this.roomAuthority(roomId);
      const room = this.room(roomId);
      const now = this.now();
      const providers = [];
      for (const member of Object.values(members)) {
        if (member.kind !== "agent" || member.active === false) continue;
        let lastHeartbeatAt = null;
        const workingOn = [];
        for (const item of Object.values(room.state.workItems ?? {})) {
          const session = sessionRecord(item);
          if (session.worker_member_id !== member.id || !session.heartbeat_at) continue;
          if (!lastHeartbeatAt || session.heartbeat_at > lastHeartbeatAt) lastHeartbeatAt = session.heartbeat_at;
          if (sessionWorker(item, now) === member.id) {
            workingOn.push({ workItemId: item.id, title: item.title, heartbeat_at: session.heartbeat_at });
          }
        }
        const stale = !lastHeartbeatAt || now - Date.parse(lastHeartbeatAt) > SESSION_HEARTBEAT_STALE_MS;
        providers.push({
          memberId: member.id, displayName: member.displayName,
          capabilities: member.capabilities ?? [],
          lastHeartbeatAt,
          status: !lastHeartbeatAt ? "idle" : stale ? "stale" : "live",
          workingOn
        });
      }
      providers.sort((a, b) => (b.lastHeartbeatAt ?? "") < (a.lastHeartbeatAt ?? "") ? -1 : 1);
      return { roomId, evaluatedAt: new Date(now).toISOString(), providers };
    });
  }
  // Compact catch-up. sinceVersion equal to context_version returns
  // { not_modified: true } and no roster, work, or refs. Message and file
  // bodies are never part of either shape.
  roomContext(token, roomId, { sinceVersion = null, expectedSessionBinding = null } = {}) {
    return this.readTransaction(() => {
      const auth = this.authenticate(token, roomId, expectedSessionBinding);
      if (sinceVersion !== null && (typeof sinceVersion !== "string" || !/^[a-f0-9]{64}$/.test(sinceVersion))) {
        fail(422, "invalid_context_version", "since_version must be the previous context_version (64 lowercase hex characters), or omit it");
      }
      const room = this.room(roomId);
      const caughtUp = this.db.prepare("SELECT sequence FROM cursors WHERE room_id=? AND member_id=?").get(roomId, auth.member.id)?.sequence ?? 0;
      const built = buildRoomContext({
        state: room.state, sequence: room.sequence, viewerId: auth.member.id, caughtUp, now: this.now()
      });
      const identity = {
        viewerId: auth.member.id, viewerAccountId: auth.account?.id ?? null, viewerAuthEpoch: auth.account?.authEpoch ?? null,
        viewerSessionBinding: auth.sessionBinding, viewerSessionRevision: auth.sessionRevision ?? null
      };
      if (sinceVersion === built.context_version) {
        return { not_modified: true, context_version: built.context_version, roomId, ...identity };
      }
      return { ...built, ...identity };
    });
  }
  workContext(token, roomId, workItemId, { includeSource = false, includeOffers = false, expectedSessionBinding = null } = {}) {
    return this.readTransaction(() => {
      const auth = this.authenticate(token, roomId, expectedSessionBinding);
      if (!validId(workItemId) || typeof includeSource !== "boolean" || typeof includeOffers !== "boolean") fail(422, "invalid_work_context", "Choose one work ID and boolean context options");
      const room = this.room(roomId), now = this.now();
      if (!Object.hasOwn(room.state.workItems, workItemId)) fail(404, "work_not_found", "Work item not found in this Room");
      return { ...selectedWorkContext({ state: room.state, workItemId, viewerId: auth.member.id, sequence: room.sequence, now, includeSource, includeOffers }),
        viewerId: auth.member.id, viewerAccountId: auth.account?.id ?? null, viewerAuthEpoch: auth.account?.authEpoch ?? null,
        viewerSessionBinding: auth.sessionBinding, viewerSessionRevision: auth.sessionRevision ?? null };
    });
  }
  workDiscussion(token, roomId, workItemId, { cursor = null, since, limit, expectedSessionBinding = null } = {}) {
    return this.readTransaction(() => {
      const auth = this.authenticate(token, roomId, expectedSessionBinding);
      if (!validId(workItemId)) fail(422, "invalid_discussion", "Choose one work item");
      const room = this.room(roomId);
      if (!Object.hasOwn(room.state.workItems, workItemId)) fail(404, "work_not_found", "Work item not found in this Room");
      const window = discussionWindow({ sequence: room.sequence, roomId, workItemId, viewerId: auth.member.id, cursor, since, limit });
      const anchorId = this.db.prepare("SELECT id FROM events WHERE room_id=? AND sequence=?").get(roomId, window.horizon)?.id;
      if (!anchorId || (window.anchorId !== null && window.anchorId !== anchorId)) fail(409, "discussion_history_changed", "Discussion history changed; restart after recovery");
      const metadata = this.db.prepare("SELECT sequence,id,json_extract(body,'$.data.messageId') AS message_id FROM events WHERE room_id=? AND sequence<=? AND json_extract(body,'$.type')=? ORDER BY sequence").all(roomId, window.horizon, T.MESSAGE_POSTED);
      return { ...selectedWorkDiscussion({ state: room.state, workItemId, viewerId: auth.member.id, sequence: room.sequence,
        now: this.now(), metadata, window, anchorId, cursor }),
        viewerAccountId: auth.account?.id ?? null, viewerAuthEpoch: auth.account?.authEpoch ?? null,
        viewerSessionBinding: auth.sessionBinding, viewerSessionRevision: auth.sessionRevision ?? null };
    });
  }
  workResult(token, roomId, workItemId, { completionEventId = null, draftMessageId = null, expectedSessionBinding = null } = {}) {
    return this.readTransaction(() => {
      const auth = this.authenticate(token, roomId, expectedSessionBinding);
      if (!validId(workItemId) || [completionEventId, draftMessageId].some(id => id !== null && !validId(id))
        || completionEventId !== null && draftMessageId !== null) fail(422, "invalid_result_selection", "Choose current result, one completion, or one draft");
      const room = this.room(roomId);
      if (!Object.hasOwn(room.state.workItems, workItemId)) fail(404, "work_not_found", "Work item not found in this Room");
      let value;
      try { value = selectedWorkResult({ db: this.db, state: room.state, workItemId, sequence: room.sequence, now: this.now(), completionEventId, draftMessageId }); }
      catch { fail(422, "result_unavailable", "Exact text evidence is unavailable; no other result was substituted"); }
      if (!value) fail(404, "result_not_found", "Completion not found on this work; no other result was substituted");
      return { ...value, viewerId: auth.member.id, viewerAccountId: auth.account?.id ?? null, viewerAuthEpoch: auth.account?.authEpoch ?? null,
        viewerSessionBinding: auth.sessionBinding, viewerSessionRevision: auth.sessionRevision ?? null };
    });
  }
  eventsAfter(token, roomId, after = 0, limit = 100, bindingOrOptions = null, options = {}) {
    // 5th arg may be the legacy session binding or an options object.
    const opts = bindingOrOptions && typeof bindingOrOptions === "object" && !Array.isArray(bindingOrOptions)
      ? bindingOrOptions : options;
    const expectedSessionBinding = opts.expectedSessionBinding ?? (typeof bindingOrOptions === "string" || bindingOrOptions === null ? bindingOrOptions : null);
    const { actor = null, since = null, until = null } = opts;
    // #658: mention timeouts are evaluated lazily on read. The flip needs a
    // write-capable transaction, so it runs before the query_only read
    // below; usually a no-op (one indexed UPDATE, zero rows touched).
    this.flipExpiredMentions(roomId);
    return this.readTransaction(() => {
      const auth = this.authenticate(token, roomId, expectedSessionBinding);
      if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail(422, "invalid_cursor", "Invalid event cursor or limit");
      if (actor !== null && (typeof actor !== "string" || !actor)) fail(422, "invalid_cursor", "Invalid actor filter");
      for (const [name, value] of [["since", since], ["until", until]]) {
        if (value !== null && (typeof value !== "string" || Number.isNaN(Date.parse(value)))) fail(422, "invalid_cursor", `Invalid ${name} timestamp`);
      }
      const sequence = this.room(roomId).sequence;
      if (after > sequence) fail(409, "cursor_ahead", "Cursor exceeds room history; fetch a fresh snapshot");
      // Round-2 #110: audit filters. The event log is the audit log —
      // every mutation records actorId + at, so "who did what when" is a
      // filtered read, not a new table.
      const events = this.db.prepare(
        `SELECT sequence,body FROM events WHERE room_id=? AND sequence>?
         AND (? IS NULL OR json_extract(body,'$.actorId')=?)
         AND (? IS NULL OR json_extract(body,'$.at')>=?)
         AND (? IS NULL OR json_extract(body,'$.at')<=?)
         ORDER BY sequence LIMIT ?`
      ).all(roomId, after, actor, actor, since, since, until, until, limit).map(r => ({ sequence: r.sequence, event: JSON.parse(r.body) }));
      // The cursor advances by what was SCANNED, not by what was returned.
      // A filter can match nothing in a stretch of the log: taking `next` from
      // the last returned row left it at the caller's own `after`, while
      // hasMore was measured against the room's unfiltered sequence - so a
      // client following the documented next/hasMore contract asked for the
      // same empty page forever. Fewer rows than the limit means the scan
      // reached the end of the log, so the cursor belongs at that end.
      //
      // This is computed before the DM filter below on purpose: the cursor
      // must describe what was scanned, not what this viewer was allowed to
      // see, or two members would page the same log at different speeds.
      const reachedEnd = events.length < limit;
      const next = reachedEnd ? sequence : events.at(-1).sequence;
      // RC-2026-09-18-012: targeted-DM privacy. A message.posted event
      // carrying data.toMemberId is a direct message: only its sender and
      // its addressed member may read it. Other events (including
      // non-targeted messages and room-level events that also carry a
      // toMemberId, like ownership transfers) are unaffected. The cursor
      // still advances past filtered events so pagination cannot stall.
      const viewerId = auth.member.id;
      const identityId = this.bonds.identityForMember(roomId, viewerId);
      const isOwner = viewerId === this.room(roomId).state.room.ownerId;
      const visible = events.filter(({ event }) =>
        (event?.type !== T.MESSAGE_POSTED || !event?.data?.toMemberId
        || event.actorId === viewerId || event.data.toMemberId === viewerId)
        && peerEventVisible(event, { memberId: viewerId, identityId, isOwner }));
      // #658: mention chips ride on message views. One batched query for
      // the whole page (no N+1); only members who can read the room see it.
      const messageIds = visible.filter(({ event }) => event?.type === T.MESSAGE_POSTED).map(({ event }) => event.id);
      const members = this.room(roomId).state.members ?? {};
      const chips = this.mentionChipsForEvents(roomId, members, messageIds);
      for (const { event } of visible) {
        if (event?.type === T.MESSAGE_POSTED && chips.has(event.id)) event.mentions = chips.get(event.id);
      }
      return { events: visible, next, hasMore: next < sequence };
    });
  }
  // RC-2026-09-18-012: agent-scoped unified inbox. An authenticated agent
  // member reads its own items only:
  //   - targeted DMs addressed to it (message.posted with toMemberId = me),
  //   - collab threads currently assigned to it,
  //   - open @agent routing mentions naming it,
  //   - direct @mentions of it that are still waiting for an answer
  //     (mention_states delivered/acknowledged/timed_out), with the message
  //     text, so an agent that only polls its inbox never misses a question.
  // Additive and room-scoped; the human /api/inbox/* account-session gate
  // is untouched. The HTTP layer additionally requires agent membership
  // and, for API-key callers, the inbox:read scope.
  agentInbox(token, roomId, { limit = 50, expectedSessionBinding = null } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) fail(422, "invalid_inbox_limit", "Limit must be an integer 1..200");
    // RC-2026-09-18-013: the first per-room collab access lazily replays the
    // persisted journal inside a WRITE transaction. That replay cannot run
    // inside the readTransaction below ("Cannot write inside a read-only
    // transaction" -> 500), so warm it here first. Idempotent once warm.
    this.collab.listAssignments(roomId);
    // Consent-bound DMs: incoming pending requests for the inbox. Read
    // outside the readTransaction below — the module wraps reads in a
    // write-capable transaction, which cannot nest inside a read-only one.
    // authenticate() is a pure read, so calling it twice is harmless.
    const preAuth = this.authenticate(token, roomId, expectedSessionBinding);
    const dmRequests = this.dmConsents.pendingFor(roomId, preAuth.member.id);
    return this.readTransaction(() => {
      const auth = this.authenticate(token, roomId, expectedSessionBinding);
      const memberId = auth.member.id;
      const directMessages = this.db.prepare(
        `SELECT sequence, body FROM events WHERE room_id=?
         AND json_extract(body,'$.type')=? AND json_extract(body,'$.data.toMemberId')=?
         ORDER BY sequence DESC LIMIT ?`)
        .all(roomId, T.MESSAGE_POSTED, memberId, limit)
        .map(row => {
          const parsed = JSON.parse(row.body);
          return {
            sequence: row.sequence,
            messageId: parsed.data.messageId ?? null,
            from: parsed.actorId,
            body: parsed.data.body,
            at: parsed.at,
            channel: "room",
          };
        });
      const assignments = this.collab.listAssignments(roomId)
        .filter(record => record.status === "assigned"
          && record.assignee?.kind === "agent" && record.assignee?.id === memberId)
        .map(record => ({
          assignmentId: record.assignmentId,
          threadId: record.threadId,
          channel: channelOfThreadId(record.threadId),
          assignedBy: record.assignedBy,
          assignedAt: record.assignedAt,
        }));
      const mentions = this.collab.listRouting(roomId).records
        .filter(record => record.agent === memberId && ["routed", "escalated"].includes(record.status))
        .map(record => ({
          routingId: record.routingId,
          threadId: record.threadId,
          channel: channelOfThreadId(record.threadId),
          from: record.from,
          context: record.context,
          mode: record.mode,
          status: record.status,
          createdAt: record.createdAt,
        }));
      const directMentions = this.openDirectMentions(roomId, memberId, limit);
      // Bond proposals and peer DMs are sibling lists, same composition as
      // routing mentions (items plus a next action). Direct @mentions stay
      // their own list — friend traffic is not a mention.
      const identityId = this.bonds.identityForMember(roomId, memberId);
      const bondProposals = identityId ? this.bonds.pendingProposalsFor(identityId) : [];
      // RC-2026-09-24-210: peer-DM bodies are room-scoped — the inbox shows
      // only messages posted in this room, never another room's DM traffic.
      const peerMessages = identityId ? this.bonds.recentMessagesFor(identityId, roomId, limit) : [];
      return Object.freeze({
        agentId: memberId,
        roomId,
        directMessages: Object.freeze(directMessages),
        assignments: Object.freeze(assignments),
        mentions: Object.freeze(mentions),
        directMentions: Object.freeze(directMentions),
        bondProposals: Object.freeze(bondProposals),
        peerMessages: Object.freeze(peerMessages),
        next: Object.freeze(inboxNext(roomId, directMessages, assignments, mentions, directMentions, bondProposals, peerMessages)),
        dmRequests: Object.freeze(dmRequests),
      });
    });
  }
  // Direct @mentions of this member that nobody has answered yet, newest
  // first, joined to the message that carried them. Pure read: expiry is
  // derived from timeout_at here rather than flipped, because this runs
  // inside a read-only transaction. A mention inside a private message is
  // shown only to that message's two parties. A database from before the
  // #658 schema has no mention_states table and simply has no mentions.
  openDirectMentions(roomId, memberId, limit = 50, nowMs = this.now()) {
    let rows;
    try {
      rows = this.db.prepare(
        `SELECT m.message_event_id AS eventId, m.state, m.timeout_at AS timeoutAt, e.sequence, e.body
         FROM mention_states m JOIN events e ON e.room_id=m.room_id AND e.id=m.message_event_id
         WHERE m.room_id=? AND m.mentioned_member_id=? AND m.state IN ('delivered','acknowledged','timed_out')
         ORDER BY e.sequence DESC LIMIT ?`
      ).all(roomId, memberId, limit);
    } catch (error) {
      if (/no such table/i.test(error?.message ?? "")) return [];
      throw error;
    }
    // timed_out is terminal, so a late reply does not flip the row. Once this
    // member has replied to that message, it is no longer waiting in the inbox.
    const answeredBy = new Map();
    if (rows.some(row => row.state === "timed_out")) {
      for (const message of this.room(roomId).state.messages ?? []) {
        if (message.authorId === memberId && message.replyToId) answeredBy.set(message.replyToId, true);
      }
    }
    return rows.map(row => ({ row, event: JSON.parse(row.body) }))
      .filter(({ event }) => event?.type === T.MESSAGE_POSTED
        && (!event.data?.toMemberId || event.data.toMemberId === memberId || event.actorId === memberId))
      .filter(({ row, event }) => row.state !== "timed_out" || !answeredBy.get(event.data.messageId ?? row.eventId))
      .map(({ row, event }) => Object.freeze({
        sequence: row.sequence,
        eventId: row.eventId,
        messageId: event.data.messageId ?? null,
        replyToId: event.data.messageId ?? row.eventId,
        from: event.actorId,
        body: event.data.body,
        at: event.at,
        state: row.state !== "timed_out" && row.timeoutAt <= nowMs ? "timed_out" : row.state,
        channel: event.data.channelId ?? "general",
        private: Boolean(event.data.toMemberId),
        ...(event.data.toMemberId ? { replyToMemberId: event.actorId } : {}),
      }));
  }
  // Return-brief wiring (disposition 5557850637): one read transaction keeps the frozen
  // horizon, the cursor, the paged events, and the live projection at the same commit.
  // Fetching never acknowledges - only markCaughtUp does, explicitly.
  returnBrief(token, roomId, { horizon = null, after = null, cursor: frozenCursor = null, limit = RETURN_BRIEF_DEFAULT_LIMIT, expectedSessionBinding = null } = {}) {
    return this.readTransaction(() => {
      const auth = this.authenticate(token, roomId, expectedSessionBinding);
      const room = this.room(roomId);
      const cursor = this.db.prepare("SELECT sequence FROM cursors WHERE room_id=? AND member_id=?").get(roomId, auth.member.id)?.sequence ?? 0;
      const { H, startAfter, C, limit: pageLimit } = resolveHistoryWindow({ sequence: room.sequence, storedCursor: cursor, horizon, after, continuationCursor: frozenCursor, limit });
      const rows = this.db.prepare("SELECT sequence, body FROM events WHERE room_id=? AND sequence>? AND sequence<=? ORDER BY sequence LIMIT ?").all(roomId, startAfter, H, pageLimit)
        .map(r => ({ sequence: r.sequence, event: JSON.parse(r.body) }));
      const brief = buildReturnBrief({ sequence: room.sequence, workItems: room.state.workItems, rows, H, startAfter, C, memberId: auth.member.id });
      const identityId = this.bonds.identityForMember(roomId, auth.member.id);
      const isOwner = auth.member.id === room.state.room.ownerId;
      brief.history.items = brief.history.items.filter(({ event }) => peerEventVisible(event, { memberId: auth.member.id, identityId, isOwner }));
      return { roomId, viewerId: auth.member.id, viewerAccountId: auth.account?.id ?? null, viewerAuthEpoch: auth.account?.authEpoch ?? null, viewerSessionBinding: auth.sessionBinding, viewerSessionRevision: auth.sessionRevision ?? null, ...brief };
    });
  }
  markCaughtUp(token, roomId, sequence, expectedSessionBinding = null) {
    return this.transaction(() => {
      const auth = this.authenticate(token, roomId, expectedSessionBinding);
      if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > this.room(roomId).sequence) fail(422, "invalid_cursor", "Invalid caught-up cursor");
      this.db.prepare("INSERT INTO cursors VALUES(?,?,?) ON CONFLICT(room_id,member_id) DO UPDATE SET sequence=max(cursors.sequence,excluded.sequence)").run(roomId, auth.member.id, sequence);
      return { cursor: this.db.prepare("SELECT sequence FROM cursors WHERE room_id=? AND member_id=?").get(roomId, auth.member.id).sequence };
    });
  }
  command(token, roomId, command, expectedSessionBinding = null) {
    validateCommand(command);
    return this.transaction(() => {
      const auth = this.authenticate(token, roomId, expectedSessionBinding);
      // RC-2026-09-23-100: guest-agent scope gate (dual-check part 2 of the
      // GX-invite design). Guest members may post chat messages and set
      // reactions; drafts (message.posted carrying a workItemId) need the
      // contributor tier recorded at redemption. Every other command type
      // is refused outright — a guest can never hold a scope outside
      // guest:*, even if some other path granted permission bits.
      if (auth.member && isGuestAgentMemberId(auth.member.id)) {
        const tier = this.guestInvites.guestTierOf(auth.member.id) ?? "observer";
        const isDraft = command.type === T.MESSAGE_POSTED && command.data?.workItemId != null;
        const allowed = command.type === T.MESSAGE_REACTION_SET
          || (command.type === T.MESSAGE_POSTED && (!isDraft || tier === "contributor"));
        if (!allowed) fail(403, "guest_scope_denied", "Guest members cannot perform this action");
      }
      const fingerprint = hash(canonical(command));
      const prior = this.db.prepare("SELECT c.fingerprint,e.sequence,e.body FROM commands c JOIN events e ON e.room_id=c.room_id AND e.sequence=c.sequence WHERE c.room_id=? AND c.actor_id=? AND c.id=?").get(roomId, auth.member.id, command.id);
      if (prior) {
        if (prior.fingerprint !== fingerprint) fail(409, "idempotency_conflict", "Command ID already used for different content");
        return { sequence: prior.sequence, event: JSON.parse(prior.body), duplicate: true };
      }
      // Live chat posts and replies only. The replay above, importEvents,
      // initialize, and projection replay do not reach this line.
      this.roomFlood.consume(roomId, auth.member.id, command.type);
      if (command.causationId && !this.db.prepare("SELECT 1 FROM events WHERE room_id=? AND id=?").get(roomId, command.causationId)) fail(422, "invalid_cause", "Causation event must exist in this room");
      // bond.list is a read. It does not append a ledger event, so an archived
      // room can still answer it. Writes below still hit refuseArchivedWrite.
      if (command.type === "bond.list") {
        const listed = this.room(roomId);
        return { sequence: listed.sequence, duplicate: false, event: null, bonds: this.bonds.listForMember(roomId, auth.member.id) };
      }
      const room = this.room(roomId);
      refuseArchivedWrite(room.state);
      if (command.type === T.MESSAGE_POSTED && typeof command.data.toMemberId === "string" && command.data.toMemberId) {
        // DMs are open by default: only an explicit denial (blocked /
        // rejected / revoked) refuses. Runs before the event is built, so a
        // refused DM never persists and never wakes its target.
        this.dmConsents.requireDmAllowed(roomId, auth.member.id, command.data.toMemberId);
      }
      // Room Trust off: a post that would wake a cross-owner agent still
      // lands. The wake is skipped and the result carries a note. Assign
      // stays blocked in the reducer.
      const skippedWakes = command.type === T.MESSAGE_POSTED
        ? agentWakeTargetIds(room.state, auth.member.id, command.data)
          .filter(id => firstBlockedWakeTarget(room.state, auth.member.id, [id]))
        : [];
      const target = room.state.members[command.data.memberId];
      const endingAccess = command.type === T.MEMBER_ACCESS_CHANGED && target?.active === true && command.data.active === false
        && canonical(target.permissions) === canonical(command.data.permissions);
      const requestMode = command.type === T.MESSAGE_POSTED && replyPostMode(command.data);
      const endingRequest = (requestMode === "respond" || command.type === T.REPLY_REQUEST_CANCELLED)
        && room.state.replyRequests?.[command.data.responseToRequestId ?? command.data.requestMessageId]?.status === "open";
      const endingHelp = command.type === T.WORK_HELP_UPDATED && command.data.status === "withdrawn"
        && room.state.workItems[command.data.workItemId]?.helpWanted?.status === "open";
      const priorOffer = room.state.helpOffers?.[command.data.offerId];
      const endingOffer = command.type === HELP_OFFER_UPDATED &&
        (priorOffer?.status === "offered" && ["declined", "withdrawn"].includes(command.data.status)
          || priorOffer?.status === "selected" && command.data.status === "released");
      const endingClaim = command.type === T.CLAIM_RELEASED
        && room.state.workItems[command.data.workItemId]?.claim?.status === "active";
      // Hard lock for the work-item claim, on every write path (not only
      // POST /work-sessions). Live-only: replay of an older manager override
      // still applies. The holder re-claims; a fresh foreign holder conflicts.
      // Owner resume of a round-limit pause is the existing supervised handoff.
      if ([T.SESSION_STARTED, T.SESSION_STATUS_CHANGED, T.SESSION_STOPPED].includes(command.type)) {
        const heldItem = room.state.workItems?.[command.data?.workItemId];
        const supervisedResume = command.data?.resumeApproved === true
          && (room.state.room?.ownerId === auth.member.id || memberCan(room.state, auth.member.id, "manage_claims"));
        if (heldItem && !supervisedResume && !memberCan(room.state, auth.member.id, "manage_claims")) {
          const conflict = sessionClaimConflict(heldItem, auth.member.id, this.now());
          if (conflict) fail(409, "session_claimed", conflict);
        }
      }
      const HALT_GATED = [T.WORK_PROPOSED, T.WORK_ACCEPTED, T.WORK_STARTED, T.WORK_BLOCKED, T.WORK_BLOCKER_RESOLVED,
        T.WORK_COMPLETED, T.WORK_SUPERSEDED, T.CLAIM_ACQUIRED, T.CLAIM_RELEASED, T.CLAIM_RENEWED, T.VERIFICATION_RECORDED, T.OWNER_DECISION_RECORDED];
      if (HALT_GATED.includes(command.type) && room.state.agentHalts?.[auth.member.id])
        fail(409, "halt_active", "This member recorded halt-all; a steer/decide member must clear the exact halt before further work mutations");
      const workItem = room.state.workItems[command.data.workItemId];
      const endingWork = (command.type === T.WORK_COMPLETED && [WORK_STATES.ACCEPTED, WORK_STATES.WORKING].includes(workItem?.state))
        || (command.type === T.WORK_BLOCKER_RESOLVED && workItem?.state === WORK_STATES.BLOCKED)
        || (command.type === T.WORK_SUPERSEDED && workItem != null && workItem.state !== WORK_STATES.SUPERSEDED && !workItem.supersededBy);
      const endingSession = [T.SESSION_STOP_REQUESTED, T.SESSION_STOPPED].includes(command.type)
        && workItem != null && !isTerminalSession(sessionRecord(workItem).status);
      const cleanup = endingAccess || endingRequest || endingHelp || endingOffer || endingClaim || endingWork || endingSession || command.type === T.ROOM_ARCHIVED;
      // At capacity, each remaining membership/request/help/offer/claim and each open work item can still be ended once.
      if ((room.sequence >= PILOT_LIMITS.eventsPerRoom && !cleanup) || (command.type === T.MEMBER_ADDED && Object.keys(room.state.members).length >= PILOT_LIMITS.membersPerRoom) || (command.type === T.WORK_PROPOSED && Object.keys(room.state.workItems).length >= PILOT_LIMITS.workItemsPerRoom)) fail(409, "pilot_limit", "Bounded pilot capacity reached; no data was changed");
      enforceSpendAllowance(room.state, command, this.now(), fail); // C3: a start that would exceed the room allowance is refused
      // Graduated autonomy tiers: read fresh from the table on every command,
      // so a demotion to t1_readonly wins on the agent's next write. New
      // agent members enroll at t2_standard (see autonomy-tiers.mjs).
      enforceAutonomyTiers({ db: this.db, roomId, state: room.state, command, actor: auth.member, nowMs: this.now(), fail });
      // Bond / peer DM. Room chat (message.posted) is unchanged and still
      // requires room membership plus DM consent when toMemberId is set.
      // Peer DMs are a separate command, gated by an active bond with peer.dm.
      let bondEffect = null;
      if (this.bonds.handles(command.type)) {
        bondEffect = this.bonds.prepare(roomId, auth.member.id, command);
        if (bondEffect.kind === "idempotent") {
          return { sequence: room.sequence, duplicate: true, event: null, bond: bondEffect.bond };
        }
      }
      const memberAuthorityEvent = [T.MEMBER_ADDED, T.MEMBER_ACCESS_CHANGED].includes(command.type);
      const incoming = event({
        type: bondEffect?.eventType ?? command.type, roomId, actorId: auth.member.id, at: new Date(this.now()).toISOString(),
        idempotencyKey: hash(`${auth.member.id}:${command.id}`), causationId: command.causationId,
        data: bondEffect ? bondEffect.data
          : memberAuthorityEvent ? { ...command.data, authorityPolicyVersion: MEMBERSHIP_AUTHORITY_POLICY_VERSION }
          : requestMode ? { ...command.data, requestPolicyVersion: REPLY_POLICY_VERSION } : command.data
      });
      let state;
      try {
        if (requestMode === "respond") {
          const basis = this.db.prepare("SELECT id,body FROM events WHERE room_id=? AND sequence=?").get(roomId, command.data.contextSequence);
          if (basis?.id !== command.data.contextEventId || JSON.parse(basis.body).type !== T.MESSAGE_POSTED) throw new Error("Stale reply request context sequence");
        }
        state = compact(applyEventWithGrowth(room.state, incoming, growthCollector).state);
        if (incoming.type === T.WORK_COMPLETED && incoming.data.evidenceKind === "room_text") verifyTextCompletion(this.db, room.state, room.state.workItems[incoming.data.workItemId], incoming.data);
      }
      catch (error) {
        if (error?.code === TRUST_OFF_CODE) fail(403, TRUST_OFF_CODE, error.message);
        if (/^Claim held by [A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(error.message)) fail(409, "session_claimed", error.message);
        if (command.type === T.MESSAGE_REACTION_SET && (/^Event data missing /.test(error.message) || error.message === "Invalid reaction choice")) {
          fail(422, "invalid_arguments", error.message);
        }
        fail(/Stale|already exists|Invalid transition|Invalid session|Stop already|capacity reached|cannot be pinned|already_offered|helper_selected|history_full|offer_limit|Offer transition unavailable/.test(error.message) ? 409 : 422, "command_rejected", error.message);
      }
      // Integration map slice 5: the external path is only as strong as
      // its signature. Room_text is unchanged above; every other completion
      // must carry a signed evidence object that verifies against the agent
      // key registry. This runs outside the catch above so evidence
      // failures keep their typed status (422 for a bad object, 409 for a
      // replay) instead of collapsing into command_rejected.
      if (incoming.type === T.WORK_COMPLETED && incoming.data.evidenceKind !== "room_text") {
        try {
          verifyCompletionEvidence(this.db, this.keyRegistry, roomId, incoming.data);
        } catch (error) {
          if (error instanceof EvidenceError) throw new ServiceError(error.code === "duplicate_evidence" ? 409 : 422, error.code, error.message);
          throw error;
        }
      }
      if (incoming.type === T.CLAIM_ACQUIRED) {
        // Same transaction as actor/revision validation and persistence. Keeping
        // this live-only preserves replay of previously accepted reservations.
        const conflict = conflictingClaim(room.state.workItems, state.workItems[incoming.data.workItemId], Date.parse(incoming.at));
        if (conflict) fail(409, "claim_conflict", `Scope is reserved by work ${conflict.id}. Coordinate or release that reservation first; no new claim was saved.`);
      }
      const projection = JSON.stringify(state);
      if (Buffer.byteLength(projection) > PILOT_LIMITS.projectionBytes && !cleanup) fail(409, "pilot_limit", "Room projection limit reached; no data was changed");
      const sequence = room.sequence + 1;
      this.db.prepare("INSERT INTO events VALUES(?,?,?,?)").run(roomId, sequence, incoming.id, JSON.stringify(incoming));
      if (bondEffect?.dm) this.bonds.sealDm(bondEffect.dm, incoming.id);
      this.db.prepare("INSERT INTO commands VALUES(?,?,?,?,?)").run(roomId, auth.member.id, command.id, fingerprint, sequence);
      this.db.prepare("UPDATE rooms SET sequence=?,projection=?,archived_at=? WHERE id=?").run(sequence, projection, archivedAtOf(state), roomId);
      if (command.data.workItemId) this.reminders.resolveWork(roomId, state.workItems[command.data.workItemId]);
      if (command.type === T.MEMBER_ACCESS_CHANGED) this.agentConnections.revokeMember(roomId, command.data.memberId);
      if (command.type === T.MEMBER_ACCESS_CHANGED && command.data.active === false) {
        this.db.prepare("UPDATE credentials SET revoked=1 WHERE room_id=? AND member_id=?").run(roomId, command.data.memberId);
        this.reminders.retireMember(roomId, command.data.memberId);
      }
      // RC-2026-09-18-051: wake-on-mention. An @-mention or DM addressed to
      // an offline wakeable agent enqueues a wake signal (delivered on the
      // agent's next heartbeat) and journals an agent.wake webhook delivery
      // for any subscription the agent registered. Runs in the same
      // transaction as the message event, so a wake is never recorded
      // without its triggering message.
      if (command.type === T.MESSAGE_POSTED) {
        this.maybeWakeOnMention(roomId, state, auth.member.id, command.data, incoming.id);
        state = this.resumeRoundLimitPauses(roomId, state, auth.member.id, incoming, sequence);
      }
      if (command.type === T.DM_POSTED && incoming.data?.toIdentityId) {
        // Same agent.wake path as room mentions: queue a signal, then journal
        // it through deliverWakePing. Event-push (wakeUrl fan-out) lives
        // inside that function when present; this command does not POST.
        const { woken, signal } = this.agentHeartbeats.wakeIfOffline({
          agentId: incoming.data.toIdentityId, kind: "dm", roomId, messageId: incoming.data.messageId ?? incoming.id
        });
        if (woken && signal) this.agentPlugin.deliverWakePing({ identityId: incoming.data.toIdentityId, signal });
        // RC-2026-09-24-203: push doorbell — a pointer-only POST for the
        // offline agent's push subscription (the inbox pull carries the
        // body). Fire-and-forget; never fails the command.
        if (woken) this.agentHeartbeats.pushNotify({ identityId: incoming.data.toIdentityId,
          eventType: "dm.posted", roomId, id: incoming.data.messageId ?? incoming.id, ts: this.now() });
      }
      // RC-2026-09-24-203: push doorbell for bond proposals. Both parties
      // (not the proposer, who is online by definition) get a pointer-only
      // POST when offline with a push subscription.
      if (bondEffect?.eventType === "bond.proposed" && bondEffect.data) {
        const { agentAId, agentBId, proposerIdentityId, bondId } = bondEffect.data;
        for (const partyId of [agentAId, agentBId]) {
          if (typeof partyId === "string" && partyId.length > 0 && partyId !== proposerIdentityId) {
            this.agentHeartbeats.pushNotify({ identityId: partyId, eventType: "bond.proposed",
              roomId, id: typeof bondId === "string" ? bondId : incoming.id, ts: this.now() });
          }
        }
      }
      // #658: mention lifecycle. Runs in the same transaction as the message
      // event: mention rows are never recorded without their triggering
      // message, and a post by a mentioned member marks their pending
      // mentions responded in the same transaction. Never throws for
      // unparseable input — an unresolvable mention is simply not tracked.
      if (command.type === T.MESSAGE_POSTED) this.trackMentions(roomId, state, auth.member.id, command.data, incoming.id);
      // Attention: write-time activity fan-out (mention/reply/thread_reply/
      // reaction). Runs in the same transaction as the triggering event.
      // Never throws: a fan-out failure must not fail the command.
      try { recordActivityEvents(this, roomId, state, auth.member.id, command, incoming); } catch {}
      // Jev-harness receipt-acceptance gate, shadow mode (docs/JEV-GATES.md):
      // score the legacy event-sourced work.completed receipt, journal the
      // would-be verdict, accept anyway. Runs in the same transaction as
      // the completion; never throws — shadow measurement must not fail
      // the command that triggered it.
      if (command.type === T.WORK_COMPLETED) {
        try { this.jevShadowCompletedReceipt({ roomId, command, incoming, priorItem: room.state.workItems[command.data.workItemId] }); }
        catch {}
      }
      // RC-2026-09-19-064: signed webhook fan-out. Every persisted room
      // event is offered to enabled webhook subscriptions whose event
      // filter matches. Journaled in the same transaction as the event
      // insert (a delivery is never created without its triggering
      // event); the idempotency key makes double-apply safe, and the
      // drain kicks fire-and-forget right after the request path returns
      // (the Cloudflare cron sweep stays the restart-safe backstop).
      // Never throws — fan-out must not fail the command that triggered it.
      try {
        if (this.agentPlugin && !isPeerPrivateEvent(incoming.type)) this.agentPlugin.fanoutRoomEvent({ roomId, event: incoming });
      } catch (error) {
        console.error("webhook fan-out failed:", error?.message ?? error);
      }
      const note = skippedWakes.length
        ? `Posted. Wake skipped for ${skippedWakes.map(id => room.state.members?.[id]?.displayName || id).join(", ")}: Room Trust is off, so that agent was not woken.`
        : null;
      return { sequence, event: incoming, duplicate: false, ...(note ? { note } : {}) };
    });
  }

  // Jev-harness receipt-acceptance gate, shadow mode (docs/JEV-GATES.md):
  // maps the legacy event-sourced work.completed receipt onto the receipt
  // scorer and journals the would-be verdict. The completion is already
  // accepted at this point — this is measurement, never enforcement.
  // Caller wraps in try/catch: never throws into the command path.
  jevShadowCompletedReceipt({ roomId, command, incoming, priorItem }) {
    const data = command.data ?? {};
    // Review-policy mapping: the legacy item carries its verification
    // requirements, so the policy strength is read from the item rather
    // than the completion payload.
    const reviewPolicy = priorItem?.independentVerificationRequired ? "independent_principal"
      : priorItem?.verifierMemberId ? "distinct_member" : "self_attested";
    const summary = typeof data.summary === "string" ? data.summary : "";
    const evidenceUrl = typeof data.evidenceUrl === "string" ? data.evidenceUrl : "";
    const priorAt = priorItem?.updatedAt ? Date.parse(priorItem.updatedAt) : null;
    const decision = evaluateReceipt({
      workId: data.workItemId, ownerId: incoming.actorId,
      reviewPolicy, attestations: [], // verifications land after completion on the legacy path
      reviewerIsVerifier: false, deliveryMode: null,
      // The scorer's artifact heuristic looks for URLs/PR references in
      // the receipt text; the display-only evidenceUrl is part of the
      // receipt as presented, so it rides along in the note.
      note: evidenceUrl ? `${summary} ${evidenceUrl}` : summary,
      claimedAtMs: Number.isFinite(priorAt) ? priorAt : null, // last mutation before completion (start/block/resolve)
      doneAtMs: Date.parse(incoming.at), at: this.now(),
    });
    this.jevShadow.record({ gate: "receipt", roomId, identityId: incoming.actorId ?? null,
      subject: data.workItemId, path: "work.completed",
      score: decision.quality, decision: decision.verdict,
      escalate: decision.escalate, signals: decision.signals, at: this.now() });
  }

  // A round-limit pause clears when the paused worker is mentioned, DM'd,
  // or posts. The resume is a normal session.status_changed with
  // resumeApproved, so replay still refuses a status change that lacks it.
  // Runs inside the message transaction. A resume that cannot apply is
  // skipped; the post still stands. The room event cap is unchanged.
  resumeRoundLimitPauses(roomId, state, senderMemberId, messageEvent, sequence) {
    const body = typeof messageEvent?.data?.body === "string" ? messageEvent.data.body : "";
    const mentioned = new Set(resolveMentionTargetsInText(state.members ?? {}, {}, body, senderMemberId));
    const dmId = typeof messageEvent?.data?.toMemberId === "string" ? messageEvent.data.toMemberId : "";
    let next = state;
    let seq = sequence;
    for (const item of Object.values(state.workItems ?? {})) {
      if (seq >= PILOT_LIMITS.eventsPerRoom) break;
      const session = sessionRecord(item);
      if (session.status !== "suspended" || session.suspended_by !== "round_limit") continue;
      const worker = session.worker_member_id;
      if (!worker) continue;
      if (senderMemberId !== worker && !mentioned.has(worker) && dmId !== worker) continue;
      const actor = state.members?.[worker];
      const can = actor && actor.active !== false && (
        (worker === item.accountableMemberId && memberCan(state, worker, "accept_work"))
        || memberCan(state, worker, "steer"));
      if (!can) continue;
      const incoming = event({
        type: T.SESSION_STATUS_CHANGED, roomId, actorId: worker, at: messageEvent.at,
        idempotencyKey: hash(`${messageEvent.id}:resume:${item.id}`), causationId: messageEvent.id,
        data: { workItemId: item.id, status: "active", resumeApproved: true }
      });
      let resumed;
      try { resumed = compact(applyEvent(next, incoming)); }
      catch { continue; }
      const projection = JSON.stringify(resumed);
      if (Buffer.byteLength(projection) > PILOT_LIMITS.projectionBytes) continue;
      seq += 1;
      this.db.prepare("INSERT INTO events VALUES(?,?,?,?)").run(roomId, seq, incoming.id, JSON.stringify(incoming));
      next = resumed;
    }
    if (seq !== sequence) {
      this.db.prepare("UPDATE rooms SET sequence=?,projection=? WHERE id=?").run(seq, JSON.stringify(next), roomId);
    }
    return next;
  }

  // Wake-on-mention for message.posted: resolve @mentions and the DM target
  // to agent members, then wake the offline ones via their registered
  // agent identity. Never throws for unparseable input — a mention that
  // resolves to nobody (or to an online agent) is simply not woken.
  maybeWakeOnMention(roomId, state, senderMemberId, data, eventId) {
    const targets = agentWakeTargets(state, senderMemberId, data);
    if (targets.size === 0) return;
    const linkOf = this.db.prepare("SELECT identity_id AS identityId FROM identity_links WHERE room_id=? AND member_id=?");
    for (const [memberId, kind] of targets) {
      // Trust off skips the wake. The post already landed; the command result
      // names the skip.
      if (firstBlockedWakeTarget(state, senderMemberId, [memberId])) continue;
      const link = linkOf.get(roomId, memberId);
      if (!link) continue;
      const { woken, signal } = this.agentHeartbeats.wakeIfOffline({
        agentId: link.identityId, kind, roomId, messageId: data.messageId ?? eventId });
      if (woken && signal) {
        this.agentPlugin.deliverWakePing({ identityId: link.identityId, signal });
        // RC-2026-09-24-203: push doorbell — a pointer-only POST for the
        // offline agent's push subscription; the inbox pull carries the body.
        // Targeted DMs (kind "dm") ride dm.posted, @mentions ride message.posted.
        this.agentHeartbeats.pushNotify({ identityId: link.identityId,
          eventType: kind === "dm" ? "dm.posted" : "message.posted",
          roomId, id: data.messageId ?? eventId, ts: this.now() });
      }
    }
  }

  // #658: mention lifecycle tracking. Called inside command()'s transaction
  // for every message.posted. Two jobs:
  //   1. A reply to one mention marks that mention responded. An unrelated
  //      post leaves the others waiting. timed_out stays terminal; a late
  //      reply only removes it from the waiting inbox.
  //   2. @names in the body resolve to room members (never the sender);
  //      each resolved member gets one delivered row for this message event.
  // Unresolved names get no row — never invent a recipient.
  trackMentions(roomId, state, senderMemberId, data, eventId) {
    const nowMs = this.now();
    const replyToId = typeof data.replyToId === "string" ? data.replyToId : "";
    if (replyToId) {
      const pending = this.db.prepare(
        `SELECT m.message_event_id AS eventId, e.body
         FROM mention_states m JOIN events e ON e.room_id=m.room_id AND e.id=m.message_event_id
         WHERE m.room_id=? AND m.mentioned_member_id=? AND m.state IN ('delivered','acknowledged')`
      ).all(roomId, senderMemberId);
      const answered = pending.find(row => {
        let parsed = null;
        try { parsed = JSON.parse(row.body); } catch { parsed = null; }
        return (parsed?.data?.messageId || row.eventId) === replyToId;
      });
      if (answered) this.db.prepare(
        `UPDATE mention_states SET state='responded', decided_at=?
         WHERE room_id=? AND message_event_id=? AND mentioned_member_id=? AND state IN ('delivered','acknowledged')`
      ).run(nowMs, roomId, answered.eventId, senderMemberId);
    }
    const body = typeof data.body === "string" ? data.body : "";
    if (!body.includes("@")) return;
    const members = state?.members ?? {};
    let identityNames = {};
    try {
      const links = this.db.prepare(
        `SELECT l.member_id AS memberId, i.display_name AS displayName FROM identity_links l
         JOIN agent_identities i ON i.identity_id=l.identity_id
         WHERE l.room_id=? AND i.revoked_at IS NULL`).all(roomId);
      for (const row of links) identityNames[row.memberId] = row.displayName;
    } catch { identityNames = {}; }
    const timeoutMs = this.mentionTimeoutMsFor(roomId);
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO mention_states
       (room_id,message_event_id,mentioned_member_id,state,created_at,timeout_at,decided_at)
       VALUES(?,?,?,?,?,?,NULL)`);
    for (const memberId of resolveMentionTargetsInText(members, identityNames, body, senderMemberId)) {
      insert.run(roomId, eventId, memberId, "delivered", nowMs, nowMs + timeoutMs);
    }
  }

  // #658: per-room mention timeout, defaulting to 30 minutes. Owner-
  // configurable via setMentionTimeout; absent rows read as the default.
  mentionTimeoutMsFor(roomId) {
    const row = this.db.prepare("SELECT timeout_ms AS timeoutMs FROM room_mention_settings WHERE room_id=?").get(roomId);
    const timeoutMs = Number(row?.timeoutMs);
    return Number.isSafeInteger(timeoutMs) && timeoutMs >= MENTION_TIMEOUT_MS_MIN && timeoutMs <= MENTION_TIMEOUT_MS_MAX
      ? timeoutMs : MENTION_TIMEOUT_MS_DEFAULT;
  }

  // #658: owner-only timeout override for a room.
  setMentionTimeout(token, roomId, timeoutMs, expectedSessionBinding = null) {
    const auth = this.authenticate(token, roomId, expectedSessionBinding);
    if (auth.member.id !== this.room(roomId).state.room.ownerId) fail(403, "owner_required", "Only the room owner can configure mention timeouts");
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < MENTION_TIMEOUT_MS_MIN || timeoutMs > MENTION_TIMEOUT_MS_MAX) {
      fail(422, "invalid_mention_timeout", `timeoutMs must be an integer between ${MENTION_TIMEOUT_MS_MIN} and ${MENTION_TIMEOUT_MS_MAX}`);
    }
    return this.transaction(() => {
      this.db.prepare(
        `INSERT INTO room_mention_settings(room_id,timeout_ms,updated_at) VALUES(?,?,?)
         ON CONFLICT(room_id) DO UPDATE SET timeout_ms=excluded.timeout_ms, updated_at=excluded.updated_at`
      ).run(roomId, timeoutMs, this.now());
      return { roomId, timeoutMs };
    });
  }

  // #658: lazily flip expired delivered|acknowledged rows to timed_out.
  // Runs inside the caller's transaction (write-capable paths) or as its
  // own write transaction before a read path — never inside query_only.
  flipExpiredMentions(roomId, nowMs = this.now()) {
    // Cheap guard first: eventsAfter runs on every SSE pump (250ms per
    // connection), so the common no-expired-rows case must stay a single
    // indexed read, never a write transaction.
    // Defensive: a database from before the #658 schema has no mention_states
    // table; treat that (and only that) as nothing-to-flip rather than
    // throwing and breaking event listing. Any other error still throws.
    let expired;
    try {
      expired = this.db.prepare(
        `SELECT 1 FROM mention_states
         WHERE room_id=? AND state IN ('delivered','acknowledged') AND timeout_at<=? LIMIT 1`
      ).get(roomId, nowMs);
    } catch (error) {
      if (!/no such table/i.test(error?.message ?? "")) throw error;
      return 0;
    }
    if (!expired) return 0;
    const run = () => this.db.prepare(
      `UPDATE mention_states SET state='timed_out', decided_at=?
       WHERE room_id=? AND state IN ('delivered','acknowledged') AND timeout_at<=?`
    ).run(nowMs, roomId, nowMs);
    return this.db.isTransaction ? run().changes : this.transaction(run).changes;
  }

  // #658: explicit acknowledgement. Member-only and idempotent: the caller
  // acks their own mention row for the message event. Acking a message with
  // no mention row at all is 404; a row that names someone else is 403.
  // Terminal states return the current state unchanged (idempotent).
  acknowledgeMention(token, roomId, messageEventId, expectedSessionBinding = null) {
    const auth = this.authenticate(token, roomId, expectedSessionBinding);
    return this.transaction(() => {
      this.flipExpiredMentions(roomId);
      const mine = this.db.prepare(
        "SELECT state FROM mention_states WHERE room_id=? AND message_event_id=? AND mentioned_member_id=?"
      ).get(roomId, messageEventId, auth.member.id);
      if (!mine) {
        const any = this.db.prepare(
          "SELECT 1 FROM mention_states WHERE room_id=? AND message_event_id=?").get(roomId, messageEventId);
        fail(any ? 403 : 404, any ? "mention_not_yours" : "mention_not_found",
          any ? "You can only acknowledge your own mentions" : "No mention found for this message");
      }
      if (mine.state !== "delivered") return this.mentionView(roomId, messageEventId, auth.member.id);
      assertTransitionMention("delivered", "acknowledged");
      this.db.prepare(
        "UPDATE mention_states SET state='acknowledged' WHERE room_id=? AND message_event_id=? AND mentioned_member_id=?"
      ).run(roomId, messageEventId, auth.member.id);
      return this.mentionView(roomId, messageEventId, auth.member.id);
    });
  }

  // #658: member-readable mention list. memberId defaults to the caller; an
  // owner may query another member's mentions (feeds the #662 attention
  // card's "N mentions unacknowledged"). Supports state and after filters.
  listMentions(token, roomId, { state = null, after = null, memberId = null } = {}, expectedSessionBinding = null) {
    const auth = this.authenticate(token, roomId, expectedSessionBinding);
    const target = memberId ?? auth.member.id;
    if (typeof target !== "string" || !target) fail(422, "invalid_mention_query", "memberId must be a non-empty string");
    if (state !== null && !["delivered", "acknowledged", "responded", "timed_out"].includes(state)) {
      fail(422, "invalid_mention_query", "state must be one of delivered, acknowledged, responded, timed_out");
    }
    if (after !== null && (typeof after !== "string" || Number.isNaN(Date.parse(after)))) {
      fail(422, "invalid_mention_query", "after must be an ISO timestamp");
    }
    if (target !== auth.member.id && auth.member.id !== this.room(roomId).state.room.ownerId) {
      fail(403, "mention_forbidden", "You can only list your own mentions");
    }
    return this.transaction(() => {
      this.flipExpiredMentions(roomId);
      const rows = this.db.prepare(
        `SELECT message_event_id AS messageEventId, mentioned_member_id AS memberId, state,
                created_at AS createdAt, timeout_at AS timeoutAt, decided_at AS decidedAt
         FROM mention_states
         WHERE room_id=? AND mentioned_member_id=?
           AND (? IS NULL OR state=?) AND (? IS NULL OR created_at>=?)
         ORDER BY created_at DESC LIMIT 200`
      ).all(roomId, target, state, state, after, after === null ? null : Date.parse(after));
      const members = this.room(roomId).state.members ?? {};
      return {
        roomId, memberId: target,
        mentions: rows.map(r => ({
          messageEventId: r.messageEventId, memberId: r.memberId, state: r.state,
          displayName: members[r.memberId]?.displayName ?? r.memberId,
          createdAt: new Date(r.createdAt).toISOString(),
          timeoutAt: new Date(r.timeoutAt).toISOString(),
          decidedAt: r.decidedAt === null ? null : new Date(r.decidedAt).toISOString(),
        })),
      };
    });
  }

  // #658: single mention row view for the ack response.
  mentionView(roomId, messageEventId, memberId) {
    const row = this.db.prepare(
      `SELECT state, created_at AS createdAt, timeout_at AS timeoutAt, decided_at AS decidedAt
       FROM mention_states WHERE room_id=? AND message_event_id=? AND mentioned_member_id=?`
    ).get(roomId, messageEventId, memberId);
    if (!row) return null;
    const members = this.room(roomId).state.members ?? {};
    return {
      roomId, messageEventId, memberId, state: row.state,
      displayName: members[memberId]?.displayName ?? memberId,
      createdAt: new Date(row.createdAt).toISOString(),
      timeoutAt: new Date(row.timeoutAt).toISOString(),
      decidedAt: row.decidedAt === null ? null : new Date(row.decidedAt).toISOString(),
    };
  }

  // #658: batch-load mention chip data for a page of message events. One
  // query for the whole page (no N+1); display names come from the room
  // projection already in hand.
  mentionChipsForEvents(roomId, members, eventIds) {
    if (!eventIds.length) return new Map();
    const placeholders = eventIds.map(() => "?").join(",");
    const rows = this.db.prepare(
      `SELECT message_event_id AS messageEventId, mentioned_member_id AS memberId, state
       FROM mention_states WHERE room_id=? AND message_event_id IN (${placeholders})`
    ).all(roomId, ...eventIds);
    const chips = new Map();
    for (const row of rows) {
      const list = chips.get(row.messageEventId) ?? [];
      list.push({ memberId: row.memberId, displayName: members[row.memberId]?.displayName ?? row.memberId, state: row.state });
      chips.set(row.messageEventId, list);
    }
    return chips;
  }
}
