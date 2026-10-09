// Worker-46 fail-first: worker-ci-build.mjs temp-config cleanup must not mask
// the original write failure. If writing the temp wrangler config fails (here:
// a directory squats at the pid-unique path), the finally-block unlink must
// not throw and hide the real error behind ENOENT/EPERM.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

test("worker-ci-build.mjs: a failed temp-config write surfaces the write error, not a cleanup error", async () => {
  // The script derives its cloudflare dir from its own location, so stage a
  // copy of the CURRENT script under a scratch layout and point it at a stub
  // wrangler.jsonc whose build command carries the expected signer.
  const stage = join(tmpdir(), `w46-worker-ci-build-${process.pid}`);
  const scriptsDir = join(stage, "scripts");
  const cfDir = join(stage, "cloudflare");
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(cfDir, { recursive: true });
  const staged = join(scriptsDir, "worker-ci-build.mjs");
  writeFileSync(staged, readFileSync(join(root, "scripts", "worker-ci-build.mjs"), "utf8"));
  writeFileSync(join(cfDir, "wrangler.jsonc"), JSON.stringify({
    build: { command: "node ../scripts/sign-agent-card.mjs && node build-assets.mjs" },
  }));

  const child = spawn(process.execPath, [staged], { encoding: "utf8" });
  // Race the child's startup: squat a directory at its pid-unique temp path
  // so the 'wx' writeFileSync fails with EEXIST before wrangler ever runs.
  const squat = join(cfDir, `.ci-dry-run-${child.pid}.json`);
  mkdirSync(squat, { recursive: true });
  const result = await new Promise((resolve) => {
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
  try {
    assert.notEqual(result.code, 0, "the script must fail when the temp config cannot be written");
    // The squatted directory makes the 'wx' open fail with EEXIST; the
    // finally-block unlink of a directory throws EISDIR. The surfaced error
    // must be the original EEXIST, never the cleanup EISDIR/ENOENT/EPERM.
    assert.match(result.stderr, /EEXIST/, "the original write error (EEXIST) is what surfaces");
    assert.doesNotMatch(result.stderr, /EISDIR|ENOENT|EPERM/, "no cleanup error masks the original failure");
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
});

// Sanity: the real script still rejects deployment arguments with usage + exit 2.
test("worker-ci-build.mjs --bogus: usage error exits 2", () => {
  const r = spawnSync(process.execPath, [join(root, "scripts", "worker-ci-build.mjs"), "--bogus"], {
    encoding: "utf8", timeout: 20000, cwd: root,
  });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Usage:/i);
});
