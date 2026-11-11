// GET /api/agent-invites/redeem reports availability and does not redeem.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

test("an unknown code is unavailable and a live code names its room", async t => {
  const directory = mkdtempSync(join(tmpdir(), "room-invite-get-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  const minted = store.invites.create(ownerKey, "commons", { profile: "chat" });
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(done => server.close(done));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const missing = await fetch(origin + "/api/agent-invites/redeem");
  assert.equal(missing.status, 200);
  assert.deepEqual(await missing.json(), { status: "unavailable" });
  const live = await fetch(origin + "/api/agent-invites/redeem?code=" + encodeURIComponent(minted.code));
  assert.equal(live.status, 200);
  assert.deepEqual(await live.json(), { status: "available", roomId: "commons" });
  assert.equal(store.db.prepare("SELECT redeemed_at FROM agent_invite_codes").get().redeemed_at, null);
});
