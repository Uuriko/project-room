// RC-2026-09-19-078 — account-deletion wiring.
//
// src/account-deletion.mjs plans WHAT to purge in WHAT order but never
// touches the store. This module is the execution side: it builds the
// purge inventory from the live store, signs short-lived confirmation
// tokens (confirm-then-delete), and executes the plan — actually deleting
// the account's data. The retention policy is documented in
// RETENTION_POLICY and served at GET /api/account/retention.
//
// Deletion flow:
//   1. GET /api/account/deletion/plan -> inventoryFromStore + planDeletion
//      + summarizePurge + a confirmation token bound to (account, plan, 10m).
//   2. POST /api/account/delete { confirmationToken } -> the token is
//      verified against a freshly rebuilt plan (changed data 409s as
//      plan_changed), then executeAccountDeletion runs the purge steps in
//      order inside one transaction.

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { EVENT_TYPES, applyEvent, event, isRoomArchived, roomKind } from "../src/events.js";
import { ServiceError } from "./store.mjs";
import {
  ACTIONS,
  DEFAULT_LEGAL_HOLD_REASON,
  planDeletion,
  summarizePurge,
  validatePurgePlan,
} from "../src/account-deletion.mjs";

const fail = (status, code, message) => { throw new ServiceError(status, code, message); };

// What deletion removes vs retains, and why. Served verbatim at
// GET /api/account/retention and attached to every deletion plan.
export const RETENTION_POLICY = Object.freeze({
  version: "1.2.0",
  summary: "Account deletion purges the account's sign-in credentials, "
    + "sessions, room memberships, connected Gmail data, account setup answers, "
    + "and profile data. Personal rooms this account solely owns are archived "
    + "and their messages and files are purged. Security audit rows and "
    + "the deactivated account tombstone are retained under legal hold; "
    + "room history already shared with other members is room-owned and is "
    + "not rewritten. A shared room with other members and no other owner "
    + "blocks deletion until ownership is transferred.",
  purged: Object.freeze([
    Object.freeze({ category: "personal_room_content", description: "Messages and files in personal rooms this account solely owns are purged, and those rooms are archived." }),
    Object.freeze({ category: "credentials", description: "Account access keys (account_credentials) are deleted; outstanding keys stop working immediately." }),
    Object.freeze({ category: "sessions", description: "Browser account-session slots (account_session_slots) are deleted; every signed-in browser session ends." }),
    Object.freeze({ category: "login_methods", description: "All linked sign-in methods are deleted: password verifiers, magic codes, and recovery codes." }),
    Object.freeze({ category: "passkeys", description: "All registered passkey credentials are deleted." }),
    Object.freeze({ category: "memberships", description: "Room membership bindings (member_accounts) are deleted; the account leaves every room." }),
    Object.freeze({ category: "connected_data", description: "Connected Gmail data (gmail_mailboxes, gmail_linked_mailboxes, gmail_pending, gmail_operations) and account setup answers (account_setup) are permanently deleted." }),
    Object.freeze({ category: "profile", description: "The account row is deactivated (active=0), its auth epoch is rotated so no residual credential can authenticate, and display name / avatar are scrubbed." }),
  ]),
  retained: Object.freeze([
    Object.freeze({ category: "audit", reason: "account_access_events rows are retained for security auditing, fraud prevention, and dispute resolution." }),
    Object.freeze({ category: "profile_tombstone", reason: "The account id remains as a deactivated tombstone (active=0, profile scrubbed) so retained audit rows stay attributable. It can never sign in again." }),
    Object.freeze({ category: "room_history", reason: "Room events already shared with other members (messages, work history) are room-owned history and are not rewritten when another owner remains; only the member binding is removed. Sole ownership of a shared room blocks deletion until that ownership is transferred." }),
  ]),
});

