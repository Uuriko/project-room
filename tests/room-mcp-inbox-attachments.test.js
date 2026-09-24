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
const INBOX_TOOLS = ["inbox_put_attachment", "inbox_list_attachments", "inbox_get_attachment", "inbox_discard_attachment"];

function serve(t, { now = () => Date.now() } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "room-mcp-inbox-"));
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

test("inbox attachment tools stay behind a live identity secret", async t => {
  const { origin, store, rooms } = await serve(t);
  const owner = store.identities.create("Inbox owner");
  const created = rooms.create(owner.secret, {
    roomId: "inbox-den", title: "Inbox den", purpose: "Inbox bytes", kind: "personal", displayName: "Inbox owner"
  });
  const listed = await rpc(origin, "tools/list");
  assert.deepEqual((await listed.json()).result.tools.map(tool => tool.name), JOIN_TOOLS);
  const denied = await call(origin, "inbox_get_attachment", { id: "note" });
  assert.equal(denied.status, 401);
  assert.equal(denied.body.error.code, -32001);
  assert.equal(denied.body.error.data.reason, "auth_required");
  const bad = await rpc(origin, "tools/call", {
    name: "inbox_put_attachment", arguments: {
      id: "note", filename: "note.txt", mediaType: "text/plain", data: Buffer.from("nope").toString("base64")
    }
  }, "pri_" + "x".repeat(43));
  assert.equal(bad.status, 401);
  const roomKey = store.issueAccessKey(created.roomId, created.ownerMemberId);
  const keyCall = await call(origin, "inbox_put_attachment", {
    id: "note", filename: "note.txt", mediaType: "text/plain", data: Buffer.from("nope").toString("base64")
  }, roomKey);
  assert.equal(keyCall.status, 401);
  assert.equal(keyCall.body.result, undefined);
  const keyGet = await call(origin, "inbox_get_attachment", { id: "note" }, roomKey);
  assert.equal(keyGet.status, 401);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM inbox_attachment_bytes").get().n, 0);
});

