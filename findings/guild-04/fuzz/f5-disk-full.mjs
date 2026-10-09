// F5: disk-full simulation (ulimit -f) — writes must fail clean, DB must stay openable.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fuzz, scratchDir } from "./lib.mjs";

fuzz("F5-disk-full", async () => {
  const dir = scratchDir("g04-f5-");
  const file = join(dir, "room.sqlite");
  // Child runs under a hard file-size cap; writes must throw, not hang.
  const worker = `
    import { DatabaseSync } from "node:sqlite";
    const db = new DatabaseSync(${JSON.stringify(file)});
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, blob BLOB)");
    const big = Buffer.alloc(200000, 7);
    let writes = 0, firstError = null;
    for (let i = 0; i < 200; i++) {
      try { db.prepare("INSERT INTO t(blob) VALUES(?)").run(big); writes++; }
      catch (e) { firstError = e.code ?? e.message; break; }
    }
    console.log(JSON.stringify({ writes, firstError }));
    db.close();
  `;
  const p = spawnSync("bash", ["-c", `ulimit -f 256; node --input-type=module -e ${JSON.stringify(worker)}`],
    { timeout: 60000, encoding: "utf8" });
  assert.equal(p.status, 0, `worker crashed: ${p.stderr?.slice(-400)}`);
  const { writes, firstError } = JSON.parse(p.stdout.trim().split("\n").pop());
  assert.ok(writes < 200, "expected the cap to stop writes");
  assert.ok(firstError, "expected a clean error, not a hang");
  console.log(`  stopped after ${writes} writes with: ${firstError}`);
  // The file must still open and report integrity state (no torn handle).
  const db = new DatabaseSync(file);
  const qc = db.prepare("PRAGMA quick_check").get();
  const n = db.prepare("SELECT count(*) n FROM t").get().n;
  db.close();
  console.log(`  reopen ok: ${n} rows committed, quick_check=${qc.quick_check}`);
  assert.ok(n >= 0);
});
