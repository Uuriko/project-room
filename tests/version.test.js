import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, copyFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { SOURCE_REVISION, BUILD_ID } from "../server/version.mjs";

test("GET /api/version returns the release receipt metadata without authentication", async t => {
  const directory = mkdtempSync(join(tmpdir(), "room-version-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const server = createRoomServer({ store, streamInterval: 15 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { server.closeStreams(); server.closeAllConnections(); server.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const res = await fetch(`${origin}/api/version`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, "ok");
  assert.equal(body.mode, "single-node-pilot");
  // Whatever the file currently holds is what the route reports: placeholder
  // in development, stamped immutables after `node scripts/stamp-version.mjs`.
  assert.equal(body.sourceRevision, SOURCE_REVISION);
  assert.equal(body.buildId, BUILD_ID);
  assert.match(body.sourceRevision, /^(unstamped|[0-9a-f]{40})$/);
  const head = await fetch(`${origin}/api/version`, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  assert.equal((await fetch(`${origin}/api/version`, { method: "POST" })).status, 404);
});

test("stamp-version writes immutable revision/build metadata and re-import verifies", t => {
  const directory = mkdtempSync(join(tmpdir(), "room-stamp-"));
  const target = join(directory, "version.mjs");
  copyFileSync(new URL("../server/version.mjs", import.meta.url), target);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const revision = "0".repeat(39) + "1";
  const out = JSON.parse(execFileSync("node", ["scripts/stamp-version.mjs", target, "--revision", revision, "--build-id", "2026-09-08T00:00:00.000Z"], { encoding: "utf8" }));
  assert.deepEqual(out, { stamped: true, sourceRevision: revision, buildId: "2026-09-08T00:00:00.000Z" });
  const text = readFileSync(target, "utf8");
  assert.match(text, /export const SOURCE_REVISION = "0{39}1";/);
  assert.match(text, /export const BUILD_ID = "2026-09-08T00:00:00\.000Z";/);
  assert.throws(() => execFileSync("node", ["scripts/stamp-version.mjs", target, "--revision", "notasha"], { stdio: "pipe" }), /revision must be a full commit SHA/);
});
