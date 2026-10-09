// RH-09: channel-journal concurrent record — two processes record the same
// provider update ids concurrently. Expectation: idempotent by update id
// (ON CONFLICT DO NOTHING) — exactly N distinct rows, accepted_a+accepted_b
// == N, no duplicates, no errors.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const REPO = process.env.REPO;
if (!REPO) { console.error("REPO env required"); process.exit(1); }
const { ChannelUpdateJournal, channelJournalSchema } = await import(REPO + "/server/channel-journal.mjs");

const N = Number(process.env.ITERS || 40);
const dir = mkdtempSync(join(tmpdir(), "rh09-"));
const dbPath = join(dir, "chan.db");
{
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=8000; PRAGMA foreign_keys=OFF;");
  db.exec(channelJournalSchema);
  db.close();
}
const driver = `
import { DatabaseSync } from "node:sqlite";
const REPO = ${JSON.stringify(REPO)};
const { ChannelUpdateJournal } = await import(REPO + "/server/channel-journal.mjs");
const db = new DatabaseSync(${JSON.stringify(dbPath)});
db.exec("PRAGMA busy_timeout=8000; PRAGMA foreign_keys=OFF;");
const txn = fn => { db.exec("BEGIN IMMEDIATE"); try { const r = fn(); db.exec("COMMIT"); return r; } catch (e) { try { db.exec("ROLLBACK"); } catch {} throw e; } };
const store = { db, now: () => Date.now(), transaction: txn, readTransaction: fn => fn() };
const journal = new ChannelUpdateJournal(store);
const updates = [];
for (let i = 0; i < ${N}; i++) updates.push({ update_id: i, text: "u" + i });
try {
  const res = journal.record("a1", "c1", updates, { backlog: 100000 });
  console.log(JSON.stringify({ accepted: res.accepted, pending: res.pending }));
} catch (e) { console.log(JSON.stringify({ error: String(e.message ?? e).slice(0, 160) })); }
db.close();
`;
const runChild = () => new Promise(resolve => {
  const child = spawn(process.execPath, ["--input-type=module", "-e", driver], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", d => { out += d; });
  child.on("close", () => resolve(out.trim()));
  child.on("error", e => resolve(JSON.stringify({ error: e.message })));
});
let failed = false;
try {
  const [a, b] = await Promise.all([runChild(), runChild()]);
  console.log("A:", a); console.log("B:", b);
  const ra = JSON.parse(a), rb = JSON.parse(b);
  const db = new DatabaseSync(dbPath);
  const rows = db.prepare("SELECT COUNT(*) n FROM pending_channel_updates").get().n;
  const pending = db.prepare("SELECT COUNT(*) n FROM pending_channel_updates WHERE status='pending'").get().n;
  db.close();
  const ok = !ra.error && !rb.error && rows === N && pending === N && ra.accepted + rb.accepted === N;
  console.log(`rows=${rows} pending=${pending} accepted_a=${ra.accepted} accepted_b=${rb.accepted}`);
  console.log(ok ? "RH-09 RESULT: PASS — concurrent record is idempotent, no duplicates"
    : "RH-09 RESULT: FAIL — journal lost idempotency under concurrency");
  failed = !ok;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(failed ? 2 : 0);
