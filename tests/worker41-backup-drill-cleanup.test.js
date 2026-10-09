// WORKER-41 (guild-06): backup-drill must not litter os.tmpdir() when it
// fails mid-run. The drill creates two mkdtemp dirs up front and used to
// remove them only on the success path; any failing assertion left
// room-backup-drill-* / room-backup-dest-* behind. This test runs a copy of
// the script with a forced failure injected right after the temp dirs are
// created and asserts nothing is left behind.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const ANCHOR = 'backupDir = mkdtempSync(join(tmpdir(), "room-backup-dest-"));';
const PREFIXES = ["room-backup-drill-", "room-backup-dest-"];

function drillTmpDirs() {
  return new Set(
    readdirSync(tmpdir()).filter((n) => PREFIXES.some((p) => n.startsWith(p))),
  );
}

test("backup-drill cleans up its temp dirs when it fails mid-run", () => {
  const src = readFileSync(join(root, "scripts", "backup-drill.mjs"), "utf8");
  assert.ok(src.includes(ANCHOR), "injection anchor present in scripts/backup-drill.mjs");
  const failing = src.replace(
    ANCHOR,
    `${ANCHOR}\nthrow new Error("worker41-simulated-drill-failure");`,
  );
  // The copy lives next to the real script so both ../server/* and
  // ./backup-verify.mjs imports resolve; it is removed in finally.
  const copyPath = join(root, "scripts", "drill-fail-copy-worker41.mjs");
  writeFileSync(copyPath, failing);
  try {
    const before = drillTmpDirs();
    const r = spawnSync(process.execPath, [copyPath], {
      encoding: "utf8", timeout: 120000, cwd: root,
    });
    assert.notEqual(r.status, 0, "the injected failure must fail the drill");
    assert.match(r.stderr, /worker41-simulated-drill-failure/, "the failure surfaces");
    const leaked = [...drillTmpDirs()].filter((n) => !before.has(n));
    assert.deepEqual(leaked, [], `temp dirs leaked in os.tmpdir(): ${leaked.join(", ")}`);
  } finally {
    rmSync(copyPath, { force: true });
  }
});
