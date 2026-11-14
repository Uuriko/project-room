// Experimental families stay live unless ROOM_FREEZE_EXPERIMENTAL is on.
// The freeze answers before the handler, so an unauthenticated read that
// would otherwise be refused by room auth comes back frozen instead.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";
import { experimentalRoutesFrozen, isExperimentalRoute } from "../server/experimental-routes.mjs";

test("the experimental freeze stays off unless the flag is on", () => {
  assert.equal(experimentalRoutesFrozen({}), false);
  assert.equal(experimentalRoutesFrozen({ ROOM_FREEZE_EXPERIMENTAL: "0" }), false);
  assert.equal(experimentalRoutesFrozen({ ROOM_FREEZE_EXPERIMENTAL: "1" }), true);
  assert.equal(experimentalRoutesFrozen({ ROOM_FREEZE_EXPERIMENTAL: "true" }), true);
  for (const path of [
    "/api/rooms/commons/jev-shadow",
    "/api/rooms/commons/matchmaking/seeker",
    "/api/rooms/commons/spend-pricing",
    "/api/rooms/commons/spend-allowance",
    "/api/rooms/commons/spend-grants",
    "/api/rooms/commons/spend-grant",
  ]) assert.equal(isExperimentalRoute(path), true, path);
  assert.equal(isExperimentalRoute("/api/rooms/commons/messages"), false);
  assert.equal(isExperimentalRoute("/api/rooms/commons/work-claims"), false);
});

test("experimental routes stay live until the freeze flag is on", async t => {
  const directory = mkdtempSync(join(tmpdir(), "experimental-routes-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    delete process.env.ROOM_FREEZE_EXPERIMENTAL;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const read = async path => {
    const response = await fetch(origin + path, { headers: { origin } });
    return { status: response.status, body: await response.json() };
  };
  const paths = [
    "/api/rooms/commons/jev-shadow",
    "/api/rooms/commons/matchmaking/seeker",
    "/api/rooms/commons/spend-pricing",
  ];
  delete process.env.ROOM_FREEZE_EXPERIMENTAL;
  for (const path of paths) {
    const live = await read(path);
    assert.notEqual(live.body?.error?.code, "experimental_route_frozen", path);
    assert.equal(live.status, 401, `${path} stays on the auth path while the freeze is off`);
  }
  process.env.ROOM_FREEZE_EXPERIMENTAL = "1";
  for (const path of paths) {
    const frozen = await read(path);
    assert.equal(frozen.status, 404, path);
    assert.equal(frozen.body?.error?.code, "experimental_route_frozen", path);
  }
});
