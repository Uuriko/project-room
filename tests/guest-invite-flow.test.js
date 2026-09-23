import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore, validateCommand } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T, MEMBERSHIP_AUTHORITY_POLICY_VERSION } from "../src/events.js";
import { generateKeyPair, signCard } from "../server/agent-card-signing.mjs";
import {
  guestInviteContract, guestVoteExcluded, isGuestInviteCode,
  GUEST_INVITE_CODE_PREFIX, GUEST_BADGE_SUFFIX,
} from "../server/guest-invites.mjs";

const PEOPLE = /@gmail|John |Potter |acct-|accountId|people-data/i;

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-guest-invites-"));
  let clock = Date.now();
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => clock });
  store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey("commons", "owner");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = (path, { method = "GET", data, token } = {}) => fetch(origin + path, {
    method, headers: {
      Origin: origin,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(data === undefined ? {} : { "Content-Type": "application/json" })
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) })
  });
  return { store, origin, request, ownerKey, advance: ms => { clock += ms; } };
}

function mintBody(extras = {}) {
  return { requestId: randomUUID(), guestLabel: "Synapse visit", expectedOwnerRevision: 0, ...extras };
}

async function mintInvite(request, ownerKey, extras = {}) {
  const res = await request("/api/rooms/commons/guest-invites", { method: "POST", token: ownerKey, data: mintBody(extras) });
  assert.equal(res.status, 201);
  return res.json();
}

test("contract advertises the GX public-handoff terms", async t => {
  const { request } = await serve(t);
  const res = await request("/api/guest-invites");
  assert.equal(res.status, 200);
  const contract = await res.json();
  assert.deepEqual(contract, guestInviteContract());
  assert.equal(contract.status, "live");
  assert.equal(contract.mint, "owner_only");
  assert.deepEqual(contract.tiers.observer, ["guest:read", "guest:post"]);
  assert.deepEqual(contract.tiers.contributor, ["guest:read", "guest:post", "guest:draft"]);
  assert.equal(contract.credentialTtlMs.default, 72 * 3600 * 1000);
  assert.equal(contract.credentialTtlMs.min, 3600 * 1000);
  assert.equal(contract.credentialTtlMs.max, 14 * 86400 * 1000);
  assert.equal(contract.redeemWindowMs.default, 86400 * 1000);
  assert.equal(contract.maxActiveGuestsPerRoom, 5);
  assert.equal(contract.invitePrefix, GUEST_INVITE_CODE_PREFIX);
  assert.equal(contract.badge, GUEST_BADGE_SUFFIX);
  assert.equal(contract.account, false);
  assert.equal((await request("/api/guest-invites", { method: "HEAD" })).status, 200);
});

test("owner mint issues a public-safe GX code; strangers and non-owners are refused", async t => {
  const { store, request, ownerKey } = await serve(t);
  store.command(ownerKey, "commons", { id: randomUUID(), type: T.MEMBER_ADDED,
    data: { memberId: "guest", displayName: "Test guest", kind: "human", permissions: [] } });
  const guestKey = store.issueAccessKey("commons", "guest");

  const firstBody = mintBody();
  const first = await request("/api/rooms/commons/guest-invites", { method: "POST", token: ownerKey, data: firstBody });
  assert.equal(first.status, 201);
  const minted = await first.json();
  assert.ok(isGuestInviteCode(minted.code));
  assert.ok(minted.code.startsWith("GX-"));
  assert.equal(minted.tier, "observer");
  assert.equal(minted.credentialTtlMs, 72 * 3600 * 1000);
  assert.equal(minted.duplicate, false);
  assert.ok(minted.inviteId);

  // Storage is hash-only: no plaintext code anywhere on disk rows.
  const row = store.db.prepare("SELECT code_hash FROM guest_invites WHERE id=?").get(minted.inviteId);
  assert.match(row.code_hash, /^[0-9a-f]{64}$/);
  assert.doesNotMatch(JSON.stringify(row), new RegExp(minted.code.slice(3, 12)));

  // Same requestId is idempotent (no code on the duplicate answer).
  const retry = await request("/api/rooms/commons/guest-invites", { method: "POST", token: ownerKey, data: firstBody });
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).duplicate, true);

  const denied = await request("/api/rooms/commons/guest-invites", { method: "POST", token: guestKey, data: mintBody() });
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).error.code, "owner_required");
  const anon = await request("/api/rooms/commons/guest-invites", { method: "POST", data: mintBody() });
  assert.equal(anon.status, 401);
});

