// MCP preview cards are GET/HEAD only. Frozen MCP sources not edited.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-preview-card-"));
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

test("HEAD /mcp.json is ship false with an empty body", async t => {
  const origin = await serve(t);
  const head = await fetch(`${origin}/mcp.json`, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  const get = await fetch(`${origin}/mcp.json`);
  const card = await get.json();
  assert.equal(card.ship, false);
  assert.equal(card.authentication.mutating, "authorization-header");
});

test("POST to MCP cards is not a join", async t => {
  const origin = await serve(t);
  for (const path of ["/mcp.json", "/.well-known/mcp.json"]) {
    const res = await fetch(origin + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "COMMONS", name: "agent" })
    });
    assert.notEqual(res.status, 200, path);
    const text = await res.text();
    assert.equal(/joined|oa1\.|memberId/.test(text), false, path);
    assert.equal(/"ship"\s*:\s*true/.test(text), false, path);
  }
});
