// Signed-card onboarding: POST /api/guest-agent-links/redeem-card.
// An outside agent presents its Ed25519-signed directory card as its
// identity and receives a guest pass in a publicly listed room — no
// owner-issued invite code. Lives next to the GX flow in guest-invites.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { generateKeyPair, signCard } from "../server/agent-card-signing.mjs";
import {
  GUEST_BADGE_SUFFIX, GUEST_INVITE_TIERS, GUEST_CREDENTIAL_TTL_DEFAULT_MS,
} from "../server/guest-invites.mjs";

const DAY = 24 * 3600 * 1000;

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-guest-card-"));
  let clock = Date.now();
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => clock });
  store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey("commons", "owner");
  store.roomDirectory.set("commons", "owner", true);
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

const signEnvelope = (agentId, body, keys) => ({
  ...body,
  publicKey: keys.publicKey,
  signature: signCard({ agentId, card: body, privateKey: keys.privateKey }),
});

const cardBody = (agentId, name = "Synapse") => ({
  agentId, name, description: "visiting agent", capabilities: ["chat"],
});

const redeemCard = (request, card, roomId = "commons", extras = {}) =>
  request("/api/guest-agent-links/redeem-card", { method: "POST", data: { card, roomId, ...extras } });

test("a valid signed card mints a 3-day observer pass with the guest badge", async t => {
  const { request } = await serve(t);
  const agentId = "agent-card-1";
  const keys = generateKeyPair();
  const card = signEnvelope(agentId, cardBody(agentId), keys);
  const before = Date.now();
  const res = await redeemCard(request, card);
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.admission, "signed_card");
  assert.equal(body.tier, "observer");
  assert.deepEqual(body.scopes, [...GUEST_INVITE_TIERS.observer]);
  assert.equal(body.duplicate, false);
  assert.equal(body.member.displayName, `Synapse${GUEST_BADGE_SUFFIX}`);
  assert.equal(body.room.id, "commons");
  assert.ok(typeof body.token === "string" && body.token.startsWith("ga1."));
  // Default pass length is 3 days.
  assert.ok(Math.abs(body.expiresAt - (before + GUEST_CREDENTIAL_TTL_DEFAULT_MS)) < 60 * 1000);
  assert.equal(body.expiresAt, body.member.expiresAt);
  // The pass authenticates: the guest can read the room.
  const authed = await request("/api/rooms/commons/events", { token: body.token });
  assert.equal(authed.status, 200, `guest pass should authenticate, got ${authed.status}`);
});

test("invalid cards are rejected before any room state is touched", async t => {
  const { request, store } = await serve(t);
  const agentId = "agent-card-2";
  const keys = generateKeyPair();
  const good = signEnvelope(agentId, cardBody(agentId), keys);
  const membersBefore = Object.keys(store.room("commons").state.members).length;

  // Tampered name: signature no longer verifies.
  const tampered = { ...good, name: "Synapse-evil" };
  const bad1 = await redeemCard(request, tampered);
  assert.equal(bad1.status, 422);
  assert.equal((await bad1.json()).error.code, "card_invalid");

  // Signature from a different key.
  const other = generateKeyPair();
  const badSig = { ...good, signature: signCard({ agentId, card: cardBody(agentId), privateKey: other.privateKey }) };
  const bad2 = await redeemCard(request, badSig);
  assert.equal(bad2.status, 422);

  // Envelope agentId swapped after signing: the bound agentId no longer matches.
  const bad3 = await redeemCard(request, { ...good, agentId: "agent-card-impostor" });
  assert.equal(bad3.status, 422);

  // Malformed card (no name at all).
  const bad4 = await redeemCard(request, { agentId, publicKey: keys.publicKey, signature: good.signature });
  assert.equal(bad4.status, 422);

  assert.equal(Object.keys(store.room("commons").state.members).length, membersBefore,
    "no member row is created by a rejected card");
});