test("mint validates TTL range and tier", async t => {
  const { request, ownerKey } = await serve(t);
  for (const ttl of [59 * 60 * 1000, 15 * 86400 * 1000]) {
    const bad = await request("/api/rooms/commons/guest-invites", { method: "POST", token: ownerKey, data: mintBody({ credentialTtlMs: ttl }) });
    assert.equal(bad.status, 422);
  }
  const oneHour = await request("/api/rooms/commons/guest-invites", { method: "POST", token: ownerKey, data: mintBody({ credentialTtlMs: 3600 * 1000 }) });
  assert.equal(oneHour.status, 201);
  assert.equal((await oneHour.json()).credentialTtlMs, 3600 * 1000);
  const twoWeeks = await request("/api/rooms/commons/guest-invites", { method: "POST", token: ownerKey, data: mintBody({ credentialTtlMs: 14 * 86400 * 1000, guestLabel: "long" }) });
  assert.equal(twoWeeks.status, 201);
  const badTier = await request("/api/rooms/commons/guest-invites", { method: "POST", token: ownerKey, data: mintBody({ tier: "admin" }) });
  assert.equal(badTier.status, 422);
  // Contributor is an explicit owner upgrade, never a mint tier.
  const contributorMint = await request("/api/rooms/commons/guest-invites", { method: "POST", token: ownerKey, data: mintBody({ tier: "contributor", guestLabel: "drafts" }) });
  assert.equal(contributorMint.status, 422);
  assert.equal((await contributorMint.json()).error.code, "invalid_guest_invite");
  const observer = await request("/api/rooms/commons/guest-invites", { method: "POST", token: ownerKey, data: mintBody({ guestLabel: "observer-default" }) });
  assert.equal(observer.status, 201);
  assert.deepEqual((await observer.json()).scopes, ["guest:read", "guest:post"]);
});

test("preview reveals the room and terms but no people-data and no credential", async t => {
  const { request, ownerKey } = await serve(t);
  const minted = await mintInvite(request, ownerKey);
  const preview = await request("/api/guest-invites/preview", { method: "POST", data: { inviteCode: minted.code } });
  assert.equal(preview.status, 200);
  const shown = await preview.json();
  assert.equal(shown.room.id, "commons");
  assert.equal(shown.kind, "guest-invite");
  assert.equal(shown.tier, "observer");
  assert.ok(Array.isArray(shown.scopes));
  assert.doesNotMatch(JSON.stringify(shown), PEOPLE);
  assert.doesNotMatch(JSON.stringify(shown), /ga1\.|code_hash/i);
  const missing = await request("/api/guest-invites/preview", { method: "POST", data: { inviteCode: "GX-" + "x".repeat(32) } });
  assert.equal(missing.status, 410);
});

test("redemption needs an identity secret and a verifiable signed card", async t => {
  const { store, request, ownerKey } = await serve(t);
  const minted = await mintInvite(request, ownerKey);
  const identity = store.identities.create("Synapse");
  const keys = generateKeyPair();
  const cardBody = { name: "Synapse", description: "visiting agent", capabilities: ["chat"] };
  const card = { ...cardBody, publicKey: keys.publicKey, signature: signCard({ agentId: identity.identityId, card: cardBody, privateKey: keys.privateKey }) };

  // No identity secret at all.
  const noAuth = await request("/api/guest-invites/redeem", { method: "POST", data: { inviteCode: minted.code, card } });
  assert.equal(noAuth.status, 401);

  // Wrong identity secret.
  const wrongSecret = await request("/api/guest-invites/redeem", {
    method: "POST", token: "pri_" + "z".repeat(43),
    data: { inviteCode: minted.code, card },
  });
  assert.equal(wrongSecret.status, 401);

  // Tampered card: name changed after signing.
  const badSig = await request("/api/guest-invites/redeem", {
    method: "POST", token: identity.secret,
    data: { inviteCode: minted.code, card: { ...card, name: "Imposter" } },
  });
  assert.equal(badSig.status, 422);
  assert.equal((await badSig.json()).error.code, "card_invalid");

  // Signature from a different key than the card's publicKey.
  const otherKeys = generateKeyPair();
  const wrongKeySig = signCard({ agentId: identity.identityId, card: cardBody, privateKey: otherKeys.privateKey });
  const wrongKey = await request("/api/guest-invites/redeem", {
    method: "POST", token: identity.secret,
    data: { inviteCode: minted.code, card: { ...cardBody, publicKey: keys.publicKey, signature: wrongKeySig } },
  });
  assert.equal(wrongKey.status, 422);
  assert.equal((await wrongKey.json()).error.code, "card_invalid");
});

