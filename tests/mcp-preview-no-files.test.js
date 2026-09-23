// MCP preview: no file tools, no persisted join. Frozen MCP sources not edited.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-preview-nofiles-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function post(origin, message) {
  const res = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(message)
  });
  let json = null;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, json };
}

test("HTTP room_check_access is never joined and does not persist", async t => {
  const origin = await serve(t);
  const res = await post(origin, {
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "room_check_access", arguments: {} }
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.error, undefined);
  assert.equal(res.json.result.isError, false);
  const payload = JSON.parse(res.json.result.content[0].text);
  assert.equal(payload.joined, false);
  assert.equal(payload.ship, false);
  assert.equal(payload.persistence, "none");
  assert.deepEqual(payload.next, []);
  assert.equal(Object.hasOwn(payload, "token"), false);
  assert.equal(Object.hasOwn(payload, "memberId"), false);
});

test("HTTP tools/call of upload-like names is unknown, not a file session", async t => {
  const origin = await serve(t);
  for (const name of ["room_upload", "room_attach", "room_post_file", "files_upload", "room_post_draft"]) {
    const res = await post(origin, {
      jsonrpc: "2.0", id: name, method: "tools/call",
      params: { name, arguments: {} }
    });
    assert.equal(res.status, 200, name);
    assert.equal(res.json.error.code, -32602, name);
    assert.equal(res.json.result, undefined, name);
  }
});

test("HTTP room_listen is unavailable with empty next", async t => {
  const origin = await serve(t);
  const res = await post(origin, {
    jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "room_listen", arguments: {} }
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.result.isError, true);
  const payload = JSON.parse(res.json.result.content[0].text);
  assert.equal(payload.status, "unavailable");
  assert.deepEqual(payload.next, []);
});

test("POST /api/open is not a join and GET has no file fields", async t => {
  const origin = await serve(t);
  const posted = await fetch(`${origin}/api/open`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: "COMMONS", name: "agent" })
  });
  assert.notEqual(posted.status, 200);
  const body = await posted.text();
  assert.equal(/joined|oa1\.|memberId|token/i.test(body), false);

  const get = await fetch(`${origin}/api/open`);
  assert.equal(get.status, 200);
  const open = await get.json();
  assert.equal(open.ship, false);
  assert.equal(open.persistence, "none");
  for (const key of Object.keys(open)) {
    assert.equal(/(attach|upload|blob|file)/i.test(key), false, key);
  }
});
