import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { seedHistoricalNeedsMeRoom } from "./helpers/historical-needs-me-room.mjs";
import { attachmentLimits } from "../server/attachment-schema.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

// Test-audit authoring gate:
// 1. Protects: a room whose byte quota is full of committed files can free
//    space. Committed rows keep counting after their staging deadline (they
//    never expire by policy), and room_discard_file refused them, so the
//    uploader or owner had no way to reclaim bytes (Fo, muse-room seq 24906).
// 2. Regression: reverting discard() to staged-only makes the committed
//    delete throw 410 attachment_unavailable and the follow-up stage 409.
// 3. Existing coverage: quota-ratchet covers discarded/expired staged rows
//    only; nothing covers committed rows.
// 4. No new production seam: live RoomAttachmentBytes API.

function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-attach-commit-del-"));
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => Date.now() });

  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store };
}

const b64 = n => Buffer.alloc(n, 120).toString("base64");

function fillWithCommitted(store, roomId, memberId) {
  const now = Date.now();
  const insert = store.db.prepare(`INSERT INTO room_attachments(
    room_id,id,uploader_id,filename,media_type,byte_length,sha256,bytes,state,created_at,expires_at,message_id
  ) VALUES(?,?,?,'f.txt','text/plain',?,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',?,'committed',?,?,'m-1')`);
  const size = attachmentLimits.fileBytes;
  const count = Math.ceil(attachmentLimits.roomBytes / size);
  const blob = Buffer.alloc(size, 120);
  store.transaction(() => {
    for (let i = 0; i < count; i += 1) {
      insert.run(roomId, i === 0 ? "full" : `full-${i}`, i === 0 ? memberId : "earlier-member", size, blob, now - 2 * 86400000, now - 86400000);
    }
  });
}

test("uploader can delete a committed file whose staging deadline passed, and the quota frees", t => {
  const { store } = serve(t);
  const owner = store.identities.create("Quota owner");
  seedHistoricalNeedsMeRoom(store,owner, { roomId: "qa-commit-del", title: "q", purpose: "q", kind: "personal", displayName: "Quota owner" });
  const roomId = "qa-commit-del";
  fillWithCommitted(store, roomId, owner.identityId);

  assert.throws(() => store.roomAttachments.stage(owner.secret, roomId, { id: "new", filename: "n.txt", mediaType: "text/plain", data: b64(10) }),
    error => error.code === "attachment_quota");

  const deleted = store.roomAttachments.discard(owner.secret, roomId, "full");
  assert.equal(deleted.status, "deleted");
  const row = store.db.prepare("SELECT state, bytes FROM room_attachments WHERE room_id=? AND id='full'").get(roomId);
  assert.equal(row.state, "deleted");
  assert.equal(row.bytes, null);

  const staged = store.roomAttachments.stage(owner.secret, roomId, { id: "new", filename: "n.txt", mediaType: "text/plain", data: b64(10) });
  assert.equal(staged.status, "staged");
  assert.equal(store.roomAttachments.discard(owner.secret, roomId, "full").duplicate, true);
});

test("a committed file whose bound message is gone stays hidden from non-uploaders, so they cannot delete it", t => {
  const { store } = serve(t);
  const owner = store.identities.create("Quota owner");
  seedHistoricalNeedsMeRoom(store,owner, { roomId: "qa-commit-del2", title: "q", purpose: "q", kind: "personal", displayName: "Quota owner" });
  const roomId = "qa-commit-del2";
  store.db.prepare(`INSERT INTO room_attachments(room_id,id,uploader_id,filename,media_type,byte_length,sha256,bytes,state,created_at,expires_at,message_id)
    VALUES(?,?,?,'f.txt','text/plain',1,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',?,'committed',0,0,'m-gone')`).run(roomId, "theirs", "someone-else", Buffer.from("x"));
  assert.throws(() => store.roomAttachments.discard(owner.secret, roomId, "theirs"), error => error.code === "attachment_not_found");
  assert.equal(store.db.prepare("SELECT state FROM room_attachments WHERE room_id=? AND id='theirs'").get(roomId).state, "committed");
});

function visibilityFixture(t, normalized = false) {
  const clock = { now: Date.now() };
  const store = new RoomStore(":memory:", { now: () => clock.now });
  t.after(() => store.close());
  store.initialize(initialRoom(),normalized?{representation:"normalized-current-v1"}:undefined);
  const keys = { owner: store.issueAccessKey("commons", "owner") };
  for (const memberId of ["uploader", "recipient", "observer"]) {
    store.command(keys.owner, "commons", { id: `add-${memberId}`, type: "member.added",
      data: { memberId, displayName: memberId, kind: "human", permissions: [] } });
    keys[memberId] = store.issueAccessKey("commons", memberId);
  }
  const files = store.roomAttachments;
  const commit = (id, toMemberId, bytes = 4) => {
    files.stage(keys.uploader, "commons", { id, filename: `${id}.txt`, mediaType: "text/plain", data: b64(bytes) });
    store.command(keys.uploader, "commons", { id: `post-${id}`, type: "message.posted",
      data: { messageId: `message-${id}`, body: "File context", ...(toMemberId ? { toMemberId } : {}) } });
    return files.commit(keys.uploader, "commons", { id, messageId: `message-${id}` });
  };
  return { store, keys, files, commit, clock };
}

