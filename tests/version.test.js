import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, copyFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
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
  // QA 2026-10-03 P2-1: a trailing slash must hit the route, not a 404 whose
  // "check access" hint misdirects on a public endpoint.
  const slashed = await fetch(`${origin}/api/version/`);
  assert.equal(slashed.status, 200);
  assert.deepEqual(await slashed.json(), body);
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

test("M-55: stamp-version parses --flag value pairs structurally (target may follow flags)", t => {
  const root = join(fileURLToPath(import.meta.url), "..", "..", ".tmp");
  const directory = mkdtempSync(join(root, "room-stamp-"));
  const target = join(directory, "version.mjs");
  copyFileSync(new URL("../server/version.mjs", import.meta.url), target);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const revision = "1".repeat(40);
  // flags BEFORE the positional target: the old args.find() mistook the
  // --revision value for the target and tried to stamp the SHA as a path.
  const out = JSON.parse(execFileSync("node", [
    "scripts/stamp-version.mjs", "--revision", revision, "--build-id", "b1", target,
  ], { encoding: "utf8" }));
  assert.deepEqual(out, { stamped: true, sourceRevision: revision, buildId: "b1" });
  assert.match(readFileSync(target, "utf8"), new RegExp(`export const SOURCE_REVISION = "${revision}";`));
  // unknown options and duplicate positionals fail closed instead of stamping wrong
  assert.throws(() => execFileSync("node", ["scripts/stamp-version.mjs", "--revison", revision, target], { stdio: "pipe" }), /unknown option/);
  assert.throws(() => execFileSync("node", ["scripts/stamp-version.mjs", target, target], { stdio: "pipe" }), /at most one positional/);
});

test("M-56: stamp-version escapes values and never leaves a broken target behind", t => {
  const root = join(fileURLToPath(import.meta.url), "..", "..", ".tmp");
  const directory = mkdtempSync(join(root, "room-stamp-"));
  const target = join(directory, "version.mjs");
  copyFileSync(new URL("../server/version.mjs", import.meta.url), target);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const revision = "2".repeat(40);
  const hostile = `a"b\\c\${d}\nnewline`;
  const out = JSON.parse(execFileSync("node", [
    "scripts/stamp-version.mjs", target, "--revision", revision, "--build-id", hostile,
  ], { encoding: "utf8" }));
  assert.equal(out.buildId, hostile);
  // the stamped file is valid JS and re-imports to the exact values —
  // pre-fix the raw interpolation wrote a syntax-broken version.mjs.
  execFileSync("node", ["--check", target], { stdio: "pipe" });
  const reimported = JSON.parse(execFileSync("node", ["--input-type=module", "-e",
    `import(${JSON.stringify("file://" + target)}).then(m => console.log(JSON.stringify([m.SOURCE_REVISION, m.BUILD_ID])))`,
  ], { encoding: "utf8" }));
  assert.deepEqual(reimported, [revision, hostile]);
});
