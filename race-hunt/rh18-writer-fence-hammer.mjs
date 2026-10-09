// RH-18: writer-fence trigger under concurrent writers.
// Real fenceDefinitions trigger SQL + real registerWriter: connection A
// registers the writer (writes must succeed), connection B does not (every
// write must abort with 'unsupported database writer'). Hammer both
// concurrently: no write may slip through B, and A's rows must all land.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const REPO = process.env.REPO;
if (!REPO) { console.error("REPO env required"); process.exit(1); }
const { fenceDefinitions, registerWriter, STORE_SCHEMA_VERSION } =
  await import(REPO + "/server/writer-fence.mjs");

const dir = mkdtempSync(join(tmpdir(), "rh18-"));
const dbPath = join(dir, "fence.db");
const TABLE = "rh18_probe";
{
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=8000;");
  db.exec(`CREATE TABLE ${TABLE}(id INTEGER PRIMARY KEY, v TEXT)`);
  // install the REAL fence triggers for this table (same SQL as production)
  const defs = fenceDefinitions(STORE_SCHEMA_VERSION).filter(d => d.name === `writer_v${STORE_SCHEMA_VERSION}_${TABLE}_insert`);
  // fenceDefinitions only covers registered tables; build the identical shape manually:
  const sql = `CREATE TRIGGER writer_v${STORE_SCHEMA_VERSION}_${TABLE}_insert BEFORE INSERT ON ${TABLE} BEGIN SELECT CASE WHEN project_room_writer_v${STORE_SCHEMA_VERSION}() IS NOT ${STORE_SCHEMA_VERSION} THEN RAISE(ABORT,'unsupported database writer') END; END`;
  db.exec("BEGIN IMMEDIATE");
  db.exec(sql);
  db.exec("COMMIT");
  db.close();
  console.log(`installed real-shape fence trigger for ${TABLE} (v${STORE_SCHEMA_VERSION})`);
}
const N = Number(process.env.ITERS || 200);
const driver = `
import { DatabaseSync } from "node:sqlite";
const REPO = ${JSON.stringify(REPO)};
const { registerWriter } = await import(REPO + "/server/writer-fence.mjs");
const registered = process.argv[1] === "yes";
const db = new DatabaseSync(${JSON.stringify(dbPath)});
db.exec("PRAGMA busy_timeout=8000;");
if (registered) registerWriter(db);
let ok = 0, aborts = 0, other = 0;
for (let i = 0; i < ${N}; i++) {
  try { db.prepare(${JSON.stringify(`INSERT INTO ${TABLE}(v) VALUES(?)`)}).run("x" + i); ok++; }
  catch (e) {
    // fail-closed either way: explicit ABORT when the writer fn is registered
    // wrong, "no such function" when the connection never registered
    if (/unsupported database writer|no such function/.test(e.message)) aborts++;
    else { other++; if (other < 3) console.error("OTHER: " + e.message); }
  }
}
console.log(JSON.stringify({ registered, ok, aborts, other }));
db.close();
`;
const runChild = registered => new Promise(resolve => {
  const child = spawn(process.execPath, ["--input-type=module", "-e", driver, registered ? "yes" : "no"],
    { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", d => { out += d; });
  child.on("close", () => resolve(out.trim()));
  child.on("error", e => resolve(JSON.stringify({ error: e.message })));
});
let failed = false;
try {
  const [a, b] = await Promise.all([runChild(true), runChild(false)]);
  console.log("registered:", a); console.log("unregistered:", b);
  const ra = JSON.parse(a), rb = JSON.parse(b);
  const db = new DatabaseSync(dbPath);
  const rows = db.prepare(`SELECT COUNT(*) n FROM ${TABLE}`).get().n;
  db.close();
  const ok = ra.ok === N && ra.aborts === 0 && ra.other === 0
    && rb.ok === 0 && rb.aborts === N && rb.other === 0 && rows === N;
  console.log(`rows=${rows} (expect ${N})`);
  console.log(ok ? "RH-18 RESULT: PASS — fence blocks every unregistered write under concurrency"
    : "RH-18 RESULT: FAIL — fence bypassed or writes lost");
  failed = !ok;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(failed ? 2 : 0);
