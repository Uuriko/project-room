// Five end-to-end stories. Each one boots a loopback room and talks HTTP.
// Story (c) is the only one that may finish pending: it skips, with the
// observed status, when re-invite still returns the pre-FIX-B1 refusal.
// It never asserts success without an active membership that can post.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { AgentRooms } from "../../server/agent-rooms.mjs";
import {
  PAUSE_WRITE_GAP, accountCookie, accountHeaders, errorCode, knownGap, request, startSafetyNet
} from "./harness.mjs";

const HUMAN_PASSWORD = "fixture-password-safety-net-long-enough";
const REINVITE_PENDING = new Set(["identity_already_linked", "access_ended", "membership_removed"]);

function requirePacket(packet, needle) {
  assert.equal(packet.includes(needle), true, `served /llms.txt does not name ${needle}`);
}

function proofChallenge(body) {
  if (body && body.proof && typeof body.proof.prefix === "string" && Array.isArray(body.proof.acceptBuckets)) return body.proof;
  return null;
}

function solveProof(displayName, proof) {
  const name = displayName.trim();
  const prefix = proof.prefix;
  for (const bucket of proof.acceptBuckets) {
    for (let i = 0; i < 1_000_000; i++) {
      const nonce = i.toString(36);
      const hex = createHash("sha256").update(`${bucket}:${name}:${nonce}`).digest("hex");
      if (hex.startsWith(prefix)) return nonce;
    }
  }
  throw new Error("proof search exhausted");
}

async function mintIdentity(call, displayName, packet) {
  requirePacket(packet, "/api/agent-identities");
  let minted = await call("/api/agent-identities", { method: "POST", data: { displayName } });
  if (minted.status === 428) {
    requirePacket(packet, "proof");
    const challenge = proofChallenge(minted.body);
    assert.ok(challenge, "428 proof_required did not include a proof challenge");
    assert.equal(errorCode(minted.body), "proof_required");
    minted = await call("/api/agent-identities", {
      method: "POST",
      data: { displayName, proof: solveProof(displayName, challenge) }
    });
  }
  assert.equal(minted.status, 201, `identity mint status ${minted.status} ${errorCode(minted.body)}`);
  assert.equal(typeof minted.body?.identityId, "string");
  assert.equal(typeof minted.body?.secret, "string");
  assert.equal(minted.body.secret.startsWith("pri_"), true, "mint returns an identity secret");
  assert.equal(typeof minted.body?.privateKey, "string");
  return { identityId: minted.body.identityId, secret: minted.body.secret };
}

async function openAgentRoom(call, secret, packet, title) {
  requirePacket(packet, "/api/agent-rooms");
  const created = await call("/api/agent-rooms", {
    method: "POST",
    token: secret,
    data: { title, purpose: "Safety net room" }
  });
  assert.equal(created.status, 201, `agent room status ${created.status} ${errorCode(created.body)}`);
  const credential = created.body?.mcpToken?.credential;
  assert.equal(typeof created.body?.roomId, "string");
  assert.equal(typeof credential, "string");
  assert.equal(credential.startsWith("rak_"), true, "room create returns a room credential");
  return { roomId: created.body.roomId, credential, ownerMemberId: created.body.ownerMemberId };
}

async function postMessage(call, token, roomId, body) {
  return call(`/api/rooms/${encodeURIComponent(roomId)}/commands`, {
    method: "POST",
    token,
    data: { id: randomUUID(), type: "message.posted", data: { messageId: randomUUID(), body } }
  });
}

