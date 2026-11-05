import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { AgentRooms } from "../server/agent-rooms.mjs";
import { seedHistoricalNeedsMeRoom } from "./helpers/historical-needs-me-room.mjs";
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
  const clock = { now: Date.now() };
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => clock.now });
  const rooms = new AgentRooms(store);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, rooms, clock };
}

const tinyFile = () => Buffer.from("x").toString("base64");

test("room records quota ignores discarded rows: stage→discard loop cannot brick uploads", async t => {
  const { store } = serve(t);
  const owner = store.identities.create("Quota owner");
  seedHistoricalNeedsMeRoom(store, owner, {
    roomId: "quota-den", title: "Quota den", purpose: "quota ratchet", kind: "personal", displayName: "Quota owner"
  });
  const roomId = "quota-den";

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
      insert.run(roomId, `seed-${i}`, owner.identityId, now, now + 86400000);
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
  const { store, clock } = serve(t);
  const owner = store.identities.create("Quota owner");
  seedHistoricalNeedsMeRoom(store, owner, {
    roomId: "quota-den", title: "Quota den", purpose: "quota ratchet", kind: "personal", displayName: "Quota owner"
  });
  const roomId = "quota-den";

  // Seed EXPIRED rows to one under the cap via SQL, then force one
  // staged row to expire via the controlled production clock. That brings the
  // expired-row total to exactly recordsPerRoom (4096) before e-final:
  // if expired rows were counted (bare COUNT(*), or a mutant counting
  // expired but not discarded), e-final would hit 409 attachment_quota.
  // Previously this seeded 'discarded' rows, so the expired count was
  // only 1 and e-final succeeded whether or not expired rows counted.
  const now = Date.now();
  const seedCount = attachmentLimits.recordsPerRoom - 1;
  const sha64 = "a".repeat(64);
  const insert = store.db.prepare(`INSERT INTO room_attachments(
    room_id,id,uploader_id,filename,media_type,byte_length,sha256,bytes,state,created_at,expires_at,message_id
  ) VALUES(?,?,?,'e.txt','text/plain',1,'${sha64}',NULL,'expired',?,?,NULL)`);
  store.transaction(() => {
    for (let i = 0; i < seedCount; i += 1) {
      insert.run(roomId, `seed-${i}`, owner.identityId, now, now + 86400000);
    }
  });
  store.roomAttachments.stage(owner.secret, roomId, {
    id: "e-expiry", filename: "e.txt", mediaType: "text/plain", data: tinyFile()
  });
  clock.now += attachmentLimits.lifetimeMs + 1;
  // Legacy list retains its existing expire-on-read behavior.
  store.roomAttachments.list(owner.secret, roomId);
  // Preconditions: the flip really happened and expired rows are at
  // the cap, otherwise this test would again pass vacuously.
  const expiredRow = store.db.prepare("SELECT state FROM room_attachments WHERE room_id=? AND id=?")
    .get(roomId, "e-expiry");
  assert.equal(expiredRow.state, "expired");
  const expiredCount = store.db.prepare("SELECT COUNT(*) AS n FROM room_attachments WHERE room_id=? AND state='expired'")
    .get(roomId);
  assert.equal(expiredCount.n, attachmentLimits.recordsPerRoom);

  const after = store.roomAttachments.stage(owner.secret, roomId, {
    id: "e-final", filename: "final.txt", mediaType: "text/plain", data: tinyFile()
  });
  assert.equal(after.status, "staged");
});

