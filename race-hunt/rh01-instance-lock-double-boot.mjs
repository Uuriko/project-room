// RH-01: instance-lock empty-file reclaim race — deterministic double-hold repro.
//
// The window: acquireInstanceLock does openSync(lockPath, "wx") and THEN
// writeSync(fd, payload) as two separate steps. A racing boot that hits
// EEXIST between those two steps reads an EMPTY file, treats it as
// "malformed → stale", unlinks the live creator's lock, and acquires it too.
// Both processes then believe they hold the lock → two server.mjs on one DB.
import { openSync, writeSync, closeSync, readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const REPO = process.env.REPO;
if (!REPO) { console.error("REPO env required"); process.exit(1); }
const dir = mkdtempSync(join(tmpdir(), "rh01-"));
const lockPath = join(dir, "test.lock");
let failed = false;
try {
  // Process A: create() succeeded; writeSync not yet reached (the real window).
  const fdA = openSync(lockPath, "wx", 0o600);
  // Process B: the REAL acquireInstanceLock, racing inside A's window.
  const child = spawnSync(process.execPath,
    ["--input-type=module", "-e", `
      import { acquireInstanceLock } from ${JSON.stringify(REPO + "/server/instance-lock.mjs")};
      try {
        const lock = acquireInstanceLock(${JSON.stringify(lockPath)});
        console.log("B_ACQUIRED pid=" + lock.pid);
      } catch (e) { console.log("B_REFUSED code=" + e.code); }
    `], { encoding: "utf8", timeout: 15000 });
  const bOut = (child.stdout || "").trim();
  console.log("B:", bOut || "(no output)", child.error ? `ERR ${child.error.message}` : "");
  // Process A continues: writes its payload — to the now-unlinked inode.
  writeSync(fdA, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  closeSync(fdA);
  const bAcquired = bOut.includes("B_ACQUIRED");
  const onDisk = existsSync(lockPath) ? JSON.parse(readFileSync(lockPath, "utf8")) : null;
  console.log(`on-disk lock pid=${onDisk?.pid} (B's)`);
  if (bAcquired) {
    console.log("RH-01 RESULT: RACE CONFIRMED — A and B both hold the lock (double boot on one DB)");
    failed = true;
  } else {
    console.log("RH-01 RESULT: PASS — racing boot refused while creator's file was mid-write");
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(failed ? 2 : 0);