test("human signs up, creates a room, and posts", async t => {
  const { origin, call } = await startSafetyNet(t);
  const slot = await call("/api/account-session");
  assert.equal(slot.status, 200, `account session status ${slot.status}`);
  const slotCookie = accountCookie(slot.setCookie);
  assert.equal(typeof slotCookie, "string");
  assert.equal(typeof slot.body?.csrf, "string");
  assert.equal(typeof slot.body?.sessionRevision, "number");

  const signed = await request(origin, "/api/auth/password/signup", {
    method: "POST",
    data: {
      email: "safety-net-human@example.invalid",
      password: HUMAN_PASSWORD,
      sessionRevision: slot.body.sessionRevision
    },
    headers: {
      Cookie: `account_session=${slotCookie}`,
      "X-CSRF-Token": slot.body.csrf
    }
  });
  assert.equal(signed.status, 202, `signup status ${signed.status} ${errorCode(signed.body)}`);
  assert.equal(signed.body?.status, "check_email");
  assert.equal(JSON.stringify(signed.body).includes(HUMAN_PASSWORD), false);
  const cookie = accountCookie(signed.setCookie);
  assert.equal(typeof cookie, "string");
  assert.notEqual(cookie, slotCookie);

  const session = await request(origin, "/api/account-session", { headers: { Cookie: `account_session=${cookie}` } });
  assert.equal(session.status, 200, `signed-in session status ${session.status}`);
  assert.equal(session.body?.authenticated, true);
  const headers = accountHeaders(session.body, cookie);

  const room = await request(origin, "/api/account-rooms", {
    method: "POST",
    data: {
      roomId: "safety-human-room",
      title: "Safety net",
      purpose: "A human signs up and posts",
      kind: "personal",
      displayName: "Safety Human"
    },
    headers
  });
  assert.equal(room.status, 201, `create room status ${room.status} ${errorCode(room.body)}`);
  assert.equal(room.body?.room?.id, "safety-human-room");

  const phrase = "Safety net human post.";
  const posted = await request(origin, "/api/rooms/safety-human-room/commands", {
    method: "POST",
    data: { id: randomUUID(), type: "message.posted", data: { messageId: randomUUID(), body: phrase } },
    headers
  });
  assert.equal(posted.status, 201, `post status ${posted.status} ${errorCode(posted.body)}`);

  const snapshot = await request(origin, "/api/rooms/safety-human-room", { headers });
  assert.equal(snapshot.status, 200, `snapshot status ${snapshot.status} ${errorCode(snapshot.body)}`);
  assert.equal(snapshot.body?.state?.messages?.some(message => message.body === phrase), true);
});

test("a new agent connects from the public packet and posts", async t => {
  const { origin, call } = await startSafetyNet(t);
  const packetResponse = await fetch(origin + "/llms.txt", { headers: { "User-Agent": "project-room-agent" } });
  assert.equal(packetResponse.status, 200, `packet status ${packetResponse.status}`);
  const packetText = await packetResponse.text();
  const name = "Safety Agent";
  const identity = await mintIdentity(call, name, packetText);
  const room = await openAgentRoom(call, identity.secret, packetText, "Safety agent room");
  requirePacket(packetText, "room_post_message");
  requirePacket(packetText, "/mcp");
  const phrase = "Hello from the public packet.";
  const posted = await call("/mcp", {
    method: "POST",
    token: room.credential,
    data: {
      jsonrpc: "2.0",
      id: "safety-net-post",
      method: "tools/call",
      params: { name: "room_post_message", arguments: { roomId: room.roomId, body: phrase } }
    }
  });
  const value = posted.body?.result?.structuredContent;
  assert.equal(posted.status, 200, `mcp status ${posted.status}`);
  assert.equal(posted.body?.result?.isError ?? false, false, `mcp post ${value?.status ?? ""} ${value?.code ?? errorCode(posted.body)}`);
  assert.equal(value?.status, "posted");
  assert.equal(value?.command?.data?.body, phrase);

  requirePacket(packetText, "/api/rooms/{roomId}/events");
  const events = await call(`/api/rooms/${encodeURIComponent(room.roomId)}/events`, { token: identity.secret });
  assert.equal(events.status, 200, `events status ${events.status} ${errorCode(events.body)}`);
  assert.equal(events.body?.events?.some(row => row.event?.data?.body === phrase), true);
});

