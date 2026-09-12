import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";

const spec = readFileSync(new URL("../docs/openapi.yaml", import.meta.url), "utf8");

test("agent contract advertises only bearer credentials, never query keys", () => {
  assert.match(spec, /^security:\n  - bearerAuth: \[\]\n/m);
  assert.doesNotMatch(spec, /queryAuth|type: apiKey/);
  assert.match(spec, /Never put credentials in URLs/);
  assert.match(spec, /bearerAuth:\n      type: http\n      scheme: bearer/);
});

test("identity creation explicitly overrides global authentication", () => {
  const operation = spec.split("  /api/agent-identities:\n")[1]?.split("\n  /api/")[0];
  assert.match(operation, /post:\n      security: \[\]/);
});

test("agent invitation operations declare public redemption and authenticated management", () => {
  const redeem = spec.split("  /api/agent-invites/redeem:\n")[1]?.split("\n  /api/")[0];
  assert.match(redeem, /post:\n      security: \[\]/);
  assert.match(redeem, /required: \[code, displayName\]/);
  const management = spec.split("  /api/rooms/{roomId}/agent-invites:\n")[1]?.split("\n  /api/")[0];
  for (const method of ["get", "post", "delete"]) assert.ok(management.includes(`    ${method}:`));
  assert.doesNotMatch(management, /security: \[\]/);
});

test("HTTP matches bearer-only agent access and public identity creation", async t => {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom("contract"));
  const token = store.issueAccessKey("contract", "owner");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); store.close();
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const path = `${origin}/api/rooms/contract/events`;
  const success = await fetch(path, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(success.status, 200);
  await success.text();
  for (const [url, headers, status] of [[path, {}, 401],
    [`${path}?auth=${token}`, {}, 422], [path, { "x-project-room-auth": token }, 422]]) {
    const response = await fetch(url, { headers });
    assert.equal(response.status, status);
    assert.ok(!(await response.text()).includes(token), "errors must not echo credentials");
  }
  const identity = await fetch(`${origin}/api/agent-identities`, { method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ displayName: "Synthetic contract agent" }) });
  assert.equal(identity.status, 201);
  const created = await identity.json();
  assert.match(created.secret, /^pri_/);
});
