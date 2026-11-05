import test from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
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

function run(checkout, args, env = process.env) {
  return new Promise(resolve => {
    execFile(process.execPath, [script, ...args], { cwd: checkout, env, encoding: "utf8", timeout: 15000 }, (error, stdout, stderr) => {
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
  assert.equal(JSON.parse(ok.stdout).sourceBinding, "unverified_import");
});

test("recorded execution binds clean source, exit status and actual log digest without argv", async t => {
  const { dir, checkout } = fixture(t), output = join(dir, "evidence");
  const result = await run(checkout, ["--record", output, "--", process.execPath, "-e", "console.log('test-output')"]);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(readFileSync(join(output, "evidence.json")));
  assert.equal(report.status, "passed");
  assert.equal(report.sourceBinding, "observed_unchanged");
  assert.deepEqual(report.before, report.after);
  assert.equal(report.exitCode, 0);
  assert.equal(report.logSha256, createHash("sha256").update(readFileSync(join(output, "run.log"))).digest("hex"));
  assert.equal(JSON.stringify(report).includes("console.log"), false);
  const duplicate = await run(checkout, ["--record", output, "--", process.execPath, "-e", "process.exit(0)"]);
  assert.equal(duplicate.status, 2, "previous evidence must not be overwritten");
  assert.equal(JSON.parse(readFileSync(join(output, "evidence.json"))).commandDigest, report.commandDigest);
});

test("a passing TAP footer cannot mask nonzero process exit", async t => {
  const { dir, checkout } = fixture(t);
  const result = await run(checkout, ["--record", join(dir, "failed"), "--", process.execPath, "-e", `console.log(${JSON.stringify(tapPassed)});process.exit(7)`]);
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.exitCode, 7); assert.equal(report.suite.label, "passed"); assert.equal(report.status, "failed");
});

test("source changes during execution invalidate successful command evidence", async t => {
  const { dir, checkout } = fixture(t);
  const result = await run(checkout, ["--record", join(dir, "changed"), "--", process.execPath, "-e", "require('fs').writeFileSync('candidate.txt','changed')"]);
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).status, "source_changed_or_dirty");
});

test("timeout persists failure instead of a successful or endlessly running receipt", async t => {
  const { dir, checkout } = fixture(t);
  const result = await run(checkout, ["--record", join(dir, "timeout"), "--timeout-ms", "150", "--", process.execPath, "-e", "setInterval(()=>{},1000)"]);
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, "failed");assert.equal(report.interruption, "timeout");assert.equal(report.signal, "SIGKILL");
});

test("dirty source and output inside checkout are refused before execution", async t => {
  const { dir, checkout } = fixture(t), output = join(dir, "refused");
  writeFileSync(join(checkout, "candidate.txt"), "dirty");
  const result = await run(checkout, ["--record", output, "--", process.execPath, "-e", "process.exit(0)"]);
  assert.equal(result.status, 2);assert.equal(existsSync(output), false);
});

test("recorder interruption persists the interrupted attempt", async t => {
  const { dir, checkout } = fixture(t), output = join(dir, "interrupted");
  const child = spawn(process.execPath, [script, "--record", output, "--", process.execPath, "-e", "setInterval(()=>{},1000)"],
    { cwd: checkout, stdio: "ignore" });
  t.after(() => { if (child.exitCode === null) child.kill("SIGTERM"); });
  const completed = new Promise(resolve => child.once("close", code => resolve(code)));
  const path = join(output, "evidence.json");
  for (let i = 0; i < 100 && !existsSync(path); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(existsSync(path), true, "intent persisted before command completion");
  // Allow the signal handler to be installed after the synchronous intent write.
  await new Promise(resolve => setTimeout(resolve, 50));
  child.kill("SIGTERM");
  assert.equal(await completed, 1);
  const report = JSON.parse(readFileSync(path));
  assert.equal(report.interruption, "SIGTERM");assert.equal(report.status, "failed");
});

test("recording inside even a clean checkout is rejected", async t => {
  const { checkout } = fixture(t);
  const result = await run(checkout, ["--record", join(checkout, "evidence"), "--", process.execPath, "-e", "process.exit(0)"]);
  assert.equal(result.status, 2);assert.equal(existsSync(join(checkout, "evidence")), false);
});

test("Git environment overrides cannot substitute a clean unrelated checkout", async t => {
  const a = fixture(t), b = fixture(t);
  writeFileSync(join(a.checkout, "candidate.txt"), "dirty actual workspace");
  const result = await run(a.checkout, ["--record", join(a.dir, "wrong-repo"), "--", process.execPath, "-e", "process.exit(0)"],
    { ...process.env, GIT_DIR: join(b.checkout, ".git"), GIT_WORK_TREE: b.checkout });
  assert.equal(result.status, 2);assert.equal(existsSync(join(a.dir, "wrong-repo")), false);
});

test("timeout is bounded when an escaped descendant keeps output pipes open", async t => {
  const { dir, checkout } = fixture(t), pidPath = join(dir, "descendant.pid");
  const code = `const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:['ignore',1,2]});require('fs').writeFileSync(${JSON.stringify(pidPath)},String(c.pid));setInterval(()=>{},1000)`;
  const start = Date.now();
  try {
    const result = await run(checkout, ["--record", join(dir, "escaped"), "--timeout-ms", "500", "--", process.execPath, "-e", code]);
    assert.equal(result.status, 1);assert.ok(Date.now() - start < 10000);
    const report = JSON.parse(result.stdout);
    assert.equal(report.status, "failed");assert.equal(report.cleanupUnresolved, true);
  } finally {
    if (existsSync(pidPath)) try { process.kill(Number(readFileSync(pidPath, "utf8")), "SIGKILL"); } catch { /* already gone */ }
  }
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