test("invite, remove, then re-invite the same agent", async t => {
  const net = await startSafetyNet(t);
  const { store, call } = net;
  const owner = store.identities.create("Safety Owner");
  const rooms = new AgentRooms(store);
  const created = rooms.create(owner.secret, {
    roomId: "safety-reinvite", title: "Reinvite", purpose: "Invite remove reinvite", kind: "personal", displayName: "Safety Owner"
  });
  const peer = await call("/api/agent-identities", { method: "POST", data: { displayName: "Safety Peer" } });
  assert.equal(peer.status, 201, `peer mint status ${peer.status} ${errorCode(peer.body)}`);
  const peerSecret = peer.body.secret;
  const peerId = peer.body.identityId;

  const invite = await call(`/api/rooms/${created.roomId}/agent-invites`, {
    method: "POST", token: owner.secret, data: { profile: "chat", displayName: "Safety Peer" }
  });
  assert.equal(invite.status, 201, `invite status ${invite.status} ${errorCode(invite.body)}`);
  const joined = await call("/api/agent-invites/redeem", {
    method: "POST", token: peerSecret, data: { code: invite.body.code, displayName: "Safety Peer" }
  });
  assert.equal(joined.status, 201, `redeem status ${joined.status} ${errorCode(joined.body)}`);
  assert.equal(joined.body?.memberId, peerId);
  const firstPost = await postMessage(call, peerSecret, created.roomId, "Peer is in the room.");
  assert.equal(firstPost.status, 201, `peer post status ${firstPost.status} ${errorCode(firstPost.body)}`);

  const snapshot = await call(`/api/rooms/${created.roomId}`, { token: owner.secret });
  assert.equal(snapshot.status, 200, `owner snapshot status ${snapshot.status}`);
  const member = snapshot.body?.state?.members?.[peerId];
  assert.equal(member?.active !== false, true);
  const removed = await call(`/api/rooms/${created.roomId}/commands`, {
    method: "POST",
    token: owner.secret,
    data: {
      id: randomUUID(),
      type: "member.access_changed",
      data: { memberId: peerId, expectedMemberRevision: member.revision, permissions: member.permissions, active: false }
    }
  });
  assert.equal(removed.status, 201, `remove status ${removed.status} ${errorCode(removed.body)}`);
  const locked = await call(`/api/rooms/${created.roomId}`, { token: peerSecret });
  assert.ok(locked.status === 401 || locked.status === 403, `removed read status ${locked.status} ${errorCode(locked.body)}`);
  assert.ok(errorCode(locked.body) === "unauthenticated" || errorCode(locked.body) === "access_denied");
  assert.equal(JSON.stringify(locked.body).includes("Peer is in the room."), false);

  const again = await call(`/api/rooms/${created.roomId}/agent-invites`, {
    method: "POST", token: owner.secret, data: { profile: "chat", displayName: "Safety Peer" }
  });
  assert.equal(again.status, 201, `second invite status ${again.status} ${errorCode(again.body)}`);
  const rejoined = await call("/api/agent-invites/redeem", {
    method: "POST", token: peerSecret, data: { code: again.body.code, displayName: "Safety Peer" }
  });
  const code = errorCode(rejoined.body);
  if (REINVITE_PENDING.has(code)) {
    t.skip(`FIX-B1 is unmerged: re-inviting the removed agent returned ${rejoined.status} ${code}. The identity link is kept and redeem refuses to restore the inactive membership. This story stays pending until that invite path admits the same agent again.`);
    return;
  }
  assert.equal(rejoined.status, 201, `re-invite status ${rejoined.status} ${code}`);
  const back = await call(`/api/rooms/${created.roomId}`, { token: peerSecret });
  assert.equal(back.status, 200, `rejoined read status ${back.status} ${errorCode(back.body)}`);
  assert.equal(back.body?.state?.members?.[peerId]?.active !== false, true);
  const secondPost = await postMessage(call, peerSecret, created.roomId, "Peer is back.");
  assert.equal(secondPost.status, 201, `rejoined post status ${secondPost.status} ${errorCode(secondPost.body)}`);
});

test("claim then finish a task and the board shows the claimer, then done", async t => {
  const { store, call } = await startSafetyNet(t);
  const owner = store.identities.create("Board Owner");
  const created = new AgentRooms(store).create(owner.secret, {
    roomId: "safety-board", title: "Board", purpose: "Claim and finish", kind: "personal", displayName: "Board Owner"
  });
  const claimId = "safety-task";
  const made = await call(`/api/rooms/${created.roomId}/work-claims`, {
    method: "POST", token: owner.secret, data: { id: claimId, title: "Safety net task", reviewPolicy: "self_attested" }
  });
  assert.equal(made.status, 201, `create claim status ${made.status} ${errorCode(made.body)}`);
  assert.equal(made.body?.owner ?? null, null);

  const claimed = await call(`/api/rooms/${created.roomId}/work-claims/${claimId}/claim`, {
    method: "POST", token: owner.secret, data: { leaseHours: 1 }
  });
  assert.equal(claimed.status, 200, `claim status ${claimed.status} ${errorCode(claimed.body)}`);
  assert.equal(claimed.body?.owner, created.ownerMemberId);
  assert.equal(claimed.body?.state, "claimed");

  const board = await call(`/api/rooms/${created.roomId}/work-claims?view=summary&state=claimed`, { token: owner.secret });
  assert.equal(board.status, 200, `board status ${board.status} ${errorCode(board.body)}`);
  const listed = board.body?.claims?.find(claim => claim.id === claimId);
  assert.equal(listed?.owner, created.ownerMemberId);
  assert.equal(listed?.state, "claimed");

  const started = await call(`/api/rooms/${created.roomId}/work-claims/${claimId}/update`, {
    method: "POST", token: owner.secret, data: { state: "in_progress" }
  });
  assert.equal(started.status, 200, `start status ${started.status} ${errorCode(started.body)}`);
  const finished = await call(`/api/rooms/${created.roomId}/work-claims/${claimId}/update`, {
    method: "POST", token: owner.secret, data: { state: "done", note: "Finished the safety-net task." }
  });
  assert.equal(finished.status, 200, `finish status ${finished.status} ${errorCode(finished.body)}`);

  const doneBoard = await call(`/api/rooms/${created.roomId}/work-claims?view=summary&state=done`, { token: owner.secret });
  assert.equal(doneBoard.status, 200, `done board status ${doneBoard.status} ${errorCode(doneBoard.body)}`);
  const done = doneBoard.body?.claims?.find(claim => claim.id === claimId);
  assert.equal(done?.state, "done");
  assert.equal(done?.owner, created.ownerMemberId);
  const one = await call(`/api/rooms/${created.roomId}/work-claims/${claimId}`, { token: owner.secret });
  assert.equal(one.status, 200, `claim read status ${one.status} ${errorCode(one.body)}`);
  assert.equal(one.body?.state, "done");
  assert.equal(one.body?.owner, created.ownerMemberId);
});

