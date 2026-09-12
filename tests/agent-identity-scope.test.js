import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

function fixture(t) {
  const store = new RoomStore(":memory:");
  t.after(() => store.close());
  store.initialize(initialRoom("scope"));
  const owner = store.issueAccessKey("scope", "owner");
  const identities = store.identities;
  const identity = identities.create("Scoped agent");
  const link = permissions => identities.link(owner, "scope", { identityId: identity.identityId, permissions });
  const unlink = () => identities.unlink(owner, "scope", identity.identityId);
  const member = () => store.roomAuthority("scope").members[identity.identityId];
  return { store, owner, identities, identity, link, unlink, member };
}

test("relink applies newly requested narrower permissions and returns effective scope", t => {
  const f = fixture(t);
  const initial = f.link(["accept_work", "complete_work"]);
  assert.deepEqual(initial.permissions, ["accept_work", "complete_work"]);
  f.unlink();
  const revision = f.member().revision;
  const linked = f.link(["accept_work"]);
  assert.deepEqual(f.member().permissions, ["accept_work"]);
  assert.deepEqual(linked.permissions, ["accept_work"]);
  assert.equal(linked.relinked, true);
  assert.equal(f.member().revision, revision + 1);
  assert.deepEqual(f.store.authenticate(f.identity.secret, "scope").member.permissions, ["accept_work"]);
});

test("owner can explicitly broaden a relink without restoring unrelated former grants", t => {
  const f = fixture(t);
  f.link(["accept_work", "verify"]);
  f.unlink();
  const linked = f.link(["accept_work", "complete_work"]);
  assert.deepEqual(linked.permissions, ["accept_work", "complete_work"]);
  assert.deepEqual(f.member().permissions, ["accept_work", "complete_work"]);
});

test("invalid relink permissions fail atomically and leave identity disconnected", t => {
  const f = fixture(t);
  f.link(["accept_work"]);
  f.unlink();
  const before = structuredClone(f.member());
  for (const permissions of [["not_a_permission"], ["manage_members"], ["decide"]]) {
    assert.throws(() => f.link(permissions));
    assert.deepEqual(f.member(), before);
    assert.equal(f.identities.list(f.owner, "scope").length, 0);
    assert.throws(() => f.store.authenticate(f.identity.secret, "scope"));
  }
});

test("relink replaces permissions even if the unlinked member was independently reactivated", t => {
  const f = fixture(t);
  f.link(["accept_work", "complete_work"]);
  f.unlink();
  f.store.command(f.owner, "scope", { id: randomUUID(), type: "member.access_changed", data: {
    memberId: f.identity.identityId, expectedMemberRevision: f.member().revision,
    permissions: ["accept_work", "complete_work"], active: true
  } });
  f.link(["accept_work"]);
  assert.deepEqual(f.member().permissions, ["accept_work"]);
});

test("duplicate link cannot silently change permissions", t => {
  const f = fixture(t);
  f.link(["accept_work"]);
  const before = structuredClone(f.member());
  assert.throws(() => f.link(["complete_work"]), error => error.code === "identity_already_linked");
  assert.deepEqual(f.member(), before);
});

test("a limited administrator cannot widen a relink or remove authority they do not hold", t => {
  const f = fixture(t);
  f.store.command(f.owner, "scope", { id: randomUUID(), type: "member.added", data: {
    memberId: "manager", displayName: "Manager", kind: "human", permissions: ["manage_members", "accept_work"]
  } });
  const manager = f.store.issueAccessKey("scope", "manager");
  f.link(["accept_work"]);
  f.unlink();
  const relink = permissions => f.identities.link(manager, "scope", { identityId: f.identity.identityId, permissions });
  assert.throws(() => relink(["accept_work", "complete_work"]));
  assert.equal(f.member().active, false);
  assert.deepEqual(relink(["accept_work"]).permissions, ["accept_work"]);
  f.unlink();
  f.link(["accept_work", "complete_work"]);
  f.unlink();
  assert.throws(() => relink(["accept_work"]));
  assert.equal(f.member().active, false);
  assert.equal(f.identities.list(f.owner, "scope").length, 0);
});

test("a demoted administrator cannot relink with an old credential", t => {
  const f = fixture(t);
  f.store.command(f.owner, "scope", { id: randomUUID(), type: "member.added", data: {
    memberId: "manager", displayName: "Manager", kind: "human", permissions: ["manage_members", "accept_work"]
  } });
  const manager = f.store.issueAccessKey("scope", "manager");
  f.link(["accept_work"]);
  f.unlink();
  f.store.command(f.owner, "scope", { id: randomUUID(), type: "member.access_changed", data: {
    memberId: "manager", expectedMemberRevision: f.store.roomAuthority("scope").members.manager.revision,
    permissions: ["accept_work"], active: true
  } });
  assert.throws(() => f.identities.link(manager, "scope", { identityId: f.identity.identityId, permissions: ["accept_work"] }),
    error => error.code === "access_denied");
  assert.equal(f.member().active, false);
});

test("link insertion failure rolls back reactivation and its membership event", t => {
  const f = fixture(t);
  f.link(["accept_work", "complete_work"]);
  f.unlink();
  const before = f.store.room("scope");
  f.store.db.exec(`CREATE TEMP TRIGGER fail_identity_link BEFORE INSERT ON identity_links
    BEGIN SELECT RAISE(ABORT, 'injected link failure'); END;`);
  assert.throws(() => f.link(["accept_work"]), /injected link failure/);
  assert.deepEqual(f.store.room("scope"), before);
  assert.equal(f.identities.list(f.owner, "scope").length, 0);
  assert.throws(() => f.store.authenticate(f.identity.secret, "scope"));
  f.store.db.exec("DROP TRIGGER fail_identity_link");
  assert.deepEqual(f.link(["accept_work"]).permissions, ["accept_work"]);
});
