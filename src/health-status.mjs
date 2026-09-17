// F008 — health endpoint payload builder + public status page renderer.
//
// New-file-only: this module exports pure builder/renderer functions. It does
// not register any route and touches no store, network, or timers. The
// dependency checks are injected probes (cheap, non-invasive) so tests and
// wiring can supply fakes; nothing here is allowed to throw. Suggested wiring
// (server/http.mjs, follow-up slice): GET /api/health -> healthReply(...),
// GET /status -> renderStatusPage(...) as text/html.

export const HEALTH_OK = "healthy";
export const HEALTH_DEGRADED = "degraded";
export const HEALTH_UNHEALTHY = "unhealthy";
export const CHECK_OK = "ok";
export const CHECK_FAIL = "fail";

// Repo HTML-escape convention (see src/share-links.js).
const escHtml = value =>
  String(value).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" })[c]);

const isPlainObject = value => value !== null && typeof value === "object" && !Array.isArray(value);

// A dependency check descriptor: { name, required, probe }.
// - name: string, machine-readable check name (e.g. "storage", "database").
// - required: boolean; a failing required check makes the service unhealthy,
//   a failing optional check only degrades it.
// - probe: () => undefined | true | { ok: boolean, detail?: string }.
//   Cheap and non-invasive by contract: throwing counts as a failure.
function runCheck(check, now) {
  const name = typeof check?.name === "string" && check.name.length > 0 ? check.name : "unnamed";
  const required = check?.required === true;
  const started = now();
  let status = CHECK_OK;
  let detail = null;
  if (typeof check?.probe !== "function") {
    status = CHECK_FAIL;
    detail = "no probe supplied";
  } else {
    try {
      const outcome = check.probe();
      if (isPlainObject(outcome) && outcome.ok === false) {
        status = CHECK_FAIL;
        detail = typeof outcome.detail === "string" ? outcome.detail : "probe reported failure";
      }
    } catch (error) {
      status = CHECK_FAIL;
      detail = error instanceof Error ? error.message : String(error);
    }
  }
  return { name, required, status, detail, latencyMs: Math.max(0, now() - started) };
}

// Build the health payload. Never throws: a bad option degrades to a
// documented default instead of failing the endpoint.
export function collectHealth({ service = "project-room", version = "0.1.0", uptimeMs = 0, now, checks = [] } = {}) {
  const clock = typeof now === "function" ? now : () => Date.now();
  const list = Array.isArray(checks) ? checks : [];
  const results = list.map(check => runCheck(check, clock));
  const requiredFailed = results.some(result => result.required && result.status === CHECK_FAIL);
  const anyFailed = results.some(result => result.status === CHECK_FAIL);
  const status = requiredFailed ? HEALTH_UNHEALTHY : anyFailed ? HEALTH_DEGRADED : HEALTH_OK;
  return Object.freeze({
    service: String(service),
    version: String(version),
    status,
    uptimeMs: Number.isFinite(uptimeMs) && uptimeMs >= 0 ? Math.floor(uptimeMs) : 0,
    checkedAt: new Date(clock()).toISOString(),
    checks: Object.freeze(results.map(result => Object.freeze({ ...result }))),
  });
}

// Map a payload status to the HTTP status for the health endpoint:
// healthy and degraded answer 200 (the service is up); unhealthy is 503 so
// load balancers and readiness gates can fail over.
export function httpStatusFor(healthStatus) {
  return healthStatus === HEALTH_UNHEALTHY ? 503 : 200;
}

// Shape the endpoint reply ({ status, body }), mirroring the growth surface's
// reply convention so a future server/http.mjs branch can return it directly.
export function healthReply(payload) {
  const body = payload && typeof payload.status === "string" ? payload : collectHealth();
  return { status: httpStatusFor(body.status), body };
}

// Render the public status page as a standalone HTML document. Every dynamic
// value is escaped, so check names/details are safe to render.
export function renderStatusPage(payload) {
  const health = payload && typeof payload === "object" ? payload : {};
  const service = escHtml(health.service ?? "project-room");
  const version = escHtml(health.version ?? "unknown");
  const status = health.status === HEALTH_DEGRADED ? HEALTH_DEGRADED
    : health.status === HEALTH_UNHEALTHY ? HEALTH_UNHEALTHY
    : HEALTH_OK;
  const uptime = Number.isFinite(health.uptimeMs) && health.uptimeMs >= 0 ? Math.floor(health.uptimeMs) : 0;
  const checkedAt = escHtml(health.checkedAt ?? "unknown");
  const checks = Array.isArray(health.checks) ? health.checks : [];
  const pillClass = status === HEALTH_OK ? "pill-ok" : status === HEALTH_DEGRADED ? "pill-warn" : "pill-bad";
  const rows = checks.map(check => {
    const name = escHtml(check?.name ?? "unnamed");
    const state = check?.status === CHECK_FAIL ? CHECK_FAIL : CHECK_OK;
    const detail = check?.detail == null ? "—" : escHtml(check.detail);
    const latency = Number.isFinite(check?.latencyMs) ? `${Math.floor(check.latencyMs)} ms` : "—";
    const required = check?.required === true ? "required" : "optional";
    return `<tr><td>${name}</td><td class="${state === CHECK_OK ? "ok" : "bad"}">${state}</td>` +
      `<td>${required}</td><td>${latency}</td><td>${detail}</td></tr>`;
  }).join("");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${service} status</title>
<style>
body{font-family:system-ui,-apple-system,sans-serif;margin:2rem auto;max-width:44rem;padding:0 1rem;color:#111}
.pill{display:inline-block;padding:.25rem .75rem;border-radius:999px;font-weight:600}
.pill-ok{background:#dff5e1;color:#14532d}
.pill-warn{background:#fef3c7;color:#92400e}
.pill-bad{background:#fee2e2;color:#991b1b}
table{border-collapse:collapse;width:100%;margin-top:1rem}
th,td{border:1px solid #ddd;padding:.5rem;text-align:left}
.ok{color:#15803d;font-weight:600}
.bad{color:#b91c1c;font-weight:600}
dl{display:grid;grid-template-columns:9rem 1fr;gap:.25rem 1rem}
dt{font-weight:600}dd{margin:0}
</style>
</head>
<body>
<h1>${service} status <span class="pill ${pillClass}">${status}</span></h1>
<dl>
<dt>Service</dt><dd>${service}</dd>
<dt>Version</dt><dd>${version}</dd>
<dt>Uptime</dt><dd>${uptime} ms</dd>
<dt>Checked at</dt><dd>${checkedAt}</dd>
</dl>
<h2>Dependency checks</h2>
<table>
<thead><tr><th>Name</th><th>State</th><th>Scope</th><th>Latency</th><th>Detail</th></tr></thead>
<tbody>${rows}</tbody>
</table>
</body>
</html>`;
}