test("happy-path redemption issues the ga1. credential, badges the name, journals the owner", async t => {
  const { store, request, ownerKey } = await serve(t);
  const minted = await mintInvite(request, ownerKey);
  const identity = store.identities.create("Synapse");
  const keys = generateKeyPair();
  const cardBody = { name: "Synapse", description: "visiting agent", capabilities: ["chat"] };
  const card = { ...cardBody, publicKey: keys.publicKey, signature: signCard({ agentId: identity.identityId, card: cardBody, privateKey: keys.privateKey }) };

  const redeemed = await request("/api/guest-invites/redeem", {
    method: "POST", token: identity.secret, data: { inviteCode: minted.code, card },
  });
  assert.equal(redeemed.status, 201);
  const value = await redeemed.json();
  assert.ok(value.token.startsWith("ga1."));
  assert.equal(value.duplicate, false);
  assert.equal(value.tier, "observer");
  assert.deepEqual(value.scopes, ["guest:read", "guest:post"]);
  assert.equal(value.account, false);
  assert.ok(value.member.id.startsWith("guest-agent-"));
  assert.equal(value.member.displayName, "Synapse (guest)");
  assert.ok(value.expiresAt > Date.now());

  // The member is a real roster member with the badge; history is readable.
  const member = store.room("commons").state.members[value.member.id];
  assert.equal(member.kind, "agent");
  assert.equal(member.displayName, "Synapse (guest)");

  // The membership event is journaled with the minting owner as actor.
  const events = store.db.prepare("SELECT body FROM events WHERE room_id='commons' ORDER BY sequence DESC LIMIT 40").all()
    .map(r => JSON.parse(r.body));
  const added = events.find(e => e.type === T.MEMBER_ADDED && e.data.memberId === value.member.id);
  assert.ok(added, "membership event journaled");
  assert.equal(added.actorId, "owner");
  assert.equal(added.data.accountableHumanId, "owner");

  // The invite is single-use: burned on redemption.
  const again = await request("/api/guest-invites/redeem", {
    method: "POST", token: identity.secret, data: { inviteCode: minted.code, card },
  });
  assert.equal(again.status, 410);

  // The guest reads full room history with its credential.
  const history = await request("/api/rooms/commons/events", { token: value.token });
  assert.equal(history.status, 200);
});

test("one seat per identity per room; names come from the card and collide safely", async t => {
  const { store, request, ownerKey } = await serve(t);
  const first = await mintInvite(request, ownerKey);
  const identity = store.identities.create("Synapse");
  const keys = generateKeyPair();
  const cardBody = { name: "Synapse", description: "visiting agent", capabilities: ["chat"] };
  const card = { ...cardBody, publicKey: keys.publicKey, signature: signCard({ agentId: identity.identityId, card: cardBody, privateKey: keys.privateKey }) };
  const one = await (await request("/api/guest-invites/redeem", { method: "POST", token: identity.secret, data: { inviteCode: first.code, card } })).json();

  // A second invite for the same identity reuses the seat.
  const second = await mintInvite(request, ownerKey, { guestLabel: "second" });
  const two = await request("/api/guest-invites/redeem", { method: "POST", token: identity.secret, data: { inviteCode: second.code, card } });
  assert.equal(two.status, 200);
  const twoBody = await two.json();
  assert.equal(twoBody.duplicate, true);
  assert.equal(twoBody.member.id, one.member.id);
  assert.notEqual(twoBody.token, one.token); // fresh credential, same seat

  // A colliding name (matches the owner's display name) is refused.
  const ownerName = store.room("commons").state.members.owner.displayName;
  const identity2 = store.identities.create("Other");
  const keys2 = generateKeyPair();
  const collideBody = { name: ownerName, description: "x", capabilities: ["chat"] };
  const collideCard = { ...collideBody, publicKey: keys2.publicKey, signature: signCard({ agentId: identity2.identityId, card: collideBody, privateKey: keys2.privateKey }) };
  const third = await mintInvite(request, ownerKey, { guestLabel: "collide" });
  const collide = await request("/api/guest-invites/redeem", { method: "POST", token: identity2.secret, data: { inviteCode: third.code, card: collideCard } });
  assert.equal(collide.status, 422);
  assert.equal((await collide.json()).error.code, "card_invalid");

  // A reserved name is refused.
  const identity3 = store.identities.create("Reserved");
  const keys3 = generateKeyPair();
  const reservedBody = { name: "owner", description: "x", capabilities: ["chat"] };
  const reservedCard = { ...reservedBody, publicKey: keys3.publicKey, signature: signCard({ agentId: identity3.identityId, card: reservedBody, privateKey: keys3.privateKey }) };
  const fourth = await mintInvite(request, ownerKey, { guestLabel: "reserved" });
  const reserved = await request("/api/guest-invites/redeem", { method: "POST", token: identity3.secret, data: { inviteCode: fourth.code, card: reservedCard } });
  assert.equal(reserved.status, 422);
});

