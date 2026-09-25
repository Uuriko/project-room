import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { AgentRooms } from "../server/agent-rooms.mjs";
import { attachmentLimits } from "../server/attachment-schema.mjs";
import { setTier } from "../server/autonomy-tiers.mjs";
import { mcpAttachmentBodyBytes } from "../server/room-attachment-bytes.mjs";

const JOIN_TOOLS = ["room_join_packet", "room_join_kits", "room_join_prompt", "room_mcp_snippet"];
const FILE_TOOLS = ["room_put_file", "room_list_files", "room_get_file", "room_discard_file", "room_commit_file"];

function serve(t, { now = () => Date.now() } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "room-mcp-files-"));
  const store = new RoomStore(join(directory, "room.sqlite"), { now });
  const rooms = new AgentRooms(store);
  const server = createRoomServer({ store });
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => {
    t.after(async () => {
      server.closeStreams(); server.closeAllConnections();
      await new Promise(done => server.close(done));
      store.close(); rmSync(directory, { recursive: true, force: true });
    });
    resolve({ origin: `http://127.0.0.1:${server.address().port}`, store, rooms });
  }));
}

function rpc(origin, method, params, secret) {
  return fetch(`${origin}/room/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(secret ? { Authorization: `Bearer ${secret}` } : {})
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: "t", method, ...(params === undefined ? {} : { params }) })
  });
}

async function call(origin, name, args, secret) {
  const response = await rpc(origin, "tools/call", { name, arguments: args }, secret);
  const body = await response.json();
  return { status: response.status, body, value: body.result?.structuredContent };
}

test("room file tools stay behind a live identity secret", async t => {
  const { origin, store, rooms } = await serve(t);
  const owner = store.identities.create("File owner");
  const created = rooms.create(owner.secret, {
    roomId: "file-den", title: "File den", purpose: "Room file bytes", kind: "personal", displayName: "File owner"
  });
  const listed = await rpc(origin, "tools/list");
  assert.deepEqual((await listed.json()).result.tools.map(tool => tool.name), JOIN_TOOLS);
  const denied = await call(origin, "room_get_file", { roomId: created.roomId, id: "note" });
  assert.equal(denied.status, 401);
  assert.equal(denied.body.error.code, -32001);
  assert.equal(denied.body.error.data.reason, "auth_required");
  const deniedCommit = await call(origin, "room_commit_file", { roomId: created.roomId, id: "note", messageId: "msg-1" });
  assert.equal(deniedCommit.status, 401);
  assert.equal(deniedCommit.body.error.code, -32001);
  const bad = await rpc(origin, "tools/call", {
    name: "room_commit_file", arguments: { roomId: created.roomId, id: "note", messageId: "msg-1" }
  }, "pri_" + "x".repeat(43));
  assert.equal(bad.status, 401);
  const roomKey = store.issueAccessKey(created.roomId, created.ownerMemberId);
  const keyCall = await call(origin, "room_put_file", {
    roomId: created.roomId, id: "note", filename: "note.txt", mediaType: "text/plain", data: Buffer.from("nope").toString("base64")
  }, roomKey);
  assert.equal(keyCall.status, 401);
  assert.equal(keyCall.body.result, undefined);
  const keyCommit = await call(origin, "room_commit_file", { roomId: created.roomId, id: "note", messageId: "msg-1" }, roomKey);
  assert.equal(keyCommit.status, 401);
  assert.equal(keyCommit.body.result, undefined);
});

test("enrolled members upload and download room_attachments through hosted MCP", async t => {
  const { origin, store, rooms } = await serve(t);
  const owner = store.identities.create("File owner");
  const peer = store.identities.create("File peer");
  const outsider = store.identities.create("File outsider");
  const created = rooms.create(owner.secret, {
    roomId: "file-den", title: "File den", purpose: "Room file bytes", kind: "personal", displayName: "File owner"
  });
  store.identities.link(owner.secret, created.roomId, {
    identityId: peer.identityId, displayName: "File peer", permissions: []
  });
  const names = (await (await rpc(origin, "tools/list", { profile: "full" }, owner.secret)).json()).result.tools.map(tool => tool.name);
  for (const name of FILE_TOOLS) assert.equal(names.includes(name), true);
  const bytes = Buffer.from("room file bytes");
  const data = bytes.toString("base64");
  const staged = await call(origin, "room_put_file", {
    roomId: created.roomId, id: "note", filename: "note.txt", mediaType: "text/plain", data
  }, owner.secret);
  assert.equal(staged.status, 200);
  assert.equal(staged.body.error, undefined);
  assert.equal(staged.value.status, "staged");
  assert.equal(staged.value.duplicate, false);
  assert.equal(staged.value.attachment.sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.equal(staged.value.attachment.byteLength, bytes.length);
  assert.equal(staged.value.attachment.messageId, null);
  assert.equal(JSON.stringify(staged.body).includes(owner.secret), false);
  const row = store.db.prepare("SELECT state, byte_length, length(bytes) AS n FROM room_attachments WHERE room_id=? AND id=?").get(created.roomId, "note");
  assert.equal(row.state, "staged");
  assert.equal(row.byte_length, bytes.length);
  assert.equal(row.n, bytes.length);

  const again = await call(origin, "room_put_file", {
    roomId: created.roomId, id: "note", filename: "note.txt", mediaType: "text/plain", data
  }, owner.secret);
  assert.equal(again.value.duplicate, true);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM room_attachments WHERE room_id=?").get(created.roomId).n, 1);

  const conflict = await call(origin, "room_put_file", {
    roomId: created.roomId, id: "note", filename: "note.txt", mediaType: "text/plain", data: Buffer.from("other").toString("base64")
  }, owner.secret);
  assert.equal(conflict.value.code, "attachment_conflict");
  assert.equal(conflict.body.result.isError, true);

  // #983: staged files are visible only to the uploader, not to every member.
  const peerListed = await call(origin, "room_list_files", { roomId: created.roomId }, peer.secret);
  assert.equal(peerListed.value.files.length, 0);
  const ownerListed = await call(origin, "room_list_files", { roomId: created.roomId }, owner.secret);
  assert.equal(ownerListed.value.files.length, 1);
  assert.equal(ownerListed.value.files[0].id, "note");
  assert.equal("data" in ownerListed.value.files[0], false);

  const peerHidden = await call(origin, "room_get_file", { roomId: created.roomId, id: "note" }, peer.secret);
  assert.equal(peerHidden.value.status, 404);
  const downloaded = await call(origin, "room_get_file", { roomId: created.roomId, id: "note" }, owner.secret);
  assert.equal(downloaded.value.attachment.data, data);
  assert.equal(downloaded.value.attachment.encoding, "base64");
  assert.equal(Buffer.from(downloaded.value.attachment.data, "base64").toString(), "room file bytes");
  assert.equal(JSON.stringify(downloaded.body).includes(owner.secret), false);

  const hidden = await call(origin, "room_get_file", { roomId: created.roomId, id: "note" }, outsider.secret);
  assert.equal(hidden.body.result.isError, true);
  assert.equal(hidden.value.status, 401);
  assert.equal(JSON.stringify(hidden.body).includes("room file bytes"), false);

  const blocked = await call(origin, "room_put_file", {
    roomId: created.roomId, id: "run", filename: "run.exe", mediaType: "application/octet-stream", data: Buffer.from("MZ").toString("base64")
  }, owner.secret);
  assert.equal(blocked.value.code, "blocked_extension");

  const shaped = await call(origin, "room_put_file", {
    roomId: created.roomId, id: "bad", filename: "bad.txt", mediaType: "text/plain", data: "not base64!!"
  }, owner.secret);
  assert.equal(shaped.body.error.code, -32602);

  const peerDiscard = await call(origin, "room_discard_file", { roomId: created.roomId, id: "note" }, peer.secret);
  assert.equal(peerDiscard.value.code, "attachment_forbidden");
  const discarded = await call(origin, "room_discard_file", { roomId: created.roomId, id: "note" }, owner.secret);
  assert.equal(discarded.value.status, "discarded");
  const gone = await call(origin, "room_get_file", { roomId: created.roomId, id: "note" }, owner.secret);
  assert.equal(gone.value.status, 410);
  assert.equal(gone.value.code, "attachment_unavailable");
  const stored = store.db.prepare("SELECT state, bytes FROM room_attachments WHERE room_id=? AND id=?").get(created.roomId, "note");
  assert.equal(stored.state, "discarded");
  assert.equal(stored.bytes, null);
});

test("an enrolled uploader commits a staged file onto a message they posted", async t => {
  let now = 1_700_000_000_000;
  const { origin, store, rooms } = await serve(t, { now: () => now });
  const owner = store.identities.create("Commit owner");
  const peer = store.identities.create("Commit peer");
  const outsider = store.identities.create("Commit outsider");
  const created = rooms.create(owner.secret, {
    roomId: "commit-den", title: "Commit den", purpose: "Commit a staged file", kind: "personal", displayName: "Commit owner"
  });
  store.identities.link(owner.secret, created.roomId, {
    identityId: peer.identityId, displayName: "Commit peer", permissions: []
  });
  // #953: new agent members default to t1_readonly; peer needs write access for message.posted
  setTier(store.db, created.roomId, peer.identityId, "t2_standard", { updatedBy: "owner", nowMs: Date.now() });
  const names = (await (await rpc(origin, "tools/list", undefined, owner.secret)).json()).result.tools.map(tool => tool.name);
  assert.equal(names.includes("room_commit_file"), true);
  const posted = await call(origin, "room_post_message", {
    roomId: created.roomId, id: "chat-1", messageId: "msg-1", body: "file lands here"
  }, owner.secret);
  assert.equal(posted.value.status, "posted");
  const peerPosted = await call(origin, "room_post_message", {
    roomId: created.roomId, id: "chat-peer", messageId: "msg-peer", body: "peer chat"
  }, peer.secret);
  assert.equal(peerPosted.value.status, "posted");
  const bytes = Buffer.from("committed room file");
  const data = bytes.toString("base64");
  const staged = await call(origin, "room_put_file", {
    roomId: created.roomId, id: "note", filename: "note.txt", mediaType: "text/plain", data
  }, owner.secret);
  assert.equal(staged.value.status, "staged");
  assert.equal(staged.value.attachment.messageId, null);
  const before = store.room(created.roomId).state.messages.length;

  const shaped = await call(origin, "room_commit_file", { roomId: created.roomId, id: "note" }, owner.secret);
  assert.equal(shaped.body.error.code, -32602);
  const missingFile = await call(origin, "room_commit_file", {
    roomId: created.roomId, id: "missing", messageId: "msg-1"
  }, owner.secret);
  assert.equal(missingFile.value.status, 404);
  assert.equal(missingFile.value.code, "attachment_not_found");
  const missingMessage = await call(origin, "room_commit_file", {
    roomId: created.roomId, id: "note", messageId: "missing-msg"
  }, owner.secret);
  assert.equal(missingMessage.value.status, 404);
  assert.equal(missingMessage.value.code, "message_not_found");
  const peerCommit = await call(origin, "room_commit_file", {
    roomId: created.roomId, id: "note", messageId: "msg-peer"
  }, peer.secret);
  assert.equal(peerCommit.value.status, 403);
  assert.equal(peerCommit.value.code, "attachment_forbidden");
  const peerStaged = await call(origin, "room_put_file", {
    roomId: created.roomId, id: "peer-note", filename: "peer.txt", mediaType: "text/plain", data
  }, peer.secret);
  assert.equal(peerStaged.value.status, "staged");
  const ownerTakes = await call(origin, "room_commit_file", {
    roomId: created.roomId, id: "peer-note", messageId: "msg-1"
  }, owner.secret);
  assert.equal(ownerTakes.value.status, 403);
  assert.equal(ownerTakes.value.code, "attachment_forbidden");
  assert.equal(store.db.prepare("SELECT state, message_id FROM room_attachments WHERE room_id=? AND id=?").get(created.roomId, "peer-note").state, "staged");
  const ontoPeer = await call(origin, "room_commit_file", {
    roomId: created.roomId, id: "note", messageId: "msg-peer"
  }, owner.secret);
  assert.equal(ontoPeer.value.status, 403);
  assert.equal(ontoPeer.value.code, "attachment_forbidden");
  const hidden = await call(origin, "room_commit_file", {
    roomId: created.roomId, id: "note", messageId: "msg-1"
  }, outsider.secret);
  assert.equal(hidden.value.status, 401);
  assert.equal(JSON.stringify(hidden.body).includes(owner.secret), false);

  const committed = await call(origin, "room_commit_file", {
    roomId: created.roomId, id: "note", messageId: "msg-1"
  }, owner.secret);
  assert.equal(committed.status, 200);
  assert.equal(committed.body.error, undefined);
  assert.equal(committed.value.status, "committed");
  assert.equal(committed.value.duplicate, false);
  assert.equal(committed.value.attachment.state, "committed");
  assert.equal(committed.value.attachment.messageId, "msg-1");
  assert.equal(committed.value.attachment.sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.equal(JSON.stringify(committed.body).includes(owner.secret), false);
  assert.equal(store.room(created.roomId).state.messages.length, before);
  const row = store.db.prepare("SELECT state, message_id, length(bytes) AS n FROM room_attachments WHERE room_id=? AND id=?").get(created.roomId, "note");
  assert.equal(row.state, "committed");
  assert.equal(row.message_id, "msg-1");
  assert.equal(row.n, bytes.length);

  const again = await call(origin, "room_commit_file", {
    roomId: created.roomId, id: "note", messageId: "msg-1"
  }, owner.secret);
  assert.equal(again.value.duplicate, true);
  assert.equal(again.value.attachment.state, "committed");
  const other = await call(origin, "room_post_message", {
    roomId: created.roomId, id: "chat-2", messageId: "msg-2", body: "second post"
  }, owner.secret);
  assert.equal(other.value.status, "posted");
  const moved = await call(origin, "room_commit_file", {
    roomId: created.roomId, id: "note", messageId: "msg-2"
  }, owner.secret);
  assert.equal(moved.value.code, "attachment_conflict");
  assert.equal(store.db.prepare("SELECT message_id FROM room_attachments WHERE room_id=? AND id=?").get(created.roomId, "note").message_id, "msg-1");

  const listed = await call(origin, "room_list_files", { roomId: created.roomId }, peer.secret);
  const listedNote = listed.value.files.find(file => file.id === "note");
  assert.equal(listedNote.state, "committed");
  assert.equal(listedNote.messageId, "msg-1");
  assert.equal("data" in listedNote, false);
  const downloaded = await call(origin, "room_get_file", { roomId: created.roomId, id: "note" }, peer.secret);
  assert.equal(downloaded.value.attachment.data, data);
  const discarded = await call(origin, "room_discard_file", { roomId: created.roomId, id: "note" }, owner.secret);
  assert.equal(discarded.value.code, "attachment_unavailable");

  now += attachmentLimits.lifetimeMs + 1;
  const still = await call(origin, "room_get_file", { roomId: created.roomId, id: "note" }, owner.secret);
  assert.equal(still.value.attachment.state, "committed");
  assert.equal(still.value.attachment.data, data);

  const second = await call(origin, "room_put_file", {
    roomId: created.roomId, id: "drop", filename: "drop.txt", mediaType: "text/plain", data
  }, owner.secret);
  assert.equal(second.value.status, "staged");
  const dropped = await call(origin, "room_discard_file", { roomId: created.roomId, id: "drop" }, owner.secret);
  assert.equal(dropped.value.status, "discarded");
  const afterDrop = await call(origin, "room_commit_file", {
    roomId: created.roomId, id: "drop", messageId: "msg-1"
  }, owner.secret);
  assert.equal(afterDrop.value.status, 410);
  assert.equal(afterDrop.value.code, "attachment_unavailable");

  const aging = await call(origin, "room_put_file", {
    roomId: created.roomId, id: "aging", filename: "aging.txt", mediaType: "text/plain", data
  }, owner.secret);
  assert.equal(aging.value.status, "staged");
  now += attachmentLimits.lifetimeMs + 1;
  const expired = await call(origin, "room_commit_file", {
    roomId: created.roomId, id: "aging", messageId: "msg-1"
  }, owner.secret);
  assert.equal(expired.value.status, 410);
  assert.equal(expired.value.code, "attachment_unavailable");
  const listedExpired = await call(origin, "room_list_files", { roomId: created.roomId }, owner.secret);
  assert.equal(listedExpired.value.files.some(file => file.id === "aging"), false);
  const expiredRow = store.db.prepare("SELECT state, message_id, bytes FROM room_attachments WHERE room_id=? AND id=?").get(created.roomId, "aging");
  assert.equal(expiredRow.state, "expired");
  assert.equal(expiredRow.message_id, null);
  assert.equal(expiredRow.bytes, null);

  const removed = await call(origin, "room_post_message", {
    roomId: created.roomId, id: "chat-gone", messageId: "msg-gone", body: "will delete"
  }, owner.secret);
  assert.equal(removed.value.status, "posted");
  store.command(owner.secret, created.roomId, {
    id: "del-gone", type: "message.deleted",
    data: { messageId: "msg-gone", expectedMessageRevision: 0, reason: "removed" }
  });
  const late = await call(origin, "room_put_file", {
    roomId: created.roomId, id: "late", filename: "late.txt", mediaType: "text/plain", data
  }, owner.secret);
  assert.equal(late.value.status, "staged");
  const ontoDeleted = await call(origin, "room_commit_file", {
    roomId: created.roomId, id: "late", messageId: "msg-gone"
  }, owner.secret);
  assert.equal(ontoDeleted.value.status, 404);
  assert.equal(ontoDeleted.value.code, "message_not_found");
  assert.equal(store.db.prepare("SELECT state, message_id FROM room_attachments WHERE room_id=? AND id=?").get(created.roomId, "late").state, "staged");
});

test("a pri_ bearer can stage a file larger than the join body cap", async t => {
  const { origin, store, rooms } = await serve(t);
  const owner = store.identities.create("File owner");
  const created = rooms.create(owner.secret, {
    roomId: "file-den", title: "File den", purpose: "Room file bytes", kind: "personal", displayName: "File owner"
  });
  const payload = Buffer.alloc(20000, 0x61);
  const body = JSON.stringify({
    jsonrpc: "2.0", id: "big", method: "tools/call",
    params: { name: "room_put_file", arguments: {
      roomId: created.roomId, id: "wide", filename: "wide.txt", mediaType: "text/plain", data: payload.toString("base64")
    } }
  });
  assert.ok(Buffer.byteLength(body) > 16384);
  assert.ok(Buffer.byteLength(body) < mcpAttachmentBodyBytes);
  const open = await fetch(`${origin}/room/mcp`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body
  });
  assert.equal(open.status, 413);
  const accepted = await fetch(`${origin}/room/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${owner.secret}` },
    body
  });
  assert.equal(accepted.status, 200);
  const acceptedBody = await accepted.json();
  assert.equal(acceptedBody.result.structuredContent.attachment.byteLength, payload.length);
  const fake = "Bearer pri_" + "x".repeat(43);
  const oversized = "x".repeat(mcpAttachmentBodyBytes + 1);
  const refused = await fetch(`${origin}/room/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: fake, "Content-Length": String(Buffer.byteLength(oversized)) },
    body: oversized
  });
  assert.equal(refused.status, 413);
});

