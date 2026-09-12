import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, copyFileSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { SOURCE_REVISION, BUILD_ID } from "../server/version.mjs";
import { stampVersion } from "../scripts/stamp-version.mjs";
import { pathToFileURL } from "node:url";

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

function stampFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-stamp-"));
  mkdirSync(join(directory, "server"));
  const target = join(directory, "server/version.mjs");
  copyFileSync(new URL("../server/version.mjs", import.meta.url), target);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init"); git("add", ".");
  git("-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "commit", "-m", "fixture");
  return { repository: directory, target, revision: git("rev-parse", "HEAD"), git };
}

test("stamp-version CLI stamps a real clean HEAD", t => {
  const { repository, target, revision } = stampFixture(t);
  const out = JSON.parse(execFileSync("node", ["scripts/stamp-version.mjs", "--repository", repository, "--revision", revision, "--build-id", "2026-09-08T00:00:00.000Z"], { encoding: "utf8" }));
  assert.deepEqual(out, { stamped: true, sourceRevision: revision, buildId: "2026-09-08T00:00:00.000Z" });
  const text = readFileSync(target, "utf8");
  assert.ok(text.includes(revision));
  assert.match(text, /export const BUILD_ID = "2026-09-08T00:00:00\.000Z";/);
  assert.throws(() => execFileSync("node", ["scripts/stamp-version.mjs", target, "--revision", "notasha"], { stdio: "pipe" }), /revision must be a full commit SHA/);
});

for (const kind of ["tracked", "staged", "untracked"]) test(`stamp refuses ${kind} changes before writing`, t => {
  const f = stampFixture(t);
  if (kind === "untracked") writeFileSync(join(f.repository, "extra.mjs"), "// untracked runtime");
  else { writeFileSync(f.target, readFileSync(f.target, "utf8") + "\n// changed\n"); if (kind === "staged") f.git("add", "."); }
  const before = readFileSync(f.target, "utf8");
  assert.throws(() => stampVersion(f), /must be clean/);
  assert.equal(readFileSync(f.target, "utf8"), before);
});

test("stamp refuses forged revisions without modifying target", t => {
  const f = stampFixture(t), before = readFileSync(f.target, "utf8");
  assert.throws(() => stampVersion({ ...f, revision: "0".repeat(40) }), /must match/);
  assert.equal(readFileSync(f.target, "utf8"), before);
});

test("build IDs are serialized as data, never executed", async t => {
  const f = stampFixture(t);
  const buildId = 'x"; throw new Error("injected"); //';
  stampVersion({ ...f, buildId });
  const loaded = await import(pathToFileURL(f.target).href);
  assert.equal(loaded.BUILD_ID, buildId);
  assert.equal(loaded.SOURCE_REVISION, f.revision);
});