async function redeemGuest(t, serveResult, { name = "Synapse", tier } = {}) {
  const { store, request, ownerKey } = serveResult;
  // Invites always mint at observer; contributor comes from an explicit
  // owner upgrade after redemption.
  const minted = await mintInvite(request, ownerKey, { guestLabel: tier ? `${name} ${tier}` : name });
  const identity = store.identities.create(name);
  const keys = generateKeyPair();
  const cardBody = { name, description: "visiting agent", capabilities: ["chat"] };
  const card = { ...cardBody, publicKey: keys.publicKey, signature: signCard({ agentId: identity.identityId, card: cardBody, privateKey: keys.privateKey }) };
  const res = await request("/api/guest-invites/redeem", { method: "POST", token: identity.secret, data: { inviteCode: minted.code, card } });
  assert.equal(res.status, 201);
  const guest = { ...(await res.json()), identity, minted };
  if (tier === "contributor") {
    const upgraded = await request("/api/rooms/commons/guest-invites-upgrade", {
      method: "POST", token: ownerKey, data: { memberId: guest.member.id, tier: "contributor" },
    });
    assert.equal(upgraded.status, 200);
    guest.scopes = ["guest:read", "guest:post", "guest:draft"];
  }
  return guest;
}

test("observer guests chat and react; everything else is refused at the command gate", async t => {
  const s = await serve(t);
  const { store } = s;
  const guest = await redeemGuest(t, s);

  // Ordinary chat posts.
  const posted = store.command(guest.token, "commons", { id: randomUUID(), type: T.MESSAGE_POSTED, data: { messageId: randomUUID(), body: "Hello from outside." } });
  assert.ok(posted.event);

  // A work-item draft is refused for observers.
  assert.throws(() => store.command(guest.token, "commons", {
    id: randomUUID(), type: T.MESSAGE_POSTED, data: { messageId: randomUUID(), body: "draft", workItemId: "w1" },
  }), error => error.code === "guest_scope_denied");

  // Lifecycle, membership, governance, keys: all refused.
  for (const type of [T.MEMBER_ADDED, T.WORK_PROPOSED, T.MEMBER_ACCESS_CHANGED]) {
    assert.throws(() => store.command(guest.token, "commons", { id: randomUUID(), type, data: {} }),
      error => error.code === "guest_scope_denied", `guest blocked from ${type}`);
  }
});

test("contributor guests may post work-item drafts but nothing else", async t => {
  const s = await serve(t);
  const { store } = s;
  const guest = await redeemGuest(t, s, { name: "Drafty", tier: "contributor" });
  assert.deepEqual(guest.scopes, ["guest:read", "guest:post", "guest:draft"]);

  // A draft passes the guest scope gate (the work item itself may not
  // exist — what matters is the refusal is not the scope gate).
  try {
    store.command(guest.token, "commons", { id: randomUUID(), type: T.MESSAGE_POSTED, data: { messageId: randomUUID(), body: "draft", workItemId: "w-missing" } });
  } catch (error) {
    assert.notEqual(error.code, "guest_scope_denied");
  }
  assert.throws(() => store.command(guest.token, "commons", { id: randomUUID(), type: T.WORK_PROPOSED, data: {} }),
    error => error.code === "guest_scope_denied");
});

test("guest votes never count: the exclusion predicate covers every guest member id", async t => {
  const s = await serve(t);
  const guest = await redeemGuest(t, s);
  assert.equal(guestVoteExcluded(guest.member.id), true);
  assert.equal(guestVoteExcluded("owner"), false);
  assert.equal(guestVoteExcluded("guest-agent-abc123"), true);
  assert.equal(guestVoteExcluded(null), false);
});

