// #1522: createJoinSession must bind the session to the identity's current
// secret hash, so rotating (or revoking) the identity secret invalidates
// the 8-hour join session — the same binding createAgentSession uses
// (RC-2026-09-23-106). A null identitySecretHash leaves the session valid
// for up to 8h after rotation.
import test from "node:test";
import assert from "node:assert/strict";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

function setup(t) {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom("commons"));
  t.after(() => store.close());
  const identity = store.identities.create("join agent");
  // Link the identity to a room member the way the join flows do: the member
  // record plus the identity_links row that authenticate() consults.
  const ownerKey = store.issueAccessKey("commons", "owner");
  const linked = store.identities.link(ownerKey, "commons", {
    identityId: identity.identityId, displayName: "Join agent", permissions: ["accept_work"],
  });
  return { store, identity, memberId: linked.memberId };
}

const authError = fn => {
  try { fn(); } catch (error) { return error; }
  return null;
};

test("#1522: a join session is bound to the identity secret hash", t => {
  const { store, memberId } = setup(t);
  store.createJoinSession("commons", memberId);
  const row = store.db.prepare(
    "SELECT identity_secret_hash AS h FROM credentials WHERE room_id='commons' AND member_id=? AND kind='session' ORDER BY rowid DESC LIMIT 1"
  ).get(memberId);
  assert.ok(row && row.h !== null && row.h !== undefined,
    "the join session must carry the identity secret hash, not null");
});

test("#1522: rotating the identity secret invalidates the join session", t => {
  const { store, identity, memberId } = setup(t);
  const { token } = store.createJoinSession("commons", memberId);
  // The session works before rotation.
  const before = store.authenticate(token, "commons");
  assert.equal(before.member.id, memberId);

  store.identities.rotate(identity.identityId, identity.secret);
  const error = authError(() => store.authenticate(token, "commons"));
  assert.ok(error, "the rotated session must be rejected");
  assert.equal(error.status, 401);
});

test("#1522: revoking the identity invalidates the join session", t => {
  const { store, identity, memberId } = setup(t);
  const { token } = store.createJoinSession("commons", memberId);
  store.identities.revoke(identity.identityId, identity.secret);
  const error = authError(() => store.authenticate(token, "commons"));
  assert.ok(error, "the revoked session must be rejected");
  assert.equal(error.status, 401);
});

test("#1522: an unlinked member keeps the legacy null binding (no link to bind)", t => {
  const { store } = setup(t);
  const ownerKey = store.issueAccessKey("commons", "owner");
  // A member with no identity link at all: the session stays unbound rather
  // than failing, preserving the pre-fix behavior for that edge.
  const memberId = "lonely-agent";
  store.command(ownerKey, "commons", { id: "join-session-unlinked", type: "member.added",
    data: { memberId, displayName: "Lonely", kind: "agent", permissions: [] } });
  const { token } = store.createJoinSession("commons", memberId);
  const auth = store.authenticate(token, "commons");
  assert.equal(auth.member.id, memberId);
});

test("#3908 F-9: a guest seat's join session binds to the guest identity secret", t => {
  const { store } = setup(t);
  const identity = store.identities.create("guest joiner");
  const memberId = "guest-agent-joiner";
  const ownerKey = store.issueAccessKey("commons", "owner");
  store.command(ownerKey, "commons", { id: "join-session-guest", type: "member.added",
    data: { memberId, displayName: "Guest Joiner", kind: "agent", permissions: [], identityId: identity.identityId } });
  // The trial seat lives in guest_members only - no identity_links row.
  store.db.prepare("INSERT INTO guest_invites(id, code_hash, room_id, tier, credential_ttl_ms, guest_label, minted_by_member_id, issue_request_id, created_at, redeem_by, status) VALUES ('inv-join', '0000000000000000000000000000000000000000000000000000000000000000', 'commons', 'contributor', 3600000, 'join fixture', 'owner', 'req-join', 1, 2000000000000, 'redeemed')")
    .run();
  store.db.prepare("INSERT INTO guest_members(member_id, room_id, guest_identity_id, tier, invite_id, created_at) VALUES(?,?,?,?,?,?)")
    .run(memberId, "commons", identity.identityId, "contributor", "inv-join", Date.now());
  // Live-seat composition: the seat also holds the live access credential
  // a real redeem would have minted. The gated member -> identity
  // resolver (S-5) judges the seat by that credential, and a LIVE
  // guest's join session must still bind — the F-9 contract.
  store.db.prepare("INSERT INTO credentials(hash, room_id, member_id, kind, parent_hash, expires_at, revoked, account_id, account_auth_epoch) VALUES ('h-join-guest', 'commons', ?, 'access', NULL, 9999999999999, 0, NULL, NULL)")
    .run(memberId);
  const { token } = store.createJoinSession("commons", memberId);
  const row = store.db.prepare(
    "SELECT identity_secret_hash AS h FROM credentials WHERE room_id='commons' AND member_id=? AND kind='session' ORDER BY rowid DESC LIMIT 1"
  ).get(memberId);
  assert.ok(row && row.h !== null && row.h !== undefined,
    "the guest join session carries the guest identity secret hash, not null");
  const auth = store.authenticate(token, "commons");
  assert.equal(auth.member.id, memberId, "the bound guest session authenticates");
  store.identities.rotate(identity.identityId, identity.secret);
  const error = authError(() => store.authenticate(token, "commons"));
  assert.ok(error, "rotating the guest identity secret invalidates its join session");
  assert.equal(error.status, 401);
});
