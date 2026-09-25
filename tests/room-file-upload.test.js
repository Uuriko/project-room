import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { attachmentFromBytes, bytesToBase64, COMPOSER_FILE_BYTES } from "../src/composer-files.js";

test("attachmentFromBytes encodes a composer file and refuses anything over 1 MB", () => {
  const bytes = new TextEncoder().encode("hello");
  const payload = attachmentFromBytes({ id: "file-1", filename: " notes.txt ", mediaType: "text/plain", bytes });
  assert.equal(payload.filename, "notes.txt");
  assert.equal(payload.mediaType, "text/plain");
  assert.equal(payload.data, bytesToBase64(bytes));
  assert.equal(COMPOSER_FILE_BYTES, 1048576);
  assert.throws(
    () => attachmentFromBytes({ id: "big", filename: "big.bin", mediaType: "application/octet-stream", bytes: new Uint8Array(COMPOSER_FILE_BYTES + 1) }),
    error => error.code === "file_too_large"
  );
});

test("room file routes stage a composer upload and commit it onto a message", async t => {
  const directory = mkdtempSync(join(tmpdir(), "project-room-files-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const owner = store.issueAccessKey("commons", "owner");
  store.command(owner, "commons", { id: crypto.randomUUID(), type: T.MEMBER_ADDED, data: { memberId: "human", displayName: "human", kind: "human", permissions: ["accept_work", "complete_work", "verify"] } });
  const human = store.issueAccessKey("commons", "human");
  const server = createRoomServer({ store, streamInterval: 15 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { server.closeStreams(); server.closeAllConnections(); server.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const request = (path, { token = human, method = "GET", data } = {}) => fetch(`${origin}${path}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(data === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(data === undefined ? {} : { body: JSON.stringify(data) })
  });

  const page = await request("/", { token: null });
  assert.match(page.headers.get("content-security-policy"), /https:\/\/static\.cloudflareinsights\.com/);
  assert.match(page.headers.get("content-security-policy"), /connect-src 'self' https:\/\/cloudflareinsights\.com/);
  assert.match(page.headers.get("content-security-policy"), /frame-ancestors 'none'/);

  const anon = await request("/api/rooms/commons/files", { token: null });
  assert.equal(anon.status, 401);

  const staged = await request("/api/rooms/commons/files", {
    method: "POST",
    data: { id: "file-1", filename: "notes.txt", mediaType: "text/plain", data: Buffer.from("hello room").toString("base64") }
  });
  assert.equal(staged.status, 201);
  const stagedBody = await staged.json();
  assert.equal(stagedBody.attachment.filename, "notes.txt");
  assert.equal(stagedBody.attachment.state, "staged");

  store.command(human, "commons", { id: crypto.randomUUID(), type: T.MESSAGE_POSTED, data: { messageId: "msg-1", body: "see file" } });
  const committed = await request("/api/rooms/commons/files/file-1/commit", { method: "POST", data: { messageId: "msg-1" } });
  assert.equal(committed.status, 200);
  const committedBody = await committed.json();
  assert.equal(committedBody.attachment.state, "committed");
  assert.equal(committedBody.attachment.messageId, "msg-1");

  const listed = await (await request("/api/rooms/commons/files")).json();
  assert.equal(listed.files.some(file => file.id === "file-1" && file.messageId === "msg-1" && file.state === "committed"), true);
});
