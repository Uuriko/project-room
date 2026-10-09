// FIX-78 — board-read latency probe with contention attribution.
//
// Measures board-read latency and attributes it into three buckets:
//   server     — time the API spent processing the request (from Server-Timing
//                when the API emits it; combined with network otherwise)
//   network    — socket transit, plus any server wait the API didn't report
//                (queueing hides here per-read; the ladder pulls it out)
//   contention — extra latency that appears only when readers run concurrently
//
// How each bucket is measured (see docs/telemetry/board-read-latency-slo.md):
//   * connect:   TCP+TLS(+DNS) handshake, measured from socket events when a
//                genuinely new socket is created (0 on keep-alive reuse — the
//                probe reuses one pool per origin so ladder reads overlap).
//   * server:    parsed from the `Server-Timing` response header (sum of all
//                `dur=` values) WHEN the API emits it. The live room API does
//                NOT emit Server-Timing, so in practice this bucket is null and
//                server+network are reported as one combined "server/network"
//                bucket: ttfb - connect. The split is honest about what the
//                API actually supports.
//   * network:   (ttfb - connect - server): wire transit PLUS any server-side
//                wait the API did not report (e.g. queueing — Server-Timing
//                usually measures handler time, not queue wait). Per-read this
//                bucket is transit+unattributed; the LADDER delta is what
//                separates queueing (contention) from true transit.
//   * contention: NOT measurable on a single read. Estimated with a
//                concurrency ladder: run the same read at concurrency 1 (the
//                baseline) and at N parallel readers; contention(N) =
//                max(0, p50(N) - p50(baseline)). The delta isolates queueing/
//                lock contention on the server from everything else.
//
// This is ATTRIBUTION only — it does not fix slowness. FIX-54 (telemetry
// collector) and FIX-55 (in-room digest) are separate work items.
//
// Usage:
//   node scripts/board-read-probe.mjs [options]
//     --base-url URL        default https://room.trydemigod.com
//     --room NAME           default muse-room
//     --path PATH           default /api/rooms/<room>/work-claims?limit=200
//     --runs N              reads per level (default 10)
//     --ladder 1,2,4,8      concurrency levels (default 1,2,4,8)
//     --timeout-ms MS       per-read timeout (default 30000)
//     --bearer TOKEN        else $ROOM_IDENTITY_SECRET
//     --header "K: V"       extra request header (repeatable)
//     --pretty              pretty-print JSON (default: compact)
//     --help
//
// Output: JSON on stdout — baseline summary + per-ladder-level summaries +
// per-bucket attribution + the SLO definition used for breach verdicts.
import http from "node:http";
import https from "node:https";
import { pathToFileURL } from "node:url";

// ---------------------------------------------------------------------------
// Pure math / parsing (unit-testable)
// ---------------------------------------------------------------------------

