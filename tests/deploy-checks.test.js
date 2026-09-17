// F007: tests for scripts/deploy-checks.mjs — reproducible deploy checks.
//
// Pure functions are tested directly with temp-dir fixtures; the CLI gets a
// small spawn smoke test (--write round-trip, --check pass/fail, usage errors).
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  sha256Hex,
  hashFile,
  computeAssetHashes,
  diffManifests,
  buildManifest,
  readManifest,
  writeManifest,
  checkLockfileSync,
  runDeployChecks,
  DEFAULT_MANIFEST_NAME,
} from "../scripts/deploy-checks.mjs";

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(new URL("../scripts/deploy-checks.mjs", import.meta.url));

function tempDir(t, prefix = "deploy-checks-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => { rmSync(dir, { recursive: true, force: true }); });
  return dir;
}

function writeJson(dir, name, value) {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(value, null, 2));
  return path;
}

// Minimal in-sync package.json + lockfileVersion-3 lockfile fixture.
function syncFixtures() {
  const pkg = {
    name: "fixture-room",
    version: "1.2.3",
    dependencies: { leftpad: "1.3.0" },
    devDependencies: { eslint: "10.10.0" },
  };
  const lock = {
    name: "fixture-room",
    version: "1.2.3",
    lockfileVersion: 3,
    packages: {
      "": {
        name: "fixture-room",
        version: "1.2.3",
        dependencies: { leftpad: "1.3.0" },
        devDependencies: { eslint: "10.10.0" },
      },
      "node_modules/leftpad": { version: "1.3.0" },
      "node_modules/eslint": { version: "10.10.0" },
    },
  };
  return { pkg, lock };
}

function checkByName(result, name) {
  const found = result.checks.find(c => c.name === name);
  assert.ok(found, `expected a ${name} check`);
  return found;
}

// --- sha256Hex / hashFile ----------------------------------------------------

