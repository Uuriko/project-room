// Shared probe for /api/ready. /api/health is Worker liveness and does not
// enter the Durable Object. Readiness asks invite-only-pilot to run SELECT 1.
// One in-flight probe is shared so a 1 Hz checker does not queue a call per
// tick while the constructor holds the input gate, and a settled ready
// verdict is cached for READY_PROBE_CACHE_TTL_MS so monitor polls inside the
// window serve the cached snapshot instead of queueing on the contended
// object at all. Each caller still builds its own answer from the shared
// snapshot, because Origin checks and HEAD/GET are per request.
//
// Masking bound: only successes are cached, and only until the TTL expires.
// A store that breaks just after a successful probe is masked for at most
// the remainder of the TTL (<= READY_PROBE_CACHE_TTL_MS from that probe's
// completion); the first probe after expiry re-enters the store and a real
// failure surfaces as 503. Timeouts and errors are never cached as verdicts.

// Warm production storage answers in tens of milliseconds. A cold
// invite-only-pilot used to block the same check for 6–20 s. After one second
// the probe answers 503; while no verdict has ever settled and the first
// start is still pending, that 503 reports status "starting" (a constructor
// in progress is starting, not unready), and the pending start keeps running
// via waitUntil: when it answers at all, its result populates the cache and
// the next probe reads ready without a fresh store call. A timeout after a
// verdict has settled is busy contention and keeps the "degraded" /
// do.status "timeout" shape. The same bounds cover a local workerd isolate's
// first boot.
export const HEALTH_PROBE_TIMEOUT_MS = 1000;
export const READY_PROBE_CACHE_TTL_MS = 3000;

export function createHealthProbe({ cacheTtlMs = READY_PROBE_CACHE_TTL_MS } = {}) {
  let inflight = null; // { task, cold } — the one shared store call in flight
  let cached = null; // { snapshot, expiresAt } — last successful verdict only
  let settled = false; // any start has settled (success or error)
  const launch = start => {
    const record = { cold: !settled, task: null };
    record.task = (async () => snapshotResponse(await start()))();
    inflight = record;
    record.task.then(snapshot => {
      settled = true;
      cached = { snapshot, expiresAt: performance.now() + cacheTtlMs };
      if (inflight === record) inflight = null;
    }, () => {
      settled = true;
      if (inflight === record) inflight = null;
    });
    return record;
  };
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
    if (cached && performance.now() < cached.expiresAt) {
      return onSnapshot(cached.snapshot, { elapsedMs: 0, timeoutMs, cached: true });
    }
    const record = inflight ?? launch(start);
    const raced = await race(record.task.then(snapshot => ({ snapshot }), () => ({ error: true })), timeoutMs);
    if (raced.timeout) {
      track(record.task);
      // Still pending with no verdict ever settled from this start: the
      // object is starting, not unready. A start whose predecessor already
      // settled is contended, not cold.
      return onUnready(record.cold && inflight === record ? "starting" : "timeout", timing());
    }
    if (raced.error) return onUnready("error", timing());
    return onSnapshot(raced.snapshot, timing());
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

export function workerLivenessResponse(request, { mode, deployment, emailVerification }) {
  // emailVerification is part of the documented /api/health contract
  // (docs/openapi.yaml): the Node handler reports it so a deploy that lost
  // its mail secret cannot silently relax every email gate. #3272: the Worker
  // liveness answer describes this Worker only. An entry Worker may bind a
  // different Worker's Durable Object; /api/ready reports that authority's policy.
  const body = { status: "ok", mode, ...(deployment ? { deployment } : {}), ...(emailVerification ? { emailVerification, emailVerificationScope: "worker" } : {}) };
  return new Response(request.method === "HEAD" ? null : JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
  });
}

export function readyProbeResponse(snapshot, request, { mode, deployment, elapsedMs, cached } = {}) {
  let policy;
  try { policy = JSON.parse(new TextDecoder().decode(snapshot.body)).emailVerification; } catch { /* older authority: policy remains unknown */ }
  const knownPolicy = policy === "enforced" || policy === "relaxed-no-mailer";
  const body = {
    status: "ready",
    mode,
    ...(knownPolicy ? { emailVerification: policy, emailVerificationScope: "durable-object" } : {}),
    ...(deployment ? { deployment } : {}),
    do: { status: "ok", statusCode: snapshot.status, ...(Number.isFinite(elapsedMs) ? { ms: elapsedMs } : {}), ...(cached ? { cached: true } : {}) }
  };
  return new Response(request.method === "HEAD" ? null : JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
  });
}

export function healthLivenessResponse(request, { mode, deployment, readiness, elapsedMs, timeoutMs }) {
  const waited = Number.isFinite(elapsedMs) ? elapsedMs : timeoutMs;
  const body = {
    status: readiness === "starting" ? "starting" : "degraded",
    mode,
    ...(deployment ? { deployment } : {}),
    durableObject: { ready: false, status: readiness },
    do: readiness === "timeout"
      ? { status: "timeout", timeoutMs: timeoutMs ?? HEALTH_PROBE_TIMEOUT_MS, ...(Number.isFinite(waited) ? { ms: waited } : {}) }
      : readiness === "starting"
        ? { status: "starting", timeoutMs: timeoutMs ?? HEALTH_PROBE_TIMEOUT_MS, ...(Number.isFinite(waited) ? { ms: waited } : {}) }
        : { status: "error", ...(Number.isFinite(waited) ? { ms: waited } : {}) }
  };
  return new Response(request.method === "HEAD" ? null : JSON.stringify(body), {
    status: 503,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
  });
}
