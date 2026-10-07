// REL-13: Durable Object transaction audit.
// DurableDatabase has no raw BEGIN/COMMIT/ROLLBACK/SAVEPOINT. Runtime code
// must use store.transaction (storage.transactionSync on a Durable Object).
// This test fails when runtime code adds a raw transaction statement.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { runAnalyticsTail } from "../server/analytics/tail.mjs";
import { reapExpiredSpendAuthorizations } from "../server/spend-grants.mjs";

const RAW = /\.exec\(\s*["'`]\s*(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/;
// Node-only paths. Each one is guarded or never runs on a Durable Object.
const ALLOW = new Map([
  ["server/analytics/tail.mjs", "Node-only analytics tail; skips a Durable Object store"],
  ["cloudflare/compatibility-worker.mjs", "probe that proves raw BEGIN is refused"],
  ["server/store.mjs", "the Node branch of store.transaction itself (nodeStorage)"],
  ["server/spend-grants.mjs", "Node-only transact(); refuses a Durable Object outside store.transaction"]
]);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.mjs$/.test(name) && !/(\.test|test-fixture|\.check)\.mjs$/.test(name)) out.push(path);
  }
  return out;
}

test("runtime code has no raw transaction statements outside the allow list", () => {
  const offenders = [];
  for (const file of [...walk("server"), ...walk("cloudflare")]) {
    if (ALLOW.has(file)) continue;
    readFileSync(file, "utf8").split("\n").forEach((line, index) => {
      if (RAW.test(line)) offenders.push(`${file}:${index + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, [], "use store.transaction instead of raw BEGIN/COMMIT");
});

test("allow-listed files still exist, so the list cannot go stale", () => {
  for (const file of ALLOW.keys()) assert.ok(statSync(file).isFile(), file);
});

test("analytics tail skips a Durable Object store and never issues a raw BEGIN", async () => {
  const calls = [];
  const db = {
    storage: { transactionSync: fn => fn() },
    exec(sql) { calls.push(sql); throw new Error("raw exec on a Durable Object"); },
    prepare() { throw new Error("no reads expected"); }
  };
  const result = await runAnalyticsTail(db, { now: 0 });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "node_only");
  assert.equal(result.rowsWritten, 0);
  assert.deepEqual(calls, []);
});

test("spend transact refuses a raw BEGIN on a Durable Object and nests inside a transaction", () => {
  const calls = [];
  const durable = {
    storage: { transactionSync: fn => fn() }, isTransaction: false,
    exec(sql) { calls.push(sql); },
    prepare() { return { all: () => [], get: () => undefined, run: () => ({ changes: 0 }) }; }
  };
  assert.throws(() => reapExpiredSpendAuthorizations(durable, { roomId: "r", nowMs: 1 }), /inside store.transaction/);
  assert.deepEqual(calls, []);
  durable.isTransaction = true;
  assert.equal(reapExpiredSpendAuthorizations(durable, { roomId: "r", nowMs: 1 }), 0);
  assert.deepEqual(calls, []);
});
