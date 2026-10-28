// Access and delivery rules, checked over HTTP against one loopback room.
// A rule that does not hold is named in KNOWN-GAPS.md. The test fails when
// the note and the observed behavior disagree.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { AgentRooms } from "../../server/agent-rooms.mjs";
import { installFakeWebhookDns } from "../helpers/fake-webhook-dns.mjs";
import { PAUSE_WRITE_GAP, containsSecret, errorCode, knownGap, startSafetyNet } from "./harness.mjs";

const HOOK = "https://safety-net.example.test/hook";
const ROOM_PHRASE = "safety-net-room-phrase";
const OTHER_PHRASE = "safety-net-other-phrase";
const DM_PHRASE = "safety-net-dm-phrase";

function roomIdsIn(value, found = []) {
  if (!value || typeof value !== "object") return found;
  if (Array.isArray(value)) {
    for (const item of value) roomIdsIn(item, found);
    return found;
  }
  for (const [key, item] of Object.entries(value)) {
    if (key === "roomId" && typeof item === "string") found.push(item);
    else roomIdsIn(item, found);
  }
  return found;
}

test("safety invariants", async t => {
  const { store, call } = await startSafetyNet(t);
  installFakeWebhookDns(store);
  const rooms = new AgentRooms(store);
  const owner = store.identities.create("Invariant Owner");
  const peer = store.identities.create("Invariant Peer");
  const outsider = store.identities.create("Invariant Outsider");
  const otherOwner = store.identities.create("Invariant Other");
  const created = rooms.create(owner.secret, {
    roomId: "safety-inv-a", title: "Invariant A", purpose: "Access rules", kind: "personal", displayName: "Invariant Owner"
  });
  const other = rooms.create(otherOwner.secret, {
    roomId: "safety-inv-b", title: "Invariant B", purpose: "The other room", kind: "personal", displayName: "Invariant Other"
  });
  store.identities.link(owner.secret, created.roomId, {
    identityId: peer.identityId, displayName: "Invariant Peer", permissions: []
  });
  store.identities.link(owner.secret, created.roomId, {
    identityId: outsider.identityId, displayName: "Invariant Outsider", permissions: []
  });
  const secrets = [owner.secret, peer.secret, outsider.secret, otherOwner.secret, created.mcpToken.credential, other.mcpToken.credential];

  const visible = await call(`/api/rooms/${created.roomId}/commands`, {
    method: "POST", token: owner.secret,
    data: { id: randomUUID(), type: "message.posted", data: { messageId: randomUUID(), body: ROOM_PHRASE } }
  });
  assert.equal(visible.status, 201, `room post status ${visible.status} ${errorCode(visible.body)}`);
  const elsewhere = await call(`/api/rooms/${other.roomId}/commands`, {
    method: "POST", token: otherOwner.secret,
    data: { id: randomUUID(), type: "message.posted", data: { messageId: randomUUID(), body: OTHER_PHRASE } }
  });
  assert.equal(elsewhere.status, 201, `other post status ${elsewhere.status} ${errorCode(elsewhere.body)}`);
  const direct = await call(`/api/rooms/${created.roomId}/commands`, {
    method: "POST", token: owner.secret,
    data: { id: randomUUID(), type: "message.posted", data: { messageId: randomUUID(), body: DM_PHRASE, toMemberId: peer.identityId } }
  });
  assert.equal(direct.status, 201, `dm status ${direct.status} ${errorCode(direct.body)}`);

  const stranger = await call(`/api/rooms/${created.roomId}`, { token: otherOwner.secret });
  assert.ok(stranger.status === 401 || stranger.status === 403, `non-member read status ${stranger.status}`);
  assert.equal(JSON.stringify(stranger.body).includes(ROOM_PHRASE), false);
  const peerRoom = await call(`/api/rooms/${created.roomId}`, { token: peer.secret });
  assert.equal(peerRoom.status, 200, `member read status ${peerRoom.status} ${errorCode(peerRoom.body)}`);
  assert.equal(peerRoom.body?.state?.messages?.some(message => message.body === ROOM_PHRASE), true);

  const outsiderEvents = await call(`/api/rooms/${created.roomId}/events`, { token: outsider.secret });
  assert.equal(outsiderEvents.status, 200, `outsider events status ${outsiderEvents.status}`);
  assert.equal(JSON.stringify(outsiderEvents.body).includes(DM_PHRASE), false);
  const outsiderSnapshot = await call(`/api/rooms/${created.roomId}`, { token: outsider.secret });
  assert.equal(JSON.stringify(outsiderSnapshot.body).includes(DM_PHRASE), false);
  const outsiderSearch = await call(`/api/rooms/${created.roomId}/search?q=${encodeURIComponent(DM_PHRASE)}`, { token: outsider.secret });
  assert.equal(outsiderSearch.status, 200, `outsider search status ${outsiderSearch.status} ${errorCode(outsiderSearch.body)}`);
  assert.equal(outsiderSearch.body?.query, DM_PHRASE);
  assert.equal(JSON.stringify({ messages: outsiderSearch.body?.messages, workItems: outsiderSearch.body?.workItems }).includes(DM_PHRASE), false);
  const peerEvents = await call(`/api/rooms/${created.roomId}/events`, { token: peer.secret });
  assert.equal(JSON.stringify(peerEvents.body).includes(DM_PHRASE), true);

  const listed = await call("/api/public/rooms/directory");
  assert.equal(listed.status, 200, `directory status ${listed.status}`);
  const listedIds = () => (listed.body?.rooms ?? []).map(room => room.roomId);
  assert.equal(listedIds().includes(created.roomId), false);
  assert.equal(listedIds().includes(other.roomId), false);
  const publish = await call(`/api/rooms/${created.roomId}/directory`, {
    method: "POST", token: owner.secret, data: { discoverable: true }
  });
  assert.equal(publish.status, 200, `publish status ${publish.status} ${errorCode(publish.body)}`);
  const directory = await call("/api/public/rooms/directory");
  const publicIds = (directory.body?.rooms ?? []).map(room => room.roomId);
  assert.equal(publicIds.includes(created.roomId), true);
  assert.equal(publicIds.includes(other.roomId), false);
  const cross = await call(`/api/rooms/${other.roomId}/search?q=${encodeURIComponent(OTHER_PHRASE)}`, { token: owner.secret });
  assert.ok(cross.status === 401 || cross.status === 403, `cross-room search status ${cross.status}`);
  assert.equal(JSON.stringify(cross.body).includes(OTHER_PHRASE), false);
  const ownSearch = await call(`/api/rooms/${created.roomId}/search?q=${encodeURIComponent(OTHER_PHRASE)}`, { token: owner.secret });
  assert.equal(ownSearch.status, 200, `own search status ${ownSearch.status} ${errorCode(ownSearch.body)}`);
  assert.equal(ownSearch.body?.roomId, created.roomId);
  assert.equal(ownSearch.body?.messages?.length ?? 0, 0);

  const taskId = "safety-inv-task";
  const made = await call(`/api/rooms/${created.roomId}/work-claims`, {
    method: "POST", token: owner.secret, data: { id: taskId, title: "Invariant task", reviewPolicy: "self_attested" }
  });
  assert.equal(made.status, 201, `claim create status ${made.status} ${errorCode(made.body)}`);
  const claimed = await call(`/api/rooms/${created.roomId}/work-claims/${taskId}/claim`, {
    method: "POST", token: owner.secret, data: { leaseHours: 1 }
  });
  assert.equal(claimed.status, 200, `claim status ${claimed.status} ${errorCode(claimed.body)}`);
  const board = await call(`/api/rooms/${created.roomId}/work-claims?view=summary&state=claimed`, { token: peer.secret });
  const row = board.body?.claims?.find(claim => claim.id === taskId);
  assert.equal(row?.owner, created.ownerMemberId);
  const one = await call(`/api/rooms/${created.roomId}/work-claims/${taskId}`, { token: peer.secret });
  assert.equal(one.body?.owner, created.ownerMemberId);

  const paused = await call(`/api/rooms/${created.roomId}/agent-pause`, {
    method: "POST", token: owner.secret,
    data: { action: "pause", memberId: peer.identityId, requestId: randomUUID(), reason: "invariant stop" }
  });
  assert.equal(paused.status, 201, `pause status ${paused.status} ${errorCode(paused.body)}`);
  assert.equal(paused.body?.pause?.heldBy, "owner");
  const pausedWrite = await call(`/api/rooms/${created.roomId}/commands`, {
    method: "POST", token: peer.secret,
    data: { id: randomUUID(), type: "message.posted", data: { messageId: randomUUID(), body: "paused write" } }
  });
  if (pausedWrite.status === 423) {
    assert.equal(errorCode(pausedWrite.body), "member_paused");
    assert.equal(knownGap(PAUSE_WRITE_GAP), false, "delete the paused-agents-cannot-write note in tests/safety-net/KNOWN-GAPS.md");
  } else {
    assert.equal(pausedWrite.status, 201, `paused write status ${pausedWrite.status} ${errorCode(pausedWrite.body)}`);
    assert.equal(knownGap(PAUSE_WRITE_GAP), true, "paused agent message.posted succeeded; record it in tests/safety-net/KNOWN-GAPS.md");
  }
  await call(`/api/rooms/${created.roomId}/agent-pause`, {
    method: "POST", token: owner.secret,
    data: { action: "resume", memberId: peer.identityId, requestId: randomUUID() }
  });

  const beforeRemoval = await call(`/api/rooms/${created.roomId}`, { token: owner.secret });
  const outsiderMember = beforeRemoval.body?.state?.members?.[outsider.identityId];
  const removed = await call(`/api/rooms/${created.roomId}/commands`, {
    method: "POST", token: owner.secret,
    data: {
      id: randomUUID(), type: "member.access_changed",
      data: { memberId: outsider.identityId, expectedMemberRevision: outsiderMember.revision, permissions: outsiderMember.permissions, active: false }
    }
  });
  assert.equal(removed.status, 201, `remove status ${removed.status} ${errorCode(removed.body)}`);
  const lost = await call(`/api/rooms/${created.roomId}/events`, { token: outsider.secret });
  assert.ok(lost.status === 401 || lost.status === 403, `removed read status ${lost.status} ${errorCode(lost.body)}`);
  assert.ok(errorCode(lost.body) === "unauthenticated" || errorCode(lost.body) === "access_denied");
  assert.equal(JSON.stringify(lost.body).includes(ROOM_PHRASE), false);
  const lostWrite = await call(`/api/rooms/${created.roomId}/commands`, {
    method: "POST", token: outsider.secret,
    data: { id: randomUUID(), type: "message.posted", data: { messageId: randomUUID(), body: "removed write" } }
  });
  assert.ok(lostWrite.status === 401 || lostWrite.status === 403, `removed write status ${lostWrite.status} ${errorCode(lostWrite.body)}`);

  const subscribed = await call("/api/agent-webhooks", {
    method: "POST", token: owner.secret, data: { url: HOOK, events: ["message.posted"] }
  });
  assert.equal(subscribed.status, 201, `subscribe status ${subscribed.status} ${errorCode(subscribed.body)}`);
  const signingSecret = store.db.prepare("SELECT secret FROM agent_webhook_subs WHERE url=?").get(HOOK)?.secret;
  assert.equal(typeof signingSecret, "string");
  secrets.push(signingSecret);
  const hookList = await call("/api/agent-webhooks", { token: owner.secret });
  assert.equal(hookList.status, 200, `webhook list status ${hookList.status}`);
  await call(`/api/rooms/${created.roomId}/commands`, {
    method: "POST", token: owner.secret,
    data: { id: randomUUID(), type: "message.posted", data: { messageId: randomUUID(), body: "hook room a" } }
  });
  await call(`/api/rooms/${other.roomId}/commands`, {
    method: "POST", token: otherOwner.secret,
    data: { id: randomUUID(), type: "message.posted", data: { messageId: randomUUID(), body: "hook room b" } }
  });
  const deliveries = store.db.prepare(
    "SELECT d.payload_json AS payload FROM agent_webhook_deliveries d JOIN agent_webhook_subs s ON s.subscription_id = d.subscription_id WHERE s.url=?"
  ).all(HOOK).map(row => JSON.parse(row.payload));
  assert.ok(deliveries.length > 0, "room A post produced no webhook delivery");
  assert.equal(deliveries.every(delivery => delivery.roomId === created.roomId), true);
  assert.equal(deliveries.some(delivery => JSON.stringify(delivery).includes(OTHER_PHRASE)), false);

  const roomKey = store.issueAccessKey(created.roomId, created.ownerMemberId);
  secrets.push(roomKey);
  const keyHome = await call(`/api/rooms/${created.roomId}`, { token: roomKey });
  assert.equal(keyHome.status, 200, `room key home status ${keyHome.status} ${errorCode(keyHome.body)}`);
  const keyOther = await call(`/api/rooms/${other.roomId}`, { token: roomKey });
  assert.equal(keyOther.status, 403, `room key other status ${keyOther.status} ${errorCode(keyOther.body)}`);
  assert.equal(errorCode(keyOther.body), "access_denied");
  const tokenOther = await call(`/api/rooms/${other.roomId}`, { token: created.mcpToken.credential });
  assert.equal(tokenOther.status, 403, `onboarding token other status ${tokenOther.status} ${errorCode(tokenOther.body)}`);
  assert.equal(errorCode(tokenOther.body), "insufficient_scope");
  const tokenWide = await call("/api/agent-rooms", { token: created.mcpToken.credential });
  assert.ok(tokenWide.status === 401 || tokenWide.status === 403, `room token on identity route status ${tokenWide.status}`);

  const events = store.db.prepare("SELECT room_id AS roomId, id, body FROM events").all();
  const byId = new Map();
  for (const event of events) {
    const parsed = JSON.parse(event.body);
    assert.equal(typeof parsed.roomId, "string");
    assert.equal(parsed.roomId, event.roomId);
    assert.equal(roomIdsIn(parsed).every(roomId => roomId === event.roomId), true, `event ${event.id} names another room`);
    const seen = byId.get(event.id);
    assert.equal(seen === undefined || seen === event.roomId, true, `event ${event.id} is stored in two rooms`);
    byId.set(event.id, event.roomId);
  }
  assert.ok(events.length > 1);

  const reads = [
    peerRoom, outsiderEvents, directory, board, one, hookList, keyHome,
    await call(`/api/rooms/${created.roomId}/events`, { token: owner.secret }),
    await call("/api/public/rooms/directory")
  ];
  for (const secret of secrets) {
    for (const read of reads) assert.equal(containsSecret(read.body, secret), false);
  }
  assert.equal(containsSecret(subscribed.body, signingSecret), false);
  assert.equal(JSON.stringify(reads.map(read => read.body)).includes("privateKey"), false);
});