test("owner upgrades a guest to contributor explicitly; re-redemption cannot escalate", async t => {
  const s = await serve(t);
  const { store, request, ownerKey } = s;
  const guest = await redeemGuest(t, s, { name: "Upgradable" });
  assert.deepEqual(guest.scopes, ["guest:read", "guest:post"]);

  // Non-owners cannot upgrade.
  const anonUpgrade = await request("/api/rooms/commons/guest-invites-upgrade", {
    method: "POST", data: { memberId: guest.member.id, tier: "contributor" },
  });
  assert.equal(anonUpgrade.status, 401);

  // Owner upgrades: tier changes, journaled.
  const upgraded = await request("/api/rooms/commons/guest-invites-upgrade", {
    method: "POST", token: ownerKey, data: { memberId: guest.member.id, tier: "contributor" },
  });
  assert.equal(upgraded.status, 200);
  assert.equal((await upgraded.json()).tier, "contributor");
  assert.equal(store.guestInvites.guestTierOf(guest.member.id), "contributor");

  // Invalid tier and unknown member are refused.
  const badTier = await request("/api/rooms/commons/guest-invites-upgrade", {
    method: "POST", token: ownerKey, data: { memberId: guest.member.id, tier: "admin" },
  });
  assert.equal(badTier.status, 422);
  const unknown = await request("/api/rooms/commons/guest-invites-upgrade", {
    method: "POST", token: ownerKey, data: { memberId: "guest-agent-0000000000000000", tier: "contributor" },
  });
  assert.equal(unknown.status, 404);

  // Owner can downgrade back to observer.
  const downgraded = await request("/api/rooms/commons/guest-invites-upgrade", {
    method: "POST", token: ownerKey, data: { memberId: guest.member.id, tier: "observer" },
  });
  assert.equal(downgraded.status, 200);
  assert.equal(store.guestInvites.guestTierOf(guest.member.id), "observer");
});

test("expiry stops the credential and the next owner mint sweeps the member", async t => {
  const s = await serve(t);
  const { store, request, ownerKey, advance } = s;
  const guest = await redeemGuest(t, s);
  const ttl = guest.expiresAt - Date.now();
  advance(ttl + 1000);
  assert.throws(() => store.authenticate(guest.token, "commons"), { code: "unauthenticated" });
  // Minting again runs the existing sweep: the expired guest is deactivated.
  await mintInvite(request, ownerKey, { guestLabel: "after" });
  assert.equal(store.room("commons").state.members[guest.member.id].active, false);
  assert.equal(store.guestInvites.guestTierOf(guest.member.id), null);
});

test("guests rotate their own credential; the old one dies immediately", async t => {
  const s = await serve(t);
  const { store, request } = s;
  const guest = await redeemGuest(t, s);
  const rotated = await request("/api/guest-invites/rotate", { method: "POST", token: guest.token, data: { roomId: "commons" } });
  assert.equal(rotated.status, 200);
  const value = await rotated.json();
  assert.ok(value.token.startsWith("ga1."));
  assert.notEqual(value.token, guest.token);
  assert.equal(value.expiresAt, guest.expiresAt); // same seat, same expiry
  assert.throws(() => store.authenticate(guest.token, "commons"), { code: "unauthenticated" });
  const auth = store.authenticate(value.token, "commons");
  assert.equal(auth.member.id, guest.member.id);
});

test("owner disconnect ends one guest; revoke-all ends every guest", async t => {
  const s = await serve(t);
  const { store, request, ownerKey } = s;
  const one = await redeemGuest(t, s, { name: "Alpha" });
  const two = await redeemGuest(t, s, { name: "Beta" });

  const disc = await request("/api/rooms/commons/guest-invites-disconnect", { method: "POST", token: ownerKey, data: { memberId: one.member.id } });
  assert.equal(disc.status, 200);
  assert.equal((await disc.json()).disconnected, true);
  // Deactivation revokes the member's credentials platform-wide.
  assert.throws(() => store.authenticate(one.token, "commons"), { code: "unauthenticated" });
  // The other guest is untouched.
  assert.ok(store.authenticate(two.token, "commons").member);

  const all = await request("/api/rooms/commons/guest-invites-revoke-all", { method: "POST", token: ownerKey, data: {} });
  assert.equal(all.status, 200);
  assert.equal((await all.json()).revoked, 1);
  assert.throws(() => store.authenticate(two.token, "commons"), { code: "unauthenticated" });
  // History survives: the badged messages are still in the room.
  const events = store.db.prepare("SELECT body FROM events WHERE room_id='commons'").all().map(r => JSON.parse(r.body));
  assert.ok(events.some(e => e.type === T.MEMBER_ADDED && e.data.memberId === one.member.id));
});

