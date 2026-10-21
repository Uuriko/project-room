import test from "node:test";
import assert from "node:assert/strict";
import { ROOM_ORIGIN, EDGE_DOOR_HOSTS, edgeDoorApiPath } from "../src/service-origin.js";
import * as discovery from "../server/agent-discovery.mjs";

test("shared routing retains the discovery export contract", () => {
  assert.equal(discovery.ROOM_ORIGIN, ROOM_ORIGIN);
  assert.equal(discovery.EDGE_DOOR_HOSTS, EDGE_DOOR_HOSTS);
  assert.equal(discovery.edgeDoorApiPath, edgeDoorApiPath);
  assert.equal(Object.isFrozen(EDGE_DOOR_HOSTS), true);
  for (const host of EDGE_DOOR_HOSTS) {
    assert.equal(edgeDoorApiPath(`https://${host}`, "/api"), "/room/api");
    assert.equal(edgeDoorApiPath(`https://${host}`, "/api/rooms?limit=1"), "/room/api/rooms?limit=1");
    for (const path of ["/room/api/rooms", "/room/api", "/llms.txt", "/apiculture", "", null]) {
      assert.equal(edgeDoorApiPath(`https://${host}`, path), path);
    }
  }
  for (const origin of [ROOM_ORIGIN, "http://127.0.0.1:3000", "https://getdasha.com.example.test", "invalid"]) {
    assert.equal(edgeDoorApiPath(origin, "/api/rooms"), "/api/rooms");
  }
});
