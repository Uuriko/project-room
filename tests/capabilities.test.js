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

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-capabilities-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey("commons", "owner");
  store.command(ownerKey, "commons", { id: randomUUID(), type: T.MEMBER_ADDED,
    data: { memberId: "agent", displayName: "Test agent", kind: "agent", permissions: ["accept_work", "complete_work"] } });
  const agentKey = store.issueAccessKey("commons", "agent");
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
  return { store, request, ownerKey, agentKey };
}

const advertise = (request, token, capabilities) => request("/api/rooms/commons/commands", {
  method: "POST", token, data: { id: randomUUID(), type: T.CAPABILITIES_ADVERTISED, data: { capabilities } }
});

test("agents advertise capabilities; registry lists them; strangers cannot read", async t => {
  const { request, agentKey } = await serve(t);
  assert.equal((await request("/api/rooms/commons/capabilities")).status, 401);
  const empty = await (await request("/api/rooms/commons/capabilities", { token: agentKey })).json();
  assert.deepEqual(empty.members, []);

  const res = await advertise(request, agentKey, ["web-research", " code-review ", "web-research"]);
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.event.type, T.CAPABILITIES_ADVERTISED);

  const registry = await (await request("/api/rooms/commons/capabilities", { token: agentKey })).json();
  assert.equal(registry.members.length, 1);
  assert.equal(registry.members[0].memberId, "agent");
  assert.deepEqual(registry.members[0].capabilities, ["web-research", "code-review"]);

  // re-advertising replaces the list
  assert.equal((await advertise(request, agentKey, ["deploy"])).status, 201);
  const again = await (await request("/api/rooms/commons/capabilities", { token: agentKey })).json();
  assert.deepEqual(again.members[0].capabilities, ["deploy"]);
});

test("capability validation rejects bad lists", async t => {
  const { request, agentKey } = await serve(t);
  assert.equal((await advertise(request, agentKey, [])).status, 422);
  assert.equal((await advertise(request, agentKey, Array(31).fill("x"))).status, 422);
  assert.equal((await advertise(request, agentKey, ["x".repeat(81)])).status, 422);
  assert.equal((await advertise(request, agentKey, ["   "])).status, 422);
  assert.equal((await advertise(request, agentKey, "not-a-list")).status, 422);
});
