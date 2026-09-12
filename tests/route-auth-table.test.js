import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

// Formalizes docs/ROUTE-AUTH-TABLE.md: every mutating room route rejects
// unauthenticated requests. POST /api/agent-identities is intentionally
// unauthenticated (creating an identity grants no room access).
const MUTATING_ROOM_ROUTES = [
  "identity-links", "import", "commands", "cursor", "work-sessions",
  "reminders", "agent-connections", "guest-agent-links", "share-links",
  "share-links-cancel", "invitations",
];
const REVOKE_ROUTE = "invitations/some-invitation/revoke";

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-route-auth-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return origin;
}

test("mutating room routes reject unauthenticated requests", async t => {
  const origin = await serve(t);
  for (const route of [...MUTATING_ROOM_ROUTES, REVOKE_ROUTE]) {
    const res = await fetch(`${origin}/api/rooms/commons/${route}`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: "{}",
    });
    assert.ok([401, 403].includes(res.status), `${route}: expected 401/403, got ${res.status}`);
    await res.text().catch(() => {});
  }
});

test("identity creation stays unauthenticated but grants no room access", async t => {
  const origin = await serve(t);
  const res = await fetch(`${origin}/api/agent-identities`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ displayName: "route-auth-probe" }),
  });
  assert.equal(res.status, 201);
  const created = await res.json();
  assert.ok(created.identityId?.startsWith("ai_"), "identity id shape");
  // The new credential authenticates the identity but not any room.
  const room = await fetch(`${origin}/api/rooms/commons`, {
    headers: { Origin: origin, Authorization: `Bearer ${created.secret}` },
  });
  assert.ok([401, 403].includes(room.status), `identity token must not open rooms, got ${room.status}`);
});
