// Worker-side liveness for /api/health. A cold Durable Object can spend
// seconds rebuilding; the health check must answer before that finishes and
// say whether the object is ready. One in-flight probe is shared so a 1 Hz
// checker does not queue a fetch per tick while the constructor holds the
// input gate. Each caller still gets its own answer once the object is awake,
// because Origin checks and HEAD/GET are per request.

// Warm production health is ~50 ms (p95 ~66 ms). A cold invite-only-pilot
// used to block the same check for 6–20 s. After one second the probe
// answers 503 with do.status "timeout" instead of pretending the Worker
// is a ready room. The same bound covers a local workerd isolate's first boot.
export const HEALTH_PROBE_TIMEOUT_MS = 1000;

export function createHealthProbe() {
  let inflight = null;
  return async function probe({ start, timeoutMs = HEALTH_PROBE_TIMEOUT_MS, onSnapshot, onUnready, waitUntil }) {
    const started = performance.now();
    const timing = () => ({ elapsedMs: Math.round(performance.now() - started), timeoutMs });
    // A returned health response must not cancel the probe. The runtime drops
    // in-flight I/O that is not passed to waitUntil, which would abort the
    // constructor every 200 ms and never let the object become ready.
    const track = promise => {
      if (typeof waitUntil !== "function") return;
      waitUntil(Promise.resolve(promise).then(() => {}, () => {}));
    };
    if (inflight) {
      const joined = await race(inflight, timeoutMs);
      if (joined.timeout) track(inflight);
      if (joined.timeout || joined.error) return onUnready(joined.timeout ? "timeout" : "error", timing());
      try { return onSnapshot(await snapshotResponse(await start()), timing()); }
      catch { return onUnready("error", timing()); }
    }
    let settle;
    const gate = new Promise(resolve => { settle = resolve; });
    inflight = gate;
    const task = (async () => {
      try {
        const snapshot = await snapshotResponse(await start());
        settle({ error: false });
        return { snapshot, timing: timing() };
      } catch (error) {
        settle({ error: true });
        throw error;
      } finally {
        if (inflight === gate) inflight = null;
      }
    })();
    const raced = await race(task.then(value => value, () => ({ error: true })), timeoutMs);
    if (raced.timeout) {
      track(task);
      return onUnready("timeout", timing());
    }
    if (raced.error) return onUnready("error", timing());
    return onSnapshot(raced.snapshot, raced.timing);
  };
}

function race(promise, timeoutMs) {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve({ timeout: true }), timeoutMs);
    promise.then(
      value => { clearTimeout(timer); resolve(value); },
      () => { clearTimeout(timer); resolve({ error: true }); }
    );
  });
}

async function snapshotResponse(response) {
  return {
    status: response.status,
    statusText: response.statusText,
    headers: [...response.headers.entries()],
    body: await response.arrayBuffer()
  };
}

export function healthLivenessResponse(request, { mode, deployment, readiness, elapsedMs, timeoutMs }) {
  const waited = Number.isFinite(elapsedMs) ? elapsedMs : timeoutMs;
  const body = {
    status: "degraded",
    mode,
    ...(deployment ? { deployment } : {}),
    durableObject: { ready: false, status: readiness },
    do: readiness === "timeout"
      ? { status: "timeout", timeoutMs: timeoutMs ?? HEALTH_PROBE_TIMEOUT_MS, ...(Number.isFinite(waited) ? { ms: waited } : {}) }
      : { status: "error", ...(Number.isFinite(waited) ? { ms: waited } : {}) }
  };
  return new Response(request.method === "HEAD" ? null : JSON.stringify(body), {
    status: 503,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
  });
}

export function healthProbeResponse(snapshot, request, timing = {}) {
  if (request.method === "HEAD" || snapshot.status !== 200) return responseFromSnapshot(snapshot);
  const headers = new Headers(snapshot.headers);
  const type = headers.get("content-type") ?? "";
  if (!type.includes("application/json")) return responseFromSnapshot(snapshot);
  let parsed;
  try { parsed = JSON.parse(new TextDecoder().decode(snapshot.body)); }
  catch { return responseFromSnapshot(snapshot); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || parsed.status !== "ok") return responseFromSnapshot(snapshot);
  parsed.durableObject = { ready: true, status: snapshot.status };
  parsed.do = { status: "ok", statusCode: snapshot.status, ...(Number.isFinite(timing.elapsedMs) ? { ms: timing.elapsedMs } : {}) };
  headers.delete("content-length");
  return new Response(JSON.stringify(parsed), { status: snapshot.status, statusText: snapshot.statusText, headers });
}

function responseFromSnapshot(snapshot) {
  return new Response(snapshot.body, { status: snapshot.status, statusText: snapshot.statusText, headers: snapshot.headers });
}
