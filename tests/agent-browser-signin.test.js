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
  // No credential at all is a different problem than a wrong one: the
  // message keeps naming the fix (mint an identity), not the mismatch.
  const body = await res.json();
  assert.equal(body.error?.code, "unauthenticated");
  assert.equal(body.error?.message,
    "Agent identity secret required. Agents can self-mint an identity at POST /api/agent-identities.");
});

// WAVE-500 G1 agent-signin: a wrong identity ID or secret must read as one
// plain sentence on both agent sign-in routes. PR #2516 (Claude's lane)
// documented "A 401 there now reads: That agent ID and secret don't match.
// Check both and try again." but shipped docs only — the server still
// answered "Invalid Authorization header" for a malformed secret and
// "Unknown agent identity" when the secret (not the ID) failed. The UI
// renders error.message verbatim, so the raw API text reached agents.
const PLAIN_MISMATCH = "That agent ID and secret don't match. Check both and try again.";

async function mismatchMessage(res) {
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.error?.code, "unauthenticated");
  return body.error?.message;
}

test("POST /api/auth/agent/rooms: malformed secret reads as the plain mismatch", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const agent = f.store.identities.create("Test Agent");

  // A truncated or pasted-wrong secret fails the Authorization header shape.
  const res = await post(origin, "/api/auth/agent/rooms", { identityId: agent.identityId }, "not-a-secret");
  assert.equal(await mismatchMessage(res), PLAIN_MISMATCH);
});

test("POST /api/auth/agent/rooms: well-formed unknown secret reads as the plain mismatch", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const agent = f.store.identities.create("Test Agent");

  const res = await post(origin, "/api/auth/agent/rooms", {
    identityId: agent.identityId
  }, "pri_invalidsecret12345678901234567890123456789012");
  assert.equal(await mismatchMessage(res), PLAIN_MISMATCH);
});

test("POST /api/auth/agent/rooms: unknown identity ID reads as the plain mismatch", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const agent = f.store.identities.create("Test Agent");

  const res = await post(origin, "/api/auth/agent/rooms", { identityId: "ai_no_such_identity" }, agent.secret);
  assert.equal(await mismatchMessage(res), PLAIN_MISMATCH);
});

test("POST /api/auth/agent/session: malformed secret reads as the plain mismatch", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const agent = f.store.identities.create("Test Agent");
  linkToCommons(f, agent.identityId);

  const res = await post(origin, "/api/auth/agent/session", {
    identityId: agent.identityId,
    roomId: "commons"
  }, "not-a-secret");
  assert.equal(await mismatchMessage(res), PLAIN_MISMATCH);
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
