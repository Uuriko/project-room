// RH-11: wake-queue lease race — two processes race lease() on the same due
// wake. lease() is ONE conditional UPDATE (state='pending' -> 'leased').
// Expectation: exactly one process gets the wake (changes=1); the other gets
// null. No double-lease, attempts incremented exactly once.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const REPO = process.env.REPO;
if (!REPO) { console.error("REPO env required"); process.exit(1); }
const { WakeQueue, wakeQueueSchema } = await import(REPO + "/server/wake-queue.mjs");

const ROUNDS = Number(process.env.ITERS || 150);
const dir = mkdtempSync(join(tmpdir(), "rh11-"));
const dbPath = join(dir, "wake.db");
{
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=8000; PRAGMA foreign_keys=OFF;");
  db.exec(wakeQueueSchema);
  // lease()'s pause check references wake_queue_pause; create it (empty)
  db.exec("CREATE TABLE IF NOT EXISTS wake_queue_pause(room_id TEXT, member_id TEXT, paused_at INTEGER, reason TEXT)");
  db.close();
}
const driver = `
import { DatabaseSync } from "node:sqlite";
const REPO = ${JSON.stringify(REPO)};
const { WakeQueue } = await import(REPO + "/server/wake-queue.mjs");
const [room, member, key, owner] = [process.argv[1], process.argv[2], process.argv[3], process.argv[4]];
const db = new DatabaseSync(${JSON.stringify(dbPath)});
db.exec("PRAGMA busy_timeout=8000; PRAGMA foreign_keys=OFF;");
const store = { db, now: () => Date.now(), transaction: fn => fn(), readTransaction: fn => fn() };
const wq = new WakeQueue(store);
try {
  const got = wq.lease(room, member, key, owner);
  console.log(got ? "LEASED attempts=" + got.attempts : "NULL");
} catch (e) { console.log("ERROR " + String(e.message ?? e).slice(0, 160)); }
db.close();
`;
const runChild = (room, member, key, owner) => new Promise(resolve => {
  const child = spawn(process.execPath, ["--input-type=module", "-e", driver, room, member, key, owner],
    { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", d => { out += d; });
  child.on("close", () => resolve(out.trim()));
  child.on("error", e => resolve("SPAWN_ERROR " + e.message));
});
let bad = 0, doubleLease = 0, noLease = 0;
try {
  for (let i = 0; i < ROUNDS; i++) {
    const room = "r1", member = "m1", key = `wake-${i}`;
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA foreign_keys=OFF;");
    const now = Date.now();
    db.prepare("INSERT INTO wake_queue(room_id,member_id,queue_key,intent,state,due_at,attempts,max_attempts,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run(room, member, key, "test", "pending", now - 1000, 0, 3, now, now);
    db.close();
    const [r1, r2] = await Promise.all([runChild(room, member, key, "owner-a"), runChild(room, member, key, "owner-b")]);
    const l1 = r1.startsWith("LEASED"), l2 = r2.startsWith("LEASED");
    if (l1 && l2) { doubleLease++; bad++; }
    else if (!l1 && !l2) { noLease++; bad++; console.log(`round ${i}: NEITHER leased [${r1}] [${r2}]`); }
    if (i === 0) console.log(`sample: [${r1}] [${r2}]`);
  }
  const db = new DatabaseSync(dbPath);
  const overAttempted = db.prepare("SELECT COUNT(*) n FROM wake_queue WHERE attempts != 1").get().n;
  db.close();
  if (overAttempted > 0) { bad += overAttempted; console.log(`attempts!=1 rows: ${overAttempted}`); }
  console.log(`RH-11: ${ROUNDS} rounds, double-lease=${doubleLease}, no-lease=${noLease}, bad-attempts=${overAttempted}`);
  console.log(bad === 0 ? "RH-11 RESULT: PASS — exactly one lease winner per wake"
    : `RH-11 RESULT: FAIL — ${bad} anomalies`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(bad === 0 ? 0 : 2);
