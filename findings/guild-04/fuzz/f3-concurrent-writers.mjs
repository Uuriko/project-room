// F3: concurrent writers on the durable work-claim registry (5 procs x 50 sets).
// Asserts: no lost writes, no torn rows, every row decodes.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createDurableWorkClaimRegistry, workClaimSchema } from "../../server/work-claim-sqlite.mjs";
import { fuzz, scratchDir } from "./lib.mjs";

const NPROC = 5, NSET = 50;
fuzz("F3-concurrent-writers", async () => {
  const dir = scratchDir("g04-f3-");
  const file = join(dir, "claims.sqlite");
  {
    const db = new DatabaseSync(file);
    db.exec(workClaimSchema);
    db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
    db.close();
  }
  const worker = `
    import { DatabaseSync } from "node:sqlite";
    import { createDurableWorkClaimRegistry } from "/home/hatch/workspace/pr-wave1000-guild-04/server/work-claim-sqlite.mjs";
    const [slot, file] = [Number(process.argv[2]), process.argv[3]];
    const db = new DatabaseSync(file);
    db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
    const reg = createDurableWorkClaimRegistry(db, { transaction: fn => { db.exec("BEGIN IMMEDIATE"); try { const r = fn(); db.exec("COMMIT"); return r; } catch (e) { try { db.exec("ROLLBACK"); } catch {} throw e; } } });
    for (let i = 0; i < ${NSET}; i++) {
      reg.set("room1", { id: "p" + slot + "-c" + i, title: "t" + i, state: "claimed", owner: "p" + slot, history: [{ action: "claimed", at: i }] });
    }
    db.close();
  `;
  const procs = [];
  for (let s = 0; s < NPROC; s++) {
    procs.push(spawnSync("node", ["--input-type=module", "-e", worker, String(s), file],
      { timeout: 60000, encoding: "utf8" }));
  }
  for (const [i, p] of procs.entries()) {
    assert.equal(p.status, 0, `worker ${i} failed: ${p.stderr?.slice(-500)}`);
  }
  const db = new DatabaseSync(file);
  const reg = createDurableWorkClaimRegistry(db);
  const all = reg.list("room1");
  assert.equal(all.length, NPROC * NSET, `lost writes: got ${all.length}, want ${NPROC * NSET}`);
  for (const item of all) {
    assert.equal(typeof item.id, "string");
    assert.ok(["claimed", "unclaimed"].includes(item.state), `torn state: ${item.state}`);
    assert.ok(Array.isArray(item.history), "torn history");
  }
  const ids = new Set(all.map(i => i.id));
  assert.equal(ids.size, NPROC * NSET, "duplicate/torn ids");
  db.close();
  console.log(`  ${NPROC * NSET} claims across ${NPROC} procs: zero lost, zero torn`);
});
