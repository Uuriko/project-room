// #1522 — createJoinSession must bind the session credential to the agent's
// current identity secret hash, exactly like createAgentSession already does
// (RC-2026-09-23-106). Without the binding the 8-hour join session survives
// an identity-secret rotation: the standard response to a suspected leak
// does not invalidate the leaked session.
import test from "node:test";
import assert from "node:assert/strict";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";

// Same link shape as tests/agent-identity-secrets.test.js: an owner links the
// identity into the fixture room, which mints an agent member bound to it.
function linkToCommons(f, identityId) {
  const ownerKey = f.store.issueAccessKey("commons", "owner");
  return f.store.identities.link(ownerKey, "commons", { identityId, permissions: [] });
}

function sessionBinding(f, memberId) {
  return f.store.db
    .prepare("SELECT identity_secret_hash FROM credentials WHERE room_id='commons' AND member_id=? AND kind='session' ORDER BY rowid DESC")
    .get(memberId).identity_secret_hash;
}

test("#1522: join session binds the current identity secret hash", t => {
  const f = createAcceptanceFixture();
  t.after(() => f.store.close());
  const agent = f.store.identities.create("Join agent");
  const { memberId } = linkToCommons(f, agent.identityId);

  const { token } = f.store.createJoinSession("commons", memberId);
  const current = f.store.db
    .prepare("SELECT secret_hash FROM agent_identities WHERE identity_id=?")
    .get(agent.identityId).secret_hash;
  assert.equal(sessionBinding(f, memberId), current,
    "join session must carry the current identity secret hash, not null");

  // The session is usable before rotation.
  assert.equal(f.store.authenticate(token).member.id, memberId);
});

test("#1522: rotating the identity secret kills the outstanding join session", t => {
  const f = createAcceptanceFixture();
  t.after(() => f.store.close());
  const agent = f.store.identities.create("Rotated join agent");
  const { memberId } = linkToCommons(f, agent.identityId);

  const { token } = f.store.createJoinSession("commons", memberId);
  assert.equal(f.store.authenticate(token).member.id, memberId);

  f.store.identities.rotate(agent.identityId, agent.secret);
  assert.throws(() => f.store.authenticate(token),
    /rotated or revoked/,
    "a rotated identity secret must invalidate the join session");

  // A fresh join session after rotation binds the new hash and works.
  const fresh = f.store.createJoinSession("commons", memberId);
  assert.equal(f.store.authenticate(fresh.token).member.id, memberId);
  assert.equal(sessionBinding(f, memberId),
    f.store.db.prepare("SELECT secret_hash FROM agent_identities WHERE identity_id=?").get(agent.identityId).secret_hash);
});
