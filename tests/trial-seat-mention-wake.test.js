// Trial-seat mention wakes (decision #25): a guest/trial-seat agent member
// must RECEIVE mention wakes in its room, exactly like a linked member.
// Guest members are seated through guest_members, not identity_links —
// the wake-on-mention fan-out resolved members only via identity_links
// and silently skipped every trial seat. Work wakes stay excluded for
// trial seats (their resolution path is untouched by this fix).
//
// Authoring gate: the guest is seated through the real mint -> redeem
// HTTP flow and heartbeats with its identity secret; the mention is a
// real owner command. The wake is observed on the guest identity's own
// poll — the surface the guest agent actually reads.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { generateKeyPair, signCard } from "../server/agent-card-signing.mjs";

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
const get = (origin, path, secret) => fetch(`${origin}${path}`, {
  headers: secret ? { authorization: `Bearer ${secret}` } : {},
});

test("a mentioned trial-seat (guest) agent receives the mention wake on its poll", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  // One owner key for everything below: issuing an access key rotates the
  // member's previous key, so the fixture's f.keys.owner must not be mixed
  // with a freshly issued one.
  const ownerKey = f.store.issueAccessKey("commons", "owner");

  // Owner mints a guest invite; a fresh agent identity redeems it (the
  // real trial-seat path — the member lands in guest_members only).
  const mint = await (await post(origin, "/api/rooms/commons/guest-invites",
    { requestId: randomUUID(), guestLabel: "trial wake test", expectedOwnerRevision: 0, credentialTtlMs: 3600_000 },
    ownerKey)).json();
  assert.ok(mint.code, `mint returns a code: ${JSON.stringify(mint).slice(0, 200)}`);
  const guest = f.store.identities.create("trial-guest");
  const kp = generateKeyPair();
  const cardBody = { name: "TrialGuest", description: "trial seat wake test", capabilities: ["chat"] };
  const card = { ...cardBody, publicKey: kp.publicKey,
    signature: signCard({ agentId: guest.identityId, card: cardBody, privateKey: kp.privateKey }) };
  const redeemed = await (await post(origin, "/api/guest-invites/redeem",
    { inviteCode: mint.code, card }, guest.secret)).json();
  assert.ok(redeemed.member?.id, `redeem seats a member: ${JSON.stringify(redeemed).slice(0, 200)}`);
  const guestMemberId = redeemed.member.id;

  // Precondition of the bug: the trial seat has NO identity_links row.
  assert.equal(f.store.db.prepare(
    "SELECT COUNT(*) AS n FROM identity_links WHERE room_id=? AND member_id=?")
    .get("commons", guestMemberId).n, 0);
  assert.equal(f.store.db.prepare(
    "SELECT COUNT(*) AS n FROM guest_members WHERE room_id=? AND member_id=?")
    .get("commons", guestMemberId).n, 1);

  // The guest registers a host (heartbeat) like any always-on agent.
  const beat = await post(origin, "/api/agent-heartbeats", { hostId: "trial-host" }, guest.secret);
  assert.equal(beat.status, 200);

  // Control: an agent member with NO link of either kind is mentioned in
  // the same room — it must stay unwoken (unresolved members never wake).
  f.store.command(ownerKey, "commons", {
    id: randomUUID(), type: "member.added",
    data: { memberId: "unlinked-agent", displayName: "UnlinkedAgent", kind: "agent", permissions: [] },
  });
  f.store.command(ownerKey, "commons", {
    id: randomUUID(), type: "message.posted",
    data: { messageId: "ctrl-1", body: "@UnlinkedAgent hello" },
  });
  assert.equal(f.store.db.prepare(
    "SELECT COUNT(*) AS n FROM agent_wake_signals WHERE message_id=?").get("ctrl-1").n, 0,
    "unlinked member mention queues no wake (pre-existing behavior preserved)");

  // The owner mentions the trial seat by its card display name.
  f.store.command(ownerKey, "commons", {
    id: randomUUID(), type: "message.posted",
    data: { messageId: "trial-mention-1", body: "@TrialGuest please look at this" },
  });

  // The wake is queued for the guest identity and readable on its own poll.
  const poll = await (await get(origin,
    "/api/agent-wakes/poll?hostId=trial-host&waitMs=0", guest.secret)).json();
  assert.deepEqual(poll.pendingWakes.map(w => w.messageId), ["trial-mention-1"],
    "trial seat receives the mention wake (decision #25)");
  assert.equal(poll.pendingWakes[0].kind, "mention");

  // Boundary (decision #25): the fix must NOT leak trial seats into the
  // work-wake path — identityIdForMember (used by work wakes) still does
  // not resolve guest members.
  assert.equal(f.store.identities.identityIdForMember("commons", guestMemberId), null);
  assert.deepEqual(f.store.workWakes.pending(guest.identityId), []);
});