test("visible public files can be deleted by uploader or owner, with stable retries and no member deletion grant", t => {
  const { store, keys, files, commit } = visibilityFixture(t);
  for (const actor of ["uploader", "owner"]) {
    const id = `public-${actor}`;
    commit(id);
    assert.equal(files.get(keys.observer, "commons", id).attachment.data, b64(4));
    assert.throws(() => files.discard(keys.observer, "commons", id), error => error.status === 403 && error.code === "attachment_forbidden");
    assert.equal(files.discard(keys[actor], "commons", id).duplicate, false);
    const after = store.db.prepare("SELECT state,bytes,message_id FROM room_attachments WHERE room_id=? AND id=?").get("commons", id);
    assert.deepEqual({ ...after }, { state: "deleted", bytes: null, message_id: `message-${id}` });
    assert.deepEqual(files.discard(keys[actor], "commons", id), { status: "deleted", duplicate: true, roomId: "commons", id });
    assert.throws(() => files.get(keys.uploader, "commons", id), error => error.status === 410 && error.code === "attachment_unavailable");
    assert.throws(() => files.discard(keys.observer, "commons", id), error => error.status === 404 && error.code === "attachment_not_found");
    assert.throws(() => files.commit(keys.uploader, "commons", { id, messageId: `message-${id}` }), error => error.status === 410 && error.code === "attachment_unavailable");
  }
});

// The existing DM tests only read committed files; they never delete the
// bytes and retry as a room owner outside the DM. Exercise the real API so
// status/receipt differences cannot reveal the hidden file's existence.
for (const operation of ["get", "discard"]) test(`hidden DM attachment ${operation} remains not-found for a nonparty owner after deletion and retries`, t => {
  const { store, keys, files, commit } = visibilityFixture(t);
  const id = "private-file";
  commit(id, "recipient");
  const assertHidden = () => {
    for (const actor of ["owner", "observer"]) {
      assert.equal(files.list(keys[actor], "commons").files.some(file => file.id === id), false);
      for (const target of [id, "not-a-file"]) {
        assert.throws(() => files[operation](keys[actor], "commons", target),
          error => error.status === 404 && error.code === "attachment_not_found", `${actor} ${operation} ${target}`);
      }
    }
  };
  assertHidden();
  assert.equal(files.get(keys.recipient, "commons", id).attachment.data, b64(4));
  assert.throws(() => files.discard(keys.recipient, "commons", id), error => error.status === 403 && error.code === "attachment_forbidden");
  assert.equal(files.discard(keys.uploader, "commons", id).duplicate, false);
  assertHidden();
  assert.equal(files.discard(keys.uploader, "commons", id).duplicate, true);
  assertHidden();
  assert.throws(() => files.get(keys.recipient, "commons", id), error => error.status === 410 && error.code === "attachment_unavailable");
  assert.equal(store.db.prepare("SELECT state FROM room_attachments WHERE room_id=? AND id=?").get("commons", id).state, "deleted");
});

// Observe actual binary SQL results, independent of SELECT spelling or
// statement count. Public replies are metadata/base64, but reading blobs just
// to drop or refuse them can exhaust a Worker before it returns that reply.
function sqlPayloadCensus(db, operation) {
  let bytes = 0;
  const observe = value => {
    if (ArrayBuffer.isView(value)) bytes += value.byteLength;
    else if (value instanceof ArrayBuffer) bytes += value.byteLength;
    else if (value && typeof value === "object") for (const child of Object.values(value)) observe(child);
    return value;
  };
  const prepare = db.prepare;
  db.prepare = (...args) => {
    const statement = prepare.apply(db, args);
    return new Proxy(statement, { get(target, key) {
      const method = Reflect.get(target, key, target);
      if (typeof method !== "function") return method;
      return (...values) => {
        const result = method.apply(target, values);
        if (key === "all" || key === "get") return observe(result);
        if (key === "iterate") return (function* () { for (const row of result) yield observe(row); })();
        return result;
      };
    } });
  };
  try { return { result: operation(), bytes }; }
  finally { db.prepare = prepare; }
}

for (const action of ["list", "delete", "download", "hidden download"]) {
  test(`attachment SQL payload census: ${action} admits only authorized requested bytes`, t => {
    const { store, keys, files, commit } = visibilityFixture(t);
    const size = attachmentLimits.fileBytes - 64;
    commit("large-public-one", null, size);
    commit("large-public-two", null, size - 1);
    commit("large-private", "recipient", size - 2);
    const operation = () => {
      if (action === "list") {
        const listed = files.list(keys.owner, "commons");
        assert.deepEqual(listed.files.map(file => file.id).sort(), ["large-public-one", "large-public-two"]);
        return listed;
      }
      if (action === "delete") return files.discard(keys.owner, "commons", "large-public-one");
      if (action === "download") return files.get(keys.observer, "commons", "large-public-two");
      assert.throws(() => files.get(keys.owner, "commons", "large-private"), error => error.status === 404 && error.code === "attachment_not_found");
    };
    const census = sqlPayloadCensus(store.db, operation);
    assert.equal(census.bytes, action === "download" ? size - 1 : 0);
    if (action === "delete") {
      assert.equal(census.result.status, "deleted");
      const retry = sqlPayloadCensus(store.db, () => files.discard(keys.owner, "commons", "large-public-one"));
      assert.equal(retry.result.duplicate, true);
      assert.equal(retry.bytes, 0);
    }
    if (action === "download") assert.equal(census.result.attachment.data, b64(size - 1));
  });
}

