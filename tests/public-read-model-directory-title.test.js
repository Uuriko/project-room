// K4b (QA2 receipts-parity census): a room's receipts carried
// room.title null 33/33 where a room exists, because every title
// capture site read only the room state's title — rooms are created
// and addressed by slug, so that title is usually absent — while the
// public directory record (public_rooms.title) already holds the
// room's public name. The cure falls back to the directory title at
// the three capture sites, only where the existing code already
// gates on the room being listed/public. This fixture executes the
// CHECKS.md K4b leg both ways:
//   listed room, public_rooms title set, no room-state title
//     -> receipts carry the directory title after projection;
//   room with no public_rooms row -> title stays null
//     (honest absence, never a synthesized name);
//   unlisted room -> gains no title, even from a stale
//     public_rooms row (the fallback is consulted only behind the
//     listed gate).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import {
  projectPublicWorkReceipt,
  publicReceiptById,
  publicWorkClaimReceiptId,
  refreshListedRoom,
} from "../server/public-read-model.mjs";

const DIRECTORY_TITLE = "Directory Title K4b";
const NOW = "2026-10-11T00:00:00.000Z";

function seedRoom(store, roomId) {
  store.initialize(initialRoom(roomId));
  // The room state carries NO title (the K4b condition), but public
  // receipts are opted in. Direct projection rewrite, the fixture
  // pattern of tests/public-work-receipt-outcome.test.js.
  const state = structuredClone(store.room(roomId).state);
  delete state.room.title;
  state.room.publicReceipts = { enabled: true, revision: 1, setById: "owner", setAt: NOW };
  store.db.prepare("UPDATE rooms SET projection=? WHERE id=?").run(JSON.stringify(state), roomId);
  store.workClaims.set(roomId, {
    id: "k4b-claim", title: "K4b visible claim", state: "done", owner: "owner",
    history: [{ action: "pr_merged", actor: "owner", at: "2026-10-01T00:00:00.000Z" }],
    pullRequest: { url: "https://github.com/Uuriko/project-room/pull/4", outcome: "merged", syncedAt: "2026-10-01T00:00:00.000Z" },
    blobs: [], updatedAt: "2026-10-01T00:00:00.000Z",
  });
}

function listRoom(store, roomId) {
  store.db.prepare(`INSERT INTO room_directory_settings
      (room_id, discoverable, listed_at, updated_at)
      VALUES (?, 1, 1, 1)`).run(roomId);
}

function insertDirectoryRow(store, roomId, title) {
  store.db.prepare(`INSERT INTO public_rooms
      (slug, title, purpose, humans, agents, names_json, tasks_json, members_json, receipts_enabled, join_mode, join_token, owner_member_id, set_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    roomId, title, "A public room", 1, 0, "[]", "[]", "[]", 1, "request", null, "owner", NOW, NOW);
}

function publicWorkBody(roomId, receiptId) {
  return {
    receiptId, namespaceId: roomId, title: `Work for ${receiptId}`,
    agentName: "K4b worker", createdAt: NOW,
    artifact: { sha256: "ab".repeat(32) },
  };
}

const storedTitle = (store, id) =>
  store.db.prepare("SELECT room_title AS t FROM public_receipts WHERE id=?").get(id)?.t;

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-k4b-directory-title-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return store;
}

test("listed room with a public_rooms title: receipts carry it after projection, at all three capture sites", t => {
  const store = fixture(t);
  const roomId = "k4b-listed";
  seedRoom(store, roomId);
  listRoom(store, roomId);

  // Capture site 3 (public-work insert) BEFORE any directory row
  // exists is the negative leg for that site, asserted in the next
  // test; here the row is projected first with no directory title
  // available, then re-touched once the directory row exists.
  const earlyPwr = "pwr_" + "a1".repeat(16);
  projectPublicWorkReceipt(store, publicWorkBody(roomId, earlyPwr));
  assert.equal(storedTitle(store, earlyPwr), null);

  insertDirectoryRow(store, roomId, DIRECTORY_TITLE);

  // Capture sites 1 + 2: refreshListedRoom re-projects the opted-in
  // (work-claim) receipts through listedRoomFields and touches the
  // public-work listing rows.
  refreshListedRoom(store, roomId);
  const wcrId = publicWorkClaimReceiptId(roomId, "k4b-claim");
  assert.equal(storedTitle(store, wcrId), DIRECTORY_TITLE);
  assert.equal(storedTitle(store, earlyPwr), DIRECTORY_TITLE);
  const pub = publicReceiptById(store, wcrId);
  assert.equal(pub.room.id, roomId);
  assert.equal(pub.room.title, DIRECTORY_TITLE);

  // Capture site 3 (public-work insert) with the directory row in
  // place: the new receipt carries the directory title directly.
  const latePwr = "pwr_" + "b2".repeat(16);
  projectPublicWorkReceipt(store, publicWorkBody(roomId, latePwr));
  assert.equal(storedTitle(store, latePwr), DIRECTORY_TITLE);
});

test("listed room with no public_rooms row: title stays null, never a synthesized name", t => {
  const store = fixture(t);
  const roomId = "k4b-no-directory";
  seedRoom(store, roomId);
  listRoom(store, roomId);
  // No public_rooms row is ever inserted for this room.
  refreshListedRoom(store, roomId);
  const wcrId = publicWorkClaimReceiptId(roomId, "k4b-claim");
  assert.equal(storedTitle(store, wcrId), null);
  const pub = publicReceiptById(store, wcrId);
  assert.equal(pub.room.id, roomId);
  assert.equal(pub.room.title, null);

  const pwr = "pwr_" + "c3".repeat(16);
  projectPublicWorkReceipt(store, publicWorkBody(roomId, pwr));
  assert.equal(storedTitle(store, pwr), null);
});

test("unlisted room gains no title, even from a stale public_rooms row", t => {
  const store = fixture(t);
  const roomId = "k4b-unlisted";
  seedRoom(store, roomId);
  // Deliberately NOT listed (no directory/public setting), yet a
  // stale directory row carrying a title exists. The fallback must
  // not be consulted behind no gate: no title is exposed.
  insertDirectoryRow(store, roomId, DIRECTORY_TITLE);
  refreshListedRoom(store, roomId);
  const wcrId = publicWorkClaimReceiptId(roomId, "k4b-claim");
  assert.equal(storedTitle(store, wcrId), null);

  const pwr = "pwr_" + "d4".repeat(16);
  projectPublicWorkReceipt(store, publicWorkBody(roomId, pwr));
  assert.equal(storedTitle(store, pwr), null);
});
