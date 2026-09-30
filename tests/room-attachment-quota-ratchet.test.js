import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { AgentRooms } from "../server/agent-rooms.mjs";
import { attachmentLimits } from "../server/attachment-schema.mjs";

// Test-audit authoring gate:
// 1. Protects: stage→discard loops must not permanently consume the room's
//    (or identity's) lifetime upload quota — the records quota counts only
//    live rows (staged/committed), mirroring the byte quotas.
// 2. Regression: reverting the records count to bare COUNT(*) makes the loop
//    hit 409 attachment_quota at 4096 iterations (F1 in the API bug-hunt).
// 3. Existing coverage: no test exercises the records quota with
//    terminal-state (discarded/expired) rows.
// 4. No new production seam: exercises the live RoomAttachmentBytes /
//    InboxAttachmentBytes store API at the owner boundary.

function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-attach-quota-"));
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => Date.now() });
  const rooms = new AgentRooms(store);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, rooms };
}

const tinyFile = () => Buffer.from("x").toString("base64");

test("room records quota ignores discarded rows: stage→discard loop cannot brick uploads", async t => {
  const { store, rooms } = serve(t);
  const owner = store.identities.create("Quota owner");
  const created = rooms.create(owner.secret, {
    roomId: "quota-den", title: "Quota den", purpose: "quota ratchet", kind: "personal", displayName: "Quota owner"
  });
  const roomId = created.roomId;

  // Seed discarded rows to just under the cap via SQL (fast), then run a
  // short LIVE stage→discard loop (15 cycles crosses the 4096 cap on pre-fix). On pre-fix code the loop crosses the
  // 4096 bare-COUNT(*) cap and throws 409 attachment_quota; with the fix
  // the discarded rows never count and the loop completes.
  const now = Date.now();
  const seedCount = attachmentLimits.recordsPerRoom - 10;
  const insert = store.db.prepare(`INSERT INTO room_attachments(
    room_id,id,uploader_id,filename,media_type,byte_length,sha256,bytes,state,created_at,expires_at,message_id
  ) VALUES(?,?,?,'q.txt','text/plain',1,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',NULL,'discarded',?,?,NULL)`);
  store.transaction(() => {
    for (let i = 0; i < seedCount; i += 1) {
      insert.run(roomId, `seed-${i}`, created.ownerMemberId, now, now + 86400000);
    }
  });

  for (let i = 0; i < 15; i += 1) {
    const id = `q-${i}`;
    const staged = store.roomAttachments.stage(owner.secret, roomId, {
      id, filename: "q.txt", mediaType: "text/plain", data: tinyFile()
    });
    assert.equal(staged.status, "staged");
    const discarded = store.roomAttachments.discard(owner.secret, roomId, id);
    assert.equal(discarded.status, "discarded");
  }

  const after = store.roomAttachments.stage(owner.secret, roomId, {
    id: "q-final", filename: "final.txt", mediaType: "text/plain", data: tinyFile()
  });
  assert.equal(after.status, "staged");
  assert.equal(after.duplicate, false);
});

test("room records quota ignores expired rows", async t => {
  const { store, rooms } = serve(t);
  const owner = store.identities.create("Quota owner");
  const created = rooms.create(owner.secret, {
    roomId: "quota-den", title: "Quota den", purpose: "quota ratchet", kind: "personal", displayName: "Quota owner"
  });
  const roomId = created.roomId;

  // Seed discarded rows to just under the cap via SQL, then force one
  // staged row to expire via a backdated expires_at.
  const now = Date.now();
  const seedCount = attachmentLimits.recordsPerRoom - 10;
  const sha64 = "a".repeat(64);
  const insert = store.db.prepare(`INSERT INTO room_attachments(
    room_id,id,uploader_id,filename,media_type,byte_length,sha256,bytes,state,created_at,expires_at,message_id
  ) VALUES(?,?,?,'e.txt','text/plain',1,'${sha64}',NULL,'discarded',?,?,NULL)`);
  store.transaction(() => {
    for (let i = 0; i < seedCount; i += 1) {
      insert.run(roomId, `seed-${i}`, created.ownerMemberId, now, now + 86400000);
    }
  });
  store.roomAttachments.stage(owner.secret, roomId, {
    id: "e-expiry", filename: "e.txt", mediaType: "text/plain", data: tinyFile()
  });
  store.db.prepare("UPDATE room_attachments SET expires_at=0 WHERE room_id=? AND id=?")
    .run(roomId, "e-expiry");
  // Touch the room so expire() flips staged→expired.
  store.roomAttachments.list(owner.secret, roomId);

  const after = store.roomAttachments.stage(owner.secret, roomId, {
    id: "e-final", filename: "final.txt", mediaType: "text/plain", data: tinyFile()
  });
  assert.equal(after.status, "staged");
});

test("room records quota still caps live rows", async t => {
  const { store, rooms } = serve(t);
  const owner = store.identities.create("Quota owner");
  const created = rooms.create(owner.secret, {
    roomId: "quota-den", title: "Quota den", purpose: "quota ratchet", kind: "personal", displayName: "Quota owner"
  });
  const roomId = created.roomId;

  // Seed recordsPerRoom live (staged) rows directly. The production path
  // under test is stage()'s quota check counting live rows; the seed is
  // just setup. The per-member staged cap is covered by existing tests.
  const now = Date.now();
  const insert = store.db.prepare(`INSERT INTO room_attachments(
    room_id,id,uploader_id,filename,media_type,byte_length,sha256,bytes,state,created_at,expires_at,message_id
  ) VALUES(?,?,?,'l.txt','text/plain',1,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',?,'staged',?,?,NULL)`);
  store.transaction(() => {
    for (let i = 0; i < attachmentLimits.recordsPerRoom; i += 1) {
      insert.run(roomId, `seed-${i}`, created.ownerMemberId, Buffer.from("x"), now, now + 86400000);
    }
  });

  assert.throws(
    () => store.roomAttachments.stage(owner.secret, roomId, {
      id: "l-over", filename: "over.txt", mediaType: "text/plain", data: tinyFile()
    }),
    err => err.code === "attachment_quota",
    "live rows at the cap must still be rejected"
  );
});

test("inbox records quota ignores discarded rows", async t => {
  const { store } = serve(t);
  const owner = store.identities.create("Inbox owner");

  // Seed discarded rows to just under the cap via SQL, then a short live
  // put→discard loop. Fails on pre-fix code at the 4096 bare-COUNT(*) cap.
  const now = Date.now();
  const seedCount = attachmentLimits.recordsPerRoom - 10;
  const insert = store.db.prepare(`INSERT INTO inbox_attachment_bytes(
    identity_id,id,filename,media_type,byte_length,sha256,bytes,state,created_at,expires_at
  ) VALUES(?,?,'q.txt','text/plain',1,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',NULL,'discarded',?,?)`);
  store.transaction(() => {
    for (let i = 0; i < seedCount; i += 1) {
      insert.run(owner.identityId, `seed-${i}`, now, now + 86400000);
    }
  });

  for (let i = 0; i < 15; i += 1) {
    const id = `iq-${i}`;
    const staged = store.inboxAttachments.put(owner.identityId, {
      id, filename: "q.txt", mediaType: "text/plain", data: tinyFile()
    });
    assert.equal(staged.status, "staged");
    const discarded = store.inboxAttachments.discard(owner.identityId, id);
    assert.equal(discarded.status, "discarded");
  }

  const after = store.inboxAttachments.put(owner.identityId, {
    id: "iq-final", filename: "final.txt", mediaType: "text/plain", data: tinyFile()
  });
  assert.equal(after.status, "staged");
});