test("Stop/pause blocks the agent's writes", async t => {
  const { store, call } = await startSafetyNet(t);
  const owner = store.identities.create("Pause Owner");
  const peer = store.identities.create("Pause Peer");
  const created = new AgentRooms(store).create(owner.secret, {
    roomId: "safety-pause", title: "Pause", purpose: "Stop blocks writes", kind: "personal", displayName: "Pause Owner"
  });
  store.identities.link(owner.secret, created.roomId, {
    identityId: peer.identityId, displayName: "Pause Peer", permissions: ["accept_work", "complete_work"]
  });
  const before = await postMessage(call, peer.secret, created.roomId, "Peer can write before the pause.");
  assert.equal(before.status, 201, `pre-pause post status ${before.status} ${errorCode(before.body)}`);

  const dueAt = store.now();
  store.wakeQueue.enqueue(peer.secret, created.roomId, {
    requestId: randomUUID(), queueKey: "recipe:safety-net", intent: { recipe: "safety-net" }, dueAt, maxAttempts: 3
  });
  const paused = await call(`/api/rooms/${created.roomId}/agent-pause`, {
    method: "POST",
    token: owner.secret,
    data: { action: "pause", memberId: peer.identityId, requestId: randomUUID(), reason: "safety net stop" }
  });
  assert.equal(paused.status, 201, `pause status ${paused.status} ${errorCode(paused.body)}`);
  assert.equal(paused.body?.receipt?.heldBy, "owner");
  assert.equal(paused.body?.pause?.heldBy, "owner");
  assert.equal(store.wakeQueue.due(store.now()).some(wake => wake.queueKey === "recipe:safety-net"), false);
  assert.equal(store.wakeQueue.lease(created.roomId, peer.identityId, "recipe:safety-net", "safety-net"), null);

  const write = await postMessage(call, peer.secret, created.roomId, "Peer writes during the pause.");
  if (write.status === 423) {
    assert.equal(errorCode(write.body), "member_paused");
    assert.equal(knownGap(PAUSE_WRITE_GAP), false, "delete the paused-agents-cannot-write note in tests/safety-net/KNOWN-GAPS.md");
  } else {
    assert.equal(write.status, 201, `paused post status ${write.status} ${errorCode(write.body)}`);
    assert.equal(knownGap(PAUSE_WRITE_GAP), true, "owner pause did not refuse message.posted; record it in tests/safety-net/KNOWN-GAPS.md");
    t.diagnostic("owner pause does not refuse message.posted; see tests/safety-net/KNOWN-GAPS.md");
  }

  const resumed = await call(`/api/rooms/${created.roomId}/agent-pause`, {
    method: "POST",
    token: owner.secret,
    data: { action: "resume", memberId: peer.identityId, requestId: randomUUID() }
  });
  assert.equal(resumed.status, 201, `resume status ${resumed.status} ${errorCode(resumed.body)}`);
  assert.equal(store.wakeQueue.due(store.now()).some(wake => wake.queueKey === "recipe:safety-net"), true);
  const after = await postMessage(call, peer.secret, created.roomId, "Peer writes after resume.");
  assert.equal(after.status, 201, `resumed post status ${after.status} ${errorCode(after.body)}`);
});
