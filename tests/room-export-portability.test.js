import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

// F5 data-portability contract: the room export is the event log, nothing
// else. The work-claims board and attachment bytes live in their own tables;
// pending invitations are dropped by import. These tests pin that scope so a
// future change that widens (or silently narrows) it must update the
// documented contract in docs/history/EXPORT-RETENTION-DELETION.md.

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-export-portability-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const get = (path, token) => fetch(origin + path, {
    headers: { Origin: origin, ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
  return { store, ownerKey, origin, get };
}

test("export carries the event log only: work-claim board rows are not in the file", async t => {
  const { store, ownerKey, origin, get } = await serve(t);
  // A board entry made through the HTTP board API, so the thin
  // work_claim.updated event pointer (id, title, paths) lands in the event
  // log while the full row (note, tags, review policy) stays in the
  // work_claims table.
  const boardNote = `board-only-note-${randomUUID()}`;
  const boardCall = async (path, data) => {
    const r = await fetch(origin + path, { method: "POST",
      headers: { Origin: origin, Authorization: `Bearer ${ownerKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(data) });
    assert.ok(r.status < 300, `board call ${path} -> ${r.status}: ${await r.text()}`);
  };
  await boardCall("/api/rooms/commons/work-claims",
    { id: "portability-claim", title: "Portability probe", note: boardNote, tags: ["portability"], files: ["server/only-in-table.mjs"] });
  await boardCall("/api/rooms/commons/work-claims/portability-claim/claim", { leaseHours: 2 });
  assert.equal(store.workClaims.list("commons").length, 1);

  const res = await get("/api/rooms/commons/export", ownerKey);
  assert.equal(res.status, 200);
  const ndjson = await res.text();
  // The table-only note must not leak into the export; the thin event
  // pointer (title) is in the log by design.
  assert.ok(!ndjson.includes(boardNote), "board note must not be in the export");
  assert.ok(ndjson.includes("Portability probe"), "the work_claim.updated event pointer is in the log");
});

test("export carries the event log only: attachment bytes and records are not in the file", async t => {
  const { store, ownerKey, get } = await serve(t);
  const attId = randomUUID();
  const marker = `attachment-bytes-${randomUUID()}`;
  store.command(ownerKey, "commons", { id: randomUUID(), type: T.MESSAGE_POSTED,
    data: { messageId: "m-with-attachment", body: "see attached" } });
  store.roomAttachments.stage(ownerKey, "commons", { id: attId, filename: "notes.txt",
    mediaType: "text/plain", data: Buffer.from(marker).toString("base64") });
  store.roomAttachments.commit(ownerKey, "commons", { id: attId, messageId: "m-with-attachment" });
  assert.equal(store.roomAttachments.list(ownerKey, "commons").files.length, 1);

  const res = await get("/api/rooms/commons/export", ownerKey);
  assert.equal(res.status, 200);
  const ndjson = await res.text();
  assert.ok(!ndjson.includes(attId), "attachment id must not be in the export");
  assert.ok(!ndjson.includes(marker), "attachment bytes must not be in the export");
  assert.ok(!ndjson.includes("notes.txt"), "attachment record must not be in the export");
});


