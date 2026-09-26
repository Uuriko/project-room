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
    try { body = (await response.text()).slice(0, 400); } catch {}
    return { status: response.status, latencyMs, ok: response.status < 500, body };
  } catch (error) {
    return { status: 0, latencyMs: Math.round(performance.now() - started), ok: false, body: String(error?.cause?.code ?? error.message) };
  }
}

function classify(results) {
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
  if (results.some(r => !r.ok)) return { domain: "partial", note: "mixed failures - inspect per-endpoint results" };
  return { domain: "healthy", note: "all endpoints answered" };
}

export async function probeProd(base) {
  const results = [];
  for (const [label, path, expect] of MATRIX) {
    const r = await probe(base, path);
    let sourceRevision = null;
    if (label === "version" && r.ok) { try { sourceRevision = JSON.parse(r.body).sourceRevision ?? null; } catch {} }
    results.push({ label, path, expect, ...r, sourceRevision });
  }
  const verdict = classify(results);
  const version = results.find(r => r.label === "version");
  return {
    probed_at: new Date().toISOString(),
    base,
    verdict: verdict.domain,
    note: verdict.note,
    sourceRevision: version?.sourceRevision ?? null,
    endpoints: results.map(({ label, status, latencyMs, ok }) => ({ label, status, latencyMs, ok }))
  };
}
