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
