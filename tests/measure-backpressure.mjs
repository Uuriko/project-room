#!/usr/bin/env node
// tests/measure-backpressure.mjs — WAVE-300 coordinator 3/10 (honest backpressure), worker D.
//
// One-shot measurement harness (NOT a unit test). Boots a real server instance
// from a repo ROOT passed on the command line — run it once against the BEFORE
// ref (origin/main @ cb05aa5bf snapshot) and once against the AFTER ref
// (wave300/bp-wbd @ 10616ea72) — and measures:
//
//   1. fanout:      200 concurrent POST /commands, 10s client timeout each.
//                    Counts silent timeouts vs fast 429 vs fast 503 vs 200/201.
//   2. timeto429:   (a) sequential writes against the write rate() limiter:
//                    ms from first request to first 429/503.
//                    (b) in-flight saturation: pin 16 trickled request bodies,
//                    then probe. BEFORE has no refusal path (probe admitted);
//                    AFTER must shed fast with 503 shed_load.
//   3. norearm:     burn the 60-write budget, send 50 refused retries, verify
//                    the penalty window is NOT extended (next admit time after
//                    the storm == admit time with no storm) and that refusals
//                    did not rewrite the durable abuse-rate bucket row.
//
// Usage:
//   node tests/measure-backpressure.mjs --root <repo-root> --ref before|after [--mode all|fanout|timeto429|norearm]
//
// Local server only. No external network, no production. Prints one JSON
// document to stdout. Each mode boots a FRESH server so modes do not
// interfere (fanout would otherwise burn the write budget for later modes).

import http from "node:http";
import { randomUUID, createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const args = Object.fromEntries(
  process.argv.slice(2).map((a, i, all) => a.startsWith("--") ? [a.slice(2), all[i + 1] ?? "true"] : []).filter(x => x.length)
);
const ROOT = args.root;
const REF = args.ref ?? "unknown";
const MODE = args.mode ?? "all";
if (!ROOT) { console.error("usage: --root <repo-root> --ref before|after [--mode all|fanout|timeto429|norearm]"); process.exit(2); }

const sleep = ms => new Promise(r => setTimeout(r, ms));
const rateHash = v => createHash("sha256").update(String(v)).digest("hex");

async function boot(root) {
  const [{ RoomStore }, { createRoomServer }, { initialRoom }] = await Promise.all([
    import(pathToFileURL(join(root, "server/store.mjs")).href),
    import(pathToFileURL(join(root, "server/http.mjs")).href),
    import(pathToFileURL(join(root, "server/bootstrap.mjs")).href),
  ]);
  const directory = mkdtempSync(join(tmpdir(), "bp-measure-"));
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => Date.now() });
  store.initialize(initialRoom());
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const newKey = () => store.issueAccessKey("commons", "owner");
  const close = async () => {
    try { server.closeStreams?.(); } catch {}
    try { server.closeAllConnections?.(); } catch {}
    await new Promise(resolve => server.close(resolve));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  };
  return { origin, store, newKey, close };
}

const command = () => ({ id: randomUUID(), type: "message.posted", data: { body: "backpressure probe" } });
// Write-budget probe: POST /commands with bond.list passes through the shared
// write rate() limiter (all non-GET room routes do) but does NOT spend
// room-flood-guard tokens (only message.posted/dm.posted do) and appends no
// event. Lets the no-rearm and time-to-first-429 measurements target the
// write rate() limiter exactly, instead of tripping the chat flood guard
// (burst 30, refill 0.5/s) first.
const writeProbe = () => ({ id: randomUUID(), type: "bond.list", data: {} });