test("owner revokes an unredeemed invite; the list never leaks hashes or codes", async t => {
  const s = await serve(t);
  const { store, request, ownerKey } = s;
  const minted = await mintInvite(request, ownerKey);
  const listed = await request("/api/rooms/commons/guest-invites-list", { method: "POST", token: ownerKey, data: {} });
  assert.equal(listed.status, 200);
  const rows = await listed.json();
  const row = rows.find(r => r.inviteId === minted.inviteId);
  assert.ok(row);
  assert.equal(row.status, "active");
  assert.equal(row.guestLabel, "Synapse visit");
  assert.doesNotMatch(JSON.stringify(rows), /code_hash|ga1\.|pri_/i);
  assert.doesNotMatch(JSON.stringify(rows), new RegExp(minted.code.slice(3, 12)));

  const revoked = await request("/api/rooms/commons/guest-invites-revoke", { method: "POST", token: ownerKey, data: { inviteId: minted.inviteId } });
  assert.equal(revoked.status, 200);
  assert.equal((await revoked.json()).revoked, true);
  const preview = await request("/api/guest-invites/preview", { method: "POST", data: { inviteCode: minted.code } });
  assert.equal(preview.status, 410);

  // Non-owners cannot list or revoke.
  store.command(ownerKey, "commons", { id: randomUUID(), type: T.MEMBER_ADDED,
    data: { memberId: "guest", displayName: "Test guest", kind: "human", permissions: [] } });
  const guestKey = store.issueAccessKey("commons", "guest");
  assert.equal((await request("/api/rooms/commons/guest-invites-list", { method: "POST", token: guestKey, data: {} })).status, 403);
  assert.equal((await request("/api/rooms/commons/guest-invites-revoke", { method: "POST", token: guestKey, data: { inviteId: minted.inviteId } })).status, 403);
});

test("a disconnected guest rejoins on the same identity-bound seat", async t => {
  const s = await serve(t);
  const { store, request, ownerKey } = s;
  const guest = await redeemGuest(t, s, { name: "Returner" });
  const memberId = guest.member.id;
  assert.equal(memberId, guest.member.id);

  // Owner disconnects the guest; the seat goes inactive.
  const disc = await request("/api/rooms/commons/guest-invites-disconnect", { method: "POST", token: ownerKey, data: { memberId } });
  assert.equal(disc.status, 200);
  assert.equal(store.room("commons").state.members[memberId].active, false);

  // The same identity redeems a fresh invite: no seat_taken, the seat is
  // reactivated identity-bound with the same member id and tier, exactly one
  // guest_members row, and the reactivation is journaled.
  const minted = await mintInvite(request, ownerKey, { guestLabel: "returner encore" });
  const identity = guest.identity;
  const keys = generateKeyPair();
  const cardBody = { name: "Returner", description: "visiting agent", capabilities: ["chat"] };
  const card = { ...cardBody, publicKey: keys.publicKey, signature: signCard({ agentId: identity.identityId, card: cardBody, privateKey: keys.privateKey }) };
  const re = await request("/api/guest-invites/redeem", { method: "POST", token: identity.secret, data: { inviteCode: minted.code, card } });
  assert.equal(re.status, 200); // duplicate seat, same as an active re-redeem
  const rej = await re.json();
  assert.equal(rej.member.id, memberId);
  assert.equal(rej.duplicate, true);
  assert.equal(store.room("commons").state.members[memberId].active, true);
  assert.equal(rej.tier, "observer");
  assert.equal(store.db.prepare("SELECT COUNT(*) c FROM guest_members WHERE room_id='commons' AND guest_identity_id=?").get(identity.identityId).c, 1);
  // Fresh credential works; the old one died with the disconnect.
  assert.ok(store.authenticate(rej.token, "commons").member);
  assert.throws(() => store.authenticate(guest.token, "commons"), e => e.code === "unauthenticated" || e.status === 401);
  const journal = store.db.prepare("SELECT body FROM events WHERE room_id='commons'").all()
    .map(r => JSON.parse(r.body)).filter(e => e.type === T.MEMBER_ACCESS_CHANGED && e.data.memberId === memberId && e.data.active === true);
  assert.ok(journal.length >= 1);
  assert.equal(journal.at(-1).actorId, store.roomAuthority("commons").ownerId);

  // A different identity cannot steal the seat by name collision: the taken
  // name is refused outright, and a fresh name mints a distinct seat.
  const other = store.identities.create("Squatter");
  const okeys = generateKeyPair();
  const ocardBody = { name: "Returner", description: "squatter", capabilities: ["chat"] };
  const ocard = { ...ocardBody, publicKey: okeys.publicKey, signature: signCard({ agentId: other.identityId, card: ocardBody, privateKey: okeys.privateKey }) };
  const minted2 = await mintInvite(request, ownerKey, { guestLabel: "squatter" });
  const sq = await request("/api/guest-invites/redeem", { method: "POST", token: other.secret, data: { inviteCode: minted2.code, card: ocard } });
  assert.equal(sq.status, 422);
  const minted3 = await mintInvite(request, ownerKey, { guestLabel: "squatter2" });
  const ocardBody2 = { name: "Squatter", description: "squatter", capabilities: ["chat"] };
  const ocard2 = { ...ocardBody2, publicKey: okeys.publicKey, signature: signCard({ agentId: other.identityId, card: ocardBody2, privateKey: okeys.privateKey }) };
  const sq2 = await request("/api/guest-invites/redeem", { method: "POST", token: other.secret, data: { inviteCode: minted3.code, card: ocard2 } });
  assert.equal(sq2.status, 201);
  assert.notEqual((await sq2.json()).member.id, memberId);
});

