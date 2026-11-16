// A self-hosted checkout never ran the hosted deploy that builds room-acp.tgz.
// The Node server must still serve it, built from the reviewed room-acp/
// sources, without writing into the checkout.
import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { defaultServerArgs } from "../server/boot-options.mjs";

const repo = new URL("../", import.meta.url);

async function serve(t, assetRoot) {
  const store = new RoomStore(":memory:");
  const server = createRoomServer(defaultServerArgs({ store, assetRoot: pathToFileURL(assetRoot + "/") }));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); store.close();
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test("/room-acp.tgz is built from sources and served as gzip when no pack was prebuilt", async t => {
  const root = mkdtempSync(join(tmpdir(), "room-acp-serve-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync(new URL("room-acp", repo), join(root, "room-acp"), { recursive: true });
  mkdirSync(join(root, "scripts"));
  cpSync(new URL("scripts/build-room-acp-pack.mjs", repo), join(root, "scripts/build-room-acp-pack.mjs"));
  const origin = await serve(t, root);
  const first = await fetch(`${origin}/room-acp.tgz`);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("content-type"), "application/gzip");
  const bytes = Buffer.from(await first.arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 2)], [0x1f, 0x8b]);
  const tar = gunzipSync(bytes).toString("latin1");
  assert.match(tar, /package\/package\.json/);
  assert.match(tar, /package\/src\/cli\.mjs/);
  assert.doesNotMatch(tar, /package\/tests?\//);
  // Cached for the life of the process, and HEAD answers without a body.
  const second = Buffer.from(await (await fetch(`${origin}/room-acp.tgz`)).arrayBuffer());
  assert.ok(second.equals(bytes));
  assert.equal((await fetch(`${origin}/room-acp.tgz`, { method: "HEAD" })).status, 200);
  // The checkout stays untouched: nothing is written beside the sources.
  assert.equal(existsSync(join(root, "room-acp.tgz")), false);
  assert.deepEqual(readdirSync(root).sort(), ["room-acp", "scripts"]);
});

test("/room-acp.tgz is a 404, not a 500, when the sources are not in this runtime", async t => {
  const root = mkdtempSync(join(tmpdir(), "room-acp-serve-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const origin = await serve(t, root);
  assert.equal((await fetch(`${origin}/room-acp.tgz`)).status, 404);
});

test("a prebuilt room-acp.tgz still wins over building", async t => {
  const root = mkdtempSync(join(tmpdir(), "room-acp-serve-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(root, "room-acp.tgz"), Buffer.from([0x1f, 0x8b, 1, 2, 3]));
  const origin = await serve(t, root);
  const body = Buffer.from(await (await fetch(`${origin}/room-acp.tgz`)).arrayBuffer());
  assert.deepEqual([...body], [0x1f, 0x8b, 1, 2, 3]);
});
