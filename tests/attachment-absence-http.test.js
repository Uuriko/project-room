// G4: prove shipped HTTP/store have no room file upload/download. No implementation.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { applicationTables } from "../server/writer-fence.mjs";

const FILE_TABLES = ["files", "blobs", "attachments", "uploads", "file_objects"];
const MISSING_PATHS = [
  "/api/rooms/commons/attachments",
  "/api/rooms/commons/files",
  "/api/rooms/commons/files/x",
  "/api/uploads",
  "/api/files"
];

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-attach-abs-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  return { origin: `http://127.0.0.1:${server.address().port}`, store };
}

test("room attachment and file routes are 404 on the live dispatcher", async t => {
  const { origin } = await serve(t);
  for (const path of MISSING_PATHS) {
    for (const method of ["GET", "POST", "PUT", "DELETE"]) {
      const init = method === "GET" ? {} : {
        method,
        headers: { "Content-Type": "application/json" },
        body: "{}"
      };
      const res = await fetch(origin + path, init);
      assert.equal(res.status, 404, `${method} ${path}`);
    }
  }
});

test("multipart to /mcp is rejected as non-JSON", async t => {
  const { origin } = await serve(t);
  const res = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "multipart/form-data; boundary=x" },
    body: "--x\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a.bin\"\r\n\r\nA\r\n--x--"
  });
  assert.equal(res.status, 415);
  const body = await res.json();
  assert.equal(body.error.code, "json_required");
});

test("live sqlite_master has no file or blob tables", async t => {
  const { store } = await serve(t);
  const names = store.db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  ).all().map(row => row.name);
  for (const name of FILE_TABLES) {
    assert.equal(names.includes(name), false, name);
  }
});

test("shipped applicationTables inventory has no file or blob tables", () => {
  assert.ok(Array.isArray(applicationTables) && applicationTables.length > 0);
  for (const name of FILE_TABLES) {
    assert.equal(applicationTables.includes(name), false, name);
  }
});

test("public open and mcp cards do not advertise file upload", async t => {
  const { origin } = await serve(t);
  for (const path of ["/api/open", "/.well-known/mcp.json"]) {
    const res = await fetch(origin + path);
    assert.equal(res.status, 200, path);
    const text = await res.text();
    assert.equal(/(attachment|upload|blob)/i.test(text), false, path);
  }
  const list = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
  });
  assert.equal(list.status, 200);
  const tools = (await list.json()).result.tools.map(tool => tool.name);
  assert.equal(tools.some(name => /(attach|upload|file|blob)/i.test(name)), false);
});
