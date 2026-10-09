// FIX-33: path re-stat before patching.
// Fail-first acceptance for scripts/path-restat.mjs: given paths an agent
// intends to edit, the check fetches origin/main and re-stats each path on
// the fresh tip with `git ls-tree`. Fixture repos are fully local (file
// transport); no network is used.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(root, "scripts", "path-restat.mjs");

function git(cwd, ...args) {
  const r = spawnSync("git", ["-c", "user.email=fix33@test", "-c", "user.name=fix33", ...args],
    { cwd, encoding: "utf8", timeout: 30000 });
  assert.equal(r.status, 0, `git ${args.join(" ")} failed in ${cwd}: ${r.stderr}`);
  return r.stdout.trim();
}

// Builds: origin repo with commit1 (old-widget, keep, doomed), an agent clone
// pinned at commit1, then origin advances to commit2 (old-widget renamed to
// new-widget, doomed deleted, keep untouched).
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "path-restat-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const origin = join(dir, "origin");
  mkdirSync(join(origin, "server"), { recursive: true });
  git(dir, "init", "-b", "main", "origin");
  writeFileSync(join(origin, "server", "old-widget.mjs"), "export const w = 1;\n");
  writeFileSync(join(origin, "server", "keep.mjs"), "export const k = 1;\n");
  writeFileSync(join(origin, "server", "doomed.mjs"), "export const d = 1;\n");
  git(origin, "add", "-A");
  git(origin, "commit", "-m", "commit1");
  const agent = join(dir, "agent");
  git(dir, "clone", "--quiet", origin, "agent");
  git(origin, "mv", "server/old-widget.mjs", "server/new-widget.mjs");
  git(origin, "rm", "--quiet", "server/doomed.mjs");
  git(origin, "commit", "--quiet", "-m", "commit2: rename + delete");
  return { agent };
}

function restat(agent, ...args) {
  const r = spawnSync(process.execPath, [script, "--repo", agent, ...args],
    { encoding: "utf8", timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
  return r;
}

test("renamed path on the fresh tip fails and names the new location", t => {
  const { agent } = fixture(t);
  const r = restat(agent, "server/old-widget.mjs");
  assert.equal(r.status, 1, `expected exit 1, got ${r.status}: ${r.stdout} ${r.stderr}`);
  assert.match(r.stdout, /server\/old-widget\.mjs/);
  assert.match(r.stdout, /server\/new-widget\.mjs/);
});

test("renamed path is reported with the new location in --json", t => {
  const { agent } = fixture(t);
  const r = restat(agent, "--json", "server/old-widget.mjs");
  assert.equal(r.status, 1);
  const out = JSON.parse(r.stdout);
  assert.equal(out.paths.length, 1);
  assert.equal(out.paths[0].status, "renamed");
  assert.equal(out.paths[0].current, "server/new-widget.mjs");
});

test("unchanged paths pass with exit 0", t => {
  const { agent } = fixture(t);
  const r = restat(agent, "--json", "server/keep.mjs");
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}: ${r.stdout} ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.equal(out.paths[0].status, "ok");
});

test("deleted path on the fresh tip fails and is named deleted", t => {
  const { agent } = fixture(t);
  const r = restat(agent, "--json", "server/doomed.mjs");
  assert.equal(r.status, 1);
  const out = JSON.parse(r.stdout);
  assert.equal(out.paths[0].status, "deleted");
  assert.match(r.stdout + r.stderr, /deleted/);
});

test("path that never existed fails as not-found", t => {
  const { agent } = fixture(t);
  const r = restat(agent, "--json", "server/never-there.mjs");
  assert.equal(r.status, 1);
  const out = JSON.parse(r.stdout);
  assert.equal(out.paths[0].status, "not-found");
});

test("mixed batch exits non-zero and reports each stale path", t => {
  const { agent } = fixture(t);
  const r = restat(agent, "server/keep.mjs", "server/old-widget.mjs", "server/doomed.mjs");
  assert.equal(r.status, 1);
  assert.match(r.stdout, /server\/new-widget\.mjs/);
  assert.match(r.stdout, /deleted/);
});