const countWhere = (store, table, accountId) =>
  store.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE account_id=?`).get(accountId)?.n ?? 0;

const PURGED_BODY = "[purged]";
const REDACTED_TYPES = new Set([EVENT_TYPES.MESSAGE_POSTED, EVENT_TYPES.MESSAGE_EDITED, EVENT_TYPES.DM_POSTED]);

const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const freezeList = list => Object.freeze(list.map(entry => Object.freeze({ ...entry })));

function fileCount(store, roomId) {
  try {
    return store.db.prepare(
      "SELECT count(*) AS n FROM room_attachments WHERE room_id=? AND state IN ('staged','committed')"
    ).get(roomId)?.n ?? 0;
  } catch { return 0; }
}

// Another owner is an active human member bound to a different live account.
// Agents stay with their sponsor, so they cannot receive the room.
function otherHumanOwners(store, state, roomId, accountId, ownerMemberId) {
  const heirs = [];
  for (const member of Object.values(state.members ?? {})) {
    if (!member || member.active === false || member.kind !== "human" || member.id === ownerMemberId) continue;
    const row = store.db.prepare(
      "SELECT account_id AS accountId FROM member_accounts WHERE room_id=? AND member_id=?"
    ).get(roomId, member.id);
    if (!row || row.accountId === accountId) continue;
    const account = store.db.prepare("SELECT active FROM accounts WHERE id=?").get(row.accountId);
    if (!account || account.active !== 1) continue;
    heirs.push(member.id);
  }
  heirs.sort();
  return heirs;
}

// QA2 finding P2-11: rooms this account owns, classified so deletion cannot
// leave an ownerless room full of their content.
export function classifyOwnedRooms(store, accountId) {
  const memberships = store.db.prepare(
    "SELECT room_id AS roomId, member_id AS memberId FROM member_accounts WHERE account_id=? ORDER BY room_id"
  ).all(accountId);
  const archive = [], transfer = [], blocked = [], retained = [];
  for (const membership of memberships) {
    let loaded;
    try { loaded = store.room(membership.roomId); }
    catch { continue; }
    const state = loaded.state;
    const ownerMemberId = state.room?.ownerId;
    const entry = {
      id: membership.roomId,
      title: typeof state.room?.title === "string" && state.room.title ? state.room.title : membership.roomId,
      kind: roomKind(state.room),
      memberId: membership.memberId,
      toMemberId: null,
      messages: Array.isArray(state.messages) ? state.messages.length : 0,
      files: fileCount(store, membership.roomId),
    };
    if (ownerMemberId !== membership.memberId) {
      retained.push(entry);
      continue;
    }
    const heirs = otherHumanOwners(store, state, membership.roomId, accountId, membership.memberId);
    const otherMembers = Object.values(state.members ?? {})
      .filter(member => member && member.active !== false && member.id !== membership.memberId);
    if (heirs.length) transfer.push({ ...entry, toMemberId: heirs[0] });
    else if (entry.kind === "personal" || otherMembers.length === 0) archive.push(entry);
    else blocked.push(entry);
  }
  for (const list of [archive, transfer, blocked, retained]) list.sort(byId);
  return {
    archive: freezeList(archive),
    transfer: freezeList(transfer),
    blocked: freezeList(blocked),
    retained: freezeList(retained),
  };
}

function refuseOwnershipTransfer(rooms) {
  const listed = rooms.map(room => `${room.title} (${room.id})`).join(", ");
  const error = new ServiceError(409, "transfer_ownership_required",
    `Transfer ownership of these shared rooms before deleting this account: ${listed}`);
  error.detail = { rooms: rooms.map(room => ({ id: room.id, title: room.title, kind: room.kind })) };
  throw error;
}

const compactState = state => ({ ...state, eventLog: [], seenEvents: {}, seenIdempotencyKeys: {} });

function saveRoomProjection(store, roomId, sequence, state) {
  const compact = compactState(state);
  const archivedAt = typeof compact.room?.archivedAt === "string" ? compact.room.archivedAt : null;
  const projection = JSON.stringify(compact);
  store.db.prepare("UPDATE rooms SET sequence=?, projection=?, archived_at=? WHERE id=?").run(sequence, projection, archivedAt, roomId);
  store.db.prepare(`INSERT INTO projection_checkpoints(room_id, sequence, projection) VALUES(?,?,?)
    ON CONFLICT(room_id) DO UPDATE SET sequence=excluded.sequence, projection=excluded.projection`).run(roomId, sequence, projection);
}

function appendRoomEvent(store, roomId, actorId, type, data) {
  const current = store.room(roomId);
  const incoming = event({ type, actorId, roomId, at: new Date(store.now()).toISOString(), data });
  let next;
  try { next = applyEventOnRoom(current.state, incoming); }
  catch (error) { fail(409, "plan_changed", `Room changed during account deletion; request a fresh plan (${error.message})`); }
  const sequence = current.sequence + 1;
  store.db.prepare("INSERT INTO events VALUES(?,?,?,?)").run(roomId, sequence, incoming.id, JSON.stringify(incoming));
  saveRoomProjection(store, roomId, sequence, next);
}

function applyEventOnRoom(state, incoming) {
  // A compacted projection already has empty seen-event maps, so one new
  // event applies cleanly without replaying the room from scratch.
  const base = {
    ...state,
    eventLog: Array.isArray(state.eventLog) ? state.eventLog : [],
    seenEvents: state.seenEvents && typeof state.seenEvents === "object" ? state.seenEvents : {},
    seenIdempotencyKeys: state.seenIdempotencyKeys && typeof state.seenIdempotencyKeys === "object" ? state.seenIdempotencyKeys : {},
  };
  return applyEvent(base, incoming);
}

function redactRoomMessages(store, roomId) {
  const rows = store.db.prepare("SELECT sequence, body FROM events WHERE room_id=?").all(roomId);
  const update = store.db.prepare("UPDATE events SET body=? WHERE room_id=? AND sequence=?");
  let messages = 0;
  for (const row of rows) {
    let parsed;
    try { parsed = JSON.parse(row.body); }
    catch { continue; }
    if (!REDACTED_TYPES.has(parsed?.type) || typeof parsed.data?.body !== "string" || parsed.data.body === PURGED_BODY) continue;
    parsed.data.body = PURGED_BODY;
    update.run(JSON.stringify(parsed), roomId, row.sequence);
    messages += 1;
  }
  let files = 0;
  try {
    files = store.db.prepare(
      "UPDATE room_attachments SET state='deleted', bytes=NULL, filename='purged' WHERE room_id=? AND state IN ('staged','committed')"
    ).run(roomId).changes;
  } catch { files = 0; }
  return messages + files;
}

function rebuildRoom(store, roomId) {
  store.db.prepare("DELETE FROM projection_checkpoints WHERE room_id=?").run(roomId);
  const rebuilt = store.rebuildProjection(roomId);
  saveRoomProjection(store, roomId, rebuilt.sequence, rebuilt.state);
}

// Archive a solely owned personal room and strip message and file bytes.
// Events are redacted, then the projection is rebuilt so recovery matches.
function archivePersonalRoom(store, room) {
  const removed = redactRoomMessages(store, room.id);
  const state = store.room(room.id).state;
  if (!isRoomArchived(state)) {
    const current = store.room(room.id);
    const incoming = event({
      type: EVENT_TYPES.ROOM_ARCHIVED, actorId: room.memberId, roomId: room.id,
      at: new Date(store.now()).toISOString(), data: { reason: "Account deletion" },
    });
    const sequence = current.sequence + 1;
    store.db.prepare("INSERT INTO events VALUES(?,?,?,?)").run(room.id, sequence, incoming.id, JSON.stringify(incoming));
    store.db.prepare("UPDATE rooms SET sequence=? WHERE id=?").run(sequence, room.id);
  }
  rebuildRoom(store, room.id);
  return removed;
}

function disposeOwnedRooms(store, plan) {
  let removed = 0;
  for (const room of plan.rooms?.transfer ?? []) {
    appendRoomEvent(store, room.id, room.memberId, EVENT_TYPES.OWNERSHIP_TRANSFERRED, {
      toMemberId: room.toMemberId, reason: "Account deletion",
    });
    removed += 1;
  }
  for (const room of plan.rooms?.archive ?? []) removed += archivePersonalRoom(store, room);
  return removed;
}

// Build the planner inventory from the live store. Audit rows are legal
// hold (retained, never purged); everything else purges. Sessions purge
// before credentials: account_session_slots.parent_credential_hash is a
// foreign key into account_credentials, so deleting credentials first
// violates it. Owned rooms are part of the signed plan (QA2 P2-11).
export function inventoryFromStore(store, accountId, rooms = null) {
  if (typeof accountId !== "string" || accountId.length === 0) fail(422, "invalid_account", "Invalid account id");
  store.account(accountId); // 404 when missing
  const owned = rooms ?? classifyOwnedRooms(store, accountId);
  const roomWork = owned.archive.length + owned.transfer.length + owned.blocked.length;
  const inventory = {
    sessions: { itemCount: countWhere(store, "account_session_slots", accountId), dependsOn: [] },
    credentials: { itemCount: countWhere(store, "account_credentials", accountId), dependsOn: ["sessions"] },
    login_methods: { itemCount: store.accountLogins.listMethods(accountId).length },
    passkeys: { itemCount: store.accountLogins.listPasskeyCredentials(accountId).length },
    memberships: {
      itemCount: countWhere(store, "member_accounts", accountId),
      ...(roomWork ? { dependsOn: ["owned_rooms"] } : {}),
    },
    audit: {
      itemCount: countWhere(store, "account_access_events", accountId),
      legalHold: true,
      legalHoldReason: "Access history is retained for security auditing, fraud prevention, and dispute resolution.",
    },
    profile: { itemCount: 1 },
    // Connected Gmail data and account setup answers: purged by their own
    // executor so the signed plan, the retention policy, and the
    // confirmation summary all disclose them (M-1).
    connected_data: {
      itemCount: ["gmail_mailboxes", "gmail_linked_mailboxes", "gmail_pending", "gmail_operations", "account_setup"]
        .reduce((sum, table) => sum + countWhere(store, table, accountId), 0),
    },
  };
  if (roomWork) inventory.owned_rooms = { itemCount: owned.archive.length + owned.transfer.length, dependsOn: [] };
  return inventory;
}

function retentionLines() {
  return "Retention categories purged: " + RETENTION_POLICY.purged.map(entry => entry.category).join(", ") + ".\n"
    + "Retention categories retained: " + RETENTION_POLICY.retained.map(entry => entry.category).join(", ") + ".";
}

// Plan + human-readable confirmation summary for an account. The plan's
// rooms field is part of the confirmation-token digest.
export function planAccountDeletion(store, accountId) {
  const rooms = classifyOwnedRooms(store, accountId);
  const planned = planDeletion({ id: accountId }, inventoryFromStore(store, accountId, rooms));
  const plan = Object.freeze({ ...planned, rooms: Object.freeze({ ...rooms }) });
  const summary = summarizePurge(plan);
  return {
    plan,
    summary: Object.freeze({ ...summary, rooms: plan.rooms, text: `${summary.text}\n${retentionLines()}` }),
  };
}

// One purge executor per inventory category. Each returns the number of
// rows removed. The "profile" step runs last (planner priority 100): it
// scrubs the account row and deactivates it, which also retires any
// credential the earlier steps somehow missed via the auth-epoch check.
const EXECUTORS = {
  credentials: (store, accountId) =>
    store.db.prepare("DELETE FROM account_credentials WHERE account_id=?").run(accountId).changes,
  sessions: (store, accountId) =>
    store.db.prepare("DELETE FROM account_session_slots WHERE account_id=?").run(accountId).changes,
  login_methods: (store, accountId) => {
    let removed = 0;
    for (const table of ["account_login_methods", "account_magic_codes", "account_recovery_codes"]) {
      removed += store.db.prepare(`DELETE FROM ${table} WHERE account_id=?`).run(accountId).changes;
    }
    return removed;
  },
  passkeys: (store, accountId) =>
    store.db.prepare("DELETE FROM account_passkey_credentials WHERE account_id=?").run(accountId).changes,
  memberships: (store, accountId) =>
    store.db.prepare("DELETE FROM member_accounts WHERE account_id=?").run(accountId).changes,
  connected_data: (store, accountId) => {
    let removed = 0;
    for (const table of ["gmail_mailboxes", "gmail_linked_mailboxes", "gmail_pending", "gmail_operations", "account_setup"]) {
      removed += store.db.prepare(`DELETE FROM ${table} WHERE account_id=?`).run(accountId).changes;
    }
    return removed;
  },
  profile: (store, accountId) => {
    return store.db.prepare(`UPDATE accounts SET active=0, auth_epoch=auth_epoch+1,
      display_name=NULL, avatar_url=NULL, onboarded=1 WHERE id=?`).run(accountId).changes;
  },
  owned_rooms: (store, accountId, plan) => disposeOwnedRooms(store, plan),
};

// Execute a validated plan inside one transaction: every PURGE step runs
// its executor in planner order; RETAIN steps are reported, never run.
export function executeAccountDeletion(store, plan) {
  const check = validatePurgePlan(plan);
  if (!check.valid) fail(422, "invalid_purge_plan", `Purge plan failed validation: ${check.errors.join("; ")}`);
  if (plan.accountId == null) fail(422, "invalid_purge_plan", "Purge plan is not attributable to an account");
  if (plan.rooms?.blocked?.length) refuseOwnershipTransfer(plan.rooms.blocked);
  return store.transaction(() => {
    const purged = [];
    for (const step of plan.steps) {
      if (step.action !== ACTIONS.PURGE) continue;
      const executor = EXECUTORS[step.category];
      if (!executor) fail(422, "unknown_purge_category", `No purge executor for category "${step.category}"`);
      purged.push({ category: step.category, removed: executor(store, plan.accountId, plan) });
    }
    return {
      accountId: plan.accountId,
      purged,
      retained: plan.steps
        .filter(step => step.action === ACTIONS.RETAIN)
        .map(step => ({ category: step.category, reason: step.reason ?? DEFAULT_LEGAL_HOLD_REASON })),
    };
  });
}

// ---- Confirm-then-delete tokens ----
//
// The plan endpoint signs a short-lived token bound to (accountId, plan
// digest). The delete endpoint re-plans from the live store and verifies
// the token against the fresh plan: data that changed after confirmation
// 409s as plan_changed instead of deleting something unconfirmed.

const TOKEN_TTL_MS = 10 * 60 * 1000;

const planDigest = plan => createHash("sha256").update(JSON.stringify({
  steps: plan.steps,
  rooms: plan.rooms ?? null,
})).digest("hex");

export function createDeletionSecret() {
  return randomBytes(32);
}

export function issueDeletionToken(secret, accountId, plan, { now = Date.now, ttlMs = TOKEN_TTL_MS } = {}) {
  if (plan.accountId !== accountId) fail(422, "invalid_purge_plan", "Purge plan is not attributable to this account");
  const payload = JSON.stringify({ accountId, digest: planDigest(plan), exp: now() + ttlMs });
  const signature = createHmac("sha256", secret).update(payload, "utf8").digest("hex");
  return `${Buffer.from(payload, "utf8").toString("base64url")}.${signature}`;
}

export function verifyDeletionToken(secret, accountId, plan, token, { now = Date.now } = {}) {
  const invalid = () => fail(401, "invalid_confirmation", "That deletion confirmation is not valid; request a fresh plan");
  if (typeof token !== "string" || !token.includes(".")) invalid();
  const [encoded, signature] = token.split(".");
  let payload;
  try {
    payload = Buffer.from(encoded, "base64url").toString("utf8");
  } catch { invalid(); }
  const expected = createHmac("sha256", secret).update(payload, "utf8").digest();
  let presented;
  try {
    presented = Buffer.from(signature, "hex");
  } catch { invalid(); }
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) invalid();
  let claims;
  try {
    claims = JSON.parse(payload);
  } catch { invalid(); }
  if (claims?.accountId !== accountId || typeof claims?.exp !== "number" || claims.exp <= now()) invalid();
  if (claims.digest !== planDigest(plan) || plan.accountId !== accountId) {
    fail(409, "plan_changed", "Account data changed after the deletion plan was confirmed; request a fresh plan");
  }
  return true;
}
