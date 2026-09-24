import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const checkout = fileURLToPath(new URL("..", import.meta.url));
const script = fileURLToPath(new URL("../scripts/release-evidence.mjs", import.meta.url));
const tapPassed = "TAP version 13\n# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n";

function run(args) {
  return new Promise(resolve => {
    execFile(process.execPath, [script, ...args], { cwd: checkout, encoding: "utf8", timeout: 15000 }, (error, stdout, stderr) => {
      resolve({ status: error?.code ?? 0, stdout: stdout ?? "", stderr: stderr ?? "" });
    });
  });
}

test("a supplied probe that is not live makes the release-evidence command fail", async () => {
  const dir = mkdtempSync(join(tmpdir(), "release-evidence-"));
  const tap = join(dir, "tap.txt");
  const probes = join(dir, "probes.json");
  writeFileSync(tap, tapPassed);
  writeFileSync(probes, JSON.stringify([{ url: "https://room.example/api/version", status: 404 }]));
  const failed = await run(["--tap", tap, "--probes", probes]);
  assert.equal(failed.status, 1, failed.stdout + failed.stderr);
  const manifest = JSON.parse(failed.stdout);
  assert.equal(manifest.live, "mismatch");
  assert.equal(manifest.suite.label, "passed");
  assert.equal(manifest.candidate, "clean");
});

test("a supplied matching digest can still exit successfully", async () => {
  const dir = mkdtempSync(join(tmpdir(), "release-evidence-"));
  const tap = join(dir, "tap.txt");
  const probes = join(dir, "probes.json");
  writeFileSync(tap, tapPassed);
  writeFileSync(probes, JSON.stringify([{ url: "https://room.example/api/version", status: 200, expectedSha256: "abc", actualSha256: "abc" }]));
  const ok = await run(["--tap", tap, "--probes", probes]);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.equal(JSON.parse(ok.stdout).live, "live");
});

test("omitting probes keeps a passed clean tree successful", async () => {
  const dir = mkdtempSync(join(tmpdir(), "release-evidence-"));
  const tap = join(dir, "tap.txt");
  writeFileSync(tap, tapPassed);
  const ok = await run(["--tap", tap]);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.equal(JSON.parse(ok.stdout).live, "unverified");
});
