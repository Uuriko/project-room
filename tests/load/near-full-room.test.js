// CI load: a room at about 90% of the write ceiling, then a concurrent
// person/agent write flood and snapshot reads, on the local Worker / Durable
// Object harness (miniflare + the production worker entry).
//
// `npm test` discovers this file. The workerd scenario boots only when
// LOAD_HARNESS=1, which .github/workflows/load.yml sets. The stuck-permit
// scenario (LOAD_STUCK_PERMIT=1) is the 2026-10-24 outage: room_writer_permit
// left at the schema version. It fails until cloudflare/storage.mjs resets
// that row on the next outermost transaction.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { PILOT_LIMITS } from "../../server/store.mjs";
import { STORE_GROWTH_LIMITS } from "../../server/jobs.mjs";
import { LOAD_BUDGET, fillInBand, permitHold, roomStorageLimitBytes } from "./fixtures/budget.mjs";

const cloudflarePkg = fileURLToPath(new URL("../../cloudflare/package.json", import.meta.url));
const workerEntry = fileURLToPath(new URL("./fixtures/near-full-room-worker.mjs", import.meta.url));
const origin = "https://room.example.test";
const harnessOn = process.env.LOAD_HARNESS === "1";
const stuckOn = process.env.LOAD_STUCK_PERMIT === "1";

test("storage ceiling is the tighter of the projection cap and the SQLite value limit", () => {
  assert.equal(LOAD_BUDGET.projectionCapBytes, PILOT_LIMITS.projectionBytes);
  assert.equal(roomStorageLimitBytes(PILOT_LIMITS.projectionBytes, 2_200_000), 2_200_000);
  assert.equal(roomStorageLimitBytes(PILOT_LIMITS.projectionBytes, 8_388_642), PILOT_LIMITS.projectionBytes);
  assert.equal(roomStorageLimitBytes(PILOT_LIMITS.projectionBytes, null), PILOT_LIMITS.projectionBytes);
  assert.equal(LOAD_BUDGET.productionDatabaseLimitBytes, 10_000_000_000);
  assert.equal(STORE_GROWTH_LIMITS.dbBytes / LOAD_BUDGET.productionDatabaseLimitBytes, 0.8);
});

test("a writer permit held longer than its TTL is stuck, and one released inside the TTL is not", () => {
  assert.equal(permitHold([{ t: 0, version: 42 }, { t: 100, version: 0 }], 5000).past, false);
  assert.equal(permitHold([{ t: 0, version: 42 }, { t: 100, version: 0 }], 5000).openSince, null);
  assert.equal(permitHold([{ t: 0, version: 42 }], 5000).past, false);
  assert.equal(permitHold([{ t: 0, version: 42 }], 5000).openSince, 0);
  assert.equal(permitHold([{ t: 0, version: 42 }, { t: 5001, version: 42 }], 5000).past, true);
  assert.equal(permitHold([{ t: 0, version: 0 }, { t: 10, version: 0 }], 5000).openSince, null);
});

async function loadTools() {
  const require = createRequire(cloudflarePkg);
  const esbuild = require("esbuild");
  const mf = await import(pathToFileURL(require.resolve("miniflare")).href);
  const Miniflare = mf.Miniflare ?? mf.default?.Miniflare;
  if (typeof Miniflare !== "function") throw new Error("miniflare did not export Miniflare");
  return { esbuild, Miniflare };
}

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  assert.ok(sorted.length > 0, "no latency samples");
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

function clip(text) {
  return String(text ?? "")
    .replace(/"(?:errorId|fingerprint|requestId|op)"\s*:\s*"[^"]*"/g, '"id":"[redacted]"')
    .replace(/[A-Za-z0-9_-]{24,}/g, "[redacted]")
    .slice(0, 400);
}