test("a card whose agentId already holds a live pass gets 409, not a second pass", async t => {
  const { request } = await serve(t);
  const agentId = "agent-card-3";
  const keys = generateKeyPair();
  const card = signEnvelope(agentId, cardBody(agentId), keys);
  const first = await redeemCard(request, card);
  assert.equal(first.status, 201);
  const firstBody = await first.json();
  const memberId = firstBody.member.id;

  const replay = await redeemCard(request, card);
  assert.equal(replay.status, 409);
  assert.equal((await replay.json()).error.code, "card_already_redeemed");
  assert.equal(memberId, firstBody.member.id);
});

test("expiry re-presents a fresh pass on the same seat; the journal records the reactivation", async t => {
  const { store, request, advance } = await serve(t);
  const agentId = "agent-card-4";
  const keys = generateKeyPair();
  const card = signEnvelope(agentId, cardBody(agentId), keys);
  const first = await redeemCard(request, card, "commons", { requestedPass: 3600 * 1000 });
  assert.equal(first.status, 201);
  const firstBody = await first.json();
  const memberId = firstBody.member.id;

  advance(2 * 3600 * 1000); // past the 1-hour pass
  const second = await redeemCard(request, card);
  const secondRaw = await second.text();
  assert.equal(second.status, 200, `expected reactivation, got ${second.status}: ${secondRaw}`);
  const secondBody = JSON.parse(secondRaw);
  assert.equal(secondBody.duplicate, true);
  assert.equal(secondBody.member.id, memberId, "same deterministic seat, never a duplicate member");
  assert.ok(secondBody.expiresAt > firstBody.expiresAt);
  // The journal holds the original admission and the reactivation.
  const journal = store.db.prepare("SELECT body FROM events WHERE room_id=?").all("commons")
    .map(r => JSON.parse(r.body));
  const admissions = journal.filter(e => e.type === T.MEMBER_ADDED && e.data?.memberId === memberId);
  const reactivations = journal.filter(e => e.type === T.MEMBER_ACCESS_CHANGED && e.data?.memberId === memberId && e.data?.active === true);
  assert.equal(admissions.length, 1);
  assert.ok(reactivations.length >= 1, "reactivation is journaled");
  assert.equal(admissions[0].actorId, "owner", "the room owner sponsors the self-serve admission");
});

test("requestedPass bounds: 1 hour to 14 days, default 3 days", async t => {
  const { request } = await serve(t);
  const mk = n => {
    const agentId = `agent-card-ttl-${n}-${randomUUID().slice(0, 8)}`;
    const keys = generateKeyPair();
    return signEnvelope(agentId, cardBody(agentId, `TTL ${n}`), keys);
  };
  const before = Date.now();
  for (const [i, bad] of [59 * 60 * 1000, 15 * DAY, "not-a-number", { ttlMs: 30 * 60 * 1000 }, { ttlMs: 15 * DAY }].entries()) {
    const res = await redeemCard(request, mk(`bad-${i}`), "commons", { requestedPass: bad });
    assert.equal(res.status, 422, `requestedPass ${JSON.stringify(bad)} should be refused`);
    assert.equal((await res.json()).error.code, "invalid_pass_duration");
  }
  const oneHour = await redeemCard(request, mk("ok1"), "commons", { requestedPass: 3600 * 1000 });
  assert.equal(oneHour.status, 201);
  assert.ok(Math.abs((await oneHour.json()).expiresAt - (before + 3600 * 1000)) < 60 * 1000);
  const twoWeeks = await redeemCard(request, mk("ok2"), "commons", { requestedPass: { ttlMs: 14 * DAY } });
  assert.equal(twoWeeks.status, 201);
  const twoWeeksBody = await twoWeeks.json();
  assert.ok(Math.abs(twoWeeksBody.expiresAt - (before + 14 * DAY)) < 60 * 1000);
  const def = await redeemCard(request, mk("ok3"));
  assert.equal(def.status, 201);
  const defBody = await def.json();
  assert.ok(Math.abs(defBody.expiresAt - (before + GUEST_CREDENTIAL_TTL_DEFAULT_MS)) < 60 * 1000);
});

