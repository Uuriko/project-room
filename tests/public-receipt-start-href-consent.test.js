// P-2 (ATLAS-PUBLIC): a public receipt's start_href named the room owner
// from credit() alone — active member, no consent check — while every
// names list on the same surfaces gates on the member's publicName
// opt-in. The href now derives its name through that same predicate:
// consented owner → named as before; no opt-in → the nameless form the
// lot path already used. Stored rows follow consent: the toggle command
// itself scrubs them, and the backfill's hrefs phase sweeps the rest.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import {
  PUBLIC_START_URL,
  backfillPublicReadModel,
  projectPublicWorkReceipt,
  publicReceiptById,
  refreshListedRoom,
} from "../server/public-read-model.mjs";

const OWNER_NAME = "Room owner";
const NAMED_HREF = (() => {
  const url = new URL(PUBLIC_START_URL);
  url.searchParams.set("ref", OWNER_NAME);
  return url.href;
})();

function makeStore(t, label) {
  const directory = mkdtempSync(join(tmpdir(), `project-room-href-consent-${label}-`));
  const store = new RoomStore(join(directory, "room.sqlite"));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return store;
}

const cmd = (store, key, roomId, id, type, data) => store.command(key, roomId, { id, type, data });

const hrefsOf = store => store.db.prepare("SELECT start_href AS href FROM public_receipts ORDER BY id").all().map(row => row.href);

function seedMergedClaim(store, roomId) {
  store.workClaims.set(roomId, {
    id: "claim-1", title: "Shipped work", state: "done", owner: "owner",
    history: [{ action: "pr_merged", agentId: "owner", at: "2026-10-01T00:00:00.000Z" }],
    pullRequest: { url: "https://github.com/Uuriko/project-room/pull/4", outcome: "merged", syncedAt: "2026-10-01T00:00:00.000Z" },
    blobs: [], updatedAt: "2026-10-01T00:00:00.000Z",
  });
}

function listRoom(store, roomId) {
  store.db.prepare(`INSERT INTO room_directory_settings
      (room_id, discoverable, listed_at, updated_at, opportunities_enabled, public_receipts)
      VALUES (?, 1, NULL, 1, 1, 1)`).run(roomId);
}

