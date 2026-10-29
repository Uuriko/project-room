// The onboarding-token rotate route lives in the route table. A missing
// bearer is 401 before any rotation, and a non-POST is 405 with Allow: POST.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { AGENT_ROOM_TOKEN_ROUTES } from "../server/routes/agent-room-token.mjs";
import { ROUTES } from "../server/routes/table.mjs";

test("the rotate route is a single bearer POST on the route table", () => {
  assert.equal(AGENT_ROOM_TOKEN_ROUTES.length, 1);
  const [row] = AGENT_ROOM_TOKEN_ROUTES;
  assert.equal(row.method, "POST");
  assert.equal(row.path, "/api/agent-rooms/{roomId}/token/rotate");
  assert.equal(row.auth, "bearer");
  assert.equal(ROUTES.filter(item => item.id === row.id).length, 1);
});

test("rotate refuses a missing secret and a non-POST", async t => {
  const directory = mkdtempSync(join(tmpdir(), "project-room-rotate-route-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  const path = "/api/agent-rooms/commons/token/rotate";
  const missing = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: "{}",
  });
  assert.equal(missing.status, 401);
  assert.equal((await missing.json()).error.code, "unauthenticated");
  const anonymousGet = await fetch(`${origin}${path}`, { method: "GET", headers: { Origin: origin } });
  assert.equal(anonymousGet.status, 401, "a missing credential is refused before the method check");
  await anonymousGet.text();
  const wrong = await fetch(`${origin}${path}`, {
    method: "GET",
    headers: { Origin: origin, Authorization: `Bearer pri_${"a".repeat(43)}` },
  });
  assert.equal(wrong.status, 405);
  assert.equal(wrong.headers.get("allow"), "POST");
  await wrong.text();
});
