// Growth loop: a referral is recorded at join and counts for a reward only
// after the new member posts and 24 hours pass. The reward is a room credit
// (guest founding room, or one agent room past the daily bucket) and a
// larger personal invite. Every member's invite admits a person or an agent
// and attributes the join to them.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { ACTIVATION_DWELL_MS, GROWTH_FUNDING, GROWTH_ROOM_ORIGIN, PERSONAL_INVITE_PREFIX } from "../server/growth-loop.mjs";
import { AgentRooms } from "../server/agent-rooms.mjs";

function openStore(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-growth-"));
  let now = Date.parse("2026-06-01T00:00:00.000Z");
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => now });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.initialize(initialRoom("commons", "owner"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  return {
    store, ownerKey,
    advance(ms) { now += ms; },
  };
}

function post(store, token, body, binding = null) {
  store.command(token, "commons", { id: randomUUID(), type: "message.posted", data: { body } }, binding);
}

function accountIdFor(store, memberId) {
  return store.db.prepare("SELECT account_id FROM member_accounts WHERE room_id=? AND member_id=?").get("commons", memberId).account_id;
}

function accountLogin(store, accountId) {
  const key = store.issueAccountAccessKey(accountId);
  const slot = store.createAccountSessionSlot();
  const revision = store.accountSessionSlot(slot.token).sessionRevision;
  const session = store.loginAccountSession(slot.token, key, revision);
  return { token: slot.token, binding: session.sessionBinding };
}

function joinHuman(store, linkToken, displayName) {
  const slot = store.createAccountSessionSlot();
  const current = () => store.accountSessionSlot(slot.token);
  const joined = store.shareLinks.join(slot.token, linkToken, {
    displayName, redemptionId: randomUUID(),
    expectedSessionRevision: current().sessionRevision, expectedSessionBinding: current().sessionBinding,
  });
  return { slot, joined, binding: () => current().sessionBinding, memberId: joined.session.member.id };
}

test("a referral rewards a room only after a message and 24 hours", t => {
  const { store, ownerKey, advance } = openStore(t);
  const invite = store.referrals.board(ownerKey, "commons").invite;
  assert.match(invite.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(invite.maxJoins, 5);
  assert.match(invite.message, /Project Room Commons/);
  assert.match(invite.message, /\{url\}/);
  const quiet = joinHuman(store, invite.token, "Quiet Guest");
  const ada = joinHuman(store, invite.token, "Ada");
  post(store, ada.slot.token, "Hello from Ada", ada.binding());
  const posted = store.referrals.board(ownerKey, "commons");
  assert.equal(posted.myReferralCount, 2);
  assert.equal(posted.myActiveCount, 0);
  const roomRequest = name => ({ roomId: name, title: name, purpose: "A room of our own", kind: "personal", displayName: "Ada" });
  assert.throws(() => store.createAccountRoom(ada.slot.token, ada.binding(), roomRequest("ada-early")),
    { status: 403, code: "room_creation_denied" });
  advance(ACTIVATION_DWELL_MS);
  const live = store.referrals.board(ownerKey, "commons");
  assert.equal(live.myActiveCount, 1);
  assert.equal(live.reward.tier, "Host");
  assert.equal(live.reward.credits, 1);
  assert.equal(live.reward.next.name, "Connector");
  assert.equal(live.invite.maxJoins, 10);
  assert.equal(live.leaderboard[0].activeCount, 1);
  assert.equal(live.leaderboard[0].referralCount, 2);
  assert.equal(live.referrals.find(row => row.refereeMemberId === quiet.memberId).activatedAt, null);
  const adaLogin = accountLogin(store, accountIdFor(store, ada.memberId));
  const adaBoard = store.referrals.board(adaLogin.token, "commons", adaLogin.binding);
  assert.equal(adaBoard.reward.welcomeCredit, 1);
  const created = store.createAccountRoom(adaLogin.token, adaLogin.binding, roomRequest("ada-room"));
  assert.equal(created.duplicate, false);
  assert.equal(store.db.prepare("SELECT origin FROM member_accounts WHERE room_id=?").get("ada-room").origin, GROWTH_ROOM_ORIGIN);
  assert.throws(() => store.createAccountRoom(adaLogin.token, adaLogin.binding, roomRequest("ada-second")),
    { status: 403, code: "room_creation_denied" });
  const quietLogin = accountLogin(store, accountIdFor(store, quiet.memberId));
  const quietBoard = store.referrals.board(quietLogin.token, "commons", quietLogin.binding);
  assert.equal(quietBoard.reward.welcomeCredit, 0);
  assert.throws(() => store.createAccountRoom(quietLogin.token, quietLogin.binding, roomRequest("quiet-room")),
    { status: 403, code: "room_creation_denied" });
  assert.doesNotThrow(() => store.shareLinks.verify());
});

test("a member without invite administration gets one link that admits a person and an agent", t => {
  const { store, ownerKey } = openStore(t);
  const ownerInvite = store.referrals.board(ownerKey, "commons").invite;
  const ada = joinHuman(store, ownerInvite.token, "Ada");
  const first = store.referrals.board(ada.slot.token, "commons", ada.binding());
  const again = store.referrals.board(ada.slot.token, "commons", ada.binding());
  assert.equal(again.invite.token, first.invite.token);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM share_links WHERE request_id LIKE ?").get(`${PERSONAL_INVITE_PREFIX}%`).n, 2);
  const preview = store.shareLinks.preview(first.invite.token);
  assert.equal(preview.inviterDisplayName, "Ada");
  assert.equal(preview.link.status, "active");
  assert.equal(Object.hasOwn(preview, "issuerMemberId"), false);
  const friend = joinHuman(store, first.invite.token, "Friend");
  const agent = store.identities.create("Invited agent");
  store.shareLinks.joinAgent(agent.secret, first.invite.token, "Invited agent");
  const board = store.referrals.board(ada.slot.token, "commons", ada.binding());
  assert.equal(board.myReferralCount, 2);
  assert.deepEqual(board.myReferrals.map(row => row.refereeMemberId).sort(), [agent.identityId, friend.memberId].sort());
  const agentBoard = store.referrals.board(agent.secret, "commons");
  assert.match(agentBoard.invite.token, /^[A-Za-z0-9_-]{43}$/);
  assert.match(agentBoard.invite.message, /\{url\}/);
  assert.doesNotThrow(() => store.shareLinks.verify());
});

test("an agent spends one growth credit for a room after the daily bucket is empty", t => {
  const { store, ownerKey, advance } = openStore(t);
  const invite = store.referrals.board(ownerKey, "commons").invite;
  const agent = store.identities.create("Founder agent");
  store.shareLinks.joinAgent(agent.secret, invite.token, "Founder agent");
  const rooms = new AgentRooms(store);
  const request = roomId => ({ roomId, title: roomId, purpose: "Agent room", kind: "personal", displayName: "Founder agent" });
  for (const roomId of ["bucket-1", "bucket-2", "bucket-3"]) {
    assert.equal(rooms.create(agent.secret, request(roomId)).duplicate, false);
  }
  assert.throws(() => rooms.create(agent.secret, request("bucket-4")), { status: 429, code: "rate_limited" });
  post(store, agent.secret, "I am here");
  advance(ACTIVATION_DWELL_MS);
  assert.equal(store.referrals.board(ownerKey, "commons").myActiveCount, 1);
  const funded = rooms.create(agent.secret, request("growth-room"));
  assert.equal(funded.duplicate, false);
  assert.equal(store.db.prepare("SELECT funded_by FROM agent_room_ownership WHERE room_id=?").get("growth-room").funded_by, GROWTH_FUNDING);
  assert.throws(() => rooms.create(agent.secret, request("growth-room-2")), { status: 429, code: "rate_limited" });
});
