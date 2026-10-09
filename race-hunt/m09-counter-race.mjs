// M-09 kill test: lost-update counter through the REAL RoomStore transaction.
// Two processes x 50 read-modify-write increments. With BEGIN IMMEDIATE the
// final count must be exactly 100; with deferred BEGIN, increments are lost
// (or writers hit SQLITE_BUSY) and the count falls short.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const REPO = process.env.REPO;
if (!REPO) { console.error("REPO env required"); process.exit(1); }
const { RoomStore } = await import(REPO + "/server/store.mjs");

const N = 50;
const dir = mkdtempSync(join(tmpdir(), "m09-"));
const dbPath = join(dir, "counter.db");
let failed = false;
const spinMs = ms => { const end = Date.now() + ms; while (Date.now() < end); };
try {
  {
    const setup = new RoomStore(dbPath, { integrity: "deferred" });
    setup.db.exec("CREATE TABLE m09_counter(v INTEGER)");
    setup.db.exec("INSERT INTO m09_counter VALUES(0)");
    setup.db.close();
  }
  const driver = `
import { RoomStore } from ${JSON.stringify(REPO + "/server/store.mjs")};
const store = new RoomStore(${JSON.stringify(dbPath)}, { integrity: "deferred" });
const spinMs = ms => { const end = Date.now() + ms; while (Date.now() < end); };
try {
  for (let i = 0; i < ${N}; i++) {
    store.transaction(() => {
      const v = store.db.prepare("SELECT v FROM m09_counter").get().v;
      spinMs(3);
      store.db.prepare("UPDATE m09_counter SET v=?").run(v + 1);
    });
  }
  console.log("DONE increments=" + ${N});
} catch (e) { console.log("ERROR " + String(e.message ?? e).slice(0, 120)); }
store.db.close();
`;
  const runChild = () => new Promise(resolve => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", driver],
      { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", d => { out += d; });
    child.on("close", () => resolve(out.trim().split("\n").pop()));
    child.on("error", e => resolve("SPAWN_ERROR " + e.message));
  });
  const [r1, r2] = await Promise.all([runChild(), runChild()]);
  console.log("child A:", r1);
  console.log("child B:", r2);
  const check = new RoomStore(dbPath, { integrity: "deferred" });
  const final = check.db.prepare("SELECT v FROM m09_counter").get().v;
  check.db.close();
  console.log(`final counter=${final} (expect ${2 * N})`);
  if (final === 2 * N && r1.startsWith("DONE") && r2.startsWith("DONE")) {
    console.log("M-09 RESULT: PASS — no lost updates under BEGIN IMMEDIATE");
  } else {
    console.log("M-09 RESULT: FAIL — lost updates / writer errors (deferred BEGIN is racy)");
    failed = true;
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(failed ? 2 : 0);
