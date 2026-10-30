import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { AgentRooms } from "../server/agent-rooms.mjs";
import { readTalkPolicy } from "../server/agent-talk-policy.mjs";

function setup(t) {
  const store = new RoomStore(":memory:"); store.initialize(initialRoom());
  t.after(() => store.close());
  const identity = store.identities.create("Agent room creator");
  const room = new AgentRooms(store).create(identity.secret, { roomId: "agent-room", title: "Agent collaboration", purpose: "Invite peers", kind: "organization", displayName: "Agent room creator" });
  return { store, identity, room };
}
function admissionEvent(store, roomId, memberId) {
  return store.db.prepare("SELECT body FROM events WHERE room_id=? ORDER BY sequence DESC").all(roomId).map(row => JSON.parse(row.body)).find(event => event.type === "member.added" && event.data.memberId === memberId);
}
for (const door of ["code", "share"]) test(`agent-owned room admits a peer through ${door} without inventing a human sponsor`, t => {
  const { store, identity, room } = setup(t);
  let joined;
  if (door === "code") {
    const invite = store.invites.create(identity.secret, room.roomId, { profile: "member" });
    joined = store.invites.redeem(invite.code, { displayName: "Peer agent", requestId: randomUUID() });
  } else {
    const linkToken = randomBytes(32).toString("base64url");
    store.shareLinks.create(identity.secret, room.roomId, { requestId: randomUUID(), linkToken, expiresAt: Date.now() + 3600000, maxJoins: 2, expectedMemberRevision: 0, access: "member" }, null);
    const peer = store.identities.create("Peer agent");
    joined = store.shareLinks.joinAgent(peer.secret, linkToken, "Peer agent");
  }
  const state = store.room(room.roomId).state;
  const event = admissionEvent(store, room.roomId, joined.memberId);
  assert.equal(event.actorId, room.ownerMemberId);
  assert.equal(Object.hasOwn(event.data, "accountableHumanId"), false);
  assert.equal(Object.values(state.members).filter(member => member.kind === "human").length, 0);
  assert.equal(state.members[joined.memberId].kind, "agent");
  // Preserve the established owner-group fallback, without claiming it is a human.
  assert.equal(state.members[joined.memberId].accountableHumanId, room.ownerMemberId);
  assert.equal(readTalkPolicy(store.db, room.roomId, joined.memberId).policy, "owner");
  if (door === "code") assert.equal(event.data.referredBy, room.ownerMemberId);
});

test("human-sponsored agent inviter preserves the real human sponsor and agent grantor", t => {
  const { store } = setup(t);
  const owner = store.issueAccessKey("commons", "owner");
  store.command(owner, "commons", { id: randomUUID(), type: "member.added", data: { memberId: "friend", displayName: "Friend human", kind: "human", permissions: ["invite_member"] } });
  store.command(owner, "commons", { id: randomUUID(), type: "member.added", data: { memberId: "inviter", displayName: "Inviting agent", kind: "agent", permissions: ["invite_member"], accountableHumanId: "friend" } });
  const inviter = store.issueAccessKey("commons", "inviter");
  const invite = store.invites.create(inviter, "commons", { profile: "chat" });
  const joined = store.invites.redeem(invite.code, { displayName: "Friend peer" });
  const event = admissionEvent(store, "commons", joined.memberId);
  assert.equal(event.actorId, "inviter"); assert.equal(event.data.referredBy, "inviter");
  assert.equal(event.data.accountableHumanId, "friend");
  assert.equal(store.room("commons").state.members[joined.memberId].accountableHumanId, "friend");
});
