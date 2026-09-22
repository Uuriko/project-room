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
  version: "1.0.0",
  summary: "Account deletion purges the account's sign-in credentials, "
    + "sessions, room memberships, and profile data. Security audit rows and "
    + "the deactivated account tombstone are retained under legal hold; "
    + "room history already shared with other members is room-owned and is "
    + "not rewritten.",
  purged: Object.freeze([
    Object.freeze({ category: "credentials", description: "Account access keys (account_credentials) are deleted; outstanding keys stop working immediately." }),
    Object.freeze({ category: "sessions", description: "Browser account-session slots (account_session_slots) are deleted; every signed-in browser session ends." }),
    Object.freeze({ category: "login_methods", description: "All linked sign-in methods are deleted: password verifiers, magic codes, and recovery codes." }),
    Object.freeze({ category: "passkeys", description: "All registered passkey credentials are deleted." }),
    Object.freeze({ category: "memberships", description: "Room membership bindings (member_accounts) are deleted; the account leaves every room." }),
    Object.freeze({ category: "profile", description: "The account row is deactivated (active=0), its auth epoch is rotated so no residual credential can authenticate, and display name / avatar are scrubbed." }),
  ]),
  retained: Object.freeze([
    Object.freeze({ category: "audit", reason: "account_access_events rows are retained for security auditing, fraud prevention, and dispute resolution." }),
    Object.freeze({ category: "profile_tombstone", reason: "The account id remains as a deactivated tombstone (active=0, profile scrubbed) so retained audit rows stay attributable. It can never sign in again." }),
    Object.freeze({ category: "room_history", reason: "Room events already shared with other members (messages, work history) are room-owned history and are not rewritten; only the member binding is removed." }),
  ]),
});

const countWhere = (store, table, accountId) =>
  store.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE account_id=?`).get(accountId)?.n ?? 0;

// Build the planner inventory from the live store. Audit rows are legal
// hold (retained, never purged); everything else purges. Sessions purge
// before credentials: account_session_slots.parent_credential_hash is a
// foreign key into account_credentials, so deleting credentials first
// violates it.
export function inventoryFromStore(store, accountId) {
  if (typeof accountId !== "string" || accountId.length === 0) fail(422, "invalid_account", "Invalid account id");
  store.account(accountId); // 404 when missing
  return {
    sessions: { itemCount: countWhere(store, "account_session_slots", accountId), dependsOn: [] },
    credentials: { itemCount: countWhere(store, "account_credentials", accountId), dependsOn: ["sessions"] },
    login_methods: { itemCount: store.accountLogins.listMethods(accountId).length },
    passkeys: { itemCount: store.accountLogins.listPasskeyCredentials(accountId).length },
    memberships: { itemCount: countWhere(store, "member_accounts", accountId) },
    audit: {
      itemCount: countWhere(store, "account_access_events", accountId),
      legalHold: true,
      legalHoldReason: "Access history is retained for security auditing, fraud prevention, and dispute resolution.",
    },
    profile: { itemCount: 1 },
  };
}

// Plan + human-readable confirmation summary for an account.
export function planAccountDeletion(store, accountId) {
  const plan = planDeletion({ id: accountId }, inventoryFromStore(store, accountId));
  return { plan, summary: summarizePurge(plan) };
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
  profile: (store, accountId) => {
    for (const table of ['gmail_mailboxes', 'gmail_pending', 'account_setup']) store.db.prepare(`DELETE FROM ${table} WHERE account_id=?`).run(accountId);
    return store.db.prepare(`UPDATE accounts SET active=0, auth_epoch=auth_epoch+1,
      display_name=NULL, avatar_url=NULL, onboarded=1 WHERE id=?`).run(accountId).changes;
  },
};

// Execute a validated plan inside one transaction: every PURGE step runs
// its executor in planner order; RETAIN steps are reported, never run.
export function executeAccountDeletion(store, plan) {
  const check = validatePurgePlan(plan);
  if (!check.valid) fail(422, "invalid_purge_plan", `Purge plan failed validation: ${check.errors.join("; ")}`);
  if (plan.accountId == null) fail(422, "invalid_purge_plan", "Purge plan is not attributable to an account");
  return store.transaction(() => {
    const purged = [];
    for (const step of plan.steps) {
      if (step.action !== ACTIONS.PURGE) continue;
      const executor = EXECUTORS[step.category];
      if (!executor) fail(422, "unknown_purge_category", `No purge executor for category "${step.category}"`);
      purged.push({ category: step.category, removed: executor(store, plan.accountId) });
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

const planDigest = plan => createHash("sha256").update(JSON.stringify(plan.steps)).digest("hex");

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
