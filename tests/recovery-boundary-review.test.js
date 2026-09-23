// G3: read-only recovery review against identity-scope store. No schema/http/store edits.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { EVENT_TYPES as T } from "../src/events.js";

const SCOPE = "/Users/johnpotter/src/project-room-identity-scope";
assert.equal(existsSync(`${SCOPE}/server/store.mjs`), true);
const { RoomStore } = await import(`${SCOPE}/server/store.mjs`);
const { initialRoom } = await import(`${SCOPE}/server/bootstrap.mjs`);

function fixture() {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom());
  const owner = store.issueAccessKey("commons", "owner");
  store.command(owner, "commons", {
    id: randomUUID(), type: T.MEMBER_ADDED,
    data: { memberId: "agent", displayName: "agent", kind: "agent", permissions: ["accept_work"] }
  });
  const agent = store.issueAccessKey("commons", "agent");
  return { store, owner, agent };
}

function snapshot(store, owner) {
  return [...store.exportEvents(owner, "commons")];
}

test("unchanged export/import keeps live agent membership", () => {
  const { store, owner, agent } = fixture();
  assert.equal(store.authenticate(agent).member.id, "agent");
  const lines = snapshot(store, owner);
  assert.ok(lines.length >= 3);
  store.importEvents(owner, "commons", lines);
  assert.equal(store.authenticate(agent).member.id, "agent");
});

test("export after revocation restores inactive membership; old key cannot act", () => {
  const { store, owner, agent } = fixture();
  store.command(owner, "commons", {
    id: randomUUID(), type: T.MEMBER_ACCESS_CHANGED,
    data: { memberId: "agent", expectedMemberRevision: 0, permissions: [], active: false }
  });
  const lines = snapshot(store, owner);
  store.importEvents(owner, "commons", lines);
  assert.throws(() => store.authenticate(agent), error => error.status === 401 || error.status === 403);
  const member = store.room("commons").state.members.agent;
  assert.equal(member.active, false);
});

test("import drops pending invitation rows (documented restore contract)", () => {
  const { store, owner } = fixture();
  store.createAccount("account-target");
  const accessKey = store.issueAccountAccessKey("account-target");
  const slot = store.createAccountSessionSlot();
  store.loginAccountSession(slot.token, accessKey, slot.session.sessionRevision);
  const ownerAccountId = store.authenticate(owner).account.id;
  const ownerSlot = store.createAccountSessionSlot();
  const ownerAccess = store.issueAccountAccessKey(ownerAccountId);
  const ownerSession = store.loginAccountSession(ownerSlot.token, ownerAccess, ownerSlot.session.sessionRevision);
  const raw = randomBytes(32).toString("base64url");
  store.issueInvitation(ownerSlot.token, "commons", {
    requestId: `req-${randomBytes(4).toString("hex")}`,
    token: raw,
    intendedAccountId: "account-target",
    intendedMemberId: "target-member",
    displayName: "Target",
    role: "member",
    expiresAt: Date.now() + 3600000,
    expectedIssuerMemberRevision: store.room("commons").state.members.owner.revision,
    expectedSessionBinding: ownerSession.sessionBinding
  });
  const pending = store.db.prepare("SELECT COUNT(*) AS n FROM membership_invitations WHERE room_id=?").get("commons").n;
  assert.ok(pending >= 1);
  const lines = snapshot(store, owner);
  assert.throws(() => store.importEvents(owner, "commons", lines), error => {
    const text = String(error.message || error);
    return /invitation audit|constraint/i.test(text);
  });
});

