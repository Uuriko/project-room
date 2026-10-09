// FIX-78: board-read latency probe with contention attribution (fail-first).
//
// The probe (scripts/board-read-probe.mjs) must attribute board-read latency
// into server-time vs network-time vs contention-time. These tests pin that
// attribution against a fixture HTTP server that injects a known delay into
// exactly one bucket at a time.
//
// Bucket model (per read):
//   connectMs   — TCP+TLS handshake (fresh connections only; 0 on reuse)
//   serverMs    — from the Server-Timing response header when present
//   networkMs   — socket transit: (ttfb - connect - server) + body transfer
//   contentionMs— estimated at ladder level, not per read (see attributeContention)
//
// When the API emits no Server-Timing header, server+network are reported as
// a combined "server/network" bucket — documented in
// docs/telemetry/board-read-latency-slo.md.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  summarize,
  percentile,
  parseServerTiming,
  attributeRead,
  attributeContention,
  verdictFor,
  SLO,
  runProbe,
} from "../scripts/board-read-probe.mjs";

// ---------------------------------------------------------------------------
// Fixture server: injects a delay into exactly one attribution bucket.
//
// Control headers (all optional, ms):
//   x-fixture-delay-server     — sleep before writeHead; reported via Server-Timing
//   x-fixture-omit-server-timing — "1": inject the server sleep WITHOUT the header
//   x-fixture-delay-network    — sleep between body chunks (models transit)
//   x-fixture-contention       — if in-flight > threshold, sleep before writeHead
//   x-fixture-contention-threshold — concurrency above which contention kicks in
//   x-fixture-hang             — "1": never respond (timeout test)
// ---------------------------------------------------------------------------
function startFixture() {
  // Deterministic contention model: the probe tags every request with
  // `x-probe-concurrency` (its batch size), so the fixture parks arrivals
  // until the full batch is present, then releases them together. If the
  // observed batch size exceeds `x-fixture-contention-threshold`, every
  // request waits `x-fixture-contention` ms of queue delay, which is
  // deliberately NOT reported in Server-Timing (the header measures handler
  // time only). Queueing inflates ttfb with no server-side attribution —
  // exactly what the probe's ladder delta is designed to catch. A 5s stray
  // release keeps a client bug from hanging the suite (client timeout is 10s).
  const waiting = [];
  const release = batch => {
    for (const x of batch) {
      // Queue wait elapses BEFORE the handler clock starts: Server-Timing
      // reports handler time only, never queueing. This models real servers,
      // where queue wait inflates ttfb with no server-side attribution.
      const startHandler = () => {
        const handlerStart = Date.now();
        const respond = () => {
          const headers = { "content-type": "application/json" };
          if (!x.omitHeader) headers["server-timing"] = `app;dur=${Date.now() - handlerStart}`;
          x.res.writeHead(200, headers);
          x.res.write('{"claims":[');
          if (x.networkDelay > 0) setTimeout(() => { x.res.write(']}'); x.res.end(); }, x.networkDelay);
          else { x.res.write(']}'); x.res.end(); }
        };
        if (x.serverDelay > 0) setTimeout(respond, x.serverDelay);
        else respond();
      };
      const contended = batch.length > x.threshold ? x.contentionDelay : 0;
      if (contended > 0) setTimeout(startHandler, contended);
      else startHandler();
    }
  };
  const server = http.createServer((req, res) => {
    if (req.headers["x-fixture-hang"] === "1") return; // never respond
    const num = v => (v == null ? 0 : Number(v) || 0);
    const w = {
      req, res,
      serverDelay: num(req.headers["x-fixture-delay-server"]),
      networkDelay: num(req.headers["x-fixture-delay-network"]),
      contentionDelay: num(req.headers["x-fixture-contention"]),
      threshold: Number(req.headers["x-fixture-contention-threshold"] ?? 1),
      omitHeader: req.headers["x-fixture-omit-server-timing"] === "1",
      cap: Math.max(1, num(req.headers["x-probe-concurrency"]) || 1),
    };
    waiting.push(w);
    if (waiting.length >= w.cap) {
      release(waiting.splice(0, waiting.length));
    } else {
      // Stray release: a batch that never fills (client bug) is released
      // delay-free after 5s instead of hanging to the 10s client timeout.
      setTimeout(() => {
        const i = waiting.indexOf(w);
        if (i >= 0) {
          const stray = waiting.splice(i, 1)[0];
          stray.contentionDelay = 0;
          stray.serverDelay = 0;
          release([stray]);
        }
      }, 5000).unref?.();
    }
  });
  return new Promise(resolve => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

async function stopFixture({ server }) {
  await new Promise(resolve => server.close(resolve));
}

const within = (actual, expected, tol, label) =>
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `${label}: expected ${expected}±${tol}, got ${actual}`
  );

// ---------------------------------------------------------------------------
// Unit: percentile math on fixture distributions
// ---------------------------------------------------------------------------
test("p50/p99 are computed correctly on a fixture distribution", () => {
  const s = summarize([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(s.count, 10);
  assert.equal(s.p50, 5.5); // median of even-count sample
  assert.equal(s.p99, 10);
  assert.equal(s.min, 1);
  assert.equal(s.max, 10);
});

test("percentile handles single-sample and empty input", () => {
  assert.equal(percentile([42], 50), 42);
  assert.equal(percentile([42], 99), 42);
  assert.equal(percentile([], 50), null);
  assert.equal(summarize([]).count, 0);
});

test("p99 of 100-sample 1..100 distribution is 99 (nearest-rank)", () => {
  const samples = Array.from({ length: 100 }, (_, i) => i + 1);
  assert.equal(summarize(samples).p99, 99);
});

// ---------------------------------------------------------------------------
// Unit: Server-Timing parsing
// ---------------------------------------------------------------------------
test("parseServerTiming sums dur values across metrics", () => {
  assert.equal(parseServerTiming("db;dur=12.5, app;dur=230"), 242.5);
});

test("parseServerTiming tolerates missing dur and garbage", () => {
  assert.equal(parseServerTiming("app"), 0);
  assert.equal(parseServerTiming(""), null);
  assert.equal(parseServerTiming(null), null);
  assert.equal(parseServerTiming("app;dur=abc"), 0);
});

// ---------------------------------------------------------------------------
// Unit: per-read attribution buckets
// ---------------------------------------------------------------------------
test("attributeRead splits ttfb into server vs network when Server-Timing exists", () => {
  const a = attributeRead({ totalMs: 400, ttfbMs: 320, connectMs: 20, serverTimingMs: 250 });
  assert.equal(a.connectMs, 20);
  assert.equal(a.serverMs, 250);
  within(a.networkMs, 50, 1e-9, "network"); // ttfb - connect - server = 50
  within(a.bodyMs, 80, 1e-9, "body");       // total - ttfb
  assert.equal(a.contentionMs, 0);
});

test("attributeRead falls back to combined server/network bucket without Server-Timing", () => {
  const a = attributeRead({ totalMs: 400, ttfbMs: 320, connectMs: 20, serverTimingMs: null });
  assert.equal(a.serverMs, null);
  within(a.serverNetworkMs, 300, 1e-9, "server/network combined"); // ttfb - connect
  within(a.bodyMs, 80, 1e-9, "body");
});

test("attributeContention is the ladder delta above baseline, floored at 0", () => {
  assert.equal(attributeContention(100, 600), 500);
  assert.equal(attributeContention(600, 100), 0); // faster under load: no negative contention
  assert.equal(attributeContention(null, 600), null); // no baseline: unattributed
});

// ---------------------------------------------------------------------------
// Integration: fixture with injected SERVER delay -> server bucket
// ---------------------------------------------------------------------------
test("server delay is attributed to the server bucket", async () => {
  const fx = await startFixture();
  try {
    const r = await runProbe({
      baseUrl: fx.url,
      path: "/board",
      headers: { "x-fixture-delay-server": "250" },
      runs: 6,
      ladder: [1],
      timeoutMs: 5000,
    });
    // Assert on medians: a single cold sample can catch a slow event loop.
    const med = key => percentile(r.baseline.samples.map(s => s[key]), 50);
    within(med("serverMs"), 250, 120, "server bucket");
    assert.ok(med("networkMs") < 100,
      `network bucket should be transit-only, got ${med("networkMs")}`);
    assert.ok(r.baseline.samples.every(s => s.contentionMs === 0),
      "per-read contention must be 0");
  } finally {
    await stopFixture(fx);
  }
});

test("server delay without Server-Timing lands in the combined bucket", async () => {
  const fx = await startFixture();
  try {
    const r = await runProbe({
      baseUrl: fx.url,
      path: "/board",
      headers: { "x-fixture-delay-server": "250", "x-fixture-omit-server-timing": "1" },
      runs: 6,
      ladder: [1],
      timeoutMs: 5000,
    });
    const med = key => percentile(r.baseline.samples.map(s => s[key]), 50);
    assert.equal(r.baseline.samples[0].serverMs, null);
    // The ~250ms server sleep must show up in the combined bucket, not vanish.
    const combined = med("serverNetworkMs");
    assert.ok(combined > 150 && combined < 800,
      `combined server/network bucket should capture the sleep, got ${combined}`);
  } finally {
    await stopFixture(fx);
  }
});

// ---------------------------------------------------------------------------
// Integration: fixture with injected NETWORK delay -> network bucket
// ---------------------------------------------------------------------------
test("network (body-transfer) delay is attributed to the network bucket", async () => {
  const fx = await startFixture();
  try {
    const r = await runProbe({
      baseUrl: fx.url,
      path: "/board",
      headers: { "x-fixture-delay-network": "300" },
      runs: 6,
      ladder: [1],
      timeoutMs: 5000,
    });
    const med = key => percentile(r.baseline.samples.map(s => s[key]), 50);
    within(med("bodyMs"), 300, 120, "body/network bucket");
    assert.ok((med("serverMs") ?? 0) < 120,
      `server bucket should be small, got ${med("serverMs")}`);
  } finally {
    await stopFixture(fx);
  }
});

// ---------------------------------------------------------------------------
// Integration: fixture with injected CONTENTION -> ladder delta
//
// Queue wait is deliberately absent from Server-Timing (it measures handler
// time only) — the probe must attribute it to contention via the ladder
// delta, never to the server bucket. Two runProbe calls (solo baseline vs
// loaded) are composed with the exported attributeContention, which is also
// what runProbe uses internally for its own ladder.
// ---------------------------------------------------------------------------
test("contention delay is attributed to contention, not server or network", async () => {
  const fx = await startFixture();
  try {
    const r = await runProbe({
      baseUrl: fx.url, path: "/board",
      headers: {
        "x-fixture-contention": "400",
        "x-fixture-contention-threshold": "2",
      },
      runs: 5, ladder: [1, 8], timeoutMs: 10000,
    });
    const lvl1 = r.ladder.find(l => l.concurrency === 1);
    const lvl8 = r.ladder.find(l => l.concurrency === 8);
    assert.ok((lvl1.attribution.contentionMs ?? 0) < 150,
      `solo ladder rung must show no contention, got ${lvl1.attribution.contentionMs}`);
    within(lvl8.attribution.contentionMs, 400, 150, "ladder-delta contention");
    // Per-read semantics (documented in the probe header): the 400ms queue
    // wait inflates ttfb with no Server-Timing coverage, so it sits in the
    // per-read network residual — it must NOT be in the server bucket, and
    // the ladder delta is what re-attributes it to contention.
    const med = key => percentile(lvl8.samples.map(s => s[key]), 50);
    assert.ok((med("serverMs") ?? 0) < 120,
      `contention must not land in server bucket, got ${med("serverMs")}`);
    within(med("networkMs"), 400, 150, "per-read network residual holds the queue wait");
  } finally {
    await stopFixture(fx);
  }
});

test("no queueing -> no contention attributed (no false positives)", async () => {
  const fx = await startFixture();
  try {
    const r = await runProbe({
      baseUrl: fx.url, path: "/board",
      headers: {}, // no barrier, no injected delay anywhere
      runs: 5, ladder: [1, 2], timeoutMs: 10000,
    });
    for (const lvl of r.ladder) {
      assert.ok((lvl.attribution.contentionMs ?? 0) < 120,
        `concurrency ${lvl.concurrency}: no contention expected, got ${lvl.attribution.contentionMs}`);
    }
  } finally {
    await stopFixture(fx);
  }
});

test("hanging reads are counted as timeouts, not percentiles", async () => {
  const fx = await startFixture();
  try {
    const r = await runProbe({
      baseUrl: fx.url,
      path: "/board",
      headers: { "x-fixture-hang": "1" },
      runs: 3,
      ladder: [1],
      timeoutMs: 300,
    });
    assert.equal(r.baseline.timeouts, 3);
    assert.equal(r.baseline.summary.count, 0);
  } finally {
    await stopFixture(fx);
  }
});

// ---------------------------------------------------------------------------
// Unit: SLO breach verdicts
// ---------------------------------------------------------------------------
function fakeResult({ p99, timeouts, totalReads, contention, p50 }) {
  return {
    baseline: {
      reps: totalReads,
      timeouts,
      summary: { p99 },
    },
    ladder: [{
      concurrency: 8,
      reps: 1,
      timeouts: 0,
      summary: { p50 },
      attribution: { contentionMs: contention },
    }],
  };
}

test("verdictFor flags p99, timeout-rate, and contention breaches", () => {
  assert.equal(SLO.targets.p99_ms, 5000);
  const ok = verdictFor(fakeResult({ p99: 100, timeouts: 0, totalReads: 100, contention: 0, p50: 100 }));
  assert.equal(ok.breach, false);
  const slow = verdictFor(fakeResult({ p99: 6000, timeouts: 0, totalReads: 100, contention: 0, p50: 100 }));
  assert.equal(slow.breach, true);
  assert.match(slow.breaches.join(";"), /p99/);
  const timeouts = verdictFor(fakeResult({ p99: 100, timeouts: 6, totalReads: 100, contention: 0, p50: 100 }));
  assert.equal(timeouts.breach, true);
  assert.match(timeouts.breaches.join(";"), /timeout rate/);
  const contended = verdictFor(fakeResult({ p99: 100, timeouts: 0, totalReads: 100, contention: 50, p50: 100 }));
  assert.equal(contended.breach, true);
  assert.match(contended.breaches.join(";"), /contention/);
  // A single slow read is not a breach: p99 within target, no timeouts.
  const single = verdictFor(fakeResult({ p99: 4000, timeouts: 0, totalReads: 100, contention: 0, p50: 100 }));
  assert.equal(single.breach, false);
});
