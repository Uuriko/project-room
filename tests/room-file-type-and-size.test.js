// Declared media types are checked against magic bytes. HTML and SVG are
// stored as opaque bytes. An upload whose Content-Length decodes past 1 MiB
// is refused with the file size, not the base64 body size.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { attachmentLimits } from "../server/attachment-schema.mjs";

const PNG = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D]);
const JPEG = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10]);
const GIF = Buffer.from("GIF89a", "ascii");
const WEBP = Buffer.concat([Buffer.from("RIFF", "ascii"), Buffer.alloc(4), Buffer.from("WEBP", "ascii")]);
const PDF = Buffer.from("%PDF-1.4\n", "ascii");

function stage(store, token, id, mediaType, bytes, filename = "file.bin") {
  return store.roomAttachments.stage(token, "commons", {
    id, filename, mediaType, data: Buffer.from(bytes).toString("base64")
  });
}

test("a declared type that does not match the bytes is stored as octet-stream", t => {
  const directory = mkdtempSync(join(tmpdir(), "project-room-file-type-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const owner = store.issueAccessKey("commons", "owner");
  const cases = [
    ["png-ok", "image/png", PNG, "image/png"],
    ["jpeg-ok", "image/jpeg", JPEG, "image/jpeg"],
    ["gif-ok", "image/gif", GIF, "image/gif"],
    ["webp-ok", "image/webp", WEBP, "image/webp"],
    ["pdf-ok", "application/pdf", PDF, "application/pdf"],
    ["png-as-text", "text/plain", PNG, "application/octet-stream"],
    ["text-as-png", "image/png", Buffer.from("hello"), "application/octet-stream"],
    ["jpeg-as-png", "image/png", JPEG, "application/octet-stream"],
    ["html", "text/html", Buffer.from("<html></html>"), "application/octet-stream"],
    ["svg", "image/svg+xml", Buffer.from("<svg></svg>"), "application/octet-stream"],
    ["plain", "text/plain", Buffer.from("hello"), "text/plain"]
  ];
  for (const [id, mediaType, bytes, stored] of cases) {
    const staged = stage(store, owner, id, mediaType, bytes);
    assert.equal(staged.attachment.mediaType, stored, id);
  }
});

test("a room file upload past 1 MiB names the decoded size", async t => {
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
  const small = await post("small", Buffer.from("hello"));
  assert.equal(small.status, 201);
  const tooBig = await post("big", Buffer.alloc(2 * 1024 * 1024, 7));
  assert.equal(tooBig.status, 413);
  const refused = await tooBig.json();
  assert.equal(refused.error.code, "attachment_too_large");
  assert.equal(refused.error.message, "Files can be up to 1 MiB; this one is about 2.0 MiB");
  const atCap = await post("cap", Buffer.alloc(attachmentLimits.fileBytes, 3));
  assert.equal(atCap.status, 201, JSON.stringify(await atCap.clone().json()));
  assert.equal((await atCap.json()).attachment.byteLength, attachmentLimits.fileBytes);
});
