// PRESENCE-PRIM (migration programme, MIG-PRESENCE Gap 3): host presence
// resolves for every seat provenance, not only identity_links.
//
// Before this build, store.presence() resolved a member's host status
// through identity_links alone: guest seats (guest_members), stamped-
// identity seats with no link row (the key/grant admission class), and
// sponsored seats all read a silent `presence: null` even when the agent
// behind the seat had live hosts — indistinguishable from "nobody home".
// The build adds a `seat` provenance field to every presence row and
// resolves the identity behind each provenance:
//
//   link      -> identity_links row
//   guest     -> guest_members.guest_identity_id
//   oauth     -> member's stamped identityId + a live oauth_grant_agents
//                row for it (the stage-2 grant record, PR #4416 — read
//                defensively until that table lands)
//   key       -> member's stamped identityId (Round-2 #101 binding) with
//                no link/guest/grant row, or a guest_selfserve key seat
//   sponsored -> agent_connections row (issued); identity only when the
//                member record carries one
//   null      -> no provenance binds the member to an identity
//
// The null contract survives only for genuinely hostless or identity-less
// members — and those rows now name their seat (or its absence), so a
// null presence is an explicit unknown, never a silent one.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

function fixture(t) {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom());
  t.after(() => store.close());
  const ownerKey = store.issueAccessKey("commons", "owner");
  return { store, ownerKey };
}

const addAgent = (store, ownerKey, memberId, extra = {}) => store.command(ownerKey, "commons", {
  id: randomUUID(), type: T.MEMBER_ADDED,
  data: { memberId, displayName: memberId, kind: "agent", permissions: ["accept_work", "complete_work"], ...extra },
});
const beat = (store, identityId) => store.agentHeartbeats.heartbeat({ agentId: identityId, hostId: "h1", mode: "pull-only" });
const rowOf = (store, ownerKey, memberId) =>
  store.presence(ownerKey, "commons", []).members.find(m => m.memberId === memberId);

