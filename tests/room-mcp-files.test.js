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
import { mcpAttachmentBodyBytes } from "../server/room-attachment-bytes.mjs";

const JOIN_TOOLS = ["room_join_packet", "room_join_kits", "room_join_prompt", "room_mcp_snippet"];
const FILE_TOOLS = ["room_put_file", "room_list_files", "room_get_file", "room_discard_file"];

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
  assert.equal(denied.status, 200);
  assert.equal(denied.body.error.code, -32602);
  const bad = await rpc(origin, "tools/list", undefined, "pri_" + "x".repeat(43));
  assert.equal(bad.status, 401);
  const roomKey = store.issueAccessKey(created.roomId, created.ownerMemberId);
  const keyCall = await call(origin, "room_put_file", {
    roomId: created.roomId, id: "note", filename: "note.txt", mediaType: "text/plain", data: Buffer.from("nope").toString("base64")
  }, roomKey);
  assert.equal(keyCall.status, 401);
  assert.equal(keyCall.body.result, undefined);
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
  const names = (await (await rpc(origin, "tools/list", undefined, owner.secret)).json()).result.tools.map(tool => tool.name);
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

  const listedFiles = await call(origin, "room_list_files", { roomId: created.roomId }, peer.secret);
  assert.equal(listedFiles.value.files.length, 1);
  assert.equal(listedFiles.value.files[0].id, "note");
  assert.equal("data" in listedFiles.value.files[0], false);

  const downloaded = await call(origin, "room_get_file", { roomId: created.roomId, id: "note" }, peer.secret);
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
