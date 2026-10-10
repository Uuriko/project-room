// Issue #1618: the expired-guest 401 must branch on v0/v1 membership.
// Since #1576 landed, v0 guest-agent-link seats self-refresh via
// POST /api/guest-agent-links/refresh — telling a v0 holder "cannot be
// renewed" is false. v1 guest-invite seats stay owner-mediated and keep the
// fresh-code-path message.
// Contracts:
//  - v0 expired: 401 unauthenticated, message names /api/guest-agent-links/refresh,
//    does NOT say "cannot be renewed".
//  - v1 expired: 401 unauthenticated, message keeps "cannot be renewed — get a
//    fresh pass", does NOT name the v0 refresh endpoint.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { generateKeyPair, signCard } from "../server/agent-card-signing.mjs";
import { GUEST_AGENT_TTL_MS } from "../server/guest-agent-links.mjs";

const ROOM = "commons";
const ONE_HOUR = 3600 * 1000;

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-guest-expiry-branch-"));
  let clock = Date.now();
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => clock });
  store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey(ROOM, "owner");
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

async function mintV0Link(request, ownerKey) {
  const res = await request(`/api/rooms/${ROOM}/guest-agent-links`, {
    method: "POST", token: ownerKey, data: { requestId: randomUUID(), expectedOwnerRevision: 0 },
  });
  assert.equal(res.status, 201);
  return res.json();
}

async function mintV1Invite(request, ownerKey) {
  const res = await request(`/api/rooms/${ROOM}/guest-invites`, {
    method: "POST", token: ownerKey,
    data: { requestId: randomUUID(), guestLabel: "expiry probe", expectedOwnerRevision: 0, credentialTtlMs: ONE_HOUR },
  });
  assert.equal(res.status, 201);
  return res.json();
}

async function redeemV1(request, store, code) {
  const identity = store.identities.create(`probe-${randomUUID().slice(0, 6)}`);
  const keys = generateKeyPair();
  const cardBody = { name: "Probe", description: "expiry probe", capabilities: ["chat"] };
  const card = { ...cardBody, publicKey: keys.publicKey,
    signature: signCard({ agentId: identity.identityId, card: cardBody, privateKey: keys.privateKey }) };
  const res = await request("/api/guest-invites/redeem", {
    method: "POST", token: identity.secret, data: { inviteCode: code, card },
  });
  assert.equal(res.status, 201);
  return res.json();
}

const postChat = (request, token, body) => request(`/api/rooms/${ROOM}/commands`, {
  method: "POST", token,
  data: { id: randomUUID(), type: "message.posted", data: { messageId: randomUUID(), body } },
});

test("v0 expired credential 401 teaches the self-service refresh, not 'cannot be renewed'", async t => {
  const { request, ownerKey, advance } = await serve(t);
  const minted = await mintV0Link(request, ownerKey);
  const live = await postChat(request, minted.token, "before expiry");
  assert.equal(live.status, 201, "live v0 credential posts");

  advance(GUEST_AGENT_TTL_MS + 1000);
  const dead = await postChat(request, minted.token, "after expiry");
  assert.equal(dead.status, 401);
  const body = await dead.json();
  assert.equal(body.error.code, "unauthenticated", "status code contract is unchanged");
  assert.match(body.error.message, /Guest credential expired/, "names the expiry");
  assert.match(body.error.message, /\/api\/guest-agent-links\/refresh/, "teaches the v0 self-service refresh");
  assert.doesNotMatch(body.error.message, /cannot be renewed/i, "v0 holders CAN self-renew since #1576");
});

test("v1 expired credential 401 keeps the fresh-code-path message, never the v0 refresh endpoint", async t => {
  const { request, store, ownerKey, advance } = await serve(t);
  const invited = await mintV1Invite(request, ownerKey);
  const guest = await redeemV1(request, store, invited.code);
  const live = await postChat(request, guest.token, "before expiry");
  assert.equal(live.status, 201, "live v1 credential posts");

  advance(ONE_HOUR + 1000);
  const dead = await postChat(request, guest.token, "after expiry");
  assert.equal(dead.status, 401);
  const body = await dead.json();
  assert.equal(body.error.code, "unauthenticated", "status code contract is unchanged");
  assert.match(body.error.message, /Guest credential expired/, "names the expiry");
  assert.match(body.error.message, /cannot be renewed/i, "v1 stays owner-mediated");
  assert.doesNotMatch(body.error.message, /\/api\/guest-agent-links\/refresh/, "v1 must not point at the v0 refresh endpoint");
});