for (const terminal of ["discarded", "expired"]) for (const operation of ["get", "discard"]) {
  test(`unbound ${terminal} attachment ${operation} stays private to its uploader`, t => {
    const { store, keys, files, clock } = visibilityFixture(t);
    const id = "unbound-private";
    files.stage(keys.uploader, "commons", { id, filename: "private.txt", mediaType: "text/plain", data: b64(4) });
    for (const actor of ["owner", "observer"]) {
      assert.throws(() => files.get(keys[actor], "commons", id), error => error.status === 404 && error.code === "attachment_not_found");
    }
    if (terminal === "discarded") {
      // Owner administration of staged files does not grant permission to
      // learn their later terminal state or read another uploader's bytes.
      assert.equal(files.discard(keys.owner, "commons", id).status, "discarded");
    } else {
      clock.now += attachmentLimits.lifetimeMs + 1;
      assert.deepEqual(files.list(keys.uploader, "commons").files, []);
    }
    assert.equal(store.db.prepare("SELECT state FROM room_attachments WHERE room_id=? AND id=?").get("commons", id).state, terminal);
    assert.throws(() => files[operation](keys.uploader, "commons", id), error => error.status === 410 && error.code === "attachment_unavailable");
    for (const actor of ["owner", "observer"]) {
      for (const target of [id, "not-a-file"]) {
        assert.throws(() => files[operation](keys[actor], "commons", target),
          error => error.status === 404 && error.code === "attachment_not_found", `${actor} ${operation} ${target}`);
      }
    }
  });
}

for(const normalized of [false,true])test(`${normalized?"normalized":"legacy"} valid committed writers free full room byte quota after deadline`,t=>{
 const {store,keys,files,commit,clock}=visibilityFixture(t,normalized);
 if(normalized)store.room=()=>{throw Error("legacy full room hydration");};
 const size=attachmentLimits.fileBytes;
 for(const actor of ["uploader","recipient"]){
  for(let i=0;i<attachmentLimits.memberBytes/size;i++){
   const id=`${actor}-${i}`;
   files.stage(keys[actor],"commons",{id,filename:"q.txt",mediaType:"text/plain",data:b64(size)});
   store.command(keys[actor],"commons",{id:`post-${id}`,type:"message.posted",data:{messageId:`message-${id}`,body:"Quota context"}});
   files.commit(keys[actor],"commons",{id,messageId:`message-${id}`});
  }
 }
 assert.equal(store.db.prepare("SELECT sum(byte_length) n FROM room_attachments WHERE state='committed'").get().n,attachmentLimits.roomBytes);
 clock.now+=attachmentLimits.lifetimeMs+1;
 files.expire("commons",clock.now);
 assert.equal(store.db.prepare("SELECT count(*) n FROM room_attachments WHERE state='committed'").get().n,16);
 assert.throws(()=>files.stage(keys.owner,"commons",{id:"over-room",filename:"q.txt",mediaType:"text/plain",data:b64(1)}),e=>e.code==="attachment_quota"&&e.detail.quota.limit==="room_bytes");
 assert.throws(()=>files.discard(keys.observer,"commons","uploader-0"),e=>e.status===403);
 assert.equal(files.discard(keys.uploader,"commons","uploader-0").status,"deleted");
 assert.equal(files.discard(keys.uploader,"commons","uploader-0").duplicate,true);
 assert.equal(files.stage(keys.owner,"commons",{id:"after-delete",filename:"q.txt",mediaType:"text/plain",data:b64(1)}).status,"staged");
 assert.equal(files.discard(keys.owner,"commons","recipient-0").status,"deleted");
 assert.deepEqual({...store.db.prepare("SELECT state,bytes FROM room_attachments WHERE id='recipient-0'").get()},{state:"deleted",bytes:null});
 // Real private binding and terminal states must not create a missing-ID oracle.
 commit("private-terminal","recipient");
 for(const actor of ["owner","observer"])for(const id of ["private-terminal","missing"]){
  assert.throws(()=>files.get(keys[actor],"commons",id),e=>e.status===404&&e.code==="attachment_not_found");
  assert.throws(()=>files.discard(keys[actor],"commons",id),e=>e.status===404&&e.code==="attachment_not_found");
 }
 files.discard(keys.uploader,"commons","private-terminal");
 for(const actor of ["owner","observer"])assert.throws(()=>files.discard(keys[actor],"commons","private-terminal"),e=>e.status===404);
});
