// #3882 (bug sweep 2026-10-16, lane 08 F-4): guest-seat membership truth
// on the agent read surfaces. An identity seated as a guest (trial seat)
// lives in guest_members only — never identity_links — and the surfaces
// that enumerate "my rooms" from identity_links alone silently dropped
// the seat: the needs-me inbox never showed the room, the agent-rooms
// list omitted it, and the capability catalog resolved the identity as
// holding no membership at all. All three now enumerate seats through
// the shared resolver (server/membership-resolution.mjs): identity_links
// first, guest_members as the fallback, one seat per room.
//
// Seating follows the real mint -> redeem flow, as in
// tests/guest-wake-resolution.test.js.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { generateKeyPair, signCard } from "../server/agent-card-signing.mjs";
import { identityRoomSeats } from "../server/membership-resolution.mjs";
import { collectNeedsMe } from "../server/needs-me.mjs";
import { AgentRooms } from "../server/agent-rooms.mjs";
import { resolveCatalogAgent } from "../server/capability-visibility.mjs";
import { linkWithProof } from "./helpers/link-with-proof.mjs";

async function startServer(t, f) {
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  return `http://127.0.0.1:${server.address().port}`;
}
const post = (origin, path, body, secret) => fetch(`${origin}${path}`, {
  method: "POST",
  headers: { "content-type": "application/json", ...(secret ? { authorization: `Bearer ${secret}` } : {}) },
  body: JSON.stringify(body),
});

// Seat a trial-seat (guest) agent through the real mint -> redeem flow.
// The member lands in guest_members only — never identity_links.
async function seatGuest(f, origin, ownerKey, name) {
  const mint = await (await post(origin, "/api/rooms/commons/guest-invites",
    { requestId: randomUUID(), guestLabel: `guest ${name}`, expectedOwnerRevision: 0, credentialTtlMs: 3600_000 },
    ownerKey)).json();
  assert.ok(mint.code, `mint returns a code: ${JSON.stringify(mint).slice(0, 200)}`);
  const identity = f.store.identities.create(name);
  const kp = generateKeyPair();
  const cardBody = { name, description: "membership resolution test", capabilities: ["chat"] };
  const card = { ...cardBody, publicKey: kp.publicKey,
    signature: signCard({ agentId: identity.identityId, card: cardBody, privateKey: kp.privateKey }) };
  const redeemed = await (await post(origin, "/api/guest-invites/redeem",
    { inviteCode: mint.code, card }, identity.secret)).json();
  assert.ok(redeemed.member?.id, `redeem seats a member: ${JSON.stringify(redeemed).slice(0, 200)}`);
  return { identity, memberId: redeemed.member.id };
}

async function fixture(t) {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const ownerKey = f.store.issueAccessKey("commons", "owner");
  const guest = await seatGuest(f, origin, ownerKey, "GuestSeat");
  // Control: a fully linked member identity in the same room.
  const linked = f.store.identities.create("seat-linked");
  linkWithProof(f.store, ownerKey, "commons", linked, { memberId: "seat-linked", displayName: "SeatLinked", permissions: [] });
  // Control: an identity seated in neither table.
  const stranger = f.store.identities.create("seat-stranger");
  return { f, ownerKey, guest, linked, stranger };
}

test("resolver enumerates guest seats alongside links; a link seat wins a shared room", async t => {
  const { f, guest, linked, stranger } = await fixture(t);
  assert.deepEqual(identityRoomSeats(f.store.db, guest.identity.identityId),
    [{ roomId: "commons", memberId: guest.memberId, seat: "guest" }],
    "guest seat enumerates as a guest seat");
  assert.deepEqual(identityRoomSeats(f.store.db, linked.identityId),
    [{ roomId: "commons", memberId: "seat-linked", seat: "link" }],
    "linked seat enumerates as a link seat");
  assert.deepEqual(identityRoomSeats(f.store.db, stranger.identityId), [],
    "a non-member identity has no seats");
  // Both rows in one room: the link seat supersedes the guest seat.
  f.store.db.prepare("INSERT INTO identity_links(room_id, identity_id, member_id, linked_at) VALUES(?,?,?,?)")
    .run("commons", guest.identity.identityId, "promoted-member", Date.now());
  assert.deepEqual(identityRoomSeats(f.store.db, guest.identity.identityId),
    [{ roomId: "commons", memberId: "promoted-member", seat: "link" }],
    "one seat per room, and the link seat wins");
});

test("needs-me inbox includes rooms where the identity holds only a guest seat", async t => {
  const { f, ownerKey, guest, linked, stranger } = await fixture(t);
  f.store.command(ownerKey, "commons", { id: "dm-guest", type: "message.posted",
    data: { messageId: "dm-guest", body: "a note for the guest", toMemberId: guest.memberId } });
  f.store.command(ownerKey, "commons", { id: "dm-linked", type: "message.posted",
    data: { messageId: "dm-linked", body: "a note for the linked member", toMemberId: "seat-linked" } });

  const guestPage = collectNeedsMe(f.store, guest.identity.secret, {});
  assert.ok(guestPage.items.some(item => item.roomId === "commons" && item.kind === "dm" && item.id === "dm-guest"),
    `guest inbox surfaces the guest room's DM: ${JSON.stringify(guestPage.items.map(i => i.id))}`);
  const linkedPage = collectNeedsMe(f.store, linked.secret, {});
  assert.ok(linkedPage.items.some(item => item.roomId === "commons" && item.id === "dm-linked"),
    "linked control still surfaces its DM");
  const strangerPage = collectNeedsMe(f.store, stranger.secret, {});
  assert.ok(!strangerPage.items.some(item => item.roomId === "commons"),
    "a non-member identity sees nothing from the room");
});

test("agent-rooms list includes the guest seat's room", async t => {
  const { f, guest, linked, stranger } = await fixture(t);
  const rooms = new AgentRooms(f.store);
  const guestRooms = rooms.list(guest.identity.secret).rooms;
  const guestEntry = guestRooms.find(room => room.roomId === "commons");
  assert.ok(guestEntry, `guest list includes commons: ${JSON.stringify(guestRooms.map(r => r.roomId))}`);
  assert.equal(guestEntry.memberId, guest.memberId, "the entry carries the guest seat's member id");
  assert.ok(rooms.list(linked.secret).rooms.some(room => room.roomId === "commons"),
    "linked control still lists the room");
  assert.ok(!rooms.list(stranger.secret).rooms.some(room => room.roomId === "commons"),
    "a non-member identity does not list the room");
});

test("catalog memberships include an identity whose only seat is a guest seat", async t => {
  const { f, guest, linked, stranger } = await fixture(t);
  const guestAgent = resolveCatalogAgent(f.store, { identityId: guest.identity.identityId });
  const guestMembership = guestAgent.memberships.find(m => m.roomId === "commons");
  assert.ok(guestMembership, `guest identity holds a catalog membership: ${JSON.stringify(guestAgent.memberships)}`);
  assert.equal(guestMembership.memberId, guest.memberId);
  assert.equal(guestMembership.isGuest, true, "the membership is classified guest");
  const linkedAgent = resolveCatalogAgent(f.store, { identityId: linked.identityId });
  assert.ok(linkedAgent.memberships.some(m => m.roomId === "commons" && m.isGuest === false),
    "linked control holds a full membership");
  const strangerAgent = resolveCatalogAgent(f.store, { identityId: stranger.identityId });
  assert.ok(!strangerAgent.memberships.some(m => m.roomId === "commons"),
    "a non-member identity holds no membership in the room");
});
