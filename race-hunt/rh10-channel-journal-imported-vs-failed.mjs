// RH-10: channel-journal imported-vs-failed race — one process marks a batch
// imported while another records failures on the same ids. Expectation: every
// id ends in exactly one terminal-ish state (imported XOR failed), attempts
// stay within bounds, no row is both, none is lost.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const REPO = process.env.REPO;
if (!REPO) { console.error("REPO env required"); process.exit(1); }
const { ChannelUpdateJournal, channelJournalSchema, channelJournalLimits } =
  await import(REPO + "/server/channel-journal.mjs");

const N = Number(process.env.ITERS || 60);
const dir = mkdtempSync(join(tmpdir(), "rh10-"));
const dbPath = join(dir, "chan.db");
{
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=8000; PRAGMA foreign_keys=OFF;");
  db.exec(channelJournalSchema);
  const txn = fn => { db.exec("BEGIN IMMEDIATE"); try { const r = fn(); db.exec("COMMIT"); return r; } catch (e) { try { db.exec("ROLLBACK"); } catch {} throw e; } };
  const store = { db, now: () => Date.now(), transaction: txn, readTransaction: fn => fn() };
  const journal = new ChannelUpdateJournal(store);
  const updates = [];
  for (let i = 0; i < N; i++) updates.push({ update_id: i });
  journal.record("a1", "c1", updates, { backlog: 100000 });
  db.close();
}
const ids = JSON.stringify([...Array(N).keys()]);
const mkDriver = mode => `
import { DatabaseSync } from "node:sqlite";
const REPO = ${JSON.stringify(REPO)};
const { ChannelUpdateJournal } = await import(REPO + "/server/channel-journal.mjs");
const db = new DatabaseSync(${JSON.stringify(dbPath)});
db.exec("PRAGMA busy_timeout=8000; PRAGMA foreign_keys=OFF;");
const txn = fn => { db.exec("BEGIN IMMEDIATE"); try { const r = fn(); db.exec("COMMIT"); return r; } catch (e) { try { db.exec("ROLLBACK"); } catch {} throw e; } };
const store = { db, now: () => Date.now(), transaction: txn, readTransaction: fn => fn() };
const journal = new ChannelUpdateJournal(store);
const ids = ${ids};
try {
  if (${JSON.stringify(mode)} === "import") { const n = journal.imported("a1", "c1", ids); console.log(JSON.stringify({ mode: "import", changed: n })); }
  else { const r = journal.failed("a1", "c1", ids, new Error("boom")); console.log(JSON.stringify({ mode: "fail", ...r })); }
} catch (e) { console.log(JSON.stringify({ mode: ${JSON.stringify(mode)}, error: String(e.message ?? e).slice(0, 160) })); }
db.close();
`;
const runChild = mode => new Promise(resolve => {
  const child = spawn(process.execPath, ["--input-type=module", "-e", mkDriver(mode)], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", d => { out += d; });
  child.on("close", () => resolve(out.trim()));
  child.on("error", e => resolve(JSON.stringify({ error: e.message })));
});
let failed = false;
try {
  const [a, b] = await Promise.all([runChild("import"), runChild("fail")]);
  console.log("importer:", a); console.log("failer:", b);
  const db = new DatabaseSync(dbPath);
  const rows = db.prepare("SELECT update_id,status,attempts FROM pending_channel_updates ORDER BY update_id").all();
  db.close();
  let bad = 0;
  for (const r of rows) {
    if (!["imported", "failed", "pending"].includes(r.status)) { bad++; continue; }
    if (r.attempts > channelJournalLimits.maxAttempts) bad++;
    if (r.status === "failed" && r.attempts < channelJournalLimits.maxAttempts) bad++;
    if (r.status === "imported" && r.attempts !== 0) bad++;
  }
  if (rows.length !== N) bad++;
  const counts = { imported: 0, failed: 0, pending: 0 };
  for (const r of rows) counts[r.status]++;
  console.log(`final: ${JSON.stringify(counts)} anomalies=${bad}`);
  const ok = bad === 0;
  console.log(ok ? "RH-10 RESULT: PASS — imported/failed race leaves every row consistent"
    : "RH-10 RESULT: FAIL — inconsistent rows after imported/failed race");
  failed = !ok;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(failed ? 2 : 0);
