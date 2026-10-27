// Guest-seat liveness for the webhook wake gates (post-#4576 finding,
// muse-room seq 19133): a disconnected guest seat keeps receiving room
// message bodies via webhook because the wake resolver's guest fallback
// and the webhook drain's batch SELECT admit a seat on its
// guest_members row alone. But that row is NOT the seat's liveness
// state: GuestInvites.disconnect() revokes every credential the seat
// holds and deactivates the member — the guest_members row stays
// behind (a returning guest reactivates the same seat). The seat's
// canonical liveness state is its access credential: unrevoked and
// unexpired in `credentials` for (room_id, member_id) — the exact
// predicate disconnect() (hasLiveCredential) and the expiry sweeps
// ("judge the seat by an unrevoked row only") already use.
//
// These tests pin the resolver leg directly (unit, in-memory) and the
// drain batch SELECT's guest leg verbatim. The end-to-end
// disconnect -> post -> drain flow through the real store is pinned in
// tests/guest-wake-live-seat-drain.test.js.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { memberIdForWakeIdentity } from "../server/wake-identity-resolution.mjs";

const NOW = 1_800_000_000_000;

function seatDb(t, { credentialsTable = true } = {}) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE identity_links (
      room_id TEXT NOT NULL, identity_id TEXT NOT NULL,
      member_id TEXT NOT NULL, linked_at INTEGER NOT NULL);
    CREATE TABLE guest_members (
      member_id TEXT PRIMARY KEY, room_id TEXT NOT NULL,
      guest_identity_id TEXT NOT NULL, tier TEXT NOT NULL,
      invite_id TEXT NOT NULL, created_at INTEGER NOT NULL);
    ${credentialsTable ? `
    CREATE TABLE credentials (
      hash TEXT PRIMARY KEY, room_id TEXT NOT NULL, member_id TEXT NOT NULL,
      kind TEXT NOT NULL, parent_hash TEXT, expires_at INTEGER NOT NULL,
      revoked INTEGER NOT NULL DEFAULT 0,
      account_id TEXT, account_auth_epoch INTEGER);` : ""}
    INSERT INTO identity_links VALUES ('room-a', 'id-linked', 'mem-linked', 1);
    INSERT INTO guest_members VALUES ('mem-live', 'room-a', 'id-live', 'contributor', 'inv-1', 1);
    INSERT INTO guest_members VALUES ('mem-disconnected', 'room-a', 'id-disconnected', 'contributor', 'inv-2', 1);
    INSERT INTO guest_members VALUES ('mem-expired', 'room-a', 'id-expired', 'observer', 'inv-3', 1);
    INSERT INTO guest_members VALUES ('mem-rotated', 'room-a', 'id-rotated', 'contributor', 'inv-4', 1);
    INSERT INTO guest_members VALUES ('mem-session-only', 'room-a', 'id-session-only', 'observer', 'inv-5', 1);
    INSERT INTO guest_members VALUES ('mem-other-room-cred', 'room-a', 'id-other-room-cred', 'observer', 'inv-6', 1);
    ${credentialsTable ? `
    -- live: unrevoked access credential expiring after NOW
    INSERT INTO credentials VALUES ('h-live', 'room-a', 'mem-live', 'access', NULL, ${NOW + 60_000}, 0, NULL, NULL);
    -- disconnected: disconnect() revokes every credential the seat holds
    INSERT INTO credentials VALUES ('h-disc', 'room-a', 'mem-disconnected', 'access', NULL, ${NOW + 60_000}, 1, NULL, NULL);
    -- expired but not yet swept: unrevoked, expires_at in the past
    INSERT INTO credentials VALUES ('h-exp', 'room-a', 'mem-expired', 'access', NULL, ${NOW - 1}, 0, NULL, NULL);
    -- rotated: a revoked predecessor and a live successor
    INSERT INTO credentials VALUES ('h-rot-old', 'room-a', 'mem-rotated', 'access', NULL, ${NOW + 30_000}, 1, NULL, NULL);
    INSERT INTO credentials VALUES ('h-rot-new', 'room-a', 'mem-rotated', 'access', NULL, ${NOW + 60_000}, 0, NULL, NULL);
    -- a session credential is not the seat's access credential
    INSERT INTO credentials VALUES ('h-sess', 'room-a', 'mem-session-only', 'session', NULL, ${NOW + 60_000}, 0, NULL, NULL);
    -- a live credential in another room does not make this seat live
    INSERT INTO credentials VALUES ('h-other', 'room-b', 'mem-other-room-cred', 'access', NULL, ${NOW + 60_000}, 0, NULL, NULL);` : ""}
  `);
  return db;
}

test("resolver guest fallback: only a seat holding a live access credential resolves", t => {
  const db = seatDb(t);
  assert.equal(memberIdForWakeIdentity(db, "room-a", "id-live", NOW), "mem-live",
    "a live guest seat resolves");
  assert.equal(memberIdForWakeIdentity(db, "room-a", "id-disconnected", NOW), null,
    "a disconnected guest does not resolve — its guest_members row remains, its credential is revoked");
  assert.equal(memberIdForWakeIdentity(db, "room-a", "id-expired", NOW), null,
    "an expired guest credential does not resolve, even before the expiry sweep runs");
  assert.equal(memberIdForWakeIdentity(db, "room-a", "id-rotated", NOW), "mem-rotated",
    "a rotated seat resolves on its live successor credential");
  assert.equal(memberIdForWakeIdentity(db, "room-a", "id-session-only", NOW), null,
    "a session-kind credential does not make the seat live");
  assert.equal(memberIdForWakeIdentity(db, "room-a", "id-other-room-cred", NOW), null,
    "liveness is room-scoped: a credential in another room does not count");
  assert.equal(memberIdForWakeIdentity(db, "room-a", "id-linked", NOW), "mem-linked",
    "identity_links seats are not credential-gated");
  // The injected clock drives the boundary: at expires_at the seat is
  // no longer live (the strictly-greater predicate disconnect() uses).
  assert.equal(memberIdForWakeIdentity(db, "room-a", "id-live", NOW + 59_999), "mem-live");
  assert.equal(memberIdForWakeIdentity(db, "room-a", "id-live", NOW + 60_000), null,
    "at expires_at the seat stops resolving");
});

test("resolver guest fallback: a credentials table with no live row for the seat does not resolve", t => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE identity_links (
      room_id TEXT NOT NULL, identity_id TEXT NOT NULL,
      member_id TEXT NOT NULL, linked_at INTEGER NOT NULL);
    CREATE TABLE guest_members (
      member_id TEXT PRIMARY KEY, room_id TEXT NOT NULL,
      guest_identity_id TEXT NOT NULL, tier TEXT NOT NULL,
      invite_id TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE credentials (
      hash TEXT PRIMARY KEY, room_id TEXT NOT NULL, member_id TEXT NOT NULL,
      kind TEXT NOT NULL, parent_hash TEXT, expires_at INTEGER NOT NULL,
      revoked INTEGER NOT NULL DEFAULT 0,
      account_id TEXT, account_auth_epoch INTEGER);
    INSERT INTO guest_members VALUES ('mem-guest', 'room-a', 'id-guest', 'contributor', 'inv-1', 1);
  `);
  assert.equal(memberIdForWakeIdentity(db, "room-a", "id-guest", NOW), null,
    "credentials are tracked and none is live -> no resolution");
});