test("room records quota still caps live rows", async t => {
  const { store } = serve(t);
  const owner = store.identities.create("Quota owner");
  seedHistoricalNeedsMeRoom(store, owner, {
    roomId: "quota-den", title: "Quota den", purpose: "quota ratchet", kind: "personal", displayName: "Quota owner"
  });
  const roomId = "quota-den";

  // Seed recordsPerRoom live (staged) rows directly. The production path
  // under test is stage()'s quota check counting live rows; the seed is
  // just setup. The per-member staged cap is covered by existing tests.
  const now = Date.now();
  const insert = store.db.prepare(`INSERT INTO room_attachments(
    room_id,id,uploader_id,filename,media_type,byte_length,sha256,bytes,state,created_at,expires_at,message_id
  ) VALUES(?,?,?,'l.txt','text/plain',1,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',?,'staged',?,?,NULL)`);
  store.transaction(() => {
    for (let i = 0; i < attachmentLimits.recordsPerRoom; i += 1) {
      insert.run(roomId, `seed-${i}`, owner.identityId, Buffer.from("x"), now, now + 86400000);
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

// Current rooms use only real production writers. Reads refuse expired bytes
// without a hidden write; an explicit expiry or successful stage reclaims them.
test("normalized staging quotas expire under the guarded writer, without read-time mutation", t => {
  const { store, rooms, clock } = serve(t);
  const owner = store.identities.create("Current quota owner");
  const {roomId} = rooms.create(owner.secret, {roomId:"current-quota",title:"Quota",purpose:"Current quota",kind:"personal",displayName:"Owner",starter:false});
  store.room = () => { throw Error("legacy room hydration"); };
  const files = store.roomAttachments, upload = id => files.stage(owner.secret,roomId,{id,filename:"q.txt",mediaType:"text/plain",data:tinyFile()});
  for(let i=0;i<attachmentLimits.stagedPerMember;i++)upload(`live-${i}`);
  assert.throws(()=>upload("over"),e=>e.code==="attachment_quota"&&e.detail.quota.limit==="staged_files");
  assert.throws(()=>store.db.prepare("UPDATE room_attachments SET state='expired',bytes=NULL WHERE room_id=?").run(roomId),/unsupported current room writer/);
  clock.now += attachmentLimits.lifetimeMs + 1;
  assert.throws(()=>files.get(owner.secret,roomId,"live-0"),e=>e.status===410&&e.code==="attachment_unavailable");
  assert.equal(store.db.prepare("SELECT count(*) n FROM room_attachments WHERE room_id=? AND state='staged' AND bytes IS NOT NULL").get(roomId).n,attachmentLimits.stagedPerMember);
  assert.equal(upload("after").status,"staged");
  assert.equal(store.db.prepare("SELECT count(*) n FROM room_attachments WHERE room_id=? AND state='expired' AND bytes IS NULL").get(roomId).n,attachmentLimits.stagedPerMember);
  assert.equal(files.discard(owner.secret,roomId,"after").status,"discarded");
  assert.equal(upload("again").status,"staged");
  assert.equal(store.db.prepare("SELECT enabled FROM current_room_writer_permit").get().enabled,0);
});

test("normalized records quota counts live committed rows and ignores real discarded history",t=>{
 const {store,rooms}=serve(t),owner=store.identities.create("Current records owner");
 const {roomId}=rooms.create(owner.secret,{roomId:"current-records",title:"Records",purpose:"Records quota",kind:"personal",displayName:"Owner",starter:false});
 store.command(owner.secret,roomId,{id:"quota-message",type:"message.posted",data:{messageId:"quota-message",body:"Committed records"}});
 store.room=()=>{throw Error("legacy room hydration");};
 const files=store.roomAttachments,upload=id=>files.stage(owner.secret,roomId,{id,filename:"q.txt",mediaType:"text/plain",data:tinyFile()});
 // Every historical row was created and terminated by the public writer;
 // no raw SQL fixtures or temporarily opened permits can bypass admission.
 for(let i=0;i<attachmentLimits.recordsPerRoom;i++){
  const id=`discard-${i}`;upload(id);files.discard(owner.secret,roomId,id);
 }
 assert.equal(store.db.prepare("SELECT count(*) n FROM room_attachments WHERE state='discarded'").get().n,attachmentLimits.recordsPerRoom);
 for(let i=0;i<attachmentLimits.recordsPerRoom;i++){
  const id=`live-${i}`;upload(id);files.commit(owner.secret,roomId,{id,messageId:"quota-message"});
 }
 assert.equal(store.db.prepare("SELECT count(*) n FROM room_attachments WHERE state='committed'").get().n,attachmentLimits.recordsPerRoom);
 assert.throws(()=>upload("over"),e=>e.code==="attachment_quota"&&e.detail.quota.limit==="room_files");
 assert.equal(files.discard(owner.secret,roomId,"live-0").status,"deleted");
 assert.equal(upload("reclaimed").status,"staged");
 assert.equal(store.db.prepare("SELECT enabled FROM current_room_writer_permit").get().enabled,0);
});
