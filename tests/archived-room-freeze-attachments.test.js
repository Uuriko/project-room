// Freeze residual (16b): room attachments into archived rooms.
//
// PR #5502 froze the chartered G8 families at the store layer and named
// room attachments (stage/discard/commit) as an explicit residual NOT
// covered by it; the tranche-2 G8 cross-cut (LINE-FINDINGS-T2.md,
// T2-L10f-C4) graded the family "SKIPS — every layer": RoomAttachmentBytes
// authenticates directly and bypasses store.command (the module already
// reimplements the guest gate for exactly that reason), and had no
// archive equivalent. #5502's guard provably cannot reach this surface:
// none of its choke points (work-claim registry, bounty intake,
// insertCredential, collab #transact, project-map, invite mint) is on
// the room_attachments write path.
//
// Scope, mirroring #5502's own scope statement:
//  FROZEN — stage, discard and commit (the three writes named in the
//  residual; #5502 froze the work-claim registry's delete the same way).
//  All refuse 409 room_archived, in the freeze's exact shape, and record
//  nothing / change nothing.
//  LEFT — reads (list/get) and the staged-expiry sweep (system
//  maintenance that only removes bytes, like the read-triggered
//  mention-expiry flip #5502 left open).
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

const isArchivedRefusal = error => error?.status === 409 && error?.code === "room_archived";
const capture = fn => { try { fn(); } catch (error) { return error; } throw new Error("expected the function to throw"); };
const fileData = () => Buffer.alloc(4, "x").toString("base64");

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-freeze-attach-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const archive = () => store.command(ownerKey, "commons", { id: "archive-room", type: "room.archived", data: { reason: "pilot over" } });
  const stage = id => store.roomAttachments.stage(ownerKey, "commons", { id, filename: "n.txt", mediaType: "text/plain", data: fileData() });
  const row = id => store.db.prepare("SELECT state, message_id FROM room_attachments WHERE room_id='commons' AND id=?").get(id);
  return { store, ownerKey, archive, stage, row };
}

test("stage: a room file cannot be staged into an archived room and records nothing", t => {
  const { store, archive, stage, row } = fixture(t);
  archive();
  const error = capture(() => stage("after-archive"));
  assert.ok(isArchivedRefusal(error), `stage must refuse 409 room_archived, got ${error?.status}/${error?.code}`);
  assert.equal(row("after-archive"), undefined, "no attachment row recorded in the archived room");
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM room_attachments WHERE room_id='commons'").get().n, 0);
});

test("discard + commit: a file staged before archiving can neither be discarded nor committed after archiving", t => {
  const { store, ownerKey, archive, stage, row } = fixture(t);
  stage("pre-archive");
  const messageId = randomUUID();
  store.command(ownerKey, "commons", { id: randomUUID(), type: T.MESSAGE_POSTED, data: { messageId, body: "commit target" } });
  archive();
  const discardError = capture(() => store.roomAttachments.discard(ownerKey, "commons", "pre-archive"));
  assert.ok(isArchivedRefusal(discardError), `discard must refuse 409 room_archived, got ${discardError?.status}/${discardError?.code}`);
  const commitError = capture(() => store.roomAttachments.commit(ownerKey, "commons", { id: "pre-archive", messageId }));
  assert.ok(isArchivedRefusal(commitError), `commit must refuse 409 room_archived, got ${commitError?.status}/${commitError?.code}`);
  assert.deepEqual({ state: row("pre-archive").state, message_id: row("pre-archive").message_id }, { state: "staged", message_id: null },
    "the staged file is unchanged in the archived room");
});

test("left alone: attachment reads still work in an archived room", t => {
  const { store, ownerKey, archive, stage } = fixture(t);
  stage("readable");
  archive();
  const listed = store.roomAttachments.list(ownerKey, "commons");
  assert.deepEqual(listed.files.map(file => file.id), ["readable"], "list still answers in an archived room");
  const got = store.roomAttachments.get(ownerKey, "commons", "readable");
  assert.equal(got.attachment.id, "readable", "get still answers in an archived room");
});

test("control: stage, commit and discard still succeed in a live room", t => {
  const { store, ownerKey, stage, row } = fixture(t);
  stage("live-1");
  const messageId = randomUUID();
  store.command(ownerKey, "commons", { id: randomUUID(), type: T.MESSAGE_POSTED, data: { messageId, body: "commit target" } });
  const committed = store.roomAttachments.commit(ownerKey, "commons", { id: "live-1", messageId });
  assert.equal(committed.status, "committed");
  stage("live-2");
  const discarded = store.roomAttachments.discard(ownerKey, "commons", "live-2");
  assert.equal(discarded.status, "discarded");
  assert.equal(row("live-2").state, "discarded");
});
