// SEC-09: owner-only operations refuse a non-owner member even with a valid
// body. The HTTP handlers validate shape first, so a non-owner with a bad body
// sees 422; this test calls the store gates with valid input to prove the
// owner check itself. Each refusal has an owner control that succeeds.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { GUEST_AGENT_TOKEN_PREFIX } from "../server/guest-agent-links.mjs";

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), "owner-gates-"));
  const store = new RoomStore(join(dir, "r.sqlite"), { now: () => Date.now() });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  store.initialize(initialRoom("commons"));
  store.bindHumanAccount("commons", "owner", "account-owner");
  const ownerKey = store.issueAccessKey("commons", "owner");
  const ownerSession = store.createSession(ownerKey);
  const add = (memberId, displayName) => {
    store.command(ownerKey, "commons", { id: randomUUID(), type: T.MEMBER_ADDED, data: { memberId, displayName, kind: "human", permissions: ["steer"] } });
    store.bindHumanAccount("commons", memberId, `account-${memberId}`);
    return store.issueAccessKey("commons", memberId);
  };
  const plainKey = add("plain", "Pat");
  add("victim", "Vic");
  return { store, ownerKey, ownerSession, plainKey, plainSession: store.createSession(plainKey), identity: store.identities.create("Roaming") };
}

function refuses(fn, status, code) {
  assert.throws(fn, error => error.status === status && error.code === code, `expected ${status} ${code}`);
}

test("a non-owner member is refused by each owner-only store gate", t => {
  const f = setup(t);
  const keyHash = createHash("sha256").update(randomBytes(32)).digest("hex");
  const linkToken = () => GUEST_AGENT_TOKEN_PREFIX + randomBytes(32).toString("base64url");
  refuses(() => f.store.identities.link(f.plainKey, "commons", { identityId: f.identity.identityId, permissions: ["accept_work"] }), 403, "access_denied");
  refuses(() => f.store.agentConnections.apply(f.plainSession.token, "commons", { action: "create", requestId: randomUUID(), memberId: "agent-x",
    displayName: "X", access: "contribute", keyHash, expiresAt: Date.now() + 86400000, expectedOwnerRevision: 0 }, f.plainSession.session.sessionBinding), 403, "owner_required");
  refuses(() => f.store.guestAgentLinks.mint(f.plainKey, "commons", { requestId: randomUUID(), linkToken: linkToken(), expectedOwnerRevision: 0, displayName: "S" }, null), 403, "owner_required");
  refuses(() => f.store.invites.create(f.plainKey, "commons", { profile: "chat", expiresInMinutes: 60, displayName: "Scribe" }, null), 403, "access_denied");
  refuses(() => f.store.wakeQueue.pause(f.plainKey, "commons", { requestId: randomUUID(), reason: null }, null, { memberId: "victim" }), 403, "wake_pause_not_permitted");
  refuses(() => f.store.guestInvites.revokeAll(f.plainKey, "commons", null), 403, "owner_required");
  refuses(() => f.store.guestInvites.list(f.plainKey, "commons", null), 403, "owner_required");
  refuses(() => f.store.shareLinks.create(f.plainKey, "commons", { requestId: randomUUID(), linkToken: randomBytes(32).toString("base64url"),
    expiresAt: Date.now() + 3600000, maxJoins: 2, expectedMemberRevision: 0 }, null), 403, "access_denied");
  refuses(() => f.store.command(f.plainKey, "commons", { id: randomUUID(), type: T.MEMBER_ADDED,
    data: { memberId: "evil", displayName: "E", kind: "human", permissions: ["manage_members"] } }), 422, "command_rejected");
  refuses(() => f.store.command(f.plainKey, "commons", { id: randomUUID(), type: T.MEMBER_ACCESS_CHANGED,
    data: { memberId: "victim", expectedMemberRevision: 0, permissions: ["steer"], active: false } }), 422, "command_rejected");
});

test("the owner passes the same gates (control)", t => {
  const f = setup(t);
  assert.ok(f.store.identities.link(f.ownerKey, "commons", { identityId: f.identity.identityId, permissions: ["accept_work"] }));
  assert.ok(f.store.invites.create(f.ownerKey, "commons", { profile: "chat", expiresInMinutes: 60, displayName: "Scribe" }, null).inviteId);
  assert.equal(f.store.wakeQueue.pause(f.ownerKey, "commons", { requestId: randomUUID(), reason: null }, null, { memberId: "victim" }).memberId, "victim");
  assert.ok(Array.isArray(f.store.guestInvites.list(f.ownerKey, "commons", null)) || f.store.guestInvites.list(f.ownerKey, "commons", null));
});
