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
import { ACTIVATION_DWELL_MS, GROWTH_FUNDING, GROWTH_ROOM_ORIGIN, PAYOUT_DAILY_CAP, PAYOUT_WINDOW_MS, PERSONAL_INVITE_PREFIX, noteIdentityMint } from "../server/growth-loop.mjs";
import { llmsTxt, agentsJson } from "../deploy/agent-discovery.mjs";
import { AgentRooms } from "../server/agent-rooms.mjs";
import { createRoomServer } from "../server/http.mjs";

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

test("a member without invite administration gets no usable personal link (W2-H1)", t => {
  // W2-H1: the owner-as-actor fallback is gone. Members without invite
  // rights get no personal invite link (nothing to redeem), and a forged
  // redemption against their member id fails closed.
  const { store, ownerKey } = openStore(t);
  const ownerInvite = store.referrals.board(ownerKey, "commons").invite;
  const ada = joinHuman(store, ownerInvite.token, "Ada");
  const board = store.referrals.board(ada.slot.token, "commons", ada.binding());
  assert.equal(board.invite, null, "no personal link for a member who cannot invite");
  assert.equal(board.myReferralCount, 0);
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

function payoutRow(store, memberId) {
  return store.db.prepare("SELECT payout_block AS block, activated_at AS activatedAt FROM referrals WHERE referee_member_id=?").get(memberId);
}

test("an inviter's own agents do not earn credits, and other payouts stop at the daily cap", t => {
  assert.match(llmsTxt(), /GET \/api\/rooms\/\{roomId\}\/referrals/);
  assert.match(agentsJson(), /\/api\/rooms\/\{roomId\}\/referrals/);
  const { store, ownerKey, advance } = openStore(t);
  const ownerInvite = store.referrals.board(ownerKey, "commons").invite;
  const ada = joinHuman(store, ownerInvite.token, "Ada");
  const adaAccount = accountIdFor(store, ada.memberId);
  // W2-H1: personal invites require invite rights. Grant Ada invite_member
  // so the payout flow (the subject of this test) can proceed.
  {
    const member = store.room("commons").state.members[ada.memberId];
    store.command(ownerKey, "commons", { id: randomUUID(), type: "member.access_changed",
      data: { memberId: ada.memberId, expectedMemberRevision: member.revision,
        permissions: [...member.permissions, "invite_member"], active: true } });
  }
  const adaInvite = store.referrals.board(ada.slot.token, "commons", ada.binding(), {
    address: "198.51.100.8", session: "ada-browser",
  }).invite;

  const byAddress = store.identities.create("Address puppet");
  store.shareLinks.joinAgent(byAddress.secret, adaInvite.token, "Address puppet", { address: "198.51.100.8" });
  const bySession = store.identities.create("Session puppet");
  noteIdentityMint(store, bySession.identityId, { session: "ada-browser", address: "198.51.100.50" });
  store.shareLinks.joinAgent(bySession.secret, adaInvite.token, "Session puppet", { address: "198.51.100.50" });
  const byOwner = store.identities.create("Owned puppet");
  noteIdentityMint(store, byOwner.identityId, { accountId: adaAccount, address: "198.51.100.77", session: "other-browser" });
  store.shareLinks.joinAgent(byOwner.secret, adaInvite.token, "Owned puppet", { address: "198.51.100.77" });
  const stranger = store.identities.create("Stranger");
  store.shareLinks.joinAgent(stranger.secret, adaInvite.token, "Stranger", { address: "203.0.113.9" });
  for (const identity of [byAddress, bySession, byOwner, stranger]) post(store, identity.secret, `hello from ${identity.displayName}`);
  advance(ACTIVATION_DWELL_MS);
  const adaLogin = accountLogin(store, adaAccount);
  const board = store.referrals.board(adaLogin.token, "commons", adaLogin.binding);
  assert.equal(board.myReferralCount, 4);
  assert.equal(board.myActiveCount, 1);
  assert.equal(board.reward.credits, 1);
  assert.equal(payoutRow(store, byAddress.identityId).block, "address");
  assert.equal(payoutRow(store, bySession.identityId).block, "session");
  assert.equal(payoutRow(store, byOwner.identityId).block, "owner");
  assert.equal(payoutRow(store, stranger.identityId).block, null);
  assert.equal(typeof payoutRow(store, stranger.identityId).activatedAt, "number");
  const strangerLogin = store.referrals.board(stranger.secret, "commons");
  assert.equal(strangerLogin.reward.welcomeCredit, 1);
  assert.equal(store.referrals.board(byAddress.secret, "commons").reward.welcomeCredit, 0);

  const capped = store.referrals.board(ownerKey, "commons").invite;
  const friends = [];
  for (let i = 0; i < PAYOUT_DAILY_CAP + 1; i += 1) friends.push(joinHuman(store, capped.token, `Friend ${i}`));
  for (const friend of friends) post(store, friend.slot.token, "present", friend.binding());
  advance(ACTIVATION_DWELL_MS);
  const cappedBoard = store.referrals.board(ownerKey, "commons");
  assert.equal(cappedBoard.myActiveCount, PAYOUT_DAILY_CAP);
  advance(PAYOUT_WINDOW_MS);
  assert.equal(store.referrals.board(ownerKey, "commons").myActiveCount, PAYOUT_DAILY_CAP + 1);
});

test("identity mint and the invite board record the same client address", async t => {
  const { store, ownerKey } = openStore(t);
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const board = await fetch(`${origin}/api/rooms/commons/referrals`, { headers: { authorization: `Bearer ${ownerKey}` } });
  assert.equal(board.status, 200);
  const minted = await fetch(`${origin}/api/agent-identities`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ displayName: "Minted nearby" }),
  });
  assert.equal(minted.status, 201);
  const created = await minted.json();
  const issuer = store.db.prepare("SELECT referee_address AS address FROM referrals WHERE referrer_member_id=? AND payout_block='trace'").get("owner");
  const mint = store.db.prepare("SELECT growth_mint_address AS address FROM agent_identities WHERE identity_id=?").get(created.identityId);
  assert.equal(typeof issuer.address, "string");
  assert.equal(mint.address, issuer.address);
});
