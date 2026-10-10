// RC-2026-09-23 — agent browser sign-in choice.
// Tests POST /api/auth/agent/rooms (verify identity, list linked rooms)
// and POST /api/auth/agent/session (create room-scoped browser session).
// Agents can sign in on their own account via the browser UI, or choose
// the human account sign-in path.
import test from "node:test";
import assert from "node:assert/strict";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";

const startServer = async (t, f) => {
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close();
  });
  return `http://127.0.0.1:${server.address().port}`;
};

const post = (origin, path, body, secret = null) => {
  const headers = { "content-type": "application/json", "origin": origin };
  if (secret) headers["authorization"] = `Bearer ${secret}`;
  return fetch(`${origin}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body ?? {}),
  });
};

function linkToCommons(f, identityId) {
  const ownerKey = f.store.issueAccessKey("commons", "owner");
  return f.store.identities.link(ownerKey, "commons", { identityId, permissions: ["accept_work"] });
}

test("POST /api/auth/agent/rooms verifies secret and lists linked rooms", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const agent = f.store.identities.create("Test Agent");
  linkToCommons(f, agent.identityId);

  const res = await post(origin, "/api/auth/agent/rooms", {
    identityId: agent.identityId
  }, agent.secret);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.identityId, agent.identityId);
  assert.equal(data.displayName, "Test Agent");
  assert.ok(Array.isArray(data.rooms));
  assert.equal(data.rooms.length, 1);
  assert.equal(data.rooms[0].roomId, "commons");
});

test("POST /api/auth/agent/rooms rejects bad secret", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const agent = f.store.identities.create("Test Agent");

  const res = await post(origin, "/api/auth/agent/rooms", {
    identityId: agent.identityId
  }, "pri_invalidsecret12345678901234567890123456789012");
  assert.equal(res.status, 401);
});

test("POST /api/auth/agent/rooms rejects missing Authorization header", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const agent = f.store.identities.create("Test Agent");

  const res = await post(origin, "/api/auth/agent/rooms", {
    identityId: agent.identityId
  });
  assert.equal(res.status, 401);
});

test("POST /api/auth/agent/rooms returns empty rooms for unlinked identity", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const agent = f.store.identities.create("Lonely Agent");
  // Not linked to any room

  const res = await post(origin, "/api/auth/agent/rooms", {
    identityId: agent.identityId
  }, agent.secret);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.deepEqual(data.rooms, []);
});

test("POST /api/auth/agent/session creates browser session for linked agent", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const agent = f.store.identities.create("Session Agent");
  linkToCommons(f, agent.identityId);

  const res = await post(origin, "/api/auth/agent/session", {
    identityId: agent.identityId,
    roomId: "commons"
  }, agent.secret);
  assert.equal(res.status, 201);
  const session = await res.json();
  assert.ok(session.roomId === "commons" || session.room?.id === "commons");
  // Cookie should be set
  const cookie = res.headers.get("set-cookie");
  assert.ok(cookie && cookie.includes("HttpOnly"), "Session cookie must be HttpOnly");
});

test("POST /api/auth/agent/session rejects unlinked room", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const agent = f.store.identities.create("Unlinked Agent");
  // Not linked to commons

  const res = await post(origin, "/api/auth/agent/session", {
    identityId: agent.identityId,
    roomId: "commons"
  }, agent.secret);
  assert.equal(res.status, 403);
});

test("POST /api/auth/agent/session rejects bad secret", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const agent = f.store.identities.create("Test Agent");
  linkToCommons(f, agent.identityId);

  const res = await post(origin, "/api/auth/agent/session", {
    identityId: agent.identityId,
    roomId: "commons"
  }, "pri_invalidsecret12345678901234567890123456789012");
  assert.equal(res.status, 401);
});

test("POST /api/auth/agent/session rejects secret in JSON body (must use Bearer header)", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const agent = f.store.identities.create("Test Agent");
  linkToCommons(f, agent.identityId);

  // Secret in body should be rejected by exact-field validation
  const res = await post(origin, "/api/auth/agent/session", {
    identityId: agent.identityId,
    secret: agent.secret,
    roomId: "commons"
  }, agent.secret);
  assert.equal(res.status, 422);
});

test("Agent browser session is invalidated when secret is rotated", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const agent = f.store.identities.create("Rotate Agent");
  linkToCommons(f, agent.identityId);

  // Create a session with the original secret
  const res = await post(origin, "/api/auth/agent/session", {
    identityId: agent.identityId,
    roomId: "commons"
  }, agent.secret);
  assert.equal(res.status, 201);
  const cookie = res.headers.get("set-cookie");
  const token = cookie.match(/room_session=([^;]+)/)?.[1];
  assert.ok(token, "Session cookie should be set");

  // Rotate the secret
  const rotated = f.store.identities.rotate(agent.identityId, agent.secret);
  assert.ok(rotated.secret, "Rotation should return new secret");

  // The old session should now be rejected
  const checkRes = await fetch(`${origin}/api/session`, {
    headers: { "cookie": `room_session=${token}`, "origin": origin }
  });
  assert.equal(checkRes.status, 401);
});

test("Agent browser session is invalidated when secret is revoked", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const agent = f.store.identities.create("Revoke Agent");
  linkToCommons(f, agent.identityId);

  // Create a session with the original secret
  const res = await post(origin, "/api/auth/agent/session", {
    identityId: agent.identityId,
    roomId: "commons"
  }, agent.secret);
  assert.equal(res.status, 201);
  const cookie = res.headers.get("set-cookie");
  const token = cookie.match(/room_session=([^;]+)/)?.[1];
  assert.ok(token, "Session cookie should be set");

  // Revoke the secret (owner-only; use the store directly)
  f.store.identities.revoke(agent.identityId, agent.secret);

  // The session should now be rejected
  const checkRes = await fetch(`${origin}/api/session`, {
    headers: { "cookie": `room_session=${token}`, "origin": origin }
  });
  assert.equal(checkRes.status, 401);
});

test("F13: an rak_ scoped API key signs in, room-scoped and TTL-capped", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const agent = f.store.identities.create("Key Agent");
  linkToCommons(f, agent.identityId);

  const expiresAt = f.store.now() + 3600000; // 1h: shorter than the 8h default
  const key = f.store.agentPlugin.issueApiKey({ identityId: agent.identityId, scopes: ["mcp:room:commons", "rooms:read", "rooms:write"], expiresAt });
  const rak = `rak_${key.secret}`;

  // Rooms list is filtered to the key's mcp:room:* scopes.
  const roomsRes = await post(origin, "/api/auth/agent/rooms", { identityId: agent.identityId }, rak);
  assert.equal(roomsRes.status, 200);
  const roomsData = await roomsRes.json();
  assert.equal(roomsData.identityId, agent.identityId);
  assert.equal(roomsData.displayName, "Key Agent");
  assert.deepEqual(roomsData.rooms.map(r => r.roomId), ["commons"]);

  // Session TTL = min(key expiry, default session length).
  const sessionRes = await post(origin, "/api/auth/agent/session", { identityId: agent.identityId, roomId: "commons" }, rak);
  assert.equal(sessionRes.status, 201);
  const session = await sessionRes.json();
  assert.equal(session.expiresAt, expiresAt, "session dies with the key");

  // A key scoped to another room gets no session here.
  const otherKey = f.store.agentPlugin.issueApiKey({ identityId: agent.identityId, scopes: ["mcp:room:elsewhere"] });
  const denied = await post(origin, "/api/auth/agent/session", { identityId: agent.identityId, roomId: "commons" }, `rak_${otherKey.secret}`);
  assert.equal(denied.status, 403);
  const deniedRooms = await post(origin, "/api/auth/agent/rooms", { identityId: agent.identityId }, `rak_${otherKey.secret}`);
  assert.deepEqual((await deniedRooms.json()).rooms, []);

  // Key/identity mismatch and revoked keys both read as 401.
  const stranger = f.store.identities.create("Stranger");
  const mismatch = await post(origin, "/api/auth/agent/rooms", { identityId: stranger.identityId }, rak);
  assert.equal(mismatch.status, 401);
  f.store.agentPlugin.revokeApiKey({ identityId: agent.identityId, keyId: key.keyId });
  const revoked = await post(origin, "/api/auth/agent/rooms", { identityId: agent.identityId }, rak);
  assert.equal(revoked.status, 401);
});

test("F13: an rak_ key without expiry gets a 1-hour session (review option b)", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const agent = f.store.identities.create("Open Key Agent");
  linkToCommons(f, agent.identityId);
  const key = f.store.agentPlugin.issueApiKey({ identityId: agent.identityId, scopes: ["mcp:room:commons", "rooms:write"] });
  const before = f.store.now();
  const res = await post(origin, "/api/auth/agent/session", { identityId: agent.identityId, roomId: "commons" }, `rak_${key.secret}`);
  assert.equal(res.status, 201);
  const session = await res.json();
  // Key revocation does not kill minted sessions; the 1h cap bounds them.
  assert.ok(session.expiresAt >= before + 3600000 && session.expiresAt <= f.store.now() + 3600000, "rak_ sessions cap at 1h");
});

test("F13: a read-only rak_ key cannot mint a browser session", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const agent = f.store.identities.create("Read Key Agent");
  linkToCommons(f, agent.identityId);
  const key = f.store.agentPlugin.issueApiKey({ identityId: agent.identityId, scopes: ["mcp:room:commons", "rooms:read"] });
  const res = await post(origin, "/api/auth/agent/session", { identityId: agent.identityId, roomId: "commons" }, `rak_${key.secret}`);
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error.code, "insufficient_scope");
});