test("only publicly listed rooms admit signed cards", async t => {
  const { store, request } = await serve(t);
  store.roomDirectory.set("commons", "owner", false);
  const agentId = "agent-card-5";
  const keys = generateKeyPair();
  const card = signEnvelope(agentId, cardBody(agentId), keys);
  const res = await redeemCard(request, card);
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error.code, "room_not_found");
  const unknown = await redeemCard(request, card, "no-such-room");
  assert.equal(unknown.status, 404);
});

test("displayName override is honored and still gets the badge", async t => {
  const { request } = await serve(t);
  const agentId = "agent-card-6";
  const keys = generateKeyPair();
  const card = signEnvelope(agentId, cardBody(agentId), keys);
  const res = await redeemCard(request, card, "commons", { displayName: "Field Agent" });
  assert.equal(res.status, 201);
  assert.equal((await res.json()).member.displayName, `Field Agent${GUEST_BADGE_SUFFIX}`);

  for (const bad of ["", "   ", "x".repeat(81), "bad\nname"]) {
    const badAgentId = `agent-card-6b-${bad.length}`;
    const badKeys = generateKeyPair();
    const badCard = signEnvelope(badAgentId, cardBody(badAgentId), badKeys);
    const badRes = await redeemCard(request, badCard, "commons", { displayName: bad });
    assert.equal(badRes.status, 422, `displayName ${JSON.stringify(bad)} should be refused`);
    assert.equal((await badRes.json()).error.code, "card_invalid");
  }
  const numAgentId = "agent-card-6b-num";
  const numKeys = generateKeyPair();
  const numCard = signEnvelope(numAgentId, cardBody(numAgentId), numKeys);
  const numRes = await redeemCard(request, numCard, "commons", { displayName: 42 });
  assert.equal(numRes.status, 422);
  assert.equal((await numRes.json()).error.code, "invalid_card_redemption");
});

test("card guests work with the existing owner controls: upgrade, disconnect, revoke-all", async t => {
  const { store, request, ownerKey } = await serve(t);
  const mk = async n => {
    const agentId = `agent-card-ctl-${n}`;
    const keys = generateKeyPair();
    const res = await redeemCard(request, signEnvelope(agentId, cardBody(agentId, `Control ${n}`), keys));
    assert.equal(res.status, 201);
    return (await res.json()).member.id;
  };
  const memberA = await mk("a");
  const memberB = await mk("b");

  // Owner upgrades the card guest to contributor (drafts-only).
  const up = await request("/api/rooms/commons/guest-invites-upgrade", {
    method: "POST", token: ownerKey,
    data: { memberId: memberA, tier: "contributor" },
  });
  const upBody = await up.text();
  assert.equal(up.status, 200, `upgrade failed: ${upBody}`);
  assert.equal(JSON.parse(upBody).tier, "contributor");

  // Owner disconnects one card guest.
  const disc = await request("/api/rooms/commons/guest-invites-disconnect", {
    method: "POST", token: ownerKey, data: { memberId: memberB },
  });
  assert.equal(disc.status, 200);

  // Owner revoke-all ends every remaining guest.
  const revokeAll = await request("/api/rooms/commons/guest-invites-revoke-all", { method: "POST", token: ownerKey, data: {} });
  assert.equal(revokeAll.status, 200);
  assert.equal(store.guestInvites.activeGuestCount("commons"), 0);
  // The owner's invite list distinguishes card admissions.
  const list = await request("/api/rooms/commons/guest-invites-list", { method: "POST", token: ownerKey, data: {} });
  assert.equal(list.status, 200);
  const kinds = (await list.json()).map(r => r.kind);
  assert.ok(kinds.includes("card"), `expected card admissions in the owner list, got ${JSON.stringify(kinds)}`);
});