async function call(mf, path, { method = "GET", key, body, ip = "192.0.2.10" } = {}) {
  const started = performance.now();
  const response = await mf.dispatchFetch(origin + path, {
    method,
    headers: {
      Host: new URL(origin).host,
      "CF-Connecting-IP": ip,
      ...(body ? { Origin: origin, "Content-Type": "application/json" } : {}),
      ...(key ? { Authorization: `Bearer ${key}` } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const text = await response.text();
  let json = null;
  if (text) {
    try { json = JSON.parse(text); } catch { json = null; }
  }
  return { status: response.status, ms: performance.now() - started, json, text };
}

async function boot() {
  const { esbuild, Miniflare } = await loadTools();
  const bundled = await esbuild.build({
    entryPoints: [workerEntry],
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    external: ["node:*", "cloudflare:*"],
    logLevel: "silent"
  });
  const persistence = await mkdtemp(join(tmpdir(), "room-load-"));
  const config = {
    modules: true,
    script: bundled.outputFiles[0].text,
    compatibilityDate: "2026-07-30",
    compatibilityFlags: ["nodejs_compat"],
    durableObjects: { ROOM: { className: "LoadTestRoom", useSQLite: true } },
    bindings: { ROOM_ORIGIN: origin },
    durableObjectsPersist: persistence
  };
  let mf = new Miniflare(config);
  return {
    persistence,
    get mf() { return mf; },
    async reopen() {
      await mf.dispose();
      mf = new Miniflare(config);
      return mf;
    },
    async dispose() { await mf.dispose(); }
  };
}

async function seedRoom(handle) {
  const seeded = await call(handle.mf, "/__load/seed", { method: "POST", body: {}, ip: "192.0.2.9" });
  assert.equal(seeded.status, 200, clip(seeded.json?.message ?? seeded.text));
  const body = seeded.json;
  assert.equal(body.roomId, LOAD_BUDGET.roomId);
  assert.equal(body.permitVersion, 0, "seed left the writer permit held");
  assert.ok(fillInBand(body.projectionBytes, body.storageLimitBytes, LOAD_BUDGET.fillRatioMin, LOAD_BUDGET.fillRatioMax),
    `fill ${body.fillRatio} bytes ${body.projectionBytes} limit ${body.storageLimitBytes} valueLimit ${body.valueLimitBytes} posts ${body.posts}`);
  assert.ok(Array.isArray(body.actors) && body.actors.some(actor => actor.kind === "human") && body.actors.some(actor => actor.kind === "agent"));
  return body;
}

function writeReport(report) {
  const path = process.env.LOAD_REPORT_PATH;
  const line = JSON.stringify(report);
  console.log(`load-report ${line}`);
  if (path) writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
}

test("near-full room absorbs a write flood and stays openable", { timeout: 180_000, skip: harnessOn ? false : "the load workflow sets LOAD_HARNESS=1" }, async () => {
  const handle = await boot();
  const timings = [];
  const permitSamples = [];
  const report = {
    roomId: LOAD_BUDGET.roomId,
    projectionBytes: null,
    storageLimitBytes: null,
    valueLimitBytes: null,
    fillRatio: null,
    productionDatabaseLimitBytes: LOAD_BUDGET.productionDatabaseLimitBytes,
    dbBytes: null,
    writes: 0,
    snapshotReads: 0,
    fiveHundreds: 0,
    p95Ms: null,
    p95BudgetMs: LOAD_BUDGET.p95BudgetMs,
    permitTtlMs: LOAD_BUDGET.permitTtlMs,
    permitHeldPastTtl: null,
    permitIdle: null,
    roomOpenable: false,
    writerPermit: null
  };
  try {
    const seeded = await seedRoom(handle);
    report.projectionBytes = seeded.projectionBytes;
    report.storageLimitBytes = seeded.storageLimitBytes;
    report.valueLimitBytes = seeded.valueLimitBytes;
    report.fillRatio = seeded.fillRatio;
    report.dbBytes = seeded.dbBytes;

    let stopPoll = false;
    const poll = (async () => {
      while (!stopPoll) {
        const sample = await call(handle.mf, "/__load/permit", { ip: "192.0.2.8" });
        permitSamples.push({ t: Date.now(), version: sample.json?.version ?? null, status: sample.status });
        if (stopPoll) break;
        await sleep(20);
      }
    })();

    const jobs = [];
    seeded.actors.forEach((actor, index) => {
      for (let n = 0; n < LOAD_BUDGET.writesPerActor; n += 1) {
        jobs.push((async () => {
          const result = await call(handle.mf, `/api/rooms/${LOAD_BUDGET.roomId}/commands`, {
            method: "POST",
            key: actor.key,
            ip: `192.0.2.${20 + index}`,
            body: {
              id: randomUUID(),
              type: "message.posted",
              data: { messageId: `flood-${actor.memberId}-${n}`, body: `flood ${actor.kind} ${n}` }
            }
          });
          timings.push({ kind: "write", actor: actor.kind, status: result.status, ms: result.ms, code: result.json?.error?.code ?? null });
        })());
      }
    });
    for (let n = 0; n < LOAD_BUDGET.snapshotReads; n += 1) {
      const actor = seeded.actors[n % seeded.actors.length];
      const recent = n % 2 === 0;
      jobs.push((async () => {
        const path = recent
          ? `/api/rooms/${LOAD_BUDGET.roomId}?messages=recent`
          : `/api/rooms/${LOAD_BUDGET.roomId}`;
        const result = await call(handle.mf, path, { key: actor.key, ip: `192.0.2.${40 + (n % 20)}` });
        timings.push({ kind: "snapshot", status: result.status, ms: result.ms, code: result.json?.error?.code ?? null });
      })());
    }
    await Promise.all(jobs);
    stopPoll = true;
    await poll;

    let hold = permitHold(permitSamples, LOAD_BUDGET.permitTtlMs);
    if (hold.openSince !== null) {
      await sleep(LOAD_BUDGET.permitTtlMs);
      const again = await call(handle.mf, "/__load/permit", { ip: "192.0.2.8" });
      permitSamples.push({ t: Date.now(), version: again.json?.version ?? null, status: again.status });
      hold = permitHold(permitSamples, LOAD_BUDGET.permitTtlMs);
    }
    const fiveHundreds = timings.filter(row => row.status >= 500).length
      + permitSamples.filter(row => row.status >= 500).length;
    report.writes = timings.filter(row => row.kind === "write").length;
    report.snapshotReads = timings.filter(row => row.kind === "snapshot").length;
    report.fiveHundreds = fiveHundreds;
    report.p95Ms = percentile(timings.map(row => row.ms), 0.95);
    report.permitHeldPastTtl = hold.past || hold.openSince !== null;
    report.permitIdle = hold.openSince === null && permitSamples.at(-1)?.version === 0;

    assert.equal(fiveHundreds, 0, `5xx during flood ${JSON.stringify(timings.filter(row => row.status >= 500))}`);
    assert.ok(timings.some(row => row.kind === "write" && row.actor === "human" && row.status === 201), "a person write did not land");
    assert.ok(timings.some(row => row.kind === "write" && row.actor === "agent" && row.status === 201), "an agent write did not land");
    assert.ok(timings.some(row => row.kind === "snapshot" && row.status === 200), "a snapshot read did not open");
    assert.ok(report.p95Ms < LOAD_BUDGET.p95BudgetMs, `p95 ${report.p95Ms} ms over budget ${LOAD_BUDGET.p95BudgetMs} ms`);
    assert.equal(hold.past, false, "writer permit stayed held past its TTL");
    assert.equal(hold.openSince, null, "writer permit still held after the flood");

    await handle.reopen();
    const opened = await call(handle.mf, `/api/rooms/${LOAD_BUDGET.roomId}?messages=recent`, {
      key: seeded.ownerKey, ip: "192.0.2.7"
    });
    const permit = await call(handle.mf, "/__load/permit", { ip: "192.0.2.8" });
    report.roomOpenable = opened.status === 200 && Number.isFinite(opened.json?.sequence);
    report.writerPermit = permit.json?.version ?? null;
    report.fiveHundreds += opened.status >= 500 ? 1 : 0;
    assert.equal(opened.status, 200, `room did not open after cold start: ${opened.status} ${clip(opened.text)}`);
    assert.equal(typeof opened.json?.sequence, "number");
    assert.equal(permit.status, 200, clip(permit.text));
    assert.equal(permit.json?.version, 0, "writer permit held after cold start");
    report.permitIdle = true;
  } finally {
    writeReport(report);
    await handle.dispose();
    await rm(handle.persistence, { recursive: true, force: true });
  }
});

test("a stuck writer permit still leaves the room openable", {
  timeout: 180_000,
  skip: harnessOn && stuckOn ? false : "set LOAD_HARNESS=1 and LOAD_STUCK_PERMIT=1; fails on main until the storage.mjs self-heal"
}, async () => {
  const handle = await boot();
  try {
    const seeded = await seedRoom(handle);
    const stuck = await call(handle.mf, "/__load/stick-permit", { method: "POST", body: {}, ip: "192.0.2.6" });
    assert.equal(stuck.status, 200, clip(stuck.text));
    assert.equal(stuck.json.version, stuck.json.schemaVersion);
    assert.notEqual(stuck.json.version, 0);
    await handle.reopen();
    const health = await call(handle.mf, "/api/health", { ip: "192.0.2.5" });
    const opened = await call(handle.mf, `/api/rooms/${LOAD_BUDGET.roomId}?messages=recent`, {
      key: seeded.ownerKey, ip: "192.0.2.7"
    });
    const permit = await call(handle.mf, "/__load/permit", { ip: "192.0.2.8" });
    assert.equal(health.status, 200, "liveness is the worker and stays up when the object is down");
    assert.equal(opened.status, 200, `cold start with permit ${stuck.json.version} returned ${opened.status} ${clip(opened.text)}`);
    assert.equal(typeof opened.json?.sequence, "number");
    assert.equal(permit.json?.version, 0, "self-heal did not return the writer permit to idle");
  } finally {
    await handle.dispose();
    await rm(handle.persistence, { recursive: true, force: true });
  }
});