test("an expired guest rejoins after the redemption-path sweep; expired seats never consume the five-seat cap", async t => {
  const s = await serve(t);
  const { store, request, ownerKey, advance } = s;
  // A 1h guest whose credential will expire.
  const minted1 = await mintInvite(request, ownerKey, { guestLabel: "short-lived", credentialTtlMs: 3600 * 1000 });
  const identity = store.identities.create("ShortLived");
  const keys = generateKeyPair();
  const cardBody = { name: "ShortLived", description: "visiting agent", capabilities: ["chat"] };
  const card = { ...cardBody, publicKey: keys.publicKey, signature: signCard({ agentId: identity.identityId, card: cardBody, privateKey: keys.privateKey }) };
  const r1 = await request("/api/guest-invites/redeem", { method: "POST", token: identity.secret, data: { inviteCode: minted1.code, card } });
  assert.equal(r1.status, 201);
  const shortId = (await r1.json()).member.id;

  // Fill the room to the five-seat concurrent cap with 1h guests.
  for (let i = 0; i < 4; i++) {
    const m = await mintInvite(request, ownerKey, { guestLabel: `filler ${i}`, credentialTtlMs: 3600 * 1000 });
    const idn = store.identities.create(`Filler${i}`);
    const k = generateKeyPair();
    const cb = { name: `Filler${i}`, description: "visiting agent", capabilities: ["chat"] };
    const c = { ...cb, publicKey: k.publicKey, signature: signCard({ agentId: idn.identityId, card: cb, privateKey: k.privateKey }) };
    assert.equal((await request("/api/guest-invites/redeem", { method: "POST", token: idn.secret, data: { inviteCode: m.code, card: c } })).status, 201);
  }
  // A sixth guest exceeds five — the cap fires before expiry.
  const over = await mintInvite(request, ownerKey, { guestLabel: "overfull", credentialTtlMs: 3600 * 1000 });
  const overIdn = store.identities.create("Overfull");
  const ok = generateKeyPair();
  const ocb = { name: "Overfull", description: "visiting agent", capabilities: ["chat"] };
  const oc = { ...ocb, publicKey: ok.publicKey, signature: signCard({ agentId: overIdn.identityId, card: ocb, privateKey: ok.privateKey }) };
  assert.equal((await request("/api/guest-invites/redeem", { method: "POST", token: overIdn.secret, data: { inviteCode: over.code, card: oc } })).status, 429);

  // Advance past the 1h credential TTL. The next redemption sweeps the
  // expired seats itself — no owner mint needed — and succeeds.
  advance(3600 * 1000 + 1000);
  const late = await mintInvite(request, ownerKey, { guestLabel: "latecomer", credentialTtlMs: 3600 * 1000 });
  const lateIdn = store.identities.create("Latecomer");
  const lk = generateKeyPair();
  const lcb = { name: "Latecomer", description: "visiting agent", capabilities: ["chat"] };
  const lc = { ...lcb, publicKey: lk.publicKey, signature: signCard({ agentId: lateIdn.identityId, card: lcb, privateKey: lk.privateKey }) };
  const rl = await request("/api/guest-invites/redeem", { method: "POST", token: lateIdn.secret, data: { inviteCode: late.code, card: lc } });
  assert.equal(rl.status, 201);
  assert.equal(store.room("commons").state.members[shortId].active, false);
  const sweeps = store.db.prepare("SELECT body FROM events WHERE room_id='commons'").all()
    .map(r => JSON.parse(r.body)).filter(e => e.type === T.MEMBER_ACCESS_CHANGED && e.data.active === false && e.data.memberId === shortId);
  assert.ok(sweeps.length >= 1);

  // The expired guest itself can rejoin on its own seat.
  const encore = await mintInvite(request, ownerKey, { guestLabel: "short-lived encore", credentialTtlMs: 3600 * 1000 });
  const re = await request("/api/guest-invites/redeem", { method: "POST", token: identity.secret, data: { inviteCode: encore.code, card } });
  assert.equal(re.status, 200); // duplicate seat
  assert.equal((await re.json()).member.id, shortId);
  assert.equal(store.room("commons").state.members[shortId].active, true);
});

