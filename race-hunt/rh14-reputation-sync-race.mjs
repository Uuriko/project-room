// RH-14: claim-reputation concurrent sync — two processes run
// syncClaimReputationJournal concurrently (DELETE legacy + INSERT OR IGNORE
// fold, no wrapping transaction since DatabaseSync has no .transaction).
// Expectation: both complete without error and converge to identical signal sets.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const REPO = process.env.REPO;
if (!REPO) { console.error("REPO env required"); process.exit(1); }
const { syncClaimReputationJournal, CLAIM_REPUTATION_SCHEMA } =
  await import(REPO + "/server/claim-reputation.mjs");

const dir = mkdtempSync(join(tmpdir(), "rh14-"));
const dbPath = join(dir, "rep.db");
const mkEvent = (seq, claimId, action, agent) => JSON.stringify({
  type: "work_claim.updated", at: new Date(1_700_000_000_000 + seq * 1000).toISOString(),
  data: { workClaim: claimId, action, actorId: agent },
});
{
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=8000;");
  db.exec("CREATE TABLE events(room_id TEXT, sequence INTEGER, body TEXT)");
  const ins = db.prepare("INSERT INTO events(room_id,sequence,body) VALUES(?,?,?)");
  let seq = 1;
  for (const [claimId, agent] of [["c1", "alice"], ["c2", "bob"], ["c3", "alice"]]) {
    ins.run("room1", seq, mkEvent(seq, claimId, "claimed", agent)); seq++;
  }
  ins.run("room1", seq, mkEvent(seq, "c1", "closed", "alice")); seq++;
  ins.run("room1", seq, mkEvent(seq, "c2", "lease_expired", "bob")); seq++;
  db.close();
}
const driver = `
import { DatabaseSync } from "node:sqlite";
const REPO = ${JSON.stringify(REPO)};
const { syncClaimReputationJournal } = await import(REPO + "/server/claim-reputation.mjs");
const db = new DatabaseSync(${JSON.stringify(dbPath)});
db.exec("PRAGMA busy_timeout=8000;");
try {
  const r = syncClaimReputationJournal(db, { roomId: "room1" });
  console.log(JSON.stringify({ ok: true, ...r }));
} catch (e) { console.log(JSON.stringify({ ok: false, error: String(e.message ?? e).slice(0, 160) })); }
db.close();
`;
const runChild = () => new Promise(resolve => {
  const child = spawn(process.execPath, ["--input-type=module", "-e", driver], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", d => { out += d; });
  child.on("close", () => resolve(out.trim()));
  child.on("error", e => resolve(JSON.stringify({ ok: false, error: e.message })));
});
let failed = false;
try {
  // control: sequential sync
  const db0 = new DatabaseSync(dbPath);
  const control = syncClaimReputationJournal(db0, { roomId: "room1" });
  const controlRows = db0.prepare("SELECT id FROM claim_reputation_signals ORDER BY id").all().map(r => r.id);
  db0.exec("DELETE FROM claim_reputation_signals");
  db0.close();
  console.log(`control: signalsWritten=${control.signalsWritten}`);

  const [a, b] = await Promise.all([runChild(), runChild()]);
  console.log("A:", a); console.log("B:", b);
  const ra = JSON.parse(a), rb = JSON.parse(b);
  const db = new DatabaseSync(dbPath);
  const finalRows = db.prepare("SELECT id FROM claim_reputation_signals ORDER BY id").all().map(r => r.id);
  db.close();
  const same = JSON.stringify(finalRows) === JSON.stringify(controlRows);
  console.log(`converged=${same} final=${finalRows.length} control=${controlRows.length}`);
  const ok = ra.ok && rb.ok && same;
  console.log(ok ? "RH-14 RESULT: PASS — concurrent syncs converge idempotently"
    : "RH-14 RESULT: FAIL — concurrent sync divergence or error");
  failed = !ok;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(failed ? 2 : 0);
