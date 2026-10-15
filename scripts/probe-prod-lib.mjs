// Shared probe logic for probe-prod.mjs (CLI) and watch-deploy-drift.mjs.
// Matrix and classification are built from the 2026-09-25 1101 incident
// evidence, not from path-shape guesses:
//   - "/" is DO-BACKED: it served an 1101 during the outage. It is not an
//     edge-static canary.
//   - /.well-known/agent.json also flows through the DO on the canonical
//     host, so it cannot be an independent edge canary.
//   - /api/health/jobs is the JOBS CANARY: its handler catches DO RPC errors
//     and answers a clean 503. During the incident it kept answering while
//     every other DO-backed route hard-failed. A 200 or a clean JSON 503
//     with schema room.job-health/1 proves the Worker itself is alive; it hard-failing means the
//     Worker or the DO is failing; use external edge and logs to distinguish.
export const MATRIX = [
  ["home", "/", "do"],
  ["version", "/api/version", "do"],
  ["health", "/api/health", "do"],
  ["join-page", "/join", "do"],
  ["jobs-canary", "/api/health/jobs", "canary"]
];

async function probe(base, path) {
  const started = performance.now();
  try {
    const response = await fetch(base + path, { redirect: "manual", signal: AbortSignal.timeout(15000) });
    const latencyMs = Math.round(performance.now() - started);
    let body = "";
    try {
      const chunks = []; let bytes = 0;
      for await (const chunk of response.body) {
        bytes += chunk.length;
        if (bytes > 64 * 1024) break;
        chunks.push(chunk);
      }
      if (bytes <= 64 * 1024) body = Buffer.concat(chunks).toString("utf8");
    } catch {}
    return { status: response.status, latencyMs, ok: response.status === 200, body };
  } catch (error) {
    return { status: 0, latencyMs: Math.round(performance.now() - started), ok: false, body: String(error?.cause?.code ?? error.message) };
  }
}

function classify(results) {
  // These routes are public. A login challenge, redirect or malformed public
  // response cannot prove health or identify a failing infrastructure layer.
  if (results.some(r => (r.status > 0 && r.status < 500 && r.status !== 200)
      || (r.status === 200 && !r.ok))) {
    return { domain: "unverified", note: "Public observations were denied, redirected or invalid; application health is unverified, not evidence of a DO outage" };
  }
  const byLabel = Object.fromEntries(results.map(r => [r.label, r]));
  const doBackedBad = results.filter(r => r.expect === "do").some(r => !r.ok);
  const canary = byLabel["jobs-canary"];
  // The canary's own catch returns a clean 503 when the DO is failing.
  // An arbitrary 503 from an edge proxy is not proof of this catch path;
  // require the documented schema and unavailable status in its JSON.
  let canaryCaughtDo = false;
  if (canary?.status === 503) {
    try { const data = JSON.parse(canary.body); canaryCaughtDo = data.schema === "room.job-health/1" && data.status === "unavailable"; } catch {}
  }
  const workerAnswered = canary && (canary.ok || canaryCaughtDo);
  if (doBackedBad && workerAnswered) return { domain: "do-rpc-fail", note: "DO-backed routes (/, /api/version, /api/health, /join) fail while the jobs canary still answers: invite-only-pilot DO RPC failing (1101 class); see docs/INCIDENT-1101-RUNBOOK.md" };
  if (doBackedBad && !workerAnswered) return { domain: "unclassified-outage", note: "DO-backed routes and the jobs canary both fail: probe the external edge and inspect Worker/DO logs; this alone does not identify the failing layer" };
  // A canary that answered with its job-health document while every other
  // endpoint is fine is healthy infrastructure with unhealthy jobs: the
  // job health rides along as jobsHealth, not in this verdict.
  if (results.every(r => r.ok || (r.label === "jobs-canary" && r.canaryAnswered))) {
    return { domain: "healthy", note: "all endpoints answered (job health is reported separately)" };
  }
  if (results.some(r => !r.ok)) return { domain: "partial", note: "mixed failures - inspect per-endpoint results" };
  return { domain: "healthy", note: "all endpoints answered" };
}

export async function probeProd(base) {
  const results = [];
  let jobsHealth = null;
  for (const [label, path, expect] of MATRIX) {
    const r = await probe(base, path);
    let sourceRevision = null;
    if (label === "jobs-canary") {
      // The canary proves the Worker is alive by answering with the
      // documented schema — at 200 when jobs are healthy, and at 503 with
      // the same document when they are not. Whether the jobs themselves
      // are healthy is the body's own status, captured separately as
      // jobsHealth. A red job (e.g. integrity) must not poison this
      // probe's verdict: job health has its own surface (/api/health/jobs)
      // and its own alarms.
      let value;
      try { value = JSON.parse(r.body); } catch {}
      r.canaryAnswered = value?.schema === "room.job-health/1" && Array.isArray(value?.jobs);
      if (r.canaryAnswered) {
        jobsHealth = {
          status: value.status ?? null,
          failing: value.jobs
            .filter(j => j && typeof j.name === "string" && j.status !== "ok" && j.status !== "disabled")
            .map(j => j.name)
        };
        if (r.status === 200) r.ok = true;
      } else if (r.status === 200) {
        r.ok = false;
      }
    } else if (["version", "health"].includes(label) && r.ok) {
      let value;
      try { value = JSON.parse(r.body); } catch {}
      r.ok = value?.status === "ok";
      if (label === "version") {
        sourceRevision = r.ok && typeof value.sourceRevision === "string" && /^[a-f0-9]{40}$/i.test(value.sourceRevision)
          ? value.sourceRevision.toLowerCase() : null;
        r.ok = Boolean(sourceRevision);
      }
    }
    results.push({ label, path, expect, ...r, sourceRevision });
  }
  const verdict = classify(results);
  const version = results.find(r => r.label === "version");
  return {
    probed_at: new Date().toISOString(),
    base,
    verdict: verdict.domain,
    note: verdict.note,
    jobsHealth,
    sourceRevision: version?.sourceRevision ?? null,
    endpoints: results.map(({ label, status, latencyMs, ok }) => ({ label, status, latencyMs, ok }))
  };
}
