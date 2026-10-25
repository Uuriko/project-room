// R350-n1 (Fo 13936, option b): an agent that revokes its own identity
// secret stays an active room member on purpose (revoke() leaves room links
// alone, and an owner-issued room key can still act). Member views carry a
// read-time identityRevoked flag so the room can show the seat as signed out
// for good, and pickers can drop it, without changing membership.
import test from "node:test";
import assert from "node:assert/strict";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";

function linkedAgent(f, name) {
  const agent = f.store.identities.create(name);
  f.store.identities.link(f.keys.owner, "commons", { identityId: agent.identityId, permissions: ["accept_work"] });
  return agent;
}

test("full snapshot flags a member whose linked identity secret is revoked", t => {
  const f = createAcceptanceFixture(); t.after(() => f.store.close());
  const gone = linkedAgent(f, "Gone agent"), kept = linkedAgent(f, "Kept agent");
  f.store.identities.revoke(gone.identityId, gone.secret);
  const { members } = f.store.snapshot(f.keys.owner, "commons").state;
  assert.equal(members[gone.identityId].identityRevoked, true);
  assert.notEqual(members[gone.identityId].active, false, "membership itself is unchanged");
  assert.equal(members[kept.identityId].identityRevoked, undefined);
  assert.equal(members.owner.identityRevoked, undefined);
});

test("work snapshot carries the same flag", t => {
  const f = createAcceptanceFixture(); t.after(() => f.store.close());
  const gone = linkedAgent(f, "Gone agent");
  f.store.identities.revoke(gone.identityId, gone.secret);
  const { members } = f.store.snapshot(f.keys.owner, "commons", null, "work").state;
  assert.equal(members[gone.identityId].identityRevoked, true);
});

test("the flag is read-time only: the projection is not mutated", t => {
  const f = createAcceptanceFixture(); t.after(() => f.store.close());
  const gone = linkedAgent(f, "Gone agent");
  f.store.identities.revoke(gone.identityId, gone.secret);
  f.store.snapshot(f.keys.owner, "commons");
  assert.equal(f.store.room("commons").state.members[gone.identityId].identityRevoked, undefined);
});
