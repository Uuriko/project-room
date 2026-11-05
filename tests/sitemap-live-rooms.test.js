// Prod sitemap listed /r/ slugs that 404: a slug the public route rejects
// (uppercase) and native rooms whose page is not currently published.
// Invariant: a room is in the sitemap exactly when loadPublicRoom serves it.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { listPublicRoomSitemap, loadPublicRoom } from "../server/public-read-model.mjs";

test("sitemap room slugs match the rooms the public page serves", t => {
  const directory = mkdtempSync(join(tmpdir(), "room-sitemap-live-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const now = "2026-11-01T00:00:00.000Z";
  const insert = store.db.prepare(`INSERT INTO public_rooms
    (slug, title, purpose, humans, agents, names_json, tasks_json, members_json,
     receipts_enabled, join_mode, join_token, owner_member_id, set_at, updated_at)
    VALUES (?, 'Room', 'Purpose', 0, 0, '[]', '[]', '[]', 0, 'request', NULL, NULL, ?, ?)`);
  for (const slug of ["room-ok", "personal-jKGHmWYv7AhN", "commons"]) insert.run(slug, now, now);

  const listed = new Set(listPublicRoomSitemap(store).map(row => row.slug));
  assert.ok(listed.has("room-ok"), "a servable legacy room stays listed");
  assert.ok(!listed.has("personal-jKGHmWYv7AhN"), "a slug the route rejects is not listed");
  for (const slug of ["room-ok", "personal-jKGHmWYv7AhN", "commons"]) {
    let served = false;
    try { served = loadPublicRoom(store, slug) !== null; } catch { served = false; }
    assert.equal(listed.has(slug), served, `sitemap and page agree for ${slug}`);
  }
});
