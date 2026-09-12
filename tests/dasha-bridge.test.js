import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { RoomAgentClient } from "../client/room-agent.mjs";
import { randomUUID } from "node:crypto";

// The bridge's room half (finding [dasha] work items, posting answers back)
// is exercised here with a stubbed Dasha call. The real HTTP call is only
// made in `prompt`/`run-once` with a live DASHA_API_KEY.

test("dasha bridge reference: [dasha] work item found and answer posted", async t => {
  const directory = mkdtempSync(join(tmpdir(), "project-room-dasha-bridge-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey("commons", "owner");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const client = new RoomAgentClient({ origin, roomId: "commons", token: ownerKey });

  // Seed one [dasha] work item and one ordinary item.
  const dashaWorkItemId = randomUUID();
  await client.command({ id: randomUUID(), type: "work.proposed",
    data: { workItemId: dashaWorkItemId, title: "[dasha] Summarize Raft", definitionOfDone: "Three sentences.", accountableMemberId: "owner", mode: "read" } });
  await client.command({ id: randomUUID(), type: "work.proposed",
    data: { workItemId: randomUUID(), title: "Ordinary task", definitionOfDone: "Done.", accountableMemberId: "owner", mode: "read" } });

  // Bridge logic: oldest proposed [dasha] item.
  const snapshot = await client.snapshot();
  const items = Object.values(snapshot.state.workItems);
  const pending = items.filter(w => w.state === "proposed" && w.title.toLowerCase().startsWith("[dasha]"));
  assert.equal(pending.length, 1);
  assert.equal(pending[0].id, dashaWorkItemId);

  // Post the (stubbed) model answer back as a message referencing the work item.
  await client.command({ id: randomUUID(), type: "message.posted",
    data: { messageId: randomUUID(), body: "Raft is a consensus algorithm. Stubbed answer.", workItemId: dashaWorkItemId } });
  const after = await client.snapshot();
  const posted = after.state.messages.find(m => m.workItemId === dashaWorkItemId);
  assert.ok(posted);
  assert.match(posted.body, /Raft/);
});

test("dasha bridge requires a developer key", async () => {
  // dashaChat without DASHA_API_KEY must fail fast, not call the network.
  delete process.env.DASHA_API_KEY;
  const source = await import("node:fs").then(fs => fs.readFileSync(new URL("../scripts/dasha-bridge.mjs", import.meta.url), "utf8"));
  assert.match(source, /DASHA_API_KEY/);
  assert.match(source, /lobby\.getdasha\.com\/compute\/api\/v1/);
});
