// WORKER-40 (guild-06 shard 40): request-host-fixture's `stop()` must fail
// cleanly when the evidence file already exists — one stderr line and exit 1,
// never an unhandled-rejection stack trace. The script needs a TTY, so the
// tests drive it through `script(1)` (skipped when unavailable).
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

function ptyAvailable() {
  try { execSync("command -v script", { stdio: "ignore" }); return true; }
  catch { return false; }
}

// Runs the fixture under a pty, feeds `finish`, returns the child result.
function runFixture(t, evidencePath) {
  const r = spawnSync("script", ["-qec", `node scripts/request-host-fixture.mjs ${evidencePath}`, "/dev/null"], {
    encoding: "utf8", timeout: 60000, cwd: root, input: "finish\n",
    env: { ...process.env, TMPDIR: join(root, ".tmp") },
  });
  return r;
}

test("evidence write to an existing file fails cleanly (exit 1, no stack)", { timeout: 90000 }, async t => {
  if (!ptyAvailable()) { t.skip("script(1) not available"); return; }
  const dir = mkdtempSync(join(tmpdir(), "w40-rhf-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const evidencePath = join(dir, "evidence.json");
  writeFileSync(evidencePath, "PRE-EXISTING\n");
  const r = runFixture(t, evidencePath);
  assert.equal(r.status, 1, `expected exit 1, got ${r.status}: ${(r.stderr || "").slice(0, 400)}`);
  assert.match(r.stderr || r.stdout, /request-host-fixture: cannot write evidence file/, "clean one-line error");
  assert.doesNotMatch(r.stderr || "", /^\s*at\s+\S+\s+\(node:/m, "no stack trace");
  assert.equal(readFileSync(evidencePath, "utf8"), "PRE-EXISTING\n", "existing evidence file is not clobbered");
});

test("happy path still writes evidence and exits 0", { timeout: 90000 }, async t => {
  if (!ptyAvailable()) { t.skip("script(1) not available"); return; }
  const dir = mkdtempSync(join(tmpdir(), "w40-rhf-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const evidencePath = join(dir, "evidence.json");
  const r = runFixture(t, evidencePath);
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}: ${(r.stderr || "").slice(0, 400)}`);
  const parsed = JSON.parse(readFileSync(evidencePath, "utf8"));
  assert.equal(parsed.kind, "native-host-request-exercise");
});