function makeClient(origin, token) {
  return async function post(body, { timeoutMs = 10000 } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const start = Date.now();
    try {
      const res = await fetch(origin + "/api/rooms/commons/commands", {
        method: "POST",
        signal: ctrl.signal,
        headers: {
          Origin: origin,
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      let code = null;
      try { const p = JSON.parse(text); code = p?.error?.code ?? p?.code ?? null; } catch {}
      return {
        status: res.status, ms: Date.now() - start, timedOut: false,
        retryAfter: res.headers.get("retry-after"), rateLimitReset: res.headers.get("x-ratelimit-reset"),
        code,
      };
    } catch {
      return { status: null, ms: Date.now() - start, timedOut: true, retryAfter: null, code: null };
    } finally { clearTimeout(timer); }
  };
}

// ---------------------------------------------------------------- fanout ---
async function measureFanout(origin, token) {
  const client = makeClient(origin, token);
  const N = 200;
  const t0 = Date.now();
  const results = await Promise.all(Array.from({ length: N }, () => client(command(), { timeoutMs: 10000 })));
  const wallMs = Date.now() - t0;
  const counts = { n: N, ok200_201: 0, fast429: 0, fast503: 0, otherStatus: 0, silentTimeout: 0 };
  let retryAfter429 = 0, retryAfter503 = 0;
  const codes = {};
  const lat = { ok: [], r429: [], r503: [], other: [] };
  // 429 attribution: the chat flood guard (burst 30) refuses with a SMALL
  // Retry-After (~1-2s); the write rate() limiter refuses with Retry-After
  // ~= seconds until the 60s window resets (AFTER) or no Retry-After at all
  // (BEFORE). r429flood vs r429write split the 429s on that basis.
  const r429bySource = { floodGuard: 0, writeLimiter: 0, unknown: 0 };
  for (const r of results) {
    if (r.timedOut) { counts.silentTimeout++; continue; }
    if (r.status === 200 || r.status === 201) { counts.ok200_201++; lat.ok.push(r.ms); }
    else if (r.status === 429) {
      counts.fast429++; lat.r429.push(r.ms); if (r.retryAfter) retryAfter429++;
      const ra = Number(r.retryAfter);
      if (r.retryAfter && ra <= 5) r429bySource.floodGuard++;
      else if (r.retryAfter || r.rateLimitReset) r429bySource.writeLimiter++;
      else r429bySource.unknown++;
    }
    else if (r.status === 503) { counts.fast503++; lat.r503.push(r.ms); if (r.retryAfter) retryAfter503++; }
    else { counts.otherStatus++; lat.other.push(r.ms); }
    if (r.code) codes[r.code] = (codes[r.code] ?? 0) + 1;
  }
  const pct = v => +(100 * v / N).toFixed(1);
  const q = a => {
    if (!a.length) return null;
    const s = [...a].sort((x, y) => x - y);
    const at = p => s[Math.min(s.length - 1, Math.floor(p * s.length))];
    return { p50: at(0.5), p95: at(0.95), max: s[s.length - 1] };
  };
  return {
    ...counts,
    pctOk: pct(counts.ok200_201), pct429: pct(counts.fast429), pct503: pct(counts.fast503),
    pctOther: pct(counts.otherStatus), pctSilent: pct(counts.silentTimeout),
    r429bySource,
    retryAfterOn429: retryAfter429, retryAfterOn503: retryAfter503,
    latencyMs: { ok200_201: q(lat.ok), r429: q(lat.r429), r503: q(lat.r503), other: q(lat.other) },
    wallMs, bodyCodes: codes,
  };
}

// ------------------------------------------------------------ timeto429 ---
async function measureTimeToFirst429(origin, token) {
  // Sequential bond.list writes ramp the shared write rate() limiter
  // (60/60s) without tripping the chat flood guard.
  const client = makeClient(origin, token);
  const t0 = Date.now();
  for (let i = 1; i <= 200; i++) {
    const r = await client(writeProbe(), { timeoutMs: 10000 });
    if (r.timedOut) return { outcome: "silent_timeout", atRequest: i, ms: Date.now() - t0 };
    if (r.status === 429 || r.status === 503)
      return { outcome: "refused", atRequest: i, ms: Date.now() - t0, status: r.status, code: r.code,
        retryAfter: r.retryAfter, rateLimitReset: r.rateLimitReset };
  }
  return { outcome: "none_within_200", ms: Date.now() - t0 };
}

// Pin gauge slots with trickled (never completed) request bodies, parked at
// body() — the same technique as tests/command-admission-http.test.mjs.
function trickle(origin, path, token) {
  const url = new URL(path, origin);
  const req = http.request({
    host: url.hostname, port: url.port, path: url.pathname + url.search,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Transfer-Encoding": "chunked",
      Origin: origin,
      Authorization: `Bearer ${token}`,
    },
  });
  req.on("response", response => { response.resume(); });
  req.on("error", () => {});
  req.write(`{"id":"${randomUUID()}","type":"message.posted","data":{"body":"trickle`);
  return req;
}

async function measureInflightRefusal(origin, token, ref) {
  const client = makeClient(origin, token);
  const tricklers = Array.from({ length: 16 }, () => trickle(origin, "/api/rooms/commons/commands", token));
  const t0 = Date.now();
  let outcome;
  try {
    if (ref === "after") {
      // Poll until the gate refuses; cap 8s.
      outcome = { outcome: "no_refusal_within_8s", ms: null, probeStatus: null };
      for (;;) {
        const r = await client(command(), { timeoutMs: 5000 });
        if (r.timedOut) { outcome = { outcome: "probe_timed_out", ms: Date.now() - t0, probeStatus: null }; break; }
        if (r.status === 503) {
          outcome = { outcome: "shed_503", ms: Date.now() - t0, probeStatus: 503, code: r.code, retryAfter: r.retryAfter };
          break;
        }
        if (Date.now() - t0 > 8000) { outcome = { outcome: "no_refusal_within_8s", ms: Date.now() - t0, probeStatus: r.status }; break; }
        await sleep(50);
      }
    } else {
      await sleep(500); // let the 16 trickled bodies park at body()
      const r = await client(command(), { timeoutMs: 5000 });
      outcome = r.timedOut
        ? { outcome: "probe_timed_out", ms: Date.now() - t0, probeStatus: null }
        : (r.status === 429 || r.status === 503)
          ? { outcome: "refused", ms: Date.now() - t0, probeStatus: r.status, code: r.code, retryAfter: r.retryAfter }
          : { outcome: "admitted_no_refusal_path", ms: Date.now() - t0, probeStatus: r.status };
    }
  } finally {
    for (const q of tricklers) { try { q.destroy(); } catch {} }
  }
  return outcome;
}

// --------------------------------------------------------------- norearm ---
function snapshotBuckets(store) {
  const has = store.db.prepare(
    "SELECT 1 AS hit FROM sqlite_master WHERE type='table' AND name='abuse_rate_buckets'").get();
  if (!has) return {};
  const rows = store.db.prepare("SELECT id, n, until_ms FROM abuse_rate_buckets").all();
  return Object.fromEntries(rows.map(r => [r.id, { n: r.n, until_ms: r.until_ms }]));
}

async function burnWriteBudget(client) {
  // 60 sequential admitted writes = the full write rate() budget. bond.list
  // commands spend write-budget but no flood-guard tokens.
  for (let i = 0; i < 60; i++) {
    const r = await client(writeProbe(), { timeoutMs: 10000 });
    if (r.timedOut || (r.status !== 200 && r.status !== 201))
      throw new Error(`budget burn failed at write ${i + 1}: status=${r.status} timedOut=${r.timedOut} retryAfter=${r.retryAfter}`);
  }
}

async function waitForAdmit(client, tExhausted, capMs = 90000) {
  // Poll until a write is admitted again (non-429). Each poll inside the
  // window is itself a refused request — counted, not hidden.
  let polls = 0, refusedPolls = 0;
  const t0 = Date.now();
  for (;;) {
    const r = await client(writeProbe(), { timeoutMs: 10000 });
    polls++;
    if (!r.timedOut && r.status !== 429)
      return { admitAfterExhaustedMs: Date.now() - tExhausted, status: r.status, polls, refusedPolls };
    if (r.status === 429) refusedPolls++;
    if (Date.now() - t0 > capMs) throw new Error("admit wait exceeded cap; window never reset");
    await sleep(250);
  }
}

async function measureNoRearm(origin, store, newKey) {
  // CONTROL: no storm. Burn budget on key K1, wait out the window, admit.
  const c1 = makeClient(origin, newKey());
  await burnWriteBudget(c1);
  const tExhaustedControl = Date.now();
  const control = await waitForAdmit(c1, tExhaustedControl);

  // STORM: burn budget on key K2, fire 50 refused retries, snapshot the
  // durable row before/after the storm, then wait out the window and admit.
  const c2 = makeClient(origin, newKey());
  await burnWriteBudget(c2);
  const tExhaustedStorm = Date.now();
  const before = snapshotBuckets(store);
  const stormStatuses = [];
  let lastRefusal = null;
  for (let i = 0; i < 50; i++) {
    const r = await c2(writeProbe(), { timeoutMs: 10000 });
    stormStatuses.push(r.timedOut ? "timeout" : r.status);
    if (!r.timedOut && (r.status === 429 || r.status === 503)) lastRefusal = r;
  }
  const after = snapshotBuckets(store);
  const storm = await waitForAdmit(c2, tExhaustedStorm);

  const refusedCount = stormStatuses.filter(s => s === 429 || s === 503).length;
  const writeRows = id => id.startsWith("write:");
  const changedRows = Object.keys(after).filter(id =>
    writeRows(id) && JSON.stringify(before[id]) !== JSON.stringify(after[id]));

  return {
    control: { admitAfterExhaustedMs: control.admitAfterExhaustedMs, polls: control.polls, refusedPolls: control.refusedPolls },
    storm: {
      refusedOf50: refusedCount,
      lastRefusalRetryAfter: lastRefusal?.retryAfter ?? null,
      lastRefusalRateLimitReset: lastRefusal?.rateLimitReset ?? null,
      admitAfterExhaustedMs: storm.admitAfterExhaustedMs,
      polls: storm.polls, refusedPolls: storm.refusedPolls,
    },
    admitDeltaMs: storm.admitAfterExhaustedMs - control.admitAfterExhaustedMs,
    durableRowsChangedByStorm: changedRows.map(id => ({
      id: `write:<credentialHash:${rateHash(id).slice(0, 12)}>`,
      before: before[id] ?? null, after: after[id],
    })),
    verdict: {
      windowExtended: Math.abs(storm.admitAfterExhaustedMs - control.admitAfterExhaustedMs) > 5000,
      durableRewrittenOnRefusal: changedRows.length > 0,
    },
  };
}

// ------------------------------------------------------------------ main ---
const out = { ref: REF, root: ROOT, mode: MODE, startedAt: new Date().toISOString() };

async function runMode(name, fn) {
  const { origin, store, newKey, close } = await boot(ROOT);
  try { out[name] = await fn(origin, store, newKey); }
  finally { await close(); }
}

if (MODE === "all" || MODE === "fanout")
  await runMode("fanout", (origin, _s, newKey) => measureFanout(origin, newKey()));
if (MODE === "all" || MODE === "timeto429")
  await runMode("timeto429", async (origin, _s, newKey) => ({
    sequentialToRateLimit: await measureTimeToFirst429(origin, newKey()),
    inflightSaturation: await measureInflightRefusal(origin, newKey(), REF),
  }));
if (MODE === "all" || MODE === "norearm")
  await runMode("norearm", (origin, store, newKey) => measureNoRearm(origin, store, newKey));

out.finishedAt = new Date().toISOString();
console.log(JSON.stringify(out, null, 2));