test("staged files expire and a member cannot exceed the staged-file cap", t => {
  let now = 1_700_000_000_000;
  const directory = mkdtempSync(join(tmpdir(), "room-attachment-bytes-"));
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => now });
  const rooms = new AgentRooms(store);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const owner = store.identities.create("Cap owner");
  const created = rooms.create(owner.secret, {
    roomId: "cap-den", title: "Cap den", purpose: "Caps", kind: "personal", displayName: "Cap owner"
  });
  const data = Buffer.from("x").toString("base64");
  for (let i = 0; i < attachmentLimits.stagedPerMember; i++) {
    const staged = store.roomAttachments.stage(owner.secret, created.roomId, {
      id: `f${i}`, filename: "n.txt", mediaType: "text/plain", data
    });
    assert.equal(staged.duplicate, false);
  }
  assert.throws(() => store.roomAttachments.stage(owner.secret, created.roomId, {
    id: "overflow", filename: "n.txt", mediaType: "text/plain", data
  }), error => error.status === 409 && error.code === "attachment_quota");
  now += attachmentLimits.lifetimeMs + 1;
  assert.throws(() => store.roomAttachments.get(owner.secret, created.roomId, "f0"),
    error => error.status === 410 && error.code === "attachment_unavailable");
  const after = store.roomAttachments.list(owner.secret, created.roomId);
  assert.deepEqual(after.files, []);
  const expired = store.db.prepare("SELECT state, bytes FROM room_attachments WHERE room_id=? AND id=?").get(created.roomId, "f0");
  assert.equal(expired.state, "expired");
  assert.equal(expired.bytes, null);
});

