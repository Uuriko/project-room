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
  const directory = mkdtempSync(join(tmpdir(), "project-room-heartbeats-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey("commons", "owner");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const get = (path, token) => fetch(origin + path, { headers: { Origin: origin, ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
  return { origin, ownerKey, store, get };
}

test("provider heartbeat dashboard (round-2 #118)", async t => {
  const { origin, ownerKey, store, get } = await serve(t);
  const cmd = (token, type, data) => store.command(token, "commons", { id: randomUUID(), type, data });

  // Two agent providers; one idle, one with a live session heartbeat.
  cmd(ownerKey, T.MEMBER_ADDED, { memberId: "gpu-a", displayName: "GPU A", kind: "agent", permissions: ["accept_work"] });
  cmd(ownerKey, T.MEMBER_ADDED, { memberId: "gpu-b", displayName: "GPU B", kind: "agent", permissions: ["accept_work"] });
  const gpuA = store.issueAccessKey("commons", "gpu-a");
  const workItemId = randomUUID();
  cmd(ownerKey, T.WORK_PROPOSED, { workItemId, title: "Render frames", definitionOfDone: "Frames posted.", accountableMemberId: "gpu-a", mode: "read" });
  cmd(gpuA, T.WORK_ACCEPTED, { workItemId, expectedRevision: 0 });
  cmd(gpuA, T.SESSION_STARTED, { workItemId, expectedRevision: 1 });
  cmd(gpuA, T.CAPABILITIES_ADVERTISED, { capabilities: ["compute", "mac-runner"] });

  const res = await get("/api/rooms/commons/provider-heartbeats", ownerKey);
  assert.equal(res.status, 200);
  const { providers } = await res.json();
  const ids = providers.map(p => p.memberId).sort();
  assert.deepEqual(ids, ["gpu-a", "gpu-b"]);

  const live = providers.find(p => p.memberId === "gpu-a");
  assert.equal(live.status, "live");
  assert.ok(live.lastHeartbeatAt);
  assert.equal(live.workingOn.length, 1);
  assert.equal(live.workingOn[0].workItemId, workItemId);
  assert.deepEqual(live.capabilities, ["compute", "mac-runner"]);

  const idle = providers.find(p => p.memberId === "gpu-b");
  assert.equal(idle.status, "idle");
  assert.equal(idle.lastHeartbeatAt, null);
  assert.deepEqual(idle.workingOn, []);

  // Non-members get 401.
  assert.equal((await get("/api/rooms/commons/provider-heartbeats")).status, 401);
});
