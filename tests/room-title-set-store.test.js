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

// RRC-CURE D1: a rename must not rewrite the room_title stored on an
// already-issued public receipt. The publication sync re-derives
// public_receipts rows on every command append, so the guarantee is
// pinned at store level in the configuration that can break it: a
// directory-listed room (an unlisted room stores room_title NULL),
// receipts on, and a server-verified merged work claim. A receipt
// issued after the rename takes the title current at its own issuance.
test("a rename keeps an issued receipt's stored room_title; a later receipt takes the new title", async t => {
  const store = new RoomStore(":memory:");
  t.after(() => store.close());
  store.initialize(initialRoom("commons"));
  const ownerToken = store.issueAccessKey("commons", "owner");
  const command = (type, data) => store.command(ownerToken, "commons", { id: randomUUID(), type, data });
  store.roomDirectory.set("commons", "owner", true);
  const mergedClaim = (id, syncedAt) => ({
    id, title: `Merged claim ${id}`, state: "done", owner: "owner",
    history: [{ action: "pr_merged", agentId: "owner", at: syncedAt }],
    pullRequest: { url: "https://github.com/Uuriko/project-room/pull/4", outcome: "merged", syncedAt },
    blobs: [], updatedAt: syncedAt
  });
  store.workClaims.set("commons", mergedClaim("claim-one", "2026-10-01T00:00:00.000Z"));
  command("room.public_receipts_set", { enabled: true });
  const storedTitles = () => new Map(store.db.prepare(
    "SELECT id, room_title FROM public_receipts WHERE origin_room_id='commons' AND source IN ('work-claim','work-item')"
  ).all().map(row => [row.id, row.room_title]));
  const issued = storedTitles();
  assert.equal(issued.size, 1);
  const [issuedId, issuedTitle] = [...issued.entries()][0];
  assert.equal(issuedTitle, "Project Room Commons");
  command("room.title_set", { title: "Listed Renamed" });
  assert.equal(store.room("commons").state.room.title, "Listed Renamed");
  assert.equal(storedTitles().get(issuedId), "Project Room Commons");
  store.workClaims.set("commons", mergedClaim("claim-two", "2026-10-02T00:00:00.000Z"));
  const after = storedTitles();
  assert.equal(after.size, 2);
  assert.equal(after.get(issuedId), "Project Room Commons");
  const newTitles = [...after.entries()].filter(([id]) => id !== issuedId).map(([, title]) => title);
  assert.deepEqual(newTitles, ["Listed Renamed"]);
});
