// #1522 — createJoinSession sessions survive identity-secret rotation.
// Join-flow browser sessions (8h) are created with identity_secret_hash=NULL,
// so rotating the identity secret (the standard response to a suspected leak)
// leaves the stale session working with the member's full permissions.
// createAgentSession already binds sessions to the current secret hash
// (RC-2026-09-23-106); createJoinSession must do the same.
import test from "node:test";
import assert from "node:assert/strict";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";

const setup = t => {
  const f = createAcceptanceFixture();
  t.after(() => f.store.close());
  return f;
};

test("#1522: join session dies when the member's identity secret is rotated", t => {
  const f = setup(t);
  const agent = f.store.identities.create("Join Rotate Agent");
  const ownerKey = f.store.issueAccessKey("commons", "owner");
  f.store.identities.link(ownerKey, "commons", { identityId: agent.identityId, permissions: ["accept_work"] });
  const memberId = f.store.identities.resolveIdentityLink(agent.identityId, "commons").member.id;

  const { token } = f.store.createJoinSession("commons", memberId);
  assert.doesNotThrow(() => f.store.authenticate(token, "commons"), "session works before rotation");

  const rotated = f.store.identities.rotate(agent.identityId, agent.secret);
  assert.ok(rotated.secret, "rotation should issue a new secret");

  assert.throws(() => f.store.authenticate(token, "commons"), { code: "unauthenticated" },
    "join session must be rejected after the identity secret rotates");
});

test("#1522: join session dies when the member's identity secret is revoked", t => {
  const f = setup(t);
  const agent = f.store.identities.create("Join Revoke Agent");
  const ownerKey = f.store.issueAccessKey("commons", "owner");
  f.store.identities.link(ownerKey, "commons", { identityId: agent.identityId, permissions: ["accept_work"] });
  const memberId = f.store.identities.resolveIdentityLink(agent.identityId, "commons").member.id;

  const { token } = f.store.createJoinSession("commons", memberId);
  f.store.identities.revoke(agent.identityId, agent.secret);

  assert.throws(() => f.store.authenticate(token, "commons"), { code: "unauthenticated" },
    "join session must be rejected after the identity secret is revoked");
});

test("#1522: join session still binds and works when no rotation happened", t => {
  const f = setup(t);
  const agent = f.store.identities.create("Join Happy Agent");
  const ownerKey = f.store.issueAccessKey("commons", "owner");
  f.store.identities.link(ownerKey, "commons", { identityId: agent.identityId, permissions: ["accept_work"] });
  const memberId = f.store.identities.resolveIdentityLink(agent.identityId, "commons").member.id;

  const { token } = f.store.createJoinSession("commons", memberId);
  const auth = f.store.authenticate(token, "commons");
  assert.equal(auth.member.id, memberId, "session authenticates the joined member");
});
