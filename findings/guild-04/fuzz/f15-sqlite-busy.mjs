// F15: SQLite busy — a held write lock must surface a fast error, never a hang.
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fuzz, scratchDir } from "./lib.mjs";

fuzz("F15-sqlite-busy", async () => {
  const dir = scratchDir("g04-f15-");
  const file = join(dir, "busy.sqlite");
  const holder = new DatabaseSync(file);
  holder.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
  holder.exec("BEGIN IMMEDIATE");
  holder.prepare("INSERT INTO t(v) VALUES('held')").run();
  // holder keeps the write lock open; a second connection with a short
  // busy_timeout must fail fast, not hang forever.
  const t0 = Date.now();
  let threw = null;
  try {
    const contender = new DatabaseSync(file);
    contender.exec("PRAGMA busy_timeout=500");
    contender.prepare("INSERT INTO t(v) VALUES('contend')").run();
    contender.close();
  } catch (e) { threw = e; }
  const dt = Date.now() - t0;
  assert.ok(threw, "contender unexpectedly succeeded against a held IMMEDIATE lock");
  assert.ok(dt < 5000, `busy wait took ${dt}ms — hang risk`);
  console.log(`  SQLITE_BUSY in ${dt}ms (code: ${threw.code})`);
  holder.exec("ROLLBACK");
  // after release, the write goes through
  const ok = new DatabaseSync(file);
  ok.exec("PRAGMA busy_timeout=5000");
  ok.prepare("INSERT INTO t(v) VALUES('after')").run();
  assert.equal(ok.prepare("SELECT count(*) n FROM t").get().n, 1);
  ok.close(); holder.close();
  console.log("  lock released -> write succeeds; no torn state");
});