// Nearest-rank percentile, EXCEPT p50 which is the conventional median
// (average of the two middle values on even counts). Returns null on empty.
export function percentile(samples, q) {
  if (!samples || samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  if (q === 50) {
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1
      ? sorted[mid]
      : (sorted[mid - 1] + sorted[mid]) / 2;
  }
  const rank = Math.ceil((q / 100) * sorted.length); // 1-based
  return sorted[Math.min(rank, sorted.length) - 1];
}

export function summarize(samples) {
  const vals = [...samples].sort((a, b) => a - b);
  return {
    count: vals.length,
    min: vals.length ? vals[0] : null,
    p50: percentile(vals, 50),
    p99: percentile(vals, 99),
    max: vals.length ? vals[vals.length - 1] : null,
    mean: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null,
  };
}

// Sum of all `dur=` values in a Server-Timing header. Returns null when the
// header is absent/empty (unknown), 0 when present but carrying no durations.
export function parseServerTiming(header) {
  if (header == null || String(header).trim() === "") return null;
  let total = 0;
  for (const part of String(header).split(",")) {
    const m = /dur=([0-9]+(?:\.[0-9]+)?)/.exec(part);
    if (m) total += Number(m[1]);
  }
  return total;
}

// Attribute ONE read into buckets. contentionMs is always 0 here — contention
// is a ladder-level estimate (attributeContention), never a per-read value.
export function attributeRead({ totalMs, ttfbMs, connectMs, serverTimingMs }) {
  const serverMs = serverTimingMs ?? null;
  const bodyMs = Math.max(0, totalMs - ttfbMs);
  const base = { totalMs, ttfbMs, connectMs, bodyMs, contentionMs: 0 };
  if (serverMs == null) {
    return {
      ...base,
      serverMs: null,
      serverNetworkMs: Math.max(0, ttfbMs - connectMs), // combined fallback
      networkMs: null,
    };
  }
  return {
    ...base,
    serverMs,
    serverNetworkMs: null,
    networkMs: Math.max(0, ttfbMs - connectMs - serverMs),
  };
}

// Ladder-level contention estimate: how much slower the median read gets when
// `concurrency` readers run in parallel vs the solo baseline. Floored at 0 —
// a faster loaded median means no contention, not negative contention.
// null baseline (no successful baseline reads) -> unattributed.
export function attributeContention(baselineP50, levelP50) {
  if (baselineP50 == null || levelP50 == null) return null;
  return Math.max(0, levelP50 - baselineP50);
}

// ---------------------------------------------------------------------------
// Probe engine
// ---------------------------------------------------------------------------

function timedGet(url, { headers = {}, timeoutMs = 30000, bearer = null, agent, concurrency = 1 }) {
  return new Promise(resolve => {
    const t0 = performance.now();
    const isHttps = url.startsWith("https:");
    const mod = isHttps ? https : http;
    let connectMs = 0;
    let settled = false;
    const done = result => {
      if (!settled) { settled = true; resolve(result); }
    };
    let req;
    try {
      req = mod.request(url, {
        method: "GET",
        headers: {
          ...headers,
          // Identifies probe traffic (operators can filter it) and tells a
          // test fixture how many readers form this batch, so it can model
          // queueing deterministically.
          "x-probe": "board-read-probe",
          "x-probe-concurrency": String(concurrency),
          ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        },
        // Shared keep-alive pool (see runProbe): parallel reads must overlap
        // on the wire for the contention ladder to mean anything. Fresh
        // connections per read serialize through connect+close and can never
        // contend server-side. connectMs is measured only when a genuinely
        // new socket is created (0 on reuse).
        agent,
      }, res => {
        const ttfbMs = performance.now() - t0;
        res.resume(); // drain; we only need timing + headers
        res.on("end", () => done({
          ok: true,
          timeout: false,
          totalMs: performance.now() - t0,
          ttfbMs,
          connectMs,
          status: res.statusCode,
          serverTimingMs: parseServerTiming(res.headers["server-timing"] ?? null),
        }));
      });
    } catch (err) {
      return done({ ok: false, timeout: false, error: String(err && err.message || err) });
    }
    req.on("socket", socket => {
      if (socket.connecting) {
        const tSock = performance.now();
        socket.once(isHttps ? "secureConnect" : "connect", () => {
          connectMs = performance.now() - tSock;
        });
      }
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      done({ ok: false, timeout: true, totalMs: timeoutMs });
    });
    req.on("error", () => done({ ok: false, timeout: false, error: "request_error" }));
    req.end();
  });
}

async function runLevel({ url, headers, timeoutMs, bearer, agent, concurrency, reps }) {
  const samples = [];
  let timeouts = 0;
  let errors = 0;
  for (let r = 0; r < reps; r++) {
    const batch = await Promise.all(
      Array.from({ length: concurrency }, () => timedGet(url, { headers, timeoutMs, bearer, agent, concurrency }))
    );
    for (const raw of batch) {
      if (raw.timeout) { timeouts += 1; continue; }
      if (!raw.ok) { errors += 1; continue; }
      samples.push(attributeRead(raw));
    }
  }
  return { samples, timeouts, errors };
}

function summarizeBucket(samples, key) {
  return summarize(samples.map(s => s[key]).filter(v => v != null));
}

export async function runProbe({
  baseUrl,
  path,
  headers = {},
  bearer = null,
  runs = 10,
  ladder = [1],
  timeoutMs = 30000,
}) {
  const url = `${baseUrl.replace(/\/$/, "")}${path}`;
  // One keep-alive pool per origin for the whole probe run. Parallel ladder
  // reads open parallel sockets (up to maxSockets) so they genuinely overlap
  // server-side; without reuse, fresh-connect-per-read serializes and the
  // ladder can never observe contention (verified empirically, FIX-78).
  const maxSockets = Math.max(64, ...ladder);
  const agent = {
    http: new http.Agent({ keepAlive: true, maxSockets }),
    https: new https.Agent({ keepAlive: true, maxSockets }),
  };
  const pickAgent = url.startsWith("https:") ? agent.https : agent.http;
  const baseline = await runLevel({ url, headers, timeoutMs, bearer, agent: pickAgent, concurrency: 1, reps: runs });
  const baselineP50 = summarize(baseline.samples.map(s => s.totalMs)).p50;
  const ladderResults = [];
  for (const concurrency of ladder) {
    const level = await runLevel({ url, headers, timeoutMs, bearer, agent: pickAgent, concurrency, reps: runs });
    const levelP50 = summarize(level.samples.map(s => s.totalMs)).p50;
    ladderResults.push({
      concurrency,
      reps: runs,
      timeouts: level.timeouts,
      errors: level.errors,
      summary: summarize(level.samples.map(s => s.totalMs)),
      samples: level.samples,
      attribution: {
        connectMs: summarizeBucket(level.samples, "connectMs"),
        serverMs: summarizeBucket(level.samples, "serverMs"),
        networkMs: summarizeBucket(level.samples, "networkMs"),
        serverNetworkMs: summarizeBucket(level.samples, "serverNetworkMs"),
        bodyMs: summarizeBucket(level.samples, "bodyMs"),
        contentionMs: attributeContention(baselineP50, levelP50),
      },
    });
  }
  const result = {
    target: { baseUrl, path, url },
    slo: SLO,
    baseline: {
      reps: runs,
      timeouts: baseline.timeouts,
      errors: baseline.errors,
      summary: summarize(baseline.samples.map(s => s.totalMs)),
      samples: baseline.samples,
    },
    ladder: ladderResults,
    // Headline: worst contention seen across the ladder, and the method note
    // so readers know which attribution path was actually available.
    method: {
      serverTimingPresent: baseline.samples.some(s => s.serverMs != null),
      note: "server bucket from Server-Timing when the API emits it; " +
        "otherwise server+network reported combined (serverNetworkMs). " +
        "networkMs is transit plus any server wait Server-Timing did not " +
        "report (queueing hides here per-read). contention, from the " +
        "concurrency-ladder delta vs baseline p50, is the load-induced " +
        "portion — i.e. the part of networkMs that only appears under load.",
    },
  };
  // Release pooled sockets: lets test fixtures' server.close() return
  // promptly instead of waiting out the keep-alive timeout.
  agent.http.destroy();
  agent.https.destroy();
  return result;
}

// ---------------------------------------------------------------------------
// SLO (also documented in docs/telemetry/board-read-latency-slo.md)
// ---------------------------------------------------------------------------
export const SLO = {
  name: "board-read-latency",
  description: "p50/p99 targets for a single board read (work-claims board).",
  targets: {
    p50_ms: 1500,
    p99_ms: 5000,
    timeout_ms: 30000,
    contention_share: 0.3, // contention must stay < 30% of ladder p50
  },
  breach: "BREACH when, over a probe run: p99 > 5000ms, or >5% of reads " +
    "time out, or contentionMs > 30% of the ladder p50 at any rung. " +
    "A single slow read is not a breach — the SLO is on the run's p50/p99.",
};

export function verdictFor(result) {
  const { p99_ms, contention_share } = SLO.targets;
  const b = result.baseline.summary;
  const totalTimeouts = result.baseline.timeouts +
    result.ladder.reduce((a, l) => a + l.timeouts, 0);
  const totalReads = result.baseline.reps +
    result.ladder.reduce((a, l) => a + l.reps * l.concurrency, 0);
  const timeoutRate = totalReads ? totalTimeouts / totalReads : 0;
  const breaches = [];
  if (b.p99 != null && b.p99 > p99_ms) breaches.push(`p99 ${b.p99.toFixed(0)}ms > ${p99_ms}ms`);
  if (timeoutRate > 0.05) breaches.push(`timeout rate ${(timeoutRate * 100).toFixed(1)}% > 5%`);
  for (const lvl of result.ladder) {
    const c = lvl.attribution.contentionMs;
    const p = lvl.summary.p50;
    if (c != null && p != null && p > 0 && c / p > contention_share) {
      breaches.push(`contention ${c.toFixed(0)}ms > 30% of p50 at concurrency ${lvl.concurrency}`);
    }
  }
  return { slo: SLO.name, breach: breaches.length > 0, breaches };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(`board-read-probe.mjs — FIX-78 board-read latency probe with contention attribution.

Options:
  --base-url URL     default https://room.trydemigod.com
  --room NAME        default muse-room
  --path PATH        default /api/rooms/<room>/work-claims?limit=200
  --runs N           reads per level (default 10)
  --ladder 1,2,4,8   concurrency levels (default 1,2,4,8)
  --timeout-ms MS    per-read timeout (default 30000)
  --bearer TOKEN     else $ROOM_IDENTITY_SECRET
  --header "K: V"    extra request header (repeatable)
  --pretty           pretty-print JSON

Attribution: server from Server-Timing when present (the room API does not
emit it — then server+network are reported combined); contention from the
concurrency-ladder delta vs the solo baseline. SLO: p50 <= 1500ms,
p99 <= 5000ms, timeout rate <= 5%, contention < 30% of ladder p50.`);
    return;
  }
  const baseUrl = argValue("--base-url") || "https://room.trydemigod.com";
  const room = argValue("--room") || "muse-room";
  const path = argValue("--path") || `/api/rooms/${room}/work-claims?limit=200`;
  const runs = Number(argValue("--runs") || 10);
  const ladder = (argValue("--ladder") || "1,2,4,8").split(",").map(s => Number(s.trim())).filter(n => n > 0);
  const timeoutMs = Number(argValue("--timeout-ms") || 30000);
  const bearer = argValue("--bearer") || process.env.ROOM_IDENTITY_SECRET || null;
  const headers = {};
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] === "--header" && process.argv[i + 1]) {
      const idx = process.argv[i + 1].indexOf(":");
      if (idx > 0) headers[process.argv[i + 1].slice(0, idx).trim().toLowerCase()] = process.argv[i + 1].slice(idx + 1).trim();
    }
  }
  const result = await runProbe({ baseUrl, path, headers, bearer, runs, ladder, timeoutMs });
  result.verdict = verdictFor(result);
  // Keep stdout machine-readable: samples stay, but drop per-read bulk in pretty mode? No — keep it simple and complete.
  console.log(JSON.stringify(result, null, process.argv.includes("--pretty") ? 2 : 0));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => { console.error(err); process.exit(1); });
}
