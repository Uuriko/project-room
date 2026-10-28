// RRC §A, store path: room.title_set through RoomStore.command lands on the
// projection the room read serves, with the prior title preserved.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

test("the owner renames a room through the store; the projection and history follow", async t => {
  const directory = mkdtempSync(join(tmpdir(), "project-room-title-set-store-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.initialize(initialRoom("commons"));
  const ownerToken = store.issueAccessKey("commons", "owner");
  const originalTitle = store.room("commons").state.room.title;
  const result = store.command(ownerToken, "commons", {
    id: randomUUID(), type: "room.title_set", data: { title: "Commons Renamed", purpose: "A renamed commons." }
  });
  assert.equal(result.event.type, "room.title_set");
  assert.equal(result.event.actorId, "owner");
  const state = store.room("commons").state;
  assert.equal(state.room.title, "Commons Renamed");
  assert.equal(state.room.purpose, "A renamed commons.");
  assert.equal(state.room.titleSet.previousTitle, originalTitle);
  assert.equal(state.room.titleHistory[0].title, originalTitle);
});
