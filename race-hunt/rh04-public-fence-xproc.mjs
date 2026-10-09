// RH-04: cross-process withPublicWorkClaimWriter race — two processes sharing
// one DB hammer the permit gate. Expectation: BEGIN IMMEDIATE serializes the
// entries; nobody ever sees "must be closed before entry"; the permit is 0
// at rest and every entry's write lands exactly once.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
const REPO = process.env.REPO;
if (!REPO) { console.error("REPO env required"); process.exit(1); }
const { publicWorkClaimFenceSchema } = await import(REPO + "/server/public-work-claim-fence.mjs");
const ITERS = Number(process.env.ITERS || 60);
const dir = mkdtempSync(join(tmpdir(), "rh04-"));
const dbPath = join(dir, "fence.db");
{
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
  db.exec("CREATE TABLE work_claims(room_id TEXT, claim_id TEXT)");
  db.exec("CREATE TABLE work_claim_config(room_id TEXT)");
  db.exec("CREATE TABLE public_work_tasks(namespace_key TEXT)");
  db.exec(publicWorkClaimFenceSchema);
  db.exec("INSERT INTO public_work_tasks(namespace_key) VALUES('room-pub')");
  db.close();
}
const driver = `
import { DatabaseSync } from "node:sqlite";
import { withPublicWorkClaimWriter } from ${JSON.stringify(REPO + "/server/public-work-claim-fence.mjs")};
const db = new DatabaseSync(${JSON.stringify(dbPath)});
db.exec("PRAGMA busy_timeout=8000;");
const store = { db, now: () => Date.now(), transaction(fn) {
  db.exec("BEGIN IMMEDIATE");
  try { const r = fn(); db.exec("COMMIT"); return r; }
  catch (e) { try { db.exec("ROLLBACK"); } catch {} throw e; }
} };
let entered = 0, gateErrs = 0, otherErrs = 0;
for (let i = 0; i < ${ITERS}; i++) {
  try {
    withPublicWorkClaimWriter(store, () => {
      db.prepare("INSERT INTO work_claims(room_id,claim_id) VALUES('room-pub',?)").run(process.pid + "-" + i);
    });
    entered++;
  } catch (e) {
    if (/must be closed before entry/.test(e.message)) gateErrs++; else otherErrs++;
  }
}
console.log(JSON.stringify({ pid: process.pid, entered, gateErrs, otherErrs }));
db.close();
`;
const runChild = () => new Promise(resolve => {
  const child = spawn(process.execPath, ["--input-type=module", "-e", driver], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "";
  child.stdout.on("data", d => { out += d; });
  child.stderr.on("data", d => { err += d; });
  child.on("close", code => resolve({ out: out.trim(), err: err.trim(), code }));
  child.on("error", e => resolve({ out: "", err: e.message, code: -1 }));
});
let failed = false;
try {
  const [a, b] = await Promise.all([runChild(), runChild()]);
  console.log("A:", a.out, a.code === 0 ? "" : `code=${a.code} err=${a.err.slice(0, 200)}`);
  console.log("B:", b.out, b.code === 0 ? "" : `code=${b.code} err=${b.err.slice(0, 200)}`);
  const ra = JSON.parse(a.out), rb = JSON.parse(b.out);
  const db = new DatabaseSync(dbPath);
  const permit = db.prepare("SELECT enabled FROM public_work_claim_writer_permit WHERE singleton=1").get().enabled;
  const rows = db.prepare("SELECT COUNT(*) n FROM work_claims").get().n;
  const distinct = db.prepare("SELECT COUNT(DISTINCT claim_id) n FROM work_claims").get().n;
  db.close();
  console.log(`permit=${permit} rows=${rows} distinct=${distinct}`);
  const ok = ra.entered === ITERS && rb.entered === ITERS && ra.gateErrs === 0 && rb.gateErrs === 0
    && ra.otherErrs === 0 && rb.otherErrs === 0 && permit === 0 && rows === 2 * ITERS && distinct === rows;
  console.log(ok ? "RH-04 RESULT: PASS — permit entries serialized, no gate violations, closed at rest"
    : "RH-04 RESULT: FAIL — permit race anomaly");
  failed = !ok;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(failed ? 2 : 0);
