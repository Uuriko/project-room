// RH-05: concurrent claim acquisition race — two processes, one unclaimed
// work item, durable registry, BEGIN IMMEDIATE. Expectation: exactly one
// winner per round; the loser gets a coded refusal (already claimed).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const REPO = process.env.REPO;
if (!REPO) { console.error("REPO env required"); process.exit(1); }
const { createWork, claimWork } = await import(REPO + "/server/work-claims.mjs");
const { createDurableWorkClaimRegistry, workClaimSchema } = await import(REPO + "/server/work-claim-sqlite.mjs");

const ITERS = Number(process.env.ITERS || 100);
const dir = mkdtempSync(join(tmpdir(), "rh05-"));
const dbPath = join(dir, "claims.db");
const setupDb = new DatabaseSync(dbPath);
setupDb.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=8000;");
setupDb.exec(workClaimSchema);
setupDb.close();

const driver = `
import { DatabaseSync } from "node:sqlite";
const REPO = ${JSON.stringify(REPO)};
const { claimWork } = await import(REPO + "/server/work-claims.mjs");
const { createDurableWorkClaimRegistry } = await import(REPO + "/server/work-claim-sqlite.mjs");
const [dbPath, room, claimId, agent] = [process.argv[1], process.argv[2], process.argv[3], process.argv[4]];
const db = new DatabaseSync(dbPath);
db.exec("PRAGMA busy_timeout=8000;");
const txn = fn => { db.exec("BEGIN IMMEDIATE"); try { const r = fn(); db.exec("COMMIT"); return r; } catch (e) { try { db.exec("ROLLBACK"); } catch {} throw e; } };
const reg = createDurableWorkClaimRegistry(db, { transaction: txn });
try {
  const won = txn(() => {
    const item = reg.get(room, claimId);
    reg.set(room, claimWork(item, agent, { now: Date.now() }));
    return true;
  });
  console.log("ACQUIRED");
} catch (e) {
  console.log("REFUSED " + (e.code ?? e.message ?? e).toString().slice(0, 120));
}
db.close();
`;
const runChild = (room, claimId, agent) => new Promise(resolve => {
  const child = spawn(process.execPath, ["--input-type=module", "-e", driver, dbPath, room, claimId, agent],
    { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", d => { out += d; });
  child.on("close", () => resolve(out.trim()));
  child.on("error", e => resolve("SPAWN_ERROR " + e.message));
});

let bad = 0, doubleWin = 0, noWin = 0;
try {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA busy_timeout=8000;");
  const reg = createDurableWorkClaimRegistry(db, {});
  for (let i = 0; i < ITERS; i++) {
    const room = "room1", claimId = `w${i}`;
    reg.set(room, createWork({ id: claimId, title: `work ${i}` }, { now: Date.now(), agentId: "system" }));
    const [r1, r2] = await Promise.all([
      runChild(room, claimId, "alice"), runChild(room, claimId, "bob"),
    ]);
    const w1 = r1 === "ACQUIRED", w2 = r2 === "ACQUIRED";
    if (w1 && w2) { doubleWin++; bad++; }
    else if (!w1 && !w2) { noWin++; bad++; console.log(`round ${i}: both refused [${r1}] [${r2}]`); }
    const final = reg.get(room, claimId);
    if ((w1 || w2) && !(final.state === "claimed" && (final.owner === "alice" || final.owner === "bob"))) {
      bad++; console.log(`round ${i}: winner but bad final state ${final.state}/${final.owner}`);
    }
    if (i === 0) console.log(`sample round: [${r1}] [${r2}] owner=${final.owner}`);
  }
  db.close();
  console.log(`RH-05: ${ITERS} rounds, double-win=${doubleWin}, no-win=${noWin}`);
  console.log(bad === 0 ? "RH-05 RESULT: PASS — exactly one claimant wins per round"
    : `RH-05 RESULT: FAIL — ${bad} anomalous rounds`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(bad === 0 ? 0 : 2);
