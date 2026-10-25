// Declared media types are checked against magic bytes. A PNG declared as
// text/html is stored as image/png. An upload whose body is past 1 MiB
// decoded is refused with that decoded size, and a file at the decoded cap
// is accepted.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { AgentRooms } from "../server/agent-rooms.mjs";
import { attachmentLimits } from "../server/attachment-schema.mjs";

const PNG = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D]);

function stage(store, token, id, mediaType, bytes, filename = "file.bin") {
  return store.roomAttachments.stage(token, "commons", {
    id, filename, mediaType, data: Buffer.from(bytes).toString("base64")
  });
}

test("a PNG declared as text/html is stored as image/png", t => {
  const directory = mkdtempSync(join(tmpdir(), "project-room-file-type-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const owner = store.issueAccessKey("commons", "owner");
  const png = stage(store, owner, "png-as-html", "text/html", PNG);
  assert.equal(png.attachment.mediaType, "image/png");
  const html = stage(store, owner, "html", "text/html", Buffer.from("<html></html>"));
  assert.equal(html.attachment.mediaType, "application/octet-stream");
  const plain = stage(store, owner, "plain", "text/plain", Buffer.from("hello"));
  assert.equal(plain.attachment.mediaType, "text/plain");
  const inbox = store.inboxAttachments.put("ai_filetyper", {
    id: "png-as-html", filename: "x.html", mediaType: "text/html", data: PNG.toString("base64")
  });
  assert.equal(inbox.attachment.mediaType, "image/png");
});

test("a room file upload past 1 MiB names the decoded size, and 1 MiB is accepted", async t => {
  const directory = mkdtempSync(join(tmpdir(), "project-room-file-size-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const owner = store.issueAccessKey("commons", "owner");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const post = (id, bytes) => fetch(`${origin}/api/rooms/commons/files`, {
    method: "POST",
    headers: { Authorization: `Bearer ${owner}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      id, filename: "blob.bin", mediaType: "application/octet-stream",
      data: Buffer.from(bytes).toString("base64")
    })
  });
  const justUnder = await post("under", Buffer.alloc(attachmentLimits.fileBytes - 1, 3));
  assert.equal(justUnder.status, 201, JSON.stringify(await justUnder.clone().json()));
  assert.equal((await justUnder.json()).attachment.byteLength, attachmentLimits.fileBytes - 1);
  const atCap = await post("cap", Buffer.alloc(attachmentLimits.fileBytes, 3));
  assert.equal(atCap.status, 201, JSON.stringify(await atCap.clone().json()));
  assert.equal((await atCap.json()).attachment.byteLength, attachmentLimits.fileBytes);
  const tooBig = await post("big", Buffer.alloc(2 * 1024 * 1024, 7));
  assert.equal(tooBig.status, 413);
  const refused = await tooBig.json();
  assert.equal(refused.error.code, "attachment_too_large");
  assert.equal(refused.error.message, "Files can be up to 1 MiB; this one is about 2.0 MiB");
});

test("MCP room_put_file stores a PNG declared as text/html as image/png and names an oversize decoded file", async t => {
  const directory = mkdtempSync(join(tmpdir(), "project-room-file-mcp-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  const rooms = new AgentRooms(store);
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const owner = store.identities.create("File owner");
  const created = rooms.create(owner.secret, {
    roomId: "file-den", title: "File den", purpose: "Room file bytes", kind: "personal", displayName: "File owner"
  });
  const call = async (args) => {
    const response = await fetch(`${origin}/room/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${owner.secret}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: "t", method: "tools/call", params: { name: "room_put_file", arguments: args } })
    });
    return { status: response.status, body: await response.json() };
  };
  const staged = await call({
    roomId: created.roomId, id: "png-as-html", filename: "x.html", mediaType: "text/html",
    data: PNG.toString("base64")
  });
  assert.equal(staged.status, 200);
  assert.equal(staged.body.result.structuredContent.attachment.mediaType, "image/png");
  const tooBig = await call({
    roomId: created.roomId, id: "big", filename: "blob.bin", mediaType: "application/octet-stream",
    data: Buffer.alloc(2 * 1024 * 1024, 7).toString("base64")
  });
  assert.equal(tooBig.status, 413);
  assert.equal(tooBig.body.error.code, "attachment_too_large");
  assert.equal(tooBig.body.error.message, "Files can be up to 1 MiB; this one is about 2.0 MiB");
});
