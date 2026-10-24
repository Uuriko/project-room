import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

async function start(fail = "") {
  const bundled = await build({ entryPoints: [fileURLToPath(new URL("./cron-isolation.test-fixture.mjs", import.meta.url))],
    bundle: true, write: false, format: "esm", platform: "neutral", external: ["node:*", "cloudflare:*"] });
  return new Miniflare({ modules: true, script: bundled.outputFiles[0].text,
    compatibilityDate: "2026-07-30", compatibilityFlags: ["nodejs_compat"],
    durableObjects: { ROOM: { className: "CronIsolationProbe", useSQLite: true } },
    kvNamespaces: ["ROOM_BACKUPS_KV"], bindings: { ROOM_ORIGIN: "https://room.example.test", FAIL_SLOW_JOB: fail } });
}

test("a slow RPC failure preserves earlier outcomes and does not starve later jobs", async () => {
  const mf = await start("integrity");
  try {
    const result = await (await mf.dispatchFetch("https://room.example.test/scheduled")).json();
    assert.match(result.error, /RPC failed: integrity/);
    for (const name of ["retention", "room-backup", "store-growth"]) assert.ok(result.recorded[name]?.lastSuccessAt, name);
    assert.equal(result.recorded.integrity, undefined, "a failed RPC cannot invent successful integrity work");
  } finally { await mf.dispose(); }
});

test("slow RPCs retain cadence checks instead of rerunning every cron invocation", async () => {
  const mf = await start();
  try {
    const first = await (await mf.dispatchFetch("https://room.example.test/scheduled")).json();
    const second = await (await mf.dispatchFetch("https://room.example.test/scheduled")).json();
    assert.equal(first.error, null);
    assert.equal(second.error, null);
    for (const name of ["retention", "integrity", "room-backup", "store-growth"]) {
      assert.ok(first.recorded[name]?.lastRunAt, name);
      assert.equal(second.recorded[name].lastRunAt, first.recorded[name].lastRunAt, name);
    }
  } finally { await mf.dispose(); }
});

test("concurrent real Durable Object heartbeat commits retain both jobs", async () => {
  const mf = await start();
  try {
    const recorded = await (await mf.dispatchFetch("https://room.example.test/concurrent")).json();
    assert.equal(recorded.retention.lastSuccessAt, 1234);
    assert.equal(recorded.integrity.lastSuccessAt, 1234);
  } finally { await mf.dispose(); }
});
