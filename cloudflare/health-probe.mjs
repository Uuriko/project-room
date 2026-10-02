// Worker-side liveness for /api/health. A cold Durable Object can spend
// seconds rebuilding; the health check must answer before that finishes and
// say whether the object is ready. One in-flight probe is shared so a 1 Hz
// checker does not queue a fetch per tick while the constructor holds the
// input gate. Each caller still gets its own answer once the object is awake,
// because Origin checks and HEAD/GET are per request.

// Warm production health is ~50 ms (p95 ~66 ms). A cold invite-only-pilot
// used to block the same check for 6–20 s. One second still returns liveness
// during that freeze, and it covers a local workerd isolate's first boot.
export const HEALTH_PROBE_TIMEOUT_MS = 1000;

export function createHealthProbe() {
  let inflight = null;
  return async function probe({ start, timeoutMs = HEALTH_PROBE_TIMEOUT_MS, onSnapshot, onUnready, waitUntil }) {
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
      if (joined.timeout || joined.error) return onUnready(joined.timeout ? "timeout" : "error");
      try { return onSnapshot(await snapshotResponse(await start())); }
      catch { return onUnready("error"); }
    }
    let settle;
    const gate = new Promise(resolve => { settle = resolve; });
    inflight = gate;
    const task = (async () => {
      try {
        const snapshot = await snapshotResponse(await start());
        settle({ error: false });
        return snapshot;
      } catch (error) {
        settle({ error: true });
        throw error;
      } finally {
        if (inflight === gate) inflight = null;
      }
    })();
    const raced = await race(task.then(snapshot => ({ snapshot }), () => ({ error: true })), timeoutMs);
    if (raced.timeout) {
      track(task);
      return onUnready("timeout");
    }
    if (raced.error) return onUnready("error");
    return onSnapshot(raced.snapshot);
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

export function healthLivenessResponse(request, { mode, deployment, readiness }) {
  const body = {
    status: "ok",
    mode,
    ...(deployment ? { deployment } : {}),
    durableObject: { ready: false, status: readiness }
  };
  return new Response(request.method === "HEAD" ? null : JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
  });
}

export function healthProbeResponse(snapshot, request) {
  if (request.method === "HEAD" || snapshot.status !== 200) return responseFromSnapshot(snapshot);
  const headers = new Headers(snapshot.headers);
  const type = headers.get("content-type") ?? "";
  if (!type.includes("application/json")) return responseFromSnapshot(snapshot);
  let parsed;
  try { parsed = JSON.parse(new TextDecoder().decode(snapshot.body)); }
  catch { return responseFromSnapshot(snapshot); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || parsed.status !== "ok") return responseFromSnapshot(snapshot);
  parsed.durableObject = { ready: true, status: snapshot.status };
  headers.delete("content-length");
  return new Response(JSON.stringify(parsed), { status: snapshot.status, statusText: snapshot.statusText, headers });
}

function responseFromSnapshot(snapshot) {
  return new Response(snapshot.body, { status: snapshot.status, statusText: snapshot.statusText, headers: snapshot.headers });
}
