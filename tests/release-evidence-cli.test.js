import test from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../scripts/release-evidence.mjs", import.meta.url));
const tapPassed = "TAP version 13\n# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n";

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "release-evidence-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const checkout = join(dir, "checkout");
  mkdirSync(checkout);
  writeFileSync(join(checkout, "candidate.txt"), "Committed candidate\n");
  const git = args => execFileSync("git", ["-c", "core.hooksPath=/dev/null",
    "-c", "user.name=Release fixture", "-c", "user.email=fixture@example.invalid", ...args],
  { cwd: checkout, encoding: "utf8" });
  git(["init", "--quiet"]);
  git(["add", "candidate.txt"]);
  git(["commit", "--quiet", "-m", "Release fixture"]);
  const tap = join(dir, "tap.txt");
  writeFileSync(tap, tapPassed);
  return { dir, checkout, tap };
}

function run(checkout, args) {
  return new Promise(resolve => {
    execFile(process.execPath, [script, ...args], { cwd: checkout, encoding: "utf8", timeout: 15000 }, (error, stdout, stderr) => {
      resolve({ status: error?.code ?? 0, stdout: stdout ?? "", stderr: stderr ?? "" });
    });
  });
}

test("a supplied probe that is not live makes the release-evidence command fail", async t => {
  const { dir, checkout, tap } = fixture(t);
  const probes = join(dir, "probes.json");
  writeFileSync(probes, JSON.stringify([{ url: "https://room.example/api/version", status: 404 }]));
  const failed = await run(checkout, ["--tap", tap, "--probes", probes]);
  assert.equal(failed.status, 1, failed.stdout + failed.stderr);
  const manifest = JSON.parse(failed.stdout);
  assert.equal(manifest.live, "mismatch");
  assert.equal(manifest.suite.label, "passed");
  assert.equal(manifest.candidate, "clean");
});

test("a supplied matching digest can still exit successfully", async t => {
  const { dir, checkout, tap } = fixture(t);
  const probes = join(dir, "probes.json");
  writeFileSync(probes, JSON.stringify([{ url: "https://room.example/api/version", status: 200, expectedSha256: "abc", actualSha256: "abc" }]));
  const ok = await run(checkout, ["--tap", tap, "--probes", probes]);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.equal(JSON.parse(ok.stdout).live, "live");
});

test("omitting probes keeps a passed clean tree successful", async t => {
  const { checkout, tap } = fixture(t);
  const ok = await run(checkout, ["--tap", tap]);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.equal(JSON.parse(ok.stdout).live, "unverified");
});

test("a dirty candidate is refused even when its suite and supplied digest pass", async t => {
  const { dir, checkout, tap } = fixture(t);
  writeFileSync(join(checkout, "candidate.txt"), "Uncommitted change\n");
  const probes = join(dir, "probes.json");
  writeFileSync(probes, JSON.stringify([{ url: "https://room.example/api/version", status: 200,
    expectedSha256: "abc", actualSha256: "abc" }]));
  const refused = await run(checkout, ["--tap", tap, "--probes", probes]);
  assert.equal(refused.status, 1, refused.stdout + refused.stderr);
  const manifest = JSON.parse(refused.stdout);
  assert.equal(manifest.candidate, "dirty");
  assert.equal(manifest.suite.label, "passed");
  assert.equal(manifest.live, "live");
});