test("resolver guest fallback: a pre-schema database (no credentials table) resolves on the seat row, as before", t => {
  // credentials is base schema (server/store.mjs) and predates guest
  // seats, so a database carrying guest_members but no credentials
  // table is a pre-schema / synthetic artifact where liveness was
  // never tracked. The module's posture is that such databases read
  // without throwing; stranding their seats would silently change
  // behaviour for fixtures the wake legs were built against. Every
  // production database carries the table, where the gate applies.
  const db = seatDb(t, { credentialsTable: false });
  assert.equal(memberIdForWakeIdentity(db, "room-a", "id-live", NOW), "mem-live",
    "no credentials table -> the seat row alone resolves, as before this gate");
});

// The drain's batch SELECT (server/agent-plugin-store.mjs,
// #drainWebhookDeliveriesOnce, agentId-less arm) — verbatim, including
// the guest leg's live-credential EXISTS. If that query changes, this
// copy must change with it; the end-to-end drain behaviour through the
// real store is pinned in tests/guest-wake-live-seat-drain.test.js.
const DRAIN_BATCH_SELECT = `
  SELECT d.* FROM agent_webhook_deliveries d
   LEFT JOIN agent_webhook_subs s ON s.subscription_id = d.subscription_id
   WHERE d.state IN ('pending','failed') AND d.next_attempt_at <= ?
   AND (s.subscription_id IS NULL OR (s.enabled = 1 AND (d.room_id IS NULL
     OR EXISTS (SELECT 1 FROM identity_links l WHERE l.room_id = d.room_id AND l.identity_id = d.agent_id)
     OR EXISTS (SELECT 1 FROM guest_members g WHERE g.room_id = d.room_id AND g.guest_identity_id = d.agent_id
       AND EXISTS (SELECT 1 FROM credentials c WHERE c.room_id = g.room_id AND c.member_id = g.member_id
         AND c.kind = 'access' AND c.revoked = 0 AND c.expires_at > ?)))))
   ORDER BY d.next_attempt_at ASC LIMIT ?`;