let seedCount = 0;
function seedPublicWorkReceipt(store, roomId) {
  seedCount += 1;
  const tag = String(seedCount).padStart(2, "0");
  const offerId = `offer-${seedCount}`;
  const sha = `${tag}`.repeat(32);
  const now = Date.now();
  store.db.prepare(`INSERT INTO public_work_tasks
      (offer_id, namespace_key, room_id, terms_version, repository_url, repository_ref, files_json, generation, created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(offerId, "public_ns", roomId, 1, "https://github.com/Uuriko/project-room", "main", JSON.stringify(["README.md"]), 1, now);
  const body = {
    schema: "public-work-receipt/1", receiptId: `pwr_${sha}`, namespaceId: "public_ns",
    taskId: offerId, identityId: "ai_worker", title: "Public task",
    createdAt: "2026-10-01T00:00:00.000Z", artifact: { sha256: sha },
  };
  projectPublicWorkReceipt(store, body, sha);
  return body.receiptId;
}

test("an unconsented owner is never named in a receipt start href, even from an unlisted room", t => {
  const store = makeStore(t, "unconsented");
  store.initialize(initialRoom("room-a"));
  const key = store.issueAccessKey("room-a", "owner");
  seedMergedClaim(store, "room-a");
  // Receipts on; the room is never listed (no public page, no directory
  // entry) — the exact P-2 shape: room fields are null, yet the receipt
  // is public and its footer href used to carry the owner's name.
  cmd(store, key, "room-a", "receipts-on", "room.public_receipts_set", { enabled: true });
  const hrefs = hrefsOf(store);
  assert.equal(hrefs.length, 1);
  assert.deepEqual(hrefs, [PUBLIC_START_URL]);
  const row = store.db.prepare("SELECT id, room_id FROM public_receipts").get();
  assert.equal(row.room_id, null);
  assert.equal(publicReceiptById(store, row.id).startHref, PUBLIC_START_URL);
});

test("a consented owner is named in the start href exactly as before", t => {
  const store = makeStore(t, "consented");
  store.initialize(initialRoom("room-a"));
  const key = store.issueAccessKey("room-a", "owner");
  seedMergedClaim(store, "room-a");
  cmd(store, key, "room-a", "name-on", "member.public_name_set", { enabled: true });
  cmd(store, key, "room-a", "receipts-on", "room.public_receipts_set", { enabled: true });
  assert.deepEqual(hrefsOf(store), [NAMED_HREF]);
});

test("turning name consent off removes the name from already-projected receipts", t => {
  const store = makeStore(t, "toggle-off");
  store.initialize(initialRoom("room-a"));
  const key = store.issueAccessKey("room-a", "owner");
  seedMergedClaim(store, "room-a");
  cmd(store, key, "room-a", "name-on", "member.public_name_set", { enabled: true });
  cmd(store, key, "room-a", "receipts-on", "room.public_receipts_set", { enabled: true });
  assert.deepEqual(hrefsOf(store), [NAMED_HREF]);
  cmd(store, key, "room-a", "name-off", "member.public_name_set", { enabled: false });
  assert.deepEqual(hrefsOf(store), [PUBLIC_START_URL]);
});

test("public-work receipts: consent gates the href name on projection", t => {
  const store = makeStore(t, "pwr");
  store.initialize(initialRoom("board-room"));
  const key = store.issueAccessKey("board-room", "owner");
  listRoom(store, "board-room");
  const first = seedPublicWorkReceipt(store, "board-room");
  assert.equal(publicReceiptById(store, first).startHref, PUBLIC_START_URL);
  cmd(store, key, "board-room", "name-on", "member.public_name_set", { enabled: true });
  const second = seedPublicWorkReceipt(store, "board-room");
  assert.equal(publicReceiptById(store, second).startHref, NAMED_HREF);
});

test("a listed room's public-work listing refresh honours consent both ways", t => {
  const store = makeStore(t, "listing");
  store.initialize(initialRoom("board-room"));
  const key = store.issueAccessKey("board-room", "owner");
  listRoom(store, "board-room");
  const id = seedPublicWorkReceipt(store, "board-room");
  assert.equal(publicReceiptById(store, id).startHref, PUBLIC_START_URL);
  cmd(store, key, "board-room", "name-on", "member.public_name_set", { enabled: true });
  refreshListedRoom(store, "board-room");
  assert.equal(publicReceiptById(store, id).startHref, NAMED_HREF);
  cmd(store, key, "board-room", "name-off", "member.public_name_set", { enabled: false });
  refreshListedRoom(store, "board-room");
  assert.equal(publicReceiptById(store, id).startHref, PUBLIC_START_URL);
});

test("turning consent off scrubs stored hrefs even where no public projection runs", t => {
  // Directory-listed room, public page and public receipts both OFF:
  // syncRoomPublication's projections never run for it, so before the
  // fix a name toggle left the stored pwr_ href untouched forever.
  const store = makeStore(t, "directory-only");
  store.initialize(initialRoom("board-room"));
  const key = store.issueAccessKey("board-room", "owner");
  listRoom(store, "board-room");
  cmd(store, key, "board-room", "name-on", "member.public_name_set", { enabled: true });
  const id = seedPublicWorkReceipt(store, "board-room");
  assert.equal(publicReceiptById(store, id).startHref, NAMED_HREF);
  cmd(store, key, "board-room", "name-off", "member.public_name_set", { enabled: false });
  assert.equal(publicReceiptById(store, id).startHref, PUBLIC_START_URL);
});

test("the backfill hrefs phase sweeps legacy rows and leaves consented names alone", t => {
  const store = makeStore(t, "backfill");
  store.initialize(initialRoom("room-x"));
  store.initialize(initialRoom("room-y"));
  const keyY = store.issueAccessKey("room-y", "owner");
  cmd(store, keyY, "room-y", "name-on", "member.public_name_set", { enabled: true });
  const insert = store.db.prepare(`INSERT INTO public_receipts
      (id, title, source, origin_room_id, room_id, room_title, agents_json, humans_json, pull_request, merged_at, hashes_json, at, start_href)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  insert.run(`wcr_${"11".repeat(16)}`, "Legacy X", "work-claim", "room-x", null, null, "[]", "[]", null, null, "[]", "2026-10-01T00:00:00.000Z", NAMED_HREF);
  insert.run(`wcr_${"22".repeat(16)}`, "Legacy Y", "work-claim", "room-y", null, null, "[]", "[]", null, null, "[]", "2026-10-01T00:00:00.000Z", NAMED_HREF);
  // A store whose backfill finished before the hrefs phase existed.
  store.db.prepare("INSERT OR REPLACE INTO public_read_model_backfill (id, phase, cursor, done) VALUES (1, 'directory', '', 1)").run();
  let result;
  for (let i = 0; i < 10; i++) {
    result = backfillPublicReadModel(store, { limit: 100 });
    if (result.done) break;
  }
  assert.equal(result.done, true);
  const rows = store.db.prepare("SELECT origin_room_id AS room, start_href AS href FROM public_receipts ORDER BY origin_room_id").all()
    .map(row => ({ room: row.room, href: row.href }));
  assert.deepEqual(rows, [
    { room: "room-x", href: PUBLIC_START_URL },
    { room: "room-y", href: NAMED_HREF },
  ]);
  const cursor = store.db.prepare("SELECT phase, done FROM public_read_model_backfill WHERE id=1").get();
  assert.deepEqual({ phase: cursor.phase, done: cursor.done }, { phase: "hrefs", done: 1 });
  assert.deepEqual(backfillPublicReadModel(store, { limit: 100 }), { done: true, rooms: 0, receipts: 0, cards: 0 });
});
