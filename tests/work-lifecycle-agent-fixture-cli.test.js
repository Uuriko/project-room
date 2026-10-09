// CLI arg-parsing test for scripts/work-lifecycle-agent-fixture.mjs (guild-06 fuzz).
// A flag-like argument must be rejected with usage + exit 2 — never treated as
// the evidence output path (which created rogue files named "--help").
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../scripts/work-lifecycle-agent-fixture.mjs", import.meta.url));
const NO_STACK = /^\s*at\s/m;

test("flag-like args are rejected, never used as the evidence path", t => {
  const dir = mkdtempSync(join(tmpdir(), "work-lifecycle-cli-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const arg of ["--help", "--bogus-flag-xyz"]) {
    const r = spawnSync(process.execPath, [script, arg], { encoding: "utf8", timeout: 20000, cwd: dir });
    assert.equal(r.status, 2, `expected exit 2 for ${arg}, got ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /Usage:/i, "usage goes to stderr");
    assert.doesNotMatch(r.stderr, /^\s*at\s/m, "no stack trace on usage error");
    assert.equal(existsSync(join(dir, arg)), false, `must not create a file named ${arg}`);
  }
});

// Guild-06 worker-50 fail-first: the evidence path is opened with flag "wx"
// (refuse to overwrite). A pre-existing path must be refused cleanly and fast
// — stderr + exit 2 — instead of starting the whole fixture and crashing on
// SIGTERM with an EEXIST unhandled-rejection stack trace.
test("an existing evidence file is refused before the fixture starts", t => {
  const dir = mkdtempSync(join(tmpdir(), "work-lifecycle-eexist-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const outFile = join(dir, "evidence.json");
  writeFileSync(outFile, "{}\n");
  const r = spawnSync(process.execPath, [script, outFile], { encoding: "utf8", timeout: 20000, cwd: dir });
  assert.equal(r.status, 2, `expected exit 2, got ${r.status}: ${r.stderr}`);
  assert.match(r.stderr, /refusing to overwrite/i, "clean refusal on stderr");
  assert.doesNotMatch(r.stderr, NO_STACK, "no stack trace");
  assert.doesNotMatch(r.stdout, /manifestFile/, "fixture never started");
});

// Racy twin: the file appears after startup (between the pre-flight check and
// the SIGTERM-time write). stop() must report it cleanly, not as an
// unhandled rejection.
test("a file created after startup is refused cleanly on SIGTERM", async t => {
  const dir = mkdtempSync(join(tmpdir(), "work-lifecycle-eexist-race-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const outFile = join(dir, "evidence.json");
  const child = spawn(process.execPath, [script, outFile], { cwd: dir });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  let stdout = "", stderr = "";
  child.stdout.on("data", d => { stdout += d; });
  child.stderr.on("data", d => { stderr += d; });
  // Wait for the manifest line: the fixture is up and idling for SIGTERM.
  const deadline = Date.now() + 60000;
  while (!stdout.includes("manifestFile") && Date.now() < deadline) {
    if (child.exitCode !== null) break;
    await new Promise(r => setTimeout(r, 250));
  }
  assert.ok(stdout.includes("manifestFile"), `fixture never came up: ${stderr.slice(0, 500)}`);
  writeFileSync(outFile, "{}\n"); // create it after the pre-flight check ran
  child.kill("SIGTERM");
  const code = await new Promise(resolve => {
    const to = setTimeout(() => resolve("timeout"), 30000);
    child.on("exit", c => { clearTimeout(to); resolve(c); });
  });
  assert.equal(code, 2, `expected exit 2, got ${code}: ${stderr.slice(0, 500)}`);
  assert.match(stderr, /refusing to overwrite/i, "clean refusal on stderr");
  assert.doesNotMatch(stderr, NO_STACK, "no stack trace");
  assert.doesNotMatch(stderr, /EEXIST/, "no raw EEXIST leak");
});
