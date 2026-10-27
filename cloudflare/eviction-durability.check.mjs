// B3-2 eviction durability: state a Durable Object instance holds only
// in memory between a completed channel drain and the heartbeat record
// that reports it (F1), and between storage failures and the committed
// write that clears them (F2), must survive eviction of the instance.
// Staged in the preserved harness's shape (seed 3202): stage through the
// real code paths, mf.unsafeEvictDurableObject, probe the successor.
// The 12 mid-stream / mid-write B3-2 assertions stay instrument-blocked:
// Miniflare cannot evict an object holding an open stream or an
// in-flight request, so this check claims nothing about them.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

const origin = "https://room.example.test";
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function start() {
  const bundled = await build({
    entryPoints: [fileURLToPath(new URL("./eviction-durability.test-fixture.mjs", import.meta.url))],
    bundle: true, write: false, format: "esm", platform: "neutral",
    external: ["node:*", "cloudflare:*"]
  });
  const persistence = await mkdtemp(join(tmpdir(), "b3-2-evict-"));
  return new Miniflare({
    modules: true,
    script: bundled.outputFiles[0].text,
    compatibilityDate: "2026-07-30",
    compatibilityFlags: ["nodejs_compat"],
    durableObjects: { ROOM: { className: "EvictionProbe", useSQLite: true } },
    kvNamespaces: ["ROOM_BACKUPS_KV"],
    bindings: { ROOM_ORIGIN: origin, ROOM_MAINTENANCE: "0", ROOM_GMAIL_ENABLED: "0" },
    durableObjectsPersist: persistence
  });
}

async function call(mf, path) {
  const response = await mf.dispatchFetch(origin + path);
  return { status: response.status, body: await response.json() };
}

async function evict(mf) {
  await mf.unsafeEvictDurableObject("", "EvictionProbe", { name: "invite-only-pilot" });
  await sleep(150);
}

async function pollDrainOutcome(mf, predicate) {
  let state;
  for (let attempt = 0; attempt < 50; attempt++) {
    state = await call(mf, "/probe/drain-state");
    assert.equal(state.status, 200, JSON.stringify(state.body));
    if (predicate(state.body)) return state.body;
    await sleep(100);
  }
  return state.body;
}

test("F1: a completed drain outcome survives eviction until recordCronTick consumes it", { timeout: 120_000 }, async () => {
  const mf = await start();
  try {
    await call(mf, "/probe/seed-drain");
    const started = await call(mf, "/probe/drain-tick");
    assert.equal(started.status, 200, JSON.stringify(started.body));
    assert.equal(started.body.started, 1);
    const staged = await pollDrainOutcome(mf, state => state.outcome !== null);
    assert.ok(staged.outcome !== null, "background drain stashed its outcome");
    assert.equal(typeof staged.outcome.at, "number");

    await evict(mf);

    // The successor instance reports the staged outcome, not unobserved.
    const reported = await call(mf, "/probe/drain-tick");
    assert.equal(reported.status, 200, JSON.stringify(reported.body));
    assert.equal(reported.body.unobserved, undefined, "successor must not report the staged drain as unobserved");
    assert.equal(reported.body.screened, staged.outcome.screened, "the reported outcome is the staged one");
    assert.equal(reported.body.errors, staged.outcome.errors ?? 0);
    const successor = await call(mf, "/probe/drain-state");
    assert.notEqual(successor.body.iid, staged.iid, "the probes ran on the successor instance");
    assert.equal(successor.body.outcome?.at, staged.outcome.at, "the successor rehydrated the staged outcome");

    // Consumption still happens exactly once, at the durable heartbeat
    // record — and the consumed outcome does not resurrect on eviction.
    const recorded = await call(mf, "/probe/drain-tick-record");
    assert.equal(recorded.status, 200, JSON.stringify(recorded.body));
    await pollDrainOutcome(mf, state => state.outcome?.at !== staged.outcome.at);
    await evict(mf);
    const afterConsume = await call(mf, "/probe/drain-state");
    assert.notEqual(afterConsume.body.outcome?.at, staged.outcome.at, "a consumed outcome stays consumed across eviction");
  } finally {
    await mf.dispose();
  }
});

test("F2: the storage-failure streak survives eviction until a committed write clears it", { timeout: 120_000 }, async () => {
  const mf = await start();
  try {
    const staged = await call(mf, "/probe/storage-fail-stage");
    assert.equal(staged.status, 200, JSON.stringify(staged.body));
    assert.equal(staged.body.storageFailures, 3);
    assert.equal(staged.body.storageStatus.failures, 3);
    assert.equal(staged.body.storageStatus.threshold, 3);
    assert.equal(staged.body.storageStatus.unavailable, true);
    assert.deepEqual(Object.keys(staged.body.storageStatus).sort(), ["failures", "threshold", "unavailable"], "storageStatus shape is unchanged");
    assert.equal(typeof staged.body.storageFailureLastAt, "number", "the staged streak carries its last-failure timestamp");

    await evict(mf);

    const successor = await call(mf, "/probe/storage-state");
    assert.equal(successor.status, 200, JSON.stringify(successor.body));
    assert.notEqual(successor.body.iid, staged.body.iid, "the probe ran on the successor instance");
    assert.equal(successor.body.storageFailures, 3, "the streak persisted across eviction");
    assert.equal(successor.body.storageStatus.unavailable, true, "readiness stays degraded on the successor");
    assert.equal(successor.body.storageFailureLastAt, staged.body.storageFailureLastAt, "the last-failure timestamp persisted too");

    // A committed write on the successor clears the streak — durably:
    // a second eviction must not resurrect it.
    const recovered = await call(mf, "/probe/commit-write");
    assert.equal(recovered.body.storageStatus.unavailable, false);
    assert.equal(recovered.body.storageFailures, 0);
    await evict(mf);
    const afterRecovery = await call(mf, "/probe/storage-state");
    assert.equal(afterRecovery.body.storageFailures, 0, "the cleared streak stays cleared across eviction");
    assert.equal(afterRecovery.body.storageStatus.unavailable, false);
  } finally {
    await mf.dispose();
  }
});
