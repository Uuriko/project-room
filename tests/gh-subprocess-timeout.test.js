// Fail-first regression test (guild-06 WAVE-1000 fuzz finding, 2026-10-09).
//
// Scripts that shell out to `gh` must bound the subprocess: when gh stalls
// (network blip, auth prompt, proxy hang) the script must exit on its own,
// never hang forever. Repro: put a hanging `gh` first on PATH and run the
// script — before the fix it never exits (this test fails via ETIMEDOUT);
// after adding a `timeout` to the execFileSync options it exits promptly.
//
// Bound contract: the test allows 60s. The fix must bound gh calls well under
// that (30s suggested: `gh api --paginate` over #266 comments is seconds when
// healthy).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const BOUND_MS = 60_000;

function runWithHangingGh(scriptRel, args) {
  const dir = mkdtempSync(join(tmpdir(), "gh-timeout-"));
  const fakeGh = join(dir, "gh");
  writeFileSync(fakeGh, "#!/bin/sh\nsleep 300\n");
  chmodSync(fakeGh, 0o755);
  return spawnSync(process.execPath, [join(repoRoot, scriptRel), ...args], {
    env: { ...process.env, PATH: dir + delimiter + process.env.PATH },
    timeout: BOUND_MS,
    encoding: "utf8",
    cwd: dir,
  });
}

function assertBounded(name, result) {
  assert.notEqual(
    result.error?.code,
    "ETIMEDOUT",
    `${name} hung waiting for gh: no timeout on the gh subprocess ` +
      `(killed by the ${BOUND_MS / 1000}s test bound). ` +
      `Add a timeout to the execFileSync gh call.`,
  );
}

test("claims-index.mjs exits on its own when gh stalls (does not hang)", () => {
  const r = runWithHangingGh("scripts/claims-index.mjs", ["--format", "json", "--out", "out"]);
  assertBounded("scripts/claims-index.mjs", r);
});

test("merge-queue-dryrun.mjs exits on its own when gh stalls (does not hang)", () => {
  const r = runWithHangingGh("scripts/merge-queue-dryrun.mjs", []);
  assertBounded("scripts/merge-queue-dryrun.mjs", r);
});
