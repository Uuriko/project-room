// Request telemetry for the PERF-50 §5 100x triggers (TEL, consult-build).
//
// L22's fleet-side trigger gauges found four of the five §5 quantities
// UNMEASURED because no product-side read path existed: burst write p95,
// DO CPU read share, poll share of requests, total storage bytes. This
// module is the in-object half of that read path: the Durable Object
// records every request it serves into the aggregator below, and the
// "request-telemetry" job in server/jobs.mjs publishes a snapshot as its
// health summary, where fleet-tools/trigger-gauges.mjs already reads it
// (job "request-telemetry", lastSummary fields writeP95Ms /
// readCpuSharePct / pollSharePct / activeRooms / totalStorageBytes).
//
// Hot-path budget: record() is O(1) — a classification made of string
// checks, a few counter increments, and for writes one slot of a bounded
// ring buffer. No I/O, no storage writes, no allocation per request, no
// sorting. All aggregation (the p95 sort, the share divisions) happens in
// snapshot(), which runs on the hourly job tick, off the request path.
//
// Honesty rules (mirrors trigger-gauges):
// - A field with no samples is ABSENT from the snapshot, never zero:
//   absent reads as UNMEASURED downstream.
// - snapshot() resets the window, so every summary states its own
//   window (windowMs): the period since the previous tick, or since the
//   object started. An eviction restarts the window; windowMs shows it.
// - CPU: the DO runtime exposes no per-request CPU-time counter to JS.
//   readCpuSharePct is the read+poll share of handler wall time (the
//   DO's appMs), the closest in-object proxy for this synchronous,
//   SQL-bound object. Hold (SSE) requests are excluded from both sides:
//   their elapsed time is waiting for events, not CPU. "other" requests
//   are excluded from both sides too.

const WRITE_SAMPLE_CAP = 2048;

// Request classes for the §5 traffic split. poll+hold is the wake
// traffic the queue-wake trigger watches; write is the mutation traffic
// whose p95 the sharding trigger watches.
export function classifyRequest(method, pathname, searchParams) {
  const verb = String(method ?? "GET").toUpperCase();
  let path = String(pathname ?? "");
  // Mirror server/http.mjs's trailing-slash normalisation exactly (QA
  // 2026-10-03 P2-1, http.mjs:1208): the inner handler strips every
  // trailing slash before routing and serves the canonical route, but
  // the DO call site (cloudflare/room.mjs) records the un-normalised
  // pathname — without this, GET /api/rooms/{id}/stream/ (a real,
  // minutes-long SSE hold) classified as "read" and its whole duration
  // landed in readCpuMs, poisoning the read-share gauge. The length>1
  // guard keeps the root path "/" itself untouched, as in http.mjs.
  if (path.length > 1 && path.endsWith("/")) path = path.replace(/\/+$/, "");
  if (path.startsWith("/room/")) path = path.slice(5); // /room twin prefix
  const isApi = path.startsWith("/api/");
  if (verb !== "GET" && verb !== "HEAD" && verb !== "OPTIONS") {
    // /mcp POSTs mix read and write tools; counting them as writes would
    // poison the write p95, so they stay unclassified ("other").
    return isApi && path !== "/mcp" ? "write" : "other";
  }
  if (!isApi) return "other";
  if (path.endsWith("/stream")) return "hold"; // SSE wake hold
  if (path.startsWith("/api/pair/")) return "poll"; // pairing status poll
  // Incremental check-for-new-work reads carry a cursor; the same paths
  // without one are ordinary history reads.
  if (path.startsWith("/api/rooms/")
    && (searchParams?.has("after") || searchParams?.has("since") || searchParams?.has("cursor"))) return "poll";
  return "read";
}

export function createRequestTelemetry({ startedAt = Date.now(), now = () => Date.now() } = {}) {
  let windowStartedAt = startedAt;
  let requests = 0, readRequests = 0, writeRequests = 0, pollRequests = 0, holdRequests = 0;
  let readCpuMs = 0, writeCpuMs = 0; // handler ms; read side includes poll
  const writeSamples = new Array(WRITE_SAMPLE_CAP);
  let writeSampleCount = 0, writeSampleNext = 0;

  return {
    record({ method, pathname, searchParams, durationMs }) {
      const cls = classifyRequest(method, pathname, searchParams);
      const ms = Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0;
      requests += 1;
      if (cls === "write") {
        writeRequests += 1;
        writeCpuMs += ms;
        writeSamples[writeSampleNext] = ms;
        writeSampleNext = (writeSampleNext + 1) % WRITE_SAMPLE_CAP;
        if (writeSampleCount < WRITE_SAMPLE_CAP) writeSampleCount += 1;
      } else if (cls === "read") { readRequests += 1; readCpuMs += ms; }
      else if (cls === "poll") { pollRequests += 1; readCpuMs += ms; }
      else if (cls === "hold") { holdRequests += 1; } // waiting, not CPU
      // "other" counts only toward the total (the poll-share denominator).
    },
    snapshot(at = now()) {
      const out = { requests, readRequests, writeRequests, pollRequests, holdRequests, windowMs: Math.max(0, at - windowStartedAt) };
      if (requests > 0) out.pollSharePct = Math.round(((pollRequests + holdRequests) / requests) * 10000) / 100;
      const cpuMs = readCpuMs + writeCpuMs;
      if (cpuMs > 0) out.readCpuSharePct = Math.round((readCpuMs / cpuMs) * 1000) / 10;
      if (writeSampleCount > 0) {
        const sorted = writeSamples.slice(0, writeSampleCount).sort((a, b) => a - b);
        out.writeP95Ms = Math.round(sorted[Math.min(writeSampleCount - 1, Math.ceil(writeSampleCount * 0.95) - 1)]);
      }
      // Reset the window: the next summary speaks only for its own period.
      windowStartedAt = at;
      requests = 0; readRequests = 0; writeRequests = 0; pollRequests = 0; holdRequests = 0;
      readCpuMs = 0; writeCpuMs = 0;
      writeSampleCount = 0; writeSampleNext = 0;
      return out;
    }
  };
}
