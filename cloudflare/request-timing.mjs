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

// Successful requests are the bulk of Workers Logs. Errors, and anything that
// is not a completed 2xx/3xx, are always recorded. The platform head sample
// stays at 1 so a line that is emitted is kept; sampling here is what drops
// the volume.
export const SUCCESS_REQUEST_LOG_RATE = 0.1;

export function shouldSampleRequestLog(status, random = Math.random) {
  const code = Number(status);
  if (!Number.isInteger(code) || code < 200 || code >= 400) return true;
  return random() < SUCCESS_REQUEST_LOG_RATE;
}

export function logRoomRequest({ method, path, status, totalMs, servedBy, appMs }, random = Math.random) {
  if (!shouldSampleRequestLog(status, random)) return false;
  const entry = { event: 'room.request', method, path, status, totalMs, servedBy };
  if (Number.isFinite(appMs)) {
    entry.appMs = appMs;
    entry.queueMs = Math.max(0, totalMs - appMs);
  }
  console.info(JSON.stringify(entry));
  return true;
}