// Seat a guest exactly as guest-invites redemption writes it: a member
// stamped with the identity, a redeemed invite row, and a guest_members
// row — never an identity_links row.
function seatGuest(store, ownerKey, memberId, identityId) {
  addAgent(store, ownerKey, memberId, { identityId, permissions: [] });
  const now = store.now();
  const inviteId = `invite-${memberId}`;
  store.db.prepare(`INSERT INTO guest_invites
    (id, code_hash, room_id, tier, credential_ttl_ms, guest_label, minted_by_member_id,
     minted_by_account_id, issue_request_id, created_at, redeem_by, status, redeemed_at,
     redeemed_by_identity_id, redeemed_member_id, revoked_at, revoked_by_member_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(inviteId, "a".repeat(64), "commons", "observer", 3600000, "guest", "owner",
      null, `req-${memberId}`, now, now + 60000, "redeemed", now, identityId, memberId, null, null);
  store.db.prepare(`INSERT INTO guest_members (member_id, room_id, guest_identity_id, tier, invite_id, created_at)
    VALUES (?,?,?,?,?,?)`).run(memberId, "commons", identityId, "observer", inviteId, now);
}

test("presence resolves a linked seat (regression pin) and names seat=link", t => {
  const { store, ownerKey } = fixture(t);
  const identity = store.identities.create("linked-agent");
  store.identities.link(ownerKey, "commons", {
    identityId: identity.identityId, memberId: "linked", displayName: "Linked", permissions: ["accept_work"],
  });
  beat(store, identity.identityId);
  const row = rowOf(store, ownerKey, "linked");
  assert.equal(row.seat, "link");
  assert.equal(row.presence?.status, "online");
  assert.equal(row.ownerIdentityId, identity.identityId);
  assert.equal(row.state, "listening");
});

test("presence resolves a guest seat through guest_members and names seat=guest", t => {
  const { store, ownerKey } = fixture(t);
  const identity = store.identities.create("guest-agent");
  seatGuest(store, ownerKey, "guestseat", identity.identityId);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM identity_links WHERE member_id='guestseat'").get().n, 0);
  beat(store, identity.identityId);
  const row = rowOf(store, ownerKey, "guestseat");
  assert.equal(row.seat, "guest");
  assert.equal(row.presence?.status, "online");
  assert.equal(row.ownerIdentityId, identity.identityId);
  assert.equal(row.state, "listening");
});

test("presence names a guest seat with no hosts as a known identity, not a silent null", t => {
  const { store, ownerKey } = fixture(t);
  const identity = store.identities.create("quiet-guest");
  seatGuest(store, ownerKey, "quietguest", identity.identityId);
  const row = rowOf(store, ownerKey, "quietguest");
  assert.equal(row.seat, "guest");
  assert.equal(row.presence, null, "no registered host keeps the RC-051 null contract");
  assert.equal(row.ownerIdentityId, identity.identityId,
    "the identity behind the seat is named, so the null reads as unknown, not absent");
});

test("presence resolves a stamped-identity seat with no link row and names seat=key", t => {
  const { store, ownerKey } = fixture(t);
  const identity = store.identities.create("key-agent");
  addAgent(store, ownerKey, "keyseat", { identityId: identity.identityId });
  beat(store, identity.identityId);
  const row = rowOf(store, ownerKey, "keyseat");
  assert.equal(row.seat, "key");
  assert.equal(row.presence?.status, "online");
  assert.equal(row.ownerIdentityId, identity.identityId);
});

test("presence resolves a grant seat through the grant record and names seat=oauth", t => {
  const { store, ownerKey } = fixture(t);
  // The stage-2 grant table (PR #4416's oauth-grant-agents schema,
  // verbatim) — at main the table does not exist yet and the resolver
  // must read it defensively; once #4416 lands this is its live shape.
  store.db.exec(`CREATE TABLE IF NOT EXISTS oauth_grant_agents (
    account_id TEXT NOT NULL, client_id TEXT NOT NULL, identity_id TEXT NOT NULL,
    display_name TEXT NOT NULL, created_at INTEGER NOT NULL, revoked_at INTEGER,
    PRIMARY KEY(account_id, client_id))`);
  const identity = store.identities.create("grant-agent");
  store.db.prepare(`INSERT INTO oauth_grant_agents (account_id, client_id, identity_id, display_name, created_at, revoked_at)
    VALUES (?,?,?,?,?,NULL)`).run("acct-1", "client-1", identity.identityId, "Grant Agent", store.now());
  addAgent(store, ownerKey, "grantseat", { identityId: identity.identityId });
  beat(store, identity.identityId);
  const row = rowOf(store, ownerKey, "grantseat");
  assert.equal(row.seat, "oauth");
  assert.equal(row.presence?.status, "online");
  assert.equal(row.ownerIdentityId, identity.identityId);
});

test("a revoked grant record no longer classifies the seat as oauth", t => {
  const { store, ownerKey } = fixture(t);
  store.db.exec(`CREATE TABLE IF NOT EXISTS oauth_grant_agents (
    account_id TEXT NOT NULL, client_id TEXT NOT NULL, identity_id TEXT NOT NULL,
    display_name TEXT NOT NULL, created_at INTEGER NOT NULL, revoked_at INTEGER,
    PRIMARY KEY(account_id, client_id))`);
  const identity = store.identities.create("revoked-grant-agent");
  store.db.prepare(`INSERT INTO oauth_grant_agents (account_id, client_id, identity_id, display_name, created_at, revoked_at)
    VALUES (?,?,?,?,?,?)`).run("acct-1", "client-1", identity.identityId, "Revoked Grant", store.now(), store.now());
  addAgent(store, ownerKey, "revokedseat", { identityId: identity.identityId });
  beat(store, identity.identityId);
  const row = rowOf(store, ownerKey, "revokedseat");
  assert.equal(row.seat, "key", "the stamp still binds the identity; the dead grant does not classify it");
  assert.equal(row.presence?.status, "online");
});

test("presence names a sponsored seat with no identity as seat=sponsored with explicit unknown presence", t => {
  const { store, ownerKey } = fixture(t);
  const session = store.createSession(ownerKey);
  const memberId = `agent-${randomUUID()}`;
  const keyHash = createHash("sha256").update(randomUUID()).digest("hex");
  const ownerRevision = store.room("commons").state.members.owner.revision;
  const result = store.agentConnections.apply(session.token, "commons", {
    action: "create", requestId: randomUUID(), memberId, displayName: "Sponsored",
    access: "chat", keyHash, expiresAt: Date.now() + 3600000, expectedOwnerRevision: ownerRevision,
  }, session.session.sessionBinding);
  assert.equal(result.duplicate, false);
  const row = rowOf(store, ownerKey, memberId);
  assert.equal(row.seat, "sponsored");
  assert.equal(row.presence, null);
  assert.equal(row.ownerIdentityId, null, "a sponsored seat without an identity has no host presence to resolve");
});

test("an agent with no provenance binding still reads silent null with seat=null", t => {
  const { store, ownerKey } = fixture(t);
  addAgent(store, ownerKey, "plainseat");
  const row = rowOf(store, ownerKey, "plainseat");
  assert.equal(row.seat, null);
  assert.equal(row.presence, null);
  assert.equal(row.ownerIdentityId, null);
});

test("human members carry seat=null and no host presence (unchanged)", t => {
  const { store, ownerKey } = fixture(t);
  const row = rowOf(store, ownerKey, "owner");
  assert.equal(row.kind, "human");
  assert.equal(row.seat, null);
  assert.equal(row.presence, null);
});

test("capabilities resolves a guest seat's host presence too", t => {
  const { store, ownerKey } = fixture(t);
  const identity = store.identities.create("cap-guest");
  seatGuest(store, ownerKey, "capguest", identity.identityId);
  const guestKey = store.issueAccessKey("commons", "capguest");
  store.command(guestKey, "commons", {
    id: randomUUID(), type: T.CAPABILITIES_ADVERTISED, data: { capabilities: ["chat"] },
  });
  beat(store, identity.identityId);
  const listed = store.capabilities(ownerKey, "commons").members.find(m => m.memberId === "capguest");
  assert.ok(listed, "guest with advertised capabilities is listed");
  assert.equal(listed.presence?.status, "online");
});