test("an enrolled identity puts, lists, downloads, and discards its own inbox attachment bytes", async t => {
  const { origin, store } = await serve(t);
  const owner = store.identities.create("Inbox owner");
  const other = store.identities.create("Inbox other");
  const names = (await (await rpc(origin, "tools/list", undefined, owner.secret)).json()).result.tools.map(tool => tool.name);
  for (const name of INBOX_TOOLS) assert.equal(names.includes(name), true);
  assert.equal(names.includes("room_join_packet"), true);
  const bytes = Buffer.from("inbox attachment bytes");
  const data = bytes.toString("base64");
  const staged = await call(origin, "inbox_put_attachment", {
    id: "note", filename: "note.txt", mediaType: "text/plain", data
  }, owner.secret);
  assert.equal(staged.status, 200);
  assert.equal(staged.body.error, undefined);
  assert.equal(staged.value.status, "staged");
  assert.equal(staged.value.duplicate, false);
  assert.equal(staged.value.attachment.sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.equal(staged.value.attachment.byteLength, bytes.length);
  assert.equal(JSON.stringify(staged.body).includes(owner.secret), false);
  const row = store.db.prepare("SELECT state, byte_length, length(bytes) AS n FROM inbox_attachment_bytes WHERE identity_id=? AND id=?").get(owner.identityId, "note");
  assert.equal(row.state, "staged");
  assert.equal(row.byte_length, bytes.length);
  assert.equal(row.n, bytes.length);

  const again = await call(origin, "inbox_put_attachment", {
    id: "note", filename: "note.txt", mediaType: "text/plain", data
  }, owner.secret);
  assert.equal(again.value.duplicate, true);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM inbox_attachment_bytes").get().n, 1);

  const conflict = await call(origin, "inbox_put_attachment", {
    id: "note", filename: "note.txt", mediaType: "text/plain", data: Buffer.from("other").toString("base64")
  }, owner.secret);
  assert.equal(conflict.value.code, "attachment_conflict");
  assert.equal(conflict.body.result.isError, true);

  const listed = await call(origin, "inbox_list_attachments", {}, owner.secret);
  assert.equal(listed.value.attachments.length, 1);
  assert.equal(listed.value.attachments[0].id, "note");
  assert.equal("data" in listed.value.attachments[0], false);

  const downloaded = await call(origin, "inbox_get_attachment", { id: "note" }, owner.secret);
  assert.equal(downloaded.value.attachment.data, data);
  assert.equal(downloaded.value.attachment.encoding, "base64");
  assert.equal(Buffer.from(downloaded.value.attachment.data, "base64").toString(), "inbox attachment bytes");
  assert.equal(JSON.stringify(downloaded.body).includes(owner.secret), false);

  const hiddenList = await call(origin, "inbox_list_attachments", {}, other.secret);
  assert.deepEqual(hiddenList.value.attachments, []);
  const hidden = await call(origin, "inbox_get_attachment", { id: "note" }, other.secret);
  assert.equal(hidden.body.result.isError, true);
  assert.equal(hidden.value.status, 404);
  assert.equal(hidden.value.code, "attachment_not_found");
  assert.equal(JSON.stringify(hidden.body).includes("inbox attachment bytes"), false);
  const hiddenDiscard = await call(origin, "inbox_discard_attachment", { id: "note" }, other.secret);
  assert.equal(hiddenDiscard.value.code, "attachment_not_found");
  assert.equal(store.db.prepare("SELECT state FROM inbox_attachment_bytes WHERE identity_id=? AND id=?").get(owner.identityId, "note").state, "staged");

  const blocked = await call(origin, "inbox_put_attachment", {
    id: "run", filename: "run.exe", mediaType: "application/octet-stream", data: Buffer.from("MZ").toString("base64")
  }, owner.secret);
  assert.equal(blocked.value.code, "blocked_extension");

  const shaped = await call(origin, "inbox_put_attachment", {
    id: "bad", filename: "bad.txt", mediaType: "text/plain", data: "not base64!!"
  }, owner.secret);
  assert.equal(shaped.body.error.code, -32602);

  const discarded = await call(origin, "inbox_discard_attachment", { id: "note" }, owner.secret);
  assert.equal(discarded.value.status, "discarded");
  const gone = await call(origin, "inbox_get_attachment", { id: "note" }, owner.secret);
  assert.equal(gone.value.status, 410);
  assert.equal(gone.value.code, "attachment_unavailable");
  const stored = store.db.prepare("SELECT state, bytes FROM inbox_attachment_bytes WHERE identity_id=? AND id=?").get(owner.identityId, "note");
  assert.equal(stored.state, "discarded");
  assert.equal(stored.bytes, null);
  const reuse = await call(origin, "inbox_put_attachment", {
    id: "note", filename: "note.txt", mediaType: "text/plain", data
  }, owner.secret);
  assert.equal(reuse.value.code, "attachment_conflict");
});

test("a pri_ bearer can stage an inbox attachment larger than the join body cap", async t => {
  const { origin, store } = await serve(t);
  const owner = store.identities.create("Inbox owner");
  const payload = Buffer.alloc(20000, 0x61);
  const body = JSON.stringify({
    jsonrpc: "2.0", id: "big", method: "tools/call",
    params: { name: "inbox_put_attachment", arguments: {
      id: "wide", filename: "wide.txt", mediaType: "text/plain", data: payload.toString("base64")
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
  assert.equal(JSON.stringify(acceptedBody).includes(owner.secret), false);
});

test("staged inbox attachments expire and an identity cannot exceed the staged cap", t => {
  let now = 1_700_000_000_000;
  const directory = mkdtempSync(join(tmpdir(), "inbox-attachment-bytes-"));
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => now });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const owner = store.identities.create("Cap owner");
  const data = Buffer.from("x").toString("base64");
  for (let i = 0; i < attachmentLimits.stagedPerMember; i++) {
    const staged = store.inboxAttachments.put(owner.identityId, {
      id: `f${i}`, filename: "n.txt", mediaType: "text/plain", data
    });
    assert.equal(staged.duplicate, false);
  }
  assert.throws(() => store.inboxAttachments.put(owner.identityId, {
    id: "overflow", filename: "n.txt", mediaType: "text/plain", data
  }), error => error.status === 409 && error.code === "attachment_quota");
  now += attachmentLimits.lifetimeMs + 1;
  assert.throws(() => store.inboxAttachments.get(owner.identityId, "f0"),
    error => error.status === 410 && error.code === "attachment_unavailable");
  assert.deepEqual(store.inboxAttachments.list(owner.identityId).attachments, []);
  const expired = store.db.prepare("SELECT state, bytes FROM inbox_attachment_bytes WHERE identity_id=? AND id=?").get(owner.identityId, "f0");
  assert.equal(expired.state, "expired");
  assert.equal(expired.bytes, null);
});