test("sha256Hex matches known vectors", () => {
  assert.equal(sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(sha256Hex(Buffer.from("abc")), sha256Hex("abc"));
});

test("hashFile hashes file bytes and differs on content change", t => {
  const dir = tempDir(t);
  const path = join(dir, "a.txt");
  writeFileSync(path, "hello deploy");
  assert.equal(hashFile(path), createHash("sha256").update("hello deploy").digest("hex"));
  writeFileSync(path, "hello deploy!");
  assert.notEqual(hashFile(path), sha256Hex("hello deploy"));
  assert.throws(() => hashFile(join(dir, "nope.txt")));
});

// --- computeAssetHashes ------------------------------------------------------

test("computeAssetHashes hashes files with sorted posix keys", t => {
  const dir = tempDir(t);
  writeFileSync(join(dir, "b.txt"), "b-content");
  writeFileSync(join(dir, "a.txt"), "a-content");
  const { hashes, missing, skipped } = computeAssetHashes(["b.txt", "a.txt"], { root: dir });
  assert.deepEqual(Object.keys(hashes), ["a.txt", "b.txt"]);
  assert.equal(hashes["a.txt"], sha256Hex("a-content"));
  assert.equal(hashes["b.txt"], sha256Hex("b-content"));
  assert.deepEqual(missing, []);
  assert.deepEqual(skipped, []);
});

test("computeAssetHashes reports missing files", t => {
  const dir = tempDir(t);
  writeFileSync(join(dir, "present.txt"), "x");
  const { hashes, missing } = computeAssetHashes(["present.txt", "gone.txt", "also/gone.txt"], { root: dir });
  assert.deepEqual(Object.keys(hashes), ["present.txt"]);
  assert.deepEqual(missing, ["also/gone.txt", "gone.txt"]);
});

test("computeAssetHashes expands directories recursively", t => {
  const dir = tempDir(t);
  mkdirSync(join(dir, "deploy", "sub"), { recursive: true });
  writeFileSync(join(dir, "deploy", "room-entry.mjs"), "entry");
  writeFileSync(join(dir, "deploy", "sub", "Caddyfile"), "caddy");
  writeFileSync(join(dir, "deploy", "sub", "deep.txt"), "deep");
  const { hashes, missing } = computeAssetHashes(["deploy"], { root: dir });
  assert.deepEqual(Object.keys(hashes), ["deploy/room-entry.mjs", "deploy/sub/Caddyfile", "deploy/sub/deep.txt"]);
  assert.equal(hashes["deploy/sub/deep.txt"], sha256Hex("deep"));
  assert.deepEqual(missing, []);
});

test("computeAssetHashes skips symlinks inside expanded directories", t => {
  const dir = tempDir(t);
  mkdirSync(join(dir, "deploy"));
  writeFileSync(join(dir, "deploy", "real.txt"), "real");
  try {
    symlinkSync(join(dir, "deploy", "real.txt"), join(dir, "deploy", "link.txt"));
  } catch {
    t.skip("symlinks not permitted on this platform");
    return;
  }
  const { hashes, skipped } = computeAssetHashes(["deploy"], { root: dir });
  assert.deepEqual(Object.keys(hashes), ["deploy/real.txt"]);
  assert.deepEqual(skipped, ["deploy/link.txt"]);
});

// --- diffManifests -----------------------------------------------------------

test("diffManifests passes on identical maps", () => {
  const expected = { "a.txt": "h1", "b.txt": "h2" };
  const actual = { "b.txt": "h2", "a.txt": "h1" };
  const diff = diffManifests(expected, actual);
  assert.equal(diff.ok, true);
  assert.deepEqual(diff.added, []);
  assert.deepEqual(diff.changed, []);
  assert.deepEqual(diff.removed, []);
  assert.deepEqual(diff.missing, []);
});

test("diffManifests reports added, changed, removed, and missing", () => {
  const expected = { "keep.txt": "h1", "mod.txt": "old", "del.txt": "h3" };
  const actual = { "keep.txt": "h1", "mod.txt": "new", "new.txt": "h4" };
  const diff = diffManifests(expected, actual, ["unreadable.txt"]);
  assert.equal(diff.ok, false);
  assert.deepEqual(diff.added, ["new.txt"]);
  assert.deepEqual(diff.changed, ["mod.txt"]);
  assert.deepEqual(diff.removed, ["del.txt"]);
  assert.deepEqual(diff.missing, ["unreadable.txt"]);
});

test("diffManifests is not fooled by Object.prototype keys", () => {
  const diff = diffManifests({}, { constructor: "h", toString: "h2" });
  assert.equal(diff.ok, false);
  assert.deepEqual(diff.added, ["constructor", "toString"]);
});

// --- manifest IO -------------------------------------------------------------

test("writeManifest/readManifest round-trip", t => {
  const dir = tempDir(t);
  const path = join(dir, DEFAULT_MANIFEST_NAME);
  const manifest = buildManifest({ "a.txt": "h1" }, { generatedAt: "2026-09-16T00:00:00.000Z" });
  assert.equal(manifest.version, 1);
  assert.equal(manifest.assetCount, 1);
  writeManifest(path, manifest);
  const back = readManifest(path);
  assert.deepEqual(back.assets, { "a.txt": "h1" });
  assert.equal(back.version, 1);
});

test("readManifest rejects missing, invalid, and shapeless manifests", t => {
  const dir = tempDir(t);
  assert.throws(() => readManifest(join(dir, "nope.json")), /run with --write first/);
  const bad = join(dir, "bad.json");
  writeFileSync(bad, "{not json");
  assert.throws(() => readManifest(bad), /not valid JSON/);
  const shapeless = join(dir, "shapeless.json");
  writeFileSync(shapeless, JSON.stringify({ version: 1 }));
  assert.throws(() => readManifest(shapeless), /no "assets" object/);
});

// --- checkLockfileSync -------------------------------------------------------

test("checkLockfileSync passes for an in-sync v3 lockfile", t => {
  const dir = tempDir(t);
  const { pkg, lock } = syncFixtures();
  writeJson(dir, "package.json", pkg);
  writeJson(dir, "package-lock.json", lock);
  const result = checkLockfileSync({ root: dir });
  assert.equal(result.ok, true);
  for (const name of ["lockfile-present", "package-json-parseable", "lockfile-parseable",
    "lockfile-name", "lockfile-version", "dependencies-in-sync", "no-extraneous-root-deps"]) {
    assert.equal(checkByName(result, name).ok, true, name);
  }
});

test("checkLockfileSync flags an out-of-sync spec", t => {
  const dir = tempDir(t);
  const { pkg, lock } = syncFixtures();
  lock.packages[""].devDependencies.eslint = "10.9.0";
  writeJson(dir, "package.json", pkg);
  writeJson(dir, "package-lock.json", lock);
  const result = checkLockfileSync({ root: dir });
  assert.equal(result.ok, false);
  const syncCheck = checkByName(result, "dependencies-in-sync");
  assert.equal(syncCheck.ok, false);
  assert.match(syncCheck.detail, /devDependencies\.eslint/);
  assert.match(syncCheck.detail, /"10\.10\.0".*"10\.9\.0"/);
});

test("checkLockfileSync flags a missing dependency entry", t => {
  const dir = tempDir(t);
  const { pkg, lock } = syncFixtures();
  delete lock.packages[""].dependencies.leftpad;
  writeJson(dir, "package.json", pkg);
  writeJson(dir, "package-lock.json", lock);
  const result = checkLockfileSync({ root: dir });
  assert.equal(result.ok, false);
  assert.match(checkByName(result, "dependencies-in-sync").detail, /dependencies\.leftpad/);
});

test("checkLockfileSync flags extraneous lockfile entries", t => {
  const dir = tempDir(t);
  const { pkg, lock } = syncFixtures();
  lock.packages[""].devDependencies.surprise = "9.9.9";
  writeJson(dir, "package.json", pkg);
  writeJson(dir, "package-lock.json", lock);
  const result = checkLockfileSync({ root: dir });
  assert.equal(result.ok, false);
  assert.match(checkByName(result, "no-extraneous-root-deps").detail, /devDependencies\.surprise/);
});

test("checkLockfileSync flags version and name drift", t => {
  const dir = tempDir(t);
  const { pkg, lock } = syncFixtures();
  lock.version = "9.9.9";
  lock.name = "other";
  lock.packages[""].version = "9.9.9";
  lock.packages[""].name = "other";
  writeJson(dir, "package.json", pkg);
  writeJson(dir, "package-lock.json", lock);
  const result = checkLockfileSync({ root: dir });
  assert.equal(result.ok, false);
  assert.equal(checkByName(result, "lockfile-version").ok, false);
  assert.equal(checkByName(result, "lockfile-name").ok, false);
});

test("checkLockfileSync fails cleanly on missing or broken lockfiles", t => {
  const dir = tempDir(t);
  writeJson(dir, "package.json", { name: "x", version: "1.0.0" });
  let result = checkLockfileSync({ root: dir });
  assert.equal(result.ok, false);
  assert.equal(checkByName(result, "lockfile-present").ok, false);

  writeFileSync(join(dir, "package-lock.json"), "{oops");
  result = checkLockfileSync({ root: dir });
  assert.equal(result.ok, false);
  assert.equal(checkByName(result, "lockfile-present").ok, true);
  assert.equal(checkByName(result, "lockfile-parseable").ok, false);
});

test("checkLockfileSync handles legacy v1 lockfiles", t => {
  const dir = tempDir(t);
  const pkg = { name: "legacy", version: "0.1.0", dependencies: { leftpad: "1.3.0" }, devDependencies: { tap: "^16.0.0" } };
  const lock = {
    name: "legacy", version: "0.1.0", lockfileVersion: 1,
    dependencies: { leftpad: { version: "1.3.0" }, tap: { version: "16.3.1" } },
  };
  writeJson(dir, "package.json", pkg);
  writeJson(dir, "package-lock.json", lock);
  assert.equal(checkLockfileSync({ root: dir }).ok, true);

  lock.dependencies.leftpad.version = "1.2.9";
  writeJson(dir, "package-lock.json", lock);
  const result = checkLockfileSync({ root: dir });
  assert.equal(result.ok, false);
  assert.match(checkByName(result, "dependencies-in-sync").detail, /leftpad/);
});

// --- runDeployChecks ----------------------------------------------------------

test("runDeployChecks passes on a fully in-sync fixture", t => {
  const dir = tempDir(t);
  const { pkg, lock } = syncFixtures();
  writeJson(dir, "package.json", pkg);
  writeJson(dir, "package-lock.json", lock);
  mkdirSync(join(dir, "deploy"));
  writeFileSync(join(dir, "deploy", "app.mjs"), "app");
  const manifestPath = join(dir, ".asset-hashes.json");
  writeManifest(manifestPath, buildManifest(computeAssetHashes(["deploy"], { root: dir }).hashes));
  const result = runDeployChecks({ root: dir, assets: ["deploy"], manifestPath });
  assert.equal(result.ok, true);
  assert.equal(result.lockfile.ok, true);
  assert.equal(result.assets.ok, true);
  assert.equal(result.assets.compared.ok, true);
});

test("runDeployChecks reports tampered assets with a clear diff", t => {
  const dir = tempDir(t);
  const { pkg, lock } = syncFixtures();
  writeJson(dir, "package.json", pkg);
  writeJson(dir, "package-lock.json", lock);
  mkdirSync(join(dir, "deploy"));
  writeFileSync(join(dir, "deploy", "app.mjs"), "app");
  writeFileSync(join(dir, "deploy", "cfg.txt"), "cfg");
  const manifestPath = join(dir, ".asset-hashes.json");
  writeManifest(manifestPath, buildManifest(computeAssetHashes(["deploy"], { root: dir }).hashes));
  // Tamper one file, delete another, add a third.
  writeFileSync(join(dir, "deploy", "app.mjs"), "app TAMPERED");
  rmSync(join(dir, "deploy", "cfg.txt"));
  writeFileSync(join(dir, "deploy", "extra.txt"), "extra");
  const result = runDeployChecks({ root: dir, assets: ["deploy"], manifestPath });
  assert.equal(result.ok, false);
  assert.equal(result.lockfile.ok, true);
  assert.deepEqual(result.assets.compared.changed, ["deploy/app.mjs"]);
  assert.deepEqual(result.assets.compared.removed, ["deploy/cfg.txt"]);
  assert.deepEqual(result.assets.compared.added, ["deploy/extra.txt"]);
});

test("runDeployChecks fails with a --write hint when the manifest is missing", t => {
  const dir = tempDir(t);
  const { pkg, lock } = syncFixtures();
  writeJson(dir, "package.json", pkg);
  writeJson(dir, "package-lock.json", lock);
  mkdirSync(join(dir, "deploy"));
  writeFileSync(join(dir, "deploy", "app.mjs"), "app");
  const result = runDeployChecks({ root: dir, assets: ["deploy"], manifestPath: join(dir, ".asset-hashes.json") });
  assert.equal(result.ok, false);
  assert.match(result.assets.note, /--write/);
});

test("runDeployChecks supports lockfile-only and assets-only runs", t => {
  const dir = tempDir(t);
  const { pkg, lock } = syncFixtures();
  writeJson(dir, "package.json", pkg);
  writeJson(dir, "package-lock.json", lock);
  let result = runDeployChecks({ root: dir, checkAssets: false });
  assert.equal(result.ok, true);
  assert.equal(result.assets, null);
  result = runDeployChecks({ root: dir, assets: [], checkLockfile: false });
  assert.equal(result.ok, true);
  assert.equal(result.lockfile, null);
  assert.match(result.assets.note, /no deploy assets configured/);
});

// --- CLI smoke -----------------------------------------------------------------

async function cli(args, { cwd } = {}) {
  try {
    const { stdout } = await execFileAsync(process.execPath, [scriptPath, ...args], {
      cwd: cwd || process.cwd(), encoding: "utf8", timeout: 30000,
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    return { status: error.code ?? 1, stdout: String(error.stdout ?? ""), stderr: String(error.stderr ?? "") };
  }
}

test("CLI --write then --check round-trip in a fixture root", async t => {
  const dir = tempDir(t);
  const { pkg, lock } = syncFixtures();
  writeJson(dir, "package.json", pkg);
  writeJson(dir, "package-lock.json", lock);
  mkdirSync(join(dir, "deploy"));
  writeFileSync(join(dir, "deploy", "app.mjs"), "app");

  const written = await cli(["--write", "--root", dir, "--assets", "deploy"]);
  assert.equal(written.status, 0);
  assert.match(written.stdout, /"mode":"write"/);
  assert.match(written.stdout, /"assetCount":1/);

  const checked = await cli(["--check", "--root", dir, "--assets", "deploy"]);
  assert.equal(checked.status, 0);
  assert.match(checked.stdout, /"ok":true/);

  writeFileSync(join(dir, "deploy", "app.mjs"), "app TAMPERED");
  const failed = await cli(["--check", "--root", dir, "--assets", "deploy"]);
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /deploy-checks: FAILED/);
  assert.match(failed.stderr, /changed: deploy\/app\.mjs/);
});

test("CLI --write refuses missing assets and rejects conflicting flags", async t => {
  const dir = tempDir(t);
  const missing = await cli(["--write", "--root", dir, "--assets", "nope/"]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /missing or unreadable/);

  const conflict = await cli(["--check", "--write", "--root", dir]);
  assert.equal(conflict.status, 2);
  assert.match(conflict.stderr, /mutually exclusive/);

  const help = await cli(["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /reproducible deploy checks/);
});
