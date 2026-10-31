// Shared bounded probe for readiness and job health (separate instances).
// Readiness asks invite-only-pilot to run SELECT 1.
// One in-flight probe is shared so a 1 Hz checker does not queue a call per
// tick while the constructor holds the input gate. Concurrent callers share
// only the storage snapshot: Origin is checked before this helper, and each
// caller shapes its own response (including HEAD) through onSnapshot.
// One helper instance must address one authority with request-independent start().

// Warm production storage answers in tens of milliseconds. A cold
// invite-only-pilot used to block the same check for 6–20 s. After one second
// the probe answers 503 with status "degraded" and do.status "timeout". The
// same bound covers a local workerd isolate's first boot.
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
      return onSnapshot(joined.snapshot, timing());
    }
    let settle;
    const gate = new Promise(resolve => { settle = resolve; });
    inflight = gate;
    const task = (async () => {
      try {
        const snapshot = await snapshotResponse(await start());
        settle({ error: false, snapshot });
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

export function workerLivenessResponse(request, { mode, deployment, emailVerification, jobsStatus = "unknown" }) {
  // emailVerification is part of the documented /api/health contract
  // (docs/openapi.yaml): the Node handler reports it so a deploy that lost
  // its mail secret cannot silently relax every email gate. #3272: the Worker
  // liveness answer describes this Worker only. An entry Worker may bind a
  // different Worker's Durable Object; /api/ready reports that authority's policy.
  const jobStatus = ["ok", "stale", "failing", "degraded", "timeout", "error"].includes(jobsStatus) ? jobsStatus : "unknown";
  const body = { status: jobStatus === "ok" ? "ok" : "degraded", liveness: "ok", jobs: { status: jobStatus }, mode, ...(deployment ? { deployment } : {}), ...(emailVerification ? { emailVerification, emailVerificationScope: "worker" } : {}) };
  return new Response(request.method === "HEAD" ? null : JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
  });
}

export function readyProbeResponse(snapshot, request, { mode, deployment, elapsedMs } = {}) {
  let policy;
  try { policy = JSON.parse(new TextDecoder().decode(snapshot.body)).emailVerification; } catch { /* older authority: policy remains unknown */ }
  const knownPolicy = policy === "enforced" || policy === "relaxed-no-mailer";
  const body = {
    status: "ready",
    mode,
    ...(knownPolicy ? { emailVerification: policy, emailVerificationScope: "durable-object" } : {}),
    ...(deployment ? { deployment } : {}),
    do: { status: "ok", statusCode: snapshot.status, ...(Number.isFinite(elapsedMs) ? { ms: elapsedMs } : {}) }
  };
  return new Response(request.method === "HEAD" ? null : JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
  });
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


// Only the existing job-health classifier determines readiness. Missing or
// malformed snapshots must never turn a live Worker into a false health pass.
export function jobHealthSnapshotStatus(snapshot) {
  try {
    const body = JSON.parse(new TextDecoder().decode(snapshot.body));
    if (body.schema !== 'room.job-health/1') return 'unknown';
    return ['ok', 'stale', 'failing', 'degraded'].includes(body.status) ? body.status : 'unknown';
  } catch { return 'unknown'; }
}