test("staged files stay with the uploader; DM-committed files stay with the DM pair (#983)", async t => {
  const { origin, store, rooms } = await serve(t);
  const owner = store.identities.create("Scope owner");
  const peer = store.identities.create("Scope peer");
  const third = store.identities.create("Scope third");
  const created = rooms.create(owner.secret, {
    roomId: "scope-den", title: "Scope den", purpose: "File visibility scope", kind: "personal", displayName: "Scope owner"
  });
  for (const ident of [peer, third]) {
    store.identities.link(owner.secret, created.roomId, {
      identityId: ident.identityId, displayName: "Scope member", permissions: []
    });
    // #953: new agent members default to t1_readonly; members need write access for message.posted
    setTier(store.db, created.roomId, ident.identityId, "t2_standard", { updatedBy: "owner", nowMs: Date.now() });
  }
  const pub = await call(origin, "room_post_message", {
    roomId: created.roomId, id: "post-pub", messageId: "msg-pub", body: "public file here"
  }, owner.secret);
  assert.equal(pub.value.status, "posted");
  // room_post_message has no toMemberId param; post the DM through the command path.
  store.command(owner.secret, created.roomId, {
    id: "post-dm", type: "message.posted",
    data: { messageId: "msg-dm", body: "dm file here", toMemberId: peer.identityId }
  });
  const data = label => Buffer.from(`bytes:${label}`).toString("base64");
  for (const [id, label] of [["staged-note", "staged"], ["pub-note", "public"], ["dm-note", "dm"]]) {
    const staged = await call(origin, "room_put_file", {
      roomId: created.roomId, id, filename: `${id}.txt`, mediaType: "text/plain", data: data(label)
    }, owner.secret);
    assert.equal(staged.value.status, "staged");
  }
  for (const [id, messageId] of [["pub-note", "msg-pub"], ["dm-note", "msg-dm"]]) {
    const committed = await call(origin, "room_commit_file", { roomId: created.roomId, id, messageId }, owner.secret);
    assert.equal(committed.value.status, "committed");
  }

  const ids = files => files.map(f => f.id).sort();
  const ownerList = await call(origin, "room_list_files", { roomId: created.roomId }, owner.secret);
  assert.deepEqual(ids(ownerList.value.files), ["dm-note", "pub-note", "staged-note"]);
  const peerList = await call(origin, "room_list_files", { roomId: created.roomId }, peer.secret);
  assert.deepEqual(ids(peerList.value.files), ["dm-note", "pub-note"],
    "the DM recipient sees the DM file and the public file, but not the staged upload");
  const thirdList = await call(origin, "room_list_files", { roomId: created.roomId }, third.secret);
  assert.deepEqual(ids(thirdList.value.files), ["pub-note"],
    "a member outside the DM sees only the public file");

  const getAs = (secret, id) => call(origin, "room_get_file", { roomId: created.roomId, id }, secret);
  const peerDm = await getAs(peer.secret, "dm-note");
  assert.equal(peerDm.value.attachment.data, data("dm"), "DM recipient can download the DM file");
  const thirdDm = await getAs(third.secret, "dm-note");
  assert.equal(thirdDm.value.status, 404, "DM file is not found for a non-party (no existence leak)");
  assert.equal(thirdDm.body.result.isError, true);
  for (const secret of [peer.secret, third.secret]) {
    const staged = await getAs(secret, "staged-note");
    assert.equal(staged.value.status, 404, "staged upload is not found for a non-uploader");
  }
  const ownerStaged = await getAs(owner.secret, "staged-note");
  assert.equal(ownerStaged.value.attachment.data, data("staged"), "uploader can still download their staged file");
  const thirdPub = await getAs(third.secret, "pub-note");
  assert.equal(thirdPub.value.attachment.data, data("public"), "public file stays downloadable room-wide");
});