test("the absolute ten-seat guest cap holds across disconnects; existing identities may still rejoin", async t => {
  const s = await serve(t);
  const { store, request, ownerKey } = s;
  // Accumulate ten distinct guest seats. Direct store calls here: the HTTP
  // redeem route is rate-limited to 10/min per address, which would mask the
  // room-level cap this test is about. The eleventh redeem goes over HTTP.
  const redeemOne = async name => {
    const minted = await mintInvite(request, ownerKey, { guestLabel: name });
    const idn = store.identities.create(name);
    const k = generateKeyPair();
    const cb = { name, description: "visiting agent", capabilities: ["chat"] };
    const c = { ...cb, publicKey: k.publicKey, signature: signCard({ agentId: idn.identityId, card: cb, privateKey: k.privateKey }) };
    const res = store.guestInvites.redeem(minted.code, idn.secret, c);
    return { res, idn, card: c, name };
  };
  // Ten distinct guests, disconnecting to stay under the five-seat
  // concurrent cap while accumulating absolute seats.
  const seats = [];
  let firstGuest = null;
  for (let i = 0; i < 10; i++) {
    const g = await redeemOne(`CapGuest${i}`);
    if (i === 0) firstGuest = g;
    seats.push(g);
    if (i % 2 === 1) {
      for (const s2 of seats.splice(0)) store.guestInvites.disconnect(ownerKey, "commons", s2.res.member.id);
    }
  }
  for (const s2 of seats.splice(0)) store.guestInvites.disconnect(ownerKey, "commons", s2.res.member.id);
  // Eleventh distinct identity: absolute cap refuses, over the real HTTP path.
  const m11 = await mintInvite(request, ownerKey, { guestLabel: "eleventh" });
  const id11 = store.identities.create("Eleventh");
  const k11 = generateKeyPair();
  const cb11 = { name: "Eleventh", description: "visiting agent", capabilities: ["chat"] };
  const c11 = { ...cb11, publicKey: k11.publicKey, signature: signCard({ agentId: id11.identityId, card: cb11, privateKey: k11.privateKey }) };
  const r11 = await request("/api/guest-invites/redeem", { method: "POST", token: id11.secret, data: { inviteCode: m11.code, card: c11 } });
  assert.equal(r11.status, 429);
  assert.match((await r11.json()).error.message, /absolute external-guest seat limit/);
  // One of the existing ten identities may still rejoin its own seat.
  const encore = await mintInvite(request, ownerKey, { guestLabel: "cap encore" });
  const re = await request("/api/guest-invites/redeem", { method: "POST", token: firstGuest.idn.secret, data: { inviteCode: encore.code, card: firstGuest.card } });
  assert.equal(re.status, 200); // duplicate seat
  assert.equal((await re.json()).member.id, firstGuest.res.member.id);
});

test("guest tier upgrade journals a strictly-valid MEMBER_ACCESS_CHANGED event", async t => {
  const s = await serve(t);
  const { store, request, ownerKey } = s;
  const guest = await redeemGuest(t, s, { name: "Upgradable" });
  const memberId = guest.member.id;
  const ownerId = store.roomAuthority("commons").ownerId;

  const up = await request("/api/rooms/commons/guest-invites-upgrade", { method: "POST", token: ownerKey, data: { memberId, tier: "contributor" } });
  assert.equal(up.status, 200);
  assert.equal(store.db.prepare("SELECT tier FROM guest_members WHERE member_id=?").get(memberId).tier, "contributor");

  const journaled = store.db.prepare("SELECT body FROM events WHERE room_id='commons'").all()
    .map(r => JSON.parse(r.body))
    .filter(e => e.type === T.MEMBER_ACCESS_CHANGED && e.data.memberId === memberId);
  assert.ok(journaled.length >= 1);
  const ev = journaled.at(-1);
  assert.equal(ev.actorId, ownerId);
  // Exactly the validator's four fields plus the store-added authority
  // policy version — no `tier` key anywhere in the event.
  assert.deepEqual(Object.keys(ev.data).sort(), ["active", "authorityPolicyVersion", "expectedMemberRevision", "memberId", "permissions"].sort());
  assert.equal(ev.data.active, true);
  assert.ok(!("tier" in ev.data));
  // The command shape behind the journaled event passes strict validation
  // as-is (the authority policy version is added by the store after
  // validation, exactly like every other member-authority event).
  const { authorityPolicyVersion, ...commandData } = ev.data;
  assert.equal(authorityPolicyVersion, MEMBERSHIP_AUTHORITY_POLICY_VERSION);
  assert.doesNotThrow(() => validateCommand({ id: randomUUID(), type: T.MEMBER_ACCESS_CHANGED, data: commandData }));
});
