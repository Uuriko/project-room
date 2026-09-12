import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { ROOM_TEMPLATES, roomTemplate, roomTemplateIds } from "../src/room-templates.js";
import { RoomAgentClient as RoomAgent } from "../client/room-agent.mjs";

test("room templates catalog (round-2 #115)", () => {
  assert.ok(ROOM_TEMPLATES.length >= 3);
  for (const t of ROOM_TEMPLATES) {
    assert.ok(t.id && t.title && t.description);
    assert.deepEqual(Object.keys(t.charter).sort(), ["boundaries", "escalation", "outputs", "purpose"]);
    assert.ok(Array.isArray(t.workItems) && t.workItems.length > 0);
    for (const w of t.workItems) {
      assert.ok(w.title && w.definitionOfDone && ["read", "write"].includes(w.mode));
    }
  }
  assert.deepEqual(roomTemplateIds().sort(), ROOM_TEMPLATES.map(t => t.id).sort());
  assert.equal(roomTemplate("team-standup").id, "team-standup");
  assert.equal(roomTemplate("nope"), null);
});

test("applyRoomTemplate seeds charter and work items", async t => {
  const directory = mkdtempSync(join(tmpdir(), "project-room-templates-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey("commons", "owner");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const client = new RoomAgent({ origin, roomId: "commons", token: ownerKey });
  // Charter updates require the room owner; the owner key authenticates as
  // the bootstrap owner, so no member pinning is used here.

  assert.deepEqual(client.roomTemplateIds?.() ?? roomTemplateIds(), roomTemplateIds());
  const receipt = await client.applyRoomTemplate("team-standup", { accountableMemberId: "owner" });
  assert.equal(receipt.template, "team-standup");
  assert.equal(receipt.charter, "updated");
  assert.equal(receipt.workItems.length, 2);
  assert.ok(receipt.workItems.every(w => w.workItemId));

  const charter = await client.charter();
  assert.equal(charter.charter.purpose, roomTemplate("team-standup").charter.purpose);

  await assert.rejects(() => client.applyRoomTemplate("nope"), /Unknown room template/);
});
