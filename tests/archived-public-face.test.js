// UT2 L7 money guards, build B (headline finding 05-08 F3, EXECUTED S3):
// an archived room's /r/<roomId> public face stayed live ~10.4h after
// archiving — full "Join this room" flow, a live join token, zero
// occurrences of "archiv" — while writes to archived rooms refuse 409.
// Evidence: wave-2026-10-27-user-testing-2/lanes/05-08-owner-public-face/REPORT.md.
// Cure (read-model level): syncRoomPublication treats an archived room's
// public page as retired — the public_rooms row is removed in the same
// transaction as the archive write, so loadPublicRoom / the sitemap /
// publicRoomView serve nothing (the existing retired-surface shape: 404,
// no join flow, no live token), and a stale row re-synced by the backfill
// is removed too.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { loadPublicRoom, listPublicRoomSitemap, syncRoomPublication } from "../server/public-read-model.mjs";
import { publicRoomView } from "../server/public-rooms.mjs";

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "archived-public-face-"));
  const store = new RoomStore(join(dir, "room.sqlite"));
  store.initialize(initialRoom("public-room"));
  const key = store.issueAccessKey("public-room", "owner");
  const command = (id, type, data) => store.command(key, "public-room", { id, type, data });
  command("publish-page", "room.public_page_set", { enabled: true });
  command("publish-join", "room.join_link_set", { enabled: true });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { store, key, command };
}

test("archiving retires the public face in the same write: no page, no join token, no sitemap entry", t => {
  const { store, command } = fixture(t);
  const live = loadPublicRoom(store, "public-room");
  assert.ok(live, "face is live before archiving");
  assert.equal(live.joinMode, "link");
  assert.ok(live.joinToken, "a live join token is served before archiving");
  assert.ok(publicRoomView(store, "public-room").html.includes("Join this room"));
  assert.deepEqual(listPublicRoomSitemap(store).map(row => row.slug), ["public-room"]);

  command("archive-room", "room.archived", {});
  assert.equal(typeof store.room("public-room").state.room.archivedAt, "string");

  assert.equal(store.db.prepare("SELECT slug FROM public_rooms WHERE slug='public-room'").get(), undefined,
    "the public_rooms row (and its join token) is removed by the archive write");
  assert.equal(loadPublicRoom(store, "public-room"), null);
  assert.equal(publicRoomView(store, "public-room"), null);
  assert.deepEqual(listPublicRoomSitemap(store), []);
});

test("a stale public_rooms row for an already-archived room is removed on re-sync (backfill path)", t => {
  const { store, command } = fixture(t);
  command("archive-room", "room.archived", {});
  // Simulate the pre-cure residue: a row that survived archiving.
  store.db.prepare(`INSERT INTO public_rooms
    (slug, title, purpose, humans, agents, names_json, tasks_json, members_json, receipts_enabled, join_mode, join_token, owner_member_id, set_at, updated_at)
    VALUES ('public-room','Project Room Commons','stale',0,1,'[]','[]','[]',0,'link','stale-token','owner',NULL,'2026-10-27T00:00:00.000Z')`).run();
  assert.ok(loadPublicRoom(store, "public-room"));
  const state = store.room("public-room").state;
  syncRoomPublication(store, { roomId: "public-room", state, previous: null, auth: null });
  assert.equal(store.db.prepare("SELECT slug FROM public_rooms WHERE slug='public-room'").get(), undefined);
  assert.equal(loadPublicRoom(store, "public-room"), null);
});
