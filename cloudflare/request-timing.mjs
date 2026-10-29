// Per-request timing that stays visible when a Durable Object stalls.
// `app` is handler time inside the object. `total` is what the Worker
// spent waiting for the response, including queueing and cold start.
// The gap is the stall. Query strings are never logged.

export function serverTimingMetric(name, durMs) {
  const dur = Number.isFinite(durMs) ? Math.max(0, Math.round(durMs)) : 0;
  return `${name};dur=${dur}`;
}

export function withServerTiming(response, name, durMs) {
  const headers = new Headers(response.headers);
  headers.append('Server-Timing', serverTimingMetric(name, durMs));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function requestPath(url) {
  try {
    const path = new URL(url).pathname;
    return path.length > 200 ? path.slice(0, 200) : path;
  } catch {
    return '';
  }
}

export function appDurationMs(headers) {
  const timing = headers?.get?.('Server-Timing') ?? '';
  const match = /(?:^|,\s*)app;dur=(\d+)/.exec(timing);
  return match ? Number(match[1]) : null;
}

export function logRoomRequest({ method, path, status, totalMs, servedBy, appMs }) {
  const entry = { event: 'room.request', method, path, status, totalMs, servedBy };
  if (Number.isFinite(appMs)) {
    entry.appMs = appMs;
    entry.queueMs = Math.max(0, totalMs - appMs);
  }
  console.info(JSON.stringify(entry));
}

// SPEED-PLAN 0.2: per-request store counters on the room.do_request line.
// The store's counters are cumulative (RoomStore.storeCounters); a request
// reports the delta from the previous snapshot taken at fetch entry, i.e.
// the store work done since the previous logged request in this object.
// Requests that interleave inside the object (an await in one fetch while
// another runs) share attribution — the honest grain for a census inside a
// single-threaded Durable Object, and exact for the serialised probe calls.
export function storeCounterDeltas(before, after) {
  if (!before || !after) return null;
  const delta = (a, b) => Number.isFinite(a) && Number.isFinite(b) ? Math.max(0, b - a) : null;
  return {
    rowsRead: delta(before.rowsRead, after.rowsRead),
    projectionCacheHits: delta(before.projectionCacheHits, after.projectionCacheHits) ?? 0,
    projectionCacheMisses: delta(before.projectionCacheMisses, after.projectionCacheMisses) ?? 0,
    projectionCacheEvictions: delta(before.projectionCacheEvictions, after.projectionCacheEvictions) ?? 0
  };
}

export function doRequestEntry({ method, path, status, appMs, counters }) {
  const entry = { event: 'room.do_request', method, path, status, appMs };
  if (counters) {
    if (Number.isFinite(counters.rowsRead)) entry.rowsRead = counters.rowsRead;
    entry.projectionCacheHits = counters.projectionCacheHits ?? 0;
    entry.projectionCacheMisses = counters.projectionCacheMisses ?? 0;
    entry.projectionCacheEvictions = counters.projectionCacheEvictions ?? 0;
  }
  return entry;
}

export function logDoRequest(fields) {
  console.info(JSON.stringify(doRequestEntry(fields)));
}
