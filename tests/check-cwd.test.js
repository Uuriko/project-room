// Guild-06 hardening: scripts/check.mjs resolves every path relative to the
// repository root, not the caller's cwd. Invoking it from any other directory
// must not crash with a raw ENOENT stack trace at module load.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

test("check.mjs from a foreign cwd: no ENOENT stack trace, keeps working", () => {
  const foreign = mkdtempSync(join(tmpdir(), "check-cwd-"));
  // Pre-fix this exited in <2s with `Error: ENOENT ... scandir 'cloudflare'`.
  // Post-fix the module anchors to the repo root and proceeds into the long
  // check pipeline, so the 15s timeout is what stops it — that is the green.
  const r = spawnSync(process.execPath, [join(root, "scripts", "check.mjs")], {
    encoding: "utf8", timeout: 15000, cwd: foreign, env: { ...process.env, TMPDIR: foreign },
  });
  assert.doesNotMatch(r.stderr ?? "", /scandir 'cloudflare'/, "no raw ENOENT scandir crash");
  assert.doesNotMatch(r.stderr ?? "", /^\s*at\s/m, "no stack trace on stderr");
  assert.equal(r.signal, "SIGTERM", `check.mjs should still be running its pipeline when the timeout hits (status=${r.status}, signal=${r.signal})`);
});
