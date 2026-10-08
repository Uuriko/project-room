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
