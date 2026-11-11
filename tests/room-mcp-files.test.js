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
import { issueSpendGrant } from "../server/spend-grants.mjs";
import { mcpAttachmentBodyBytes } from "../server/room-attachment-bytes.mjs";
import { linkWithProof } from "./helpers/link-with-proof.mjs";
import {seedHistoricalNeedsMeRoom} from "./helpers/historical-needs-me-room.mjs";

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
    resolve({ origin: `http://127.0.0.1:${server.address().port}`, store, rooms, server });
  }));
}

function rpc(origin, method, params, secret, {dropAck=false}={}) {
  return fetch(`${origin}/room/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(dropAck ? {"x-fixture-drop-ack":"1"} : {}),
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
  assert.deepEqual((await listed.json()).result.tools.map(tool => tool.name), [...JOIN_TOOLS, "public_work_recommend", "public_work_read_task", "room_identity_mint", "room_check_access"]);
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
  linkWithProof(store, owner.secret, created.roomId, peer, { displayName: "File peer", permissions: [] });
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
  const unselected = await call(origin, "room_list_files", { roomId: created.roomId }, owner.secret);
  assert.equal(unselected.value.code, "attachment_selection_required", "normalized inventory requires a real selected conversation");
  store.command(owner.secret,created.roomId,{id:"file-list-message",type:"message.posted",data:{messageId:"file-list-message",body:"Files can be committed here"}});
  const peerListed = await call(origin, "room_list_files", { roomId: created.roomId, messageIds:["file-list-message"] }, peer.secret);
  assert.deepEqual(peerListed.value.files, []);
  const ownerListed = await call(origin, "room_list_files", { roomId: created.roomId, messageIds:["file-list-message"] }, owner.secret);
  assert.deepEqual(ownerListed.value.files, [], "a selected committed-file list does not claim to inventory unbound staging");
  assert.equal(ownerListed.value.coverage.kind,"selected-messages");assert.equal(ownerListed.value.coverage.complete,true);

  const peerHidden = await call(origin, "room_get_file", { roomId: created.roomId, id: "note" }, peer.secret);
  assert.equal(peerHidden.value.status, 404);
  const downloaded = await call(origin, "room_get_file", { roomId: created.roomId, id: "note" }, owner.secret);
  assert.equal(downloaded.value.attachment.data, data);
  assert.equal(downloaded.value.attachment.encoding, "base64");
  assert.equal(Buffer.from(downloaded.value.attachment.data, "base64").toString(), "room file bytes");
  assert.equal(JSON.stringify(downloaded.body).includes(owner.secret), false);

  const hidden = await call(origin, "room_get_file", { roomId: created.roomId, id: "note" }, outsider.secret);
  assert.equal(hidden.body.result.isError, true);
  assert.equal(hidden.value.status, 403);
  // Hosted MCP remaps a non-member identity to not_member with a pair hint
  // (mcp-room-profile.mjs notMemberPair, f3a63d62); no_access is the
  // store/HTTP-layer code for the same refusal.
  assert.equal(hidden.value.code, "not_member");
  assert.equal(hidden.value.next.action, "pair");
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
  linkWithProof(store, owner.secret, created.roomId, peer, { displayName: "Commit peer", permissions: [] });
  // #953: new agent members default to t1_readonly; peer needs write access for message.posted
  setTier(store.db, created.roomId, peer.identityId, "t2_standard", { updatedBy: "owner", nowMs: Date.now() });
  // Spend-primitive MVP: room_put_file is priced (5 credits); the peer holds
  // a grant so this file flow exercises the paid path.
  issueSpendGrant(store.db, created.roomId, peer.identityId, {
    grantedBy: created.ownerMemberId ?? owner.identityId, capCents: "100000", perTxCapCents: "10000", nowMs: Date.now(),
  });
  const names = (await (await rpc(origin, "tools/list", { profile: "full" }, owner.secret)).json()).result.tools.map(tool => tool.name);
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
  const before = store.db.prepare("SELECT count(*) AS n FROM messages WHERE room_id=?").get(created.roomId).n;

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
  assert.equal(hidden.value.status, 403);
  assert.equal(hidden.value.code, "not_member");
  assert.equal(hidden.value.next.action, "pair");
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
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM messages WHERE room_id=?").get(created.roomId).n, before);
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

  const listed = await call(origin, "room_list_files", { roomId: created.roomId, messageIds:["msg-1"] }, peer.secret);
  const listedNote = listed.value.files.find(file => file.id === "note");
  assert.equal(listedNote.state, "committed");
  assert.equal(listedNote.messageId, "msg-1");
  assert.equal("data" in listedNote, false);
  const downloaded = await call(origin, "room_get_file", { roomId: created.roomId, id: "note" }, peer.secret);
  assert.equal(downloaded.value.attachment.data, data);
  now += attachmentLimits.lifetimeMs + 1;
  const still = await call(origin, "room_get_file", { roomId: created.roomId, id: "note" }, owner.secret);
  assert.equal(still.value.attachment.state, "committed");
  assert.equal(still.value.attachment.data, data);
  const discarded = await call(origin, "room_discard_file", { roomId: created.roomId, id: "note" }, owner.secret);
  assert.equal(discarded.value.status, "deleted");
  assert.equal(discarded.value.duplicate, false);
  const retryDelete = await call(origin, "room_discard_file", { roomId: created.roomId, id: "note" }, owner.secret);
  assert.equal(retryDelete.value.duplicate, true);
  const unavailable = await call(origin, "room_get_file", { roomId: created.roomId, id: "note" }, owner.secret);
  assert.equal(unavailable.value.status, 410);
  assert.equal(unavailable.value.code, "attachment_unavailable");

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
  const listedExpired = await call(origin, "room_list_files", { roomId: created.roomId, messageIds:["msg-1"] }, owner.secret);
  assert.equal(listedExpired.value.files.some(file => file.id === "aging"), false);
  // Read-only selected listing does not perform a roomwide expiry sweep.
  // The next successful staging transaction performs the existing cleanup.
  const cleanup=await call(origin,"room_put_file",{roomId:created.roomId,id:"expiry-cleanup",filename:"cleanup.txt",mediaType:"text/plain",data},owner.secret);
  assert.equal(cleanup.value.status,"staged");
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
  store.command(owner.secret,created.roomId,{id:"expiry-list-message",type:"message.posted",data:{messageId:"expiry-list-message",body:"Expired staging is not a committed file"}});
  const after = store.roomAttachments.list(owner.secret, created.roomId,{messageIds:["expiry-list-message"]});
  assert.deepEqual(after.files, []);assert.equal(after.coverage.complete,true);
  const renewed=store.roomAttachments.stage(owner.secret,created.roomId,{id:"after-expiry",filename:"n.txt",mediaType:"text/plain",data});
  assert.equal(renewed.status,"staged","a successful staging transaction reclaims expired quota and bytes");
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
    linkWithProof(store, owner.secret, created.roomId, ident, { displayName: ident.displayName, permissions: [] });
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
  const ownerList = await call(origin, "room_list_files", { roomId: created.roomId,messageIds:["msg-pub","msg-dm"] }, owner.secret);
  assert.deepEqual(ids(ownerList.value.files), ["dm-note", "pub-note"], "staging remains accessible only through the saved upload id/receipt");
  const peerList = await call(origin, "room_list_files", { roomId: created.roomId,messageIds:["msg-pub","msg-dm"] }, peer.secret);
  assert.deepEqual(ids(peerList.value.files), ["dm-note", "pub-note"],
    "the DM recipient sees the DM file and the public file, but not the staged upload");
  const deniedSelection=await call(origin,"room_list_files",{roomId:created.roomId,messageIds:["msg-pub","msg-dm"]},third.secret);assert.equal(deniedSelection.value.status,404);assert.equal(deniedSelection.value.files,undefined);
  const thirdList = await call(origin, "room_list_files", { roomId: created.roomId,messageIds:["msg-pub"] }, third.secret);
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

test("[legacy compatibility] a committed DM file whose message is missing from the projection is not room-visible (#2950)", async t => {
  const { origin, store } = await serve(t);
  const owner = store.identities.create("Orphan owner");
  const peer = store.identities.create("Orphan peer");
  const third = store.identities.create("Orphan third");
  seedHistoricalNeedsMeRoom(store,owner,{roomId:"orphan-den",title:"Historical orphan fixture",purpose:"Legacy history replacement and attachment privacy"});
  const created={roomId:"orphan-den"};
  for (const ident of [peer, third]) {
    linkWithProof(store, owner.secret, created.roomId, ident, { displayName: ident.displayName, permissions: [] });
    setTier(store.db, created.roomId, ident.identityId, "t2_standard", { updatedBy: "owner", nowMs: Date.now() });
  }
  store.command(owner.secret, created.roomId, {
    id: "post-dm-orphan", type: "message.posted",
    data: { messageId: "msg-dm-orphan", body: "dm file here", toMemberId: peer.identityId }
  });
  const data = Buffer.from("bytes:orphan-dm").toString("base64");
  const staged = await call(origin, "room_put_file", {
    roomId: created.roomId, id: "orphan-note", filename: "orphan-note.txt", mediaType: "text/plain", data
  }, owner.secret);
  assert.equal(staged.value.status, "staged");
  const committed = await call(origin, "room_commit_file", {
    roomId: created.roomId, id: "orphan-note", messageId: "msg-dm-orphan"
  }, owner.secret);
  assert.equal(committed.value.status, "committed");

  // Sanity: while the DM message is in the projection, the recipient can
  // download the file and a non-party cannot.
  const peerBefore = await call(origin, "room_get_file", { roomId: created.roomId, id: "orphan-note" }, peer.secret);
  assert.equal(peerBefore.value.attachment.data, data);

  // Simulate the history replacement named in #2950: export the room,
  // drop the DM post, and re-import. The attachment row survives (still
  // committed to msg-dm-orphan) but the message no longer resolves in
  // state.messages.
  const exported = [...store.exportEvents(owner.secret, created.roomId)];
  assert.equal(exported.some(line => line.event.data?.messageId === "msg-dm-orphan"), true);
  const replacement = exported
    .filter(line => line.event.data?.messageId !== "msg-dm-orphan")
    .map((line, index) => ({ sequence: index + 1, event: line.event }));
  store.importEvents(owner.secret, created.roomId, replacement);
  assert.equal(store.room(created.roomId).state.messages.some(entry => entry.id === "msg-dm-orphan"), false);
  const row = store.db.prepare("SELECT state, message_id FROM room_attachments WHERE room_id=? AND id=?").get(created.roomId, "orphan-note");
  assert.equal(row.state, "committed");
  assert.equal(row.message_id, "msg-dm-orphan");

  // Fail closed: without the message we cannot prove who the DM parties
  // were, so nobody but the uploader (the proven message author, enforced
  // by commit()) may see or download the file.
  for (const [label, secret] of [["DM recipient", peer.secret], ["non-party", third.secret]]) {
    const listed = await call(origin, "room_list_files", { roomId: created.roomId }, secret);
    assert.equal(listed.value.files.some(file => file.id === "orphan-note"), false,
      `${label} must not list a committed file whose message is missing`);
    const got = await call(origin, "room_get_file", { roomId: created.roomId, id: "orphan-note" }, secret);
    assert.equal(got.value.status, 404, `${label} must not download a committed file whose message is missing`);
    assert.equal(got.body.result.isError, true);
  }
  const ownerList = await call(origin, "room_list_files", { roomId: created.roomId }, owner.secret);
  assert.equal(ownerList.value.files.some(file => file.id === "orphan-note"), true,
    "the uploader retains access to their own committed file");
  const ownerGot = await call(origin, "room_get_file", { roomId: created.roomId, id: "orphan-note" }, owner.secret);
  assert.equal(ownerGot.value.attachment.data, data, "the uploader can still download their own committed file");
});

test('hosted normalized file listing exposes and forwards exact selected-message continuation',async t=>{
 const {origin,store,rooms}=await serve(t),owner=store.identities.create('Selected file owner'),peer=store.identities.create('Selected file peer');
 const created=rooms.create(owner.secret,{roomId:'selected-files',title:'Selected files',purpose:'Bounded file discovery',starter:false});linkWithProof(store,owner.secret,created.roomId,peer,{permissions:[]});
 const listing=await(await rpc(origin,'tools/list',{profile:'full'},owner.secret)).json(),tool=listing.result.tools.find(x=>x.name==='room_list_files');
 assert.equal(tool.inputSchema.properties.messageIds.type,'array');assert.equal(tool.inputSchema.properties.messageIds.maxItems,8);assert.equal(tool.inputSchema.properties.cursor.maxLength,4096);
 const posted=await call(origin,'room_post_message',{roomId:created.roomId,id:'selected-post',messageId:'selected-message',body:'Saved files belong here'},owner.secret);assert.equal(posted.value.status,'posted');store.command(owner.secret,created.roomId,{id:'selected-alt',type:'message.posted',data:{messageId:'selected-alt',body:'Another visible selection'}});
 for(let i=0;i<9;i++){
  const staged=await call(origin,'room_put_file',{roomId:created.roomId,id:'selected-'+i,filename:'note.txt',mediaType:'text/plain',data:Buffer.from('Useful '+i).toString('base64')},owner.secret);assert.equal(staged.value.status,'staged');
  const committed=await call(origin,'room_commit_file',{roomId:created.roomId,id:'selected-'+i,messageId:'selected-message'},owner.secret);assert.equal(committed.value.status,'committed');
 }
 const first=await call(origin,'room_list_files',{roomId:created.roomId,messageIds:['selected-message']},owner.secret);assert.equal(first.body.result.isError,undefined);assert.equal(first.value.contractVersion,2);assert.equal(first.value.files.length,8);assert.equal(first.value.coverage.complete,false);assert.equal(first.value.page.hasMore,true);
 const foreign=await call(origin,'room_list_files',{roomId:created.roomId,messageIds:['selected-message'],cursor:first.value.page.nextCursor},peer.secret);assert.equal(foreign.value.status,409);
 const changed=await call(origin,'room_list_files',{roomId:created.roomId,messageIds:['selected-message','selected-alt'],cursor:first.value.page.nextCursor},owner.secret);assert.equal(changed.value.status,409);
 const next=await call(origin,'room_list_files',{roomId:created.roomId,messageIds:['selected-message'],cursor:first.value.page.nextCursor},owner.secret);assert.equal(next.value.page.hasMore,false);assert.equal(next.value.files.length,1);assert.equal(new Set([...first.value.files,...next.value.files].map(x=>x.id)).size,9);
 const read=await call(origin,'room_get_file',{roomId:created.roomId,id:next.value.files[0].id},owner.secret);assert.equal(Buffer.from(read.value.attachment.data,'base64').toString(),'Useful 8');
 for(let i=0;i<8;i++)assert.equal((await call(origin,'room_discard_file',{roomId:created.roomId,id:'selected-'+i},owner.secret)).value.status,'deleted');
 const empty=await call(origin,'room_list_files',{roomId:created.roomId,messageIds:['selected-message']},owner.secret);assert.deepEqual(empty.value.files,[]);assert.equal(empty.value.page.hasMore,true);assert.equal(empty.value.coverage.complete,false);
 const remaining=await call(origin,'room_list_files',{roomId:created.roomId,messageIds:['selected-message'],cursor:empty.value.page.nextCursor},owner.secret);assert.deepEqual(remaining.value.files.map(x=>x.id),['selected-8']);assert.equal(remaining.value.page.hasMore,false);
 for(const selection of [[],['selected-message','selected-message'],Array.from({length:9},(_,i)=>'m'+i),[42]]){const bad=await call(origin,'room_list_files',{roomId:created.roomId,messageIds:selection},owner.secret);assert.equal(bad.body.error?.code,-32602);}
});

test('hosted file stage and commit survive lost responses and reject interrupted saves atomically',async t=>{
 const {origin,store,rooms,server}=await serve(t),owner=store.identities.create('Durable file owner');
 const created=rooms.create(owner.secret,{roomId:'durable-files',title:'Durable files',purpose:'Keep exact file operation identity',starter:false});
 let dropped=0;server.on('request',(req,res)=>{if(req.headers['x-fixture-drop-ack']==='1'){res.end=()=>{dropped++;req.socket.destroy();return res;};}});
 const stage={roomId:created.roomId,id:'saved-file',filename:'saved.txt',mediaType:'text/plain',data:Buffer.from('Useful durable bytes').toString('base64')};
 await assert.rejects(rpc(origin,'tools/call',{name:'room_put_file',arguments:stage},owner.secret,{dropAck:true}));
 assert.equal(dropped,1);assert.equal(store.db.prepare('SELECT count(*) n FROM room_attachments WHERE room_id=?').get(created.roomId).n,1);
 const retryStage=await call(origin,'room_put_file',stage,owner.secret);assert.equal(retryStage.value.duplicate,true);
 const posted=await call(origin,'room_post_message',{roomId:created.roomId,id:'durable-post',messageId:'durable-message',body:'Saved attachment pointer'},owner.secret);assert.equal(posted.value.status,'posted');
 const commit={roomId:created.roomId,id:'saved-file',messageId:'durable-message'},write=store.roomAttachments.write.bind(store.roomAttachments);
 store.roomAttachments.write=(roomId,operation)=>write(roomId,()=>{operation();throw Error('Injected attachment save fault');});
 try{const refused=await call(origin,'room_commit_file',commit,owner.secret);assert.equal(refused.body.result.isError,true);assert.equal(refused.value.status,500);}finally{store.roomAttachments.write=write;}
 const rolledBack=store.db.prepare('SELECT state,message_id FROM room_attachments WHERE room_id=? AND id=?').get(created.roomId,'saved-file');assert.deepEqual({...rolledBack},{state:'staged',message_id:null});
 await assert.rejects(rpc(origin,'tools/call',{name:'room_commit_file',arguments:commit},owner.secret,{dropAck:true}));assert.equal(dropped,2);
 const retry=await call(origin,'room_commit_file',commit,owner.secret);assert.equal(retry.value.duplicate,true);assert.equal(retry.value.attachment.messageId,'durable-message');
 const listed=await call(origin,'room_list_files',{roomId:created.roomId,messageIds:['durable-message']},owner.secret);assert.deepEqual(listed.value.files.map(x=>x.id),['saved-file']);
 const read=await call(origin,'room_get_file',{roomId:created.roomId,id:'saved-file'},owner.secret);assert.equal(read.value.attachment.data,stage.data);
 assert.deepEqual({...store.db.prepare('SELECT enabled,room_id,receipt_id FROM current_room_writer_permit').get()},{enabled:0,room_id:null,receipt_id:null});
});

test('normalized hosted file reads fail closed if a committed message loses its independent membership source',async t=>{
 const {origin,store,rooms}=await serve(t),owner=store.identities.create('Protected file owner'),peer=store.identities.create('Protected file peer');
 const created=rooms.create(owner.secret,{roomId:'protected-files',title:'Protected files',purpose:'No orphan fallback',starter:false});linkWithProof(store,owner.secret,created.roomId,peer,{permissions:[]});
 const posted=await call(origin,'room_post_message',{roomId:created.roomId,id:'protected-post',messageId:'protected-message',body:'Committed file message'},owner.secret);assert.equal(posted.value.status,'posted');
 const stage=await call(origin,'room_put_file',{roomId:created.roomId,id:'protected-file',filename:'protected.txt',mediaType:'text/plain',data:Buffer.from('PROTECTED_FILE_SENTINEL').toString('base64')},owner.secret);assert.equal(stage.value.status,'staged');
 assert.equal((await call(origin,'room_commit_file',{roomId:created.roomId,id:'protected-file',messageId:'protected-message'},owner.secret)).value.status,'committed');
 const {withCurrentRoomWriter}=await import('../server/current-room-repository.mjs');store.transaction(()=>withCurrentRoomWriter(store.db,created.roomId,()=>store.db.prepare('DELETE FROM messages WHERE room_id=? AND message_id=?').run(created.roomId,'protected-message')));
 for(const secret of [owner.secret,peer.secret]){
  const selected=await call(origin,'room_list_files',{roomId:created.roomId,messageIds:['protected-message']},secret);assert.equal(selected.body.result.isError,true);assert.equal(selected.value.files,undefined);
  const read=await call(origin,'room_get_file',{roomId:created.roomId,id:'protected-file'},secret);assert.equal(read.body.result.isError,true);assert.equal(read.value.attachment,undefined);assert.doesNotMatch(JSON.stringify(read.body),/PROTECTED_FILE_SENTINEL/);
 }
 assert.equal(store.db.prepare('SELECT state FROM room_attachments WHERE room_id=? AND id=?').get(created.roomId,'protected-file').state,'committed','bytes remain available for authorized recovery, never relabeled public');
});

for(const historyVisibility of ['since_join','all'])test(`normalized hosted file selection and downloads preserve ${historyVisibility} history policy`,async t=>{
 const now=Date.parse('2026-01-06T00:00:00Z'),{origin,store}=await serve(t,{now:()=>now});
 const owner=store.identities.create('Floor file owner'),peer=store.identities.create('Floor file reader'),roomId='floor-files';
 const {event,PERMISSIONS}=await import('../src/events.js');
 const entry=(type,data,at)=>event({roomId,actorId:owner.identityId,type,data,at});
 store.initialize([
  entry('room.created',{roomId,ownerId:owner.identityId,title:'History scoped files',purpose:'No older file body disclosure'},'2026-01-01T00:00:00Z'),
  entry('member.added',{memberId:owner.identityId,identityId:owner.identityId,displayName:'Floor file owner',kind:'agent',permissions:[...PERMISSIONS]},'2026-01-01T00:00:00Z'),
  entry('room.history_visibility_set',{historyVisibility},'2026-01-01T01:00:00Z'),
  entry('message.posted',{messageId:'prejoin-message',body:'Old file pointer'},'2026-01-02T00:00:00Z'),
  entry('member.added',{memberId:peer.identityId,identityId:peer.identityId,displayName:'Floor file reader',kind:'agent',permissions:[]},'2026-01-03T00:00:00Z')
 ],{representation:'normalized-current-v1'});
 // Synthetic code-owned canonical journal membership, not an onboarding claim.
 for(const identity of[owner,peer])store.db.prepare('INSERT INTO identity_links(room_id,identity_id,member_id,linked_at) VALUES(?,?,?,?)').run(roomId,identity.identityId,identity.identityId,now);
 const data=Buffer.from('PREJOIN_FILE_SENTINEL').toString('base64');assert.equal((await call(origin,'room_put_file',{roomId,id:'prejoin-file',filename:'old.txt',mediaType:'text/plain',data},owner.secret)).value.status,'staged');
 assert.equal((await call(origin,'room_commit_file',{roomId,id:'prejoin-file',messageId:'prejoin-message'},owner.secret)).value.status,'committed');
 if(historyVisibility==='since_join'){
 const selected=await call(origin,'room_list_files',{roomId,messageIds:['prejoin-message']},peer.secret);assert.equal(selected.value.status,404);assert.equal(selected.value.files,undefined);
 assert.throws(()=>store.roomAttachments.get(peer.secret,roomId,'prejoin-file'),e=>e.status===404&&e.code==='attachment_not_found');
 const http=await fetch(origin+'/api/rooms/'+roomId+'/files/prejoin-file',{headers:{Authorization:`Bearer ${peer.secret}`}});assert.equal(http.status,404);assert.doesNotMatch(await http.text(),/PREJOIN_FILE_SENTINEL/);
 const read=await call(origin,'room_get_file',{roomId,id:'prejoin-file'},peer.secret);assert.equal(read.value.status,404);assert.equal(read.value.attachment,undefined);assert.doesNotMatch(JSON.stringify(read.body),/PREJOIN_FILE_SENTINEL/);const absent=await call(origin,'room_get_file',{roomId,id:'unknown-file'},peer.secret);assert.equal(absent.value.status,read.value.status);assert.equal(absent.value.code,read.value.code);
 }else{
  const selected=await call(origin,'room_list_files',{roomId,messageIds:['prejoin-message']},peer.secret);assert.deepEqual(selected.value.files.map(x=>x.id),['prejoin-file']);
  assert.equal(store.roomAttachments.get(peer.secret,roomId,'prejoin-file').attachment.data,data);
  const http=await fetch(origin+'/api/rooms/'+roomId+'/files/prejoin-file',{headers:{Authorization:`Bearer ${peer.secret}`}});assert.equal(http.status,200);assert.equal((await http.json()).attachment.data,data);
  const read=await call(origin,'room_get_file',{roomId,id:'prejoin-file'},peer.secret);assert.equal(read.value.attachment.data,data,'explicit all-history policy remains effective for a nonowner');
 }
 assert.equal((await call(origin,'room_get_file',{roomId,id:'prejoin-file'},owner.secret)).value.attachment.data,data,'owner keeps established unlimited history');
});
