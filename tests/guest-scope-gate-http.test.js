// Guest scope gate, HTTP-layer half (RC-2026-09-23-101).
//
// The store.command() gate (RC-2026-09-23-100, tests in
// tests/guest-invite-flow.test.js) covers the event-sourced command path.
// These tests prove the funnel-level denial for the three HTTP families
// that bypass store.command(): bounty-escrow, work-claims and
// inbox-collab. A real redeemed GX guest credential is driven against
// every denied mutation, and the approved read/chat surface is shown
// to keep working.
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

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-guest-scope-http-"));
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => Date.now() });
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
  return { store, origin, request, ownerKey };
}

async function redeemGuest(request, ownerKey, store, name = "Synapse") {
  const mint = await request("/api/rooms/commons/guest-invites", {
    method: "POST", token: ownerKey,
    data: { requestId: randomUUID(), guestLabel: `${name} visit`, expectedOwnerRevision: 0 },
  });
  assert.equal(mint.status, 201);
  const minted = await mint.json();
  const identity = store.identities.create(name);
  const keys = generateKeyPair();
  const cardBody = { name, description: "visiting agent", capabilities: ["chat"] };
  const card = { ...cardBody, publicKey: keys.publicKey,
    signature: signCard({ agentId: identity.identityId, card: cardBody, privateKey: keys.privateKey }) };
  const redeemed = await request("/api/guest-invites/redeem", {
    method: "POST", token: identity.secret, data: { inviteCode: minted.code, card },
  });
  assert.equal(redeemed.status, 201);
  const value = await redeemed.json();
  assert.ok(value.token.startsWith("ga1."));
  assert.ok(value.member.id.startsWith("guest-agent-"));
  return value;
}

const denied = async (t, res, where) => {
  assert.equal(res.status, 403, `${where}: expected 403, got ${res.status}`);
  const body = await res.json();
  assert.equal(body.error?.code, "guest_scope_denied", `${where}: expected guest_scope_denied`);
};

test("guest cannot touch bounty mutations", async t => {
  const { store, request, ownerKey } = await serve(t);
  const guest = await redeemGuest(request, ownerKey, store);

  // Create is refused.
  const create = await request("/api/rooms/commons/bounties", {
    method: "POST", token: guest.token,
    data: { title: "Guest bounty", criteria: "Do the thing", amount: 10, deadline: new Date(Date.now() + 86400000).toISOString() },
  });
  await denied(t, create, "bounty create");

  // The owner posts one so the guest can attempt the rest of the lifecycle.
  const ownerCreate = await request("/api/rooms/commons/bounties", {
    method: "POST", token: ownerKey,
    data: { title: "Owner bounty", criteria: "Do the thing", amount: 10, deadline: new Date(Date.now() + 86400000).toISOString() },
  });
  assert.equal(ownerCreate.status, 201);
  const bountyId = (await ownerCreate.json()).bounty.id;

  for (const [name, path, data] of [
    ["bounty claim", `/api/rooms/commons/bounties/${bountyId}/claim`, {}],
    ["bounty fund", `/api/rooms/commons/bounties/${bountyId}/fund`, {}],
    ["bounty decline", `/api/rooms/commons/bounties/${bountyId}/decline`, {}],
    ["bounty snooze", `/api/rooms/commons/bounties/${bountyId}/snooze`, {}],
    ["bounty watch", `/api/rooms/commons/bounties/${bountyId}/watch`, {}],
    ["credits transfer", "/api/rooms/commons/credits/transfer", { to: "owner", amount: 1 }],
  ]) {
    const res = await request(path, { method: "POST", token: guest.token, data });
    await denied(t, res, name);
  }
});

test("guest cannot touch work-claim mutations", async t => {
  const { store, request, ownerKey } = await serve(t);
  const guest = await redeemGuest(request, ownerKey, store);

  const create = await request("/api/rooms/commons/work-claims", {
    method: "POST", token: guest.token, data: { id: "guest-work", title: "Guest work" },
  });
  await denied(t, create, "work-claim create");

  const ownerCreate = await request("/api/rooms/commons/work-claims", {
    method: "POST", token: ownerKey, data: { id: "owner-work", title: "Owner work" },
  });
  assert.equal(ownerCreate.status, 201);

  for (const [name, path, data] of [
    ["work-claim claim", "/api/rooms/commons/work-claims/owner-work/claim", {}],
    ["work-claim update", "/api/rooms/commons/work-claims/owner-work/update", { note: "x" }],
    ["work-claim review", "/api/rooms/commons/work-claims/owner-work/review", {}],
    ["work-claim release", "/api/rooms/commons/work-claims/owner-work/release", {}],
  ]) {
    const res = await request(path, { method: "POST", token: guest.token, data });
    await denied(t, res, name);
  }
});

test("guest cannot touch collab mutations", async t => {
  const { store, request, ownerKey } = await serve(t);
  const guest = await redeemGuest(request, ownerKey, store);

  for (const [name, path, data] of [
    ["collab lock acquire", "/api/rooms/commons/collab/draft-locks/acquire", {}],
    ["collab approvals", "/api/rooms/commons/collab/approvals", {}],
    ["collab assignments", "/api/rooms/commons/collab/assignments", {}],
    ["collab notes", "/api/rooms/commons/collab/notes", {}],
  ]) {
    const res = await request(path, { method: "POST", token: guest.token, data });
    await denied(t, res, name);
  }
});

test("guest keeps the approved read and chat surface", async t => {
  const { store, request, ownerKey } = await serve(t);
  const guest = await redeemGuest(request, ownerKey, store);

  // Reads across all three families stay open.
  for (const path of [
    "/api/rooms/commons/bounties",
    "/api/rooms/commons/work-claims",
    "/api/rooms/commons/collab/assignments",
    "/api/rooms/commons/events",
  ]) {
    const res = await request(path, { token: guest.token });
    assert.equal(res.status, 200, `${path}: expected 200, got ${res.status}`);
  }

  // Chat and reactions still ride the command gate.
  const messageId = randomUUID();
  const post = store.command(guest.token, "commons",
    { id: randomUUID(), type: T.MESSAGE_POSTED, data: { messageId, body: "hello from the guest" } });
  assert.ok(post.sequence > 0);
  const react = store.command(guest.token, "commons",
    { id: randomUUID(), type: T.MESSAGE_REACTION_SET, data: { messageId, reaction: "like", active: true } });
  assert.ok(react);
});
