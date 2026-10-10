// Read-only probe of every public GET route in docs/openapi.yaml (backlog TST-13).
// "Public" means the operation's security list allows no credential. The probe
// sends GET only, no credentials, no cookies, no body, one request at a time.
// It skips routes with path parameters (no safe ids to guess) and routes that
// start or finish a sign-in or stream (auth callbacks, desktop auth, MCP).
// A route "answers" when it returns any status below 500. A 5xx or a network
// error fails the run. Output is schedule-friendly: one summary line, or a
// stable JSON report (schema room.public-probe/1) with --json. Exit 0 = all
// answered, 1 = at least one failed, 2 = bad usage.
//
// Usage: node scripts/probe-public-routes.mjs [--base https://room.trydemigod.com] [--json] [--delay-ms 150]
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse } from "yaml";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const SCHEMA = "room.public-probe/1";
// Routes that are public but must not be hit by an unattended probe.
export const SKIP_PREFIXES = Object.freeze(["/api/auth/", "/mcp", "/room/mcp"]);

export function publicGetRoutes(spec = parse(readFileSync(join(ROOT, "docs/openapi.yaml"), "utf8"))) {
  const globalSecurity = spec.security ?? [];
  const probe = [], skipped = [];
  for (const [path, operations] of Object.entries(spec.paths ?? {})) {
    const op = operations?.get;
    if (!op) continue;
    const security = op.security ?? globalSecurity;
    const isPublic = Array.isArray(security) && (security.length === 0 || security.some(entry => Object.keys(entry).length === 0));
    if (!isPublic) continue;
    if (path.includes("{")) skipped.push({ path, reason: "path-parameter" });
    else if (SKIP_PREFIXES.some(prefix => path === prefix || path.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`) || path === prefix)) skipped.push({ path, reason: "auth-or-stream" });
    else probe.push(path);
  }
  return { probe: probe.sort(), skipped: skipped.sort((a, b) => a.path.localeCompare(b.path)) };
}

async function probeOne(base, path, timeoutMs) {
  const started = performance.now();
  try {
    const response = await fetch(base + path, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(timeoutMs), headers: { Accept: "application/json, text/html;q=0.9" } });
    await response.body?.cancel();
    const status = response.status;
    return { path, status, latencyMs: Math.round(performance.now() - started), ok: status > 0 && status < 500 };
  } catch (error) {
    return { path, status: 0, latencyMs: Math.round(performance.now() - started), ok: false, error: String(error?.cause?.code ?? error?.name ?? "error") };
  }
}

export async function probePublicRoutes(base, { routes = publicGetRoutes(), delayMs = 150, timeoutMs = 15000, now = () => new Date() } = {}) {
  const results = [];
  for (const path of routes.probe) {
    results.push(await probeOne(base, path, timeoutMs));
    if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
  }
  const failed = results.filter(r => !r.ok);
  const byClass = {};
  for (const r of results) { const k = r.status === 0 ? "net" : `${String(r.status)[0]}xx`; byClass[k] = (byClass[k] ?? 0) + 1; }
  const latencies = results.map(r => r.latencyMs).sort((a, b) => a - b);
  return {
    schema: SCHEMA,
    probed_at: now().toISOString(),
    base,
    verdict: failed.length ? "failing" : "answering",
    probed: results.length,
    failed: failed.length,
    skipped: routes.skipped.length,
    statusClasses: byClass,
    p95LatencyMs: latencies.length ? latencies[Math.min(latencies.length - 1, Math.ceil(latencies.length * 0.95) - 1)] : null,
    results,
    skippedRoutes: routes.skipped,
  };
}

export function summaryLine(report) {
  const classes = Object.entries(report.statusClasses).sort().map(([k, v]) => `${k}=${v}`).join(" ");
  const bad = report.results.filter(r => !r.ok).map(r => `${r.path}:${r.status}`).join(",");
  return `public-probe ${report.verdict} ${report.base} probed=${report.probed} failed=${report.failed} skipped=${report.skipped} ${classes} p95=${report.p95LatencyMs}ms${bad ? ` FAIL ${bad}` : ""}`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const value = flag => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
  const base = value("--base") ?? "https://room.trydemigod.com";
  const delayMs = Number(value("--delay-ms") ?? 150);
  if (!/^https?:\/\/[^/]+$/.test(base) || !Number.isFinite(delayMs) || delayMs < 0) {
    console.error("usage: node scripts/probe-public-routes.mjs [--base https://host] [--json] [--delay-ms 150]");
    process.exit(2);
  }
  const report = await probePublicRoutes(base, { delayMs });
  console.log(args.includes("--json") ? JSON.stringify(report, null, 2) : summaryLine(report));
  process.exit(report.failed ? 1 : 0);
}
