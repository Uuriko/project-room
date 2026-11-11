// Runtime clock deltas, not CPU or queue measurements. Cloudflare clocks
// advance on I/O; synchronous work can report zero. Header timing excludes
// subsequent response-body work. Preserve legacy queueMs as an unattributed
// residual for compatibility, never use it to locate the delay.
export const runtimeTiming = Object.freeze({ clockSemantics: 'io-bound', cpuMeasured: false });

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
  const entry = { event: 'room.request', method, path, status, totalMs, servedBy, ...runtimeTiming };
  if (Number.isFinite(appMs)) {
    entry.appMs = appMs;
    entry.queueMs = Math.max(0, totalMs - appMs);
    entry.residualMs = entry.queueMs;
    entry.residualAttribution = 'unattributed';
  }
  console.info(JSON.stringify(entry));
}
