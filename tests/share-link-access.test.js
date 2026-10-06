// Link access options (John, 2026-10-06): guest (unchanged), member, co_admin.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { auditRecovery } from "../server/recovery.mjs";
import { EVENT_TYPES as T, PERMISSIONS } from "../src/events.js";

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-link-access-"));
  let now = Date.now();
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => now }); store.initialize(initialRoom("commons", "owner"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const mint = (access, key = ownerKey, revision = 0) => {
    const linkToken = randomBytes(32).toString("base64url");
    const result = store.shareLinks.create(key, "commons", { requestId: randomUUID(), linkToken, expiresAt: now + 3600000, maxJoins: 5,
      expectedMemberRevision: revision, ...(access ? { access } : {}) }, null);
    return { linkToken, link: result.link };
  };
  const signedIn = () => {
    const slot = store.createAccountSessionSlot();
    const account = store.createAccount(`acct-${randomUUID()}`, "test");
    const key = store.insertAccountCredential(account.id, now + 86400000);
    store.loginAccountSession(slot.token, key, slot.session.sessionRevision);
    return slot;
  };
  const joinHuman = (linkToken, slot, displayName) => {
    const current = store.accountSessionSlot(slot.token);
    return store.shareLinks.join(slot.token, linkToken, { displayName, redemptionId: randomUUID(),
      expectedSessionRevision: current.sessionRevision, expectedSessionBinding: current.sessionBinding });
  };
  return { store, ownerKey, mint, signedIn, joinHuman, member: id => store.room("commons").state.members[id] };
}

test("a link without access is the same guest link as before", t => {
  const f = fixture(t), { link } = f.mint();
  assert.equal(link.role, "guest"); assert.equal(link.access, "guest"); assert.deepEqual(link.permissions, []);
});

test("a co-admin link gives every permission to the agents and people who join", t => {
  const f = fixture(t), { linkToken, link } = f.mint("co_admin");
  assert.equal(link.access, "co_admin"); assert.deepEqual(link.permissions, [...PERMISSIONS]);
  assert.match(f.store.shareLinks.preview(linkToken).access, /Full room permissions/);

  const agent = f.store.identities.create("Helper agent");
  const joined = f.store.shareLinks.joinAgent(agent.secret, linkToken, "Helper agent");
  assert.deepEqual(joined.permissions, [...PERMISSIONS]);
  assert.deepEqual(f.member(agent.identityId).permissions, [...PERMISSIONS]);
  assert.equal(f.member(agent.identityId).delegatedAdmin, true);

  const human = f.joinHuman(linkToken, f.signedIn(), "Co admin");
  assert.deepEqual(f.member(human.session.member.id).permissions, [...PERMISSIONS]);

  // Joiners can do what the creator can: mint links and change access.
  const minted = f.store.shareLinks.create(agent.secret, "commons", { requestId: randomUUID(), linkToken: randomBytes(32).toString("base64url"),
    expiresAt: Date.now() + 3600000, maxJoins: 2, expectedMemberRevision: f.member(agent.identityId).revision }, null);
  assert.equal(minted.link.status, "active");
  assert.equal(f.store.verifyInvitationAudit().consistent, true);
  assert.doesNotThrow(() => f.store.shareLinks.verify());
  auditRecovery(f.store);
});

test("a member link grants the member role's work permissions", t => {
  const f = fixture(t), { linkToken } = f.mint("member");
  const human = f.joinHuman(linkToken, f.signedIn(), "Worker");
  assert.deepEqual(f.member(human.session.member.id).permissions, ["accept_work", "complete_work", "verify"]);
  assert.doesNotThrow(() => f.store.shareLinks.verify());
});

test("only the room creator mints elevated links, and elevated links need a real account", t => {
  const f = fixture(t), { linkToken } = f.mint();
  const admin = f.store.identities.create("Helper two");
  f.store.shareLinks.joinAgent(admin.secret, linkToken, "Helper two");
  f.store.command(f.ownerKey, "commons", { id: randomUUID(), type: T.MEMBER_ACCESS_CHANGED,
    data: { memberId: admin.identityId, expectedMemberRevision: 0, permissions: ["manage_members"], active: true } });
  assert.throws(() => f.mint("co_admin", admin.secret, 1), { code: "link_access_denied" });
  assert.throws(() => f.mint("owner"), { code: "invalid_link_access" });
  const elevated = f.mint("co_admin");
  const slot = f.store.createAccountSessionSlot();
  assert.throws(() => f.joinHuman(elevated.linkToken, slot, "Passerby"), { code: "sign_in_required" });
});
