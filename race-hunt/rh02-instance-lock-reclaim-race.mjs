// RH-02: two boots racing a stale-lock reclaim — exactly one winner per round.
// A stale lock (dead pid) is reclaimed exactly once; the loser must get a
// coded refusal, never a second acquisition.
import { writeFileSync, mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const REPO = process.env.REPO;
if (!REPO) { console.error("REPO env required"); process.exit(1); }
const ITERS = Number(process.env.ITERS || 200);
const dir = mkdtempSync(join(tmpdir(), "rh02-"));

const driver = `
import { acquireInstanceLock } from ${JSON.stringify(REPO + "/server/instance-lock.mjs")};
try {
  const l = acquireInstanceLock(process.argv[1]);
  console.log("ACQUIRED pid=" + l.pid);
  l.release();
} catch (e) { console.log("REFUSED code=" + e.code); }
`;
const runChild = lockPath => new Promise(resolve => {
  const child = spawn(process.execPath, ["--input-type=module", "-e", driver, lockPath], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", d => { out += d; });
  child.on("close", () => resolve(out.trim()));
  child.on("error", e => resolve("SPAWN_ERROR " + e.message));
});

let bad = 0, doubleHold = 0, refusedBoth = 0;
try {
  for (let i = 0; i < ITERS; i++) {
    const lockPath = join(dir, `t${i}.lock`);
    writeFileSync(lockPath, JSON.stringify({ pid: 2147483646, startedAt: "2020-01-01T00:00:00.000Z" }), { mode: 0o600 });
    const [r1, r2] = await Promise.all([runChild(lockPath), runChild(lockPath)]);
    const won1 = r1.startsWith("ACQUIRED"), won2 = r2.startsWith("ACQUIRED");
    if (won1 && won2) { doubleHold++; bad++; }
    else if (!won1 && !won2) { refusedBoth++; bad++; }
    // exactly one winner expected; loser may be instance_lock_held or instance_lock_io
    if (i === 0) console.log(`sample round: [${r1}] [${r2}]`);
  }
  console.log(`RH-02: ${ITERS} rounds, double-hold=${doubleHold}, both-refused=${refusedBoth}`);
  console.log(bad === 0
    ? "RH-02 RESULT: PASS — stale reclaim has exactly one winner per round"
    : `RH-02 RESULT: FAIL — ${bad} anomalous rounds`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(bad === 0 ? 0 : 2);