test("drain batch SELECT: a disconnected or expired guest's rows never enter the batch", t => {
  const db = seatDb(t);
  db.exec(`
    CREATE TABLE agent_webhook_subs (
      subscription_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, enabled INTEGER NOT NULL);
    CREATE TABLE agent_webhook_deliveries (
      delivery_id TEXT PRIMARY KEY, subscription_id TEXT, agent_id TEXT NOT NULL,
      room_id TEXT, state TEXT NOT NULL, next_attempt_at INTEGER NOT NULL);
    INSERT INTO agent_webhook_subs VALUES ('sub-live', 'id-live', 1);
    INSERT INTO agent_webhook_subs VALUES ('sub-disconnected', 'id-disconnected', 1);
    INSERT INTO agent_webhook_subs VALUES ('sub-expired', 'id-expired', 1);
    INSERT INTO agent_webhook_subs VALUES ('sub-linked', 'id-linked', 1);
    INSERT INTO agent_webhook_subs VALUES ('sub-stranger', 'id-stranger', 1);
    INSERT INTO agent_webhook_deliveries VALUES ('del-live', 'sub-live', 'id-live', 'room-a', 'pending', ${NOW});
    INSERT INTO agent_webhook_deliveries VALUES ('del-disconnected', 'sub-disconnected', 'id-disconnected', 'room-a', 'pending', ${NOW});
    INSERT INTO agent_webhook_deliveries VALUES ('del-expired', 'sub-expired', 'id-expired', 'room-a', 'pending', ${NOW});
    INSERT INTO agent_webhook_deliveries VALUES ('del-linked', 'sub-linked', 'id-linked', 'room-a', 'pending', ${NOW});
    INSERT INTO agent_webhook_deliveries VALUES ('del-stranger', 'sub-stranger', 'id-stranger', 'room-a', 'pending', ${NOW});
    INSERT INTO agent_webhook_deliveries VALUES ('del-orphan', 'sub-removed', 'id-live', 'room-a', 'pending', ${NOW});
    INSERT INTO agent_webhook_deliveries VALUES ('del-roomless', 'sub-live', 'id-live', NULL, 'pending', ${NOW});
  `);
  const selected = db.prepare(DRAIN_BATCH_SELECT).all(NOW, NOW, 25).map(r => r.delivery_id).sort();
  assert.deepEqual(selected, ["del-linked", "del-live", "del-orphan", "del-roomless"],
    "live guest and linked rows are selected; disconnected/expired guest and unseated rows are not; " +
    "a removed subscription's row is still selected so it can dead-letter, and a roomless row is selected");
});
