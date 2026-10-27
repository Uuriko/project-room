// End to end for the guest-seat liveness gate (post-#4576 finding,
// muse-room seq 19133): an owner disconnects a guest, and from that
// moment the guest's webhook subscription must receive NOTHING — the
// fan-out must not journal new deliveries for the seat, the drain must
// not select its already-queued deliveries, and no room body may be
// POSTed to its URL — even though its guest_members row remains (a
// returning guest reactivates the same seat). A guest that stays
// connected keeps receiving throughout. The unit legs of the gate are
// pinned in tests/guest-wake-live-seat.test.js.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { generateKeyPair, signCard } from "../server/agent-card-signing.mjs";

// Fake DNS so the dispatch-time SSRF guard re-validates without
// touching the network (same shape the other webhook tests inject).
const publicDns = { resolve4: async () => ["93.184.216.34"], resolve6: async () => [] };
const ok200 = () => ({ status: 200, headers: { get: () => null }, text: async () => "ok" });

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

// Seat a trial-seat (guest) agent through the real mint -> redeem flow
// (the pattern from tests/guest-wake-resolution.test.js): the member
// lands in guest_members only, and the redeem mints its access
// credential — the seat's liveness state.
async function seatGuest(f, origin, ownerKey, name) {
  const mint = await (await post(origin, "/api/rooms/commons/guest-invites",
    { requestId: randomUUID(), guestLabel: `guest ${name}`, expectedOwnerRevision: 0, credentialTtlMs: 3600_000 },
    ownerKey)).json();
  assert.ok(mint.code, `mint returns a code: ${JSON.stringify(mint).slice(0, 200)}`);
  const identity = f.store.identities.create(name);
  const kp = generateKeyPair();
  const cardBody = { name, description: "guest live-seat drain test", capabilities: ["chat"] };
  const card = { ...cardBody, publicKey: kp.publicKey,
    signature: signCard({ agentId: identity.identityId, card: cardBody, privateKey: kp.privateKey }) };
  const redeemed = await (await post(origin, "/api/guest-invites/redeem",
    { inviteCode: mint.code, card }, identity.secret)).json();
  assert.ok(redeemed.member?.id, `redeem seats a member: ${JSON.stringify(redeemed).slice(0, 200)}`);
  return { identity, memberId: redeemed.member.id, token: redeemed.token };
}

test("disconnect -> post -> drain: a disconnected guest seat receives zero webhook deliveries; a connected guest keeps receiving", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const ownerKey = f.store.issueAccessKey("commons", "owner");
  const gone = await seatGuest(f, origin, ownerKey, "GuestGone");
  const staying = await seatGuest(f, origin, ownerKey, "GuestStaying");
  const plugin = f.store.agentPlugin;
  for (const [guest, label] of [[gone, "gone"], [staying, "staying"]]) {
    plugin.subscribeWebhook({
      identityId: guest.identity.identityId,
      url: `https://${label}.example.test/hook`,
      events: ["message.posted"],
    });
  }
  const deliveriesFor = identityId => f.store.db.prepare(
    "SELECT delivery_id AS id FROM agent_webhook_deliveries WHERE agent_id=? AND event_type='message.posted'")
    .all(identityId).map(r => r.id);
  const postRoom = (messageId, body) => f.store.command(ownerKey, "commons", {
    id: randomUUID(), type: "message.posted", data: { messageId, body },
  });

  // While both seats are live, a room post fans out to both.
  postRoom("live-1", "before disconnect");
  assert.equal(deliveriesFor(gone.identity.identityId).length, 1,
    "live guest receives the room event");
  assert.equal(deliveriesFor(staying.identity.identityId).length, 1,
    "second live guest receives the room event");

  // Owner disconnects one guest. The seat's access credential is
  // revoked and the member deactivated, but the guest_members row
  // REMAINS — the exact state the pre-fix gates misjudged as seated.
  f.store.guestInvites.disconnect(ownerKey, "commons", gone.memberId);
  assert.equal(f.store.db.prepare(
    "SELECT COUNT(*) AS n FROM guest_members WHERE member_id=?").get(gone.memberId).n, 1,
    "disconnect leaves the guest_members row in place");
  assert.equal(f.store.db.prepare(
    "SELECT COUNT(*) AS n FROM credentials WHERE room_id='commons' AND member_id=? AND kind='access' AND revoked=0")
    .get(gone.memberId).n, 0,
    "disconnect leaves the seat with no unrevoked access credential");

  // A post after the disconnect fans out only to the connected guest:
  // no new delivery is even journaled for the disconnected seat.
  postRoom("live-2", "after disconnect");
  assert.equal(deliveriesFor(gone.identity.identityId).length, 1,
    "no new delivery is journaled for the disconnected seat");
  assert.equal(deliveriesFor(staying.identity.identityId).length, 2,
    "the connected guest keeps receiving");

  // Drain: only the connected guest's deliveries are POSTed. The
  // disconnected seat's pre-disconnect delivery is never selected, so
  // its room body is never sent; the row stays pending (a reactivated
  // seat can still receive it, per the drain's re-seat contract).
  const posted = [];
  const fetchImpl = async (url, init) => { posted.push(init.headers["x-webhook-delivery"]); return ok200(); };
  const summary = await plugin.drainWebhookDeliveries({
    fetchImpl, now: Date.now() + 1000, dnsResolvers: publicDns,
  });
  assert.deepEqual([...posted].sort(), [...deliveriesFor(staying.identity.identityId)].sort(),
    "only the connected guest's deliveries are POSTed");
  assert.equal(summary.delivered, 2, "both of the connected guest's deliveries drain");
  assert.equal(summary.processed, 2, "the disconnected seat's queued row never enters the batch");
  const goneRow = f.store.db.prepare(
    "SELECT state FROM agent_webhook_deliveries WHERE agent_id=?").get(gone.identity.identityId);
  assert.equal(goneRow.state, "pending",
    "the disconnected seat's queued delivery stays pending, never sent");
});
