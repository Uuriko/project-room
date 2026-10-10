// First-request budget for an isolated staging deploy.
// The workflow runs this immediately after `wrangler deploy --env staging`,
// before smoke traffic, so the request constructs the Durable Object.
//
// Two numbers, two budgets:
// - serverMs: the Worker's own `Server-Timing: total` for this request. It
//   covers the Worker handler, the Durable Object cold start (placement,
//   constructor, store open) and the handler inside the object. This is the
//   part our code controls, and --max-ms applies to it.
// - elapsedMs: wall clock seen from the runner. It adds DNS, TLS, the path
//   to the edge and Cloudflare loading the just-deployed script. --max-wall-ms
//   is a looser ceiling on that, so a hang or a very slow edge still fails.
// A response without a Worker total (a proxy stripped it, wrong host) is
// judged on elapsedMs against --max-ms, the old rule.
//
// Usage: node scripts/cold-start-probe.mjs --base URL [--path /api/version] [--max-ms 2000] [--max-wall-ms 5000]
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
const flag = name => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const base = flag("--base");
const path = flag("--path") || "/api/version";
const maxMs = Number(flag("--max-ms") ?? 2000);
const maxWallMs = Number(flag("--max-wall-ms") ?? 5000);

if (!base || !Number.isFinite(maxMs) || maxMs <= 0 || !Number.isFinite(maxWallMs) || maxWallMs < maxMs) {
  process.stderr.write("Usage: node scripts/cold-start-probe.mjs --base URL [--path /api/version] [--max-ms 2000] [--max-wall-ms 5000]\n(--max-wall-ms must be at least --max-ms)\n");
  process.exit(1);
}

// Server-Timing metrics by name; the first `dur` for each name wins.
function serverTimings(header) {
  const out = {};
  for (const part of String(header ?? "").split(",")) {
    const [name, ...params] = part.split(";").map(piece => piece.trim());
    const dur = params.map(param => /^dur=(\d+(?:\.\d+)?)$/.exec(param)).find(Boolean);
    if (/^[A-Za-z0-9_-]+$/.test(name ?? "") && dur && !(name in out)) out[name] = Math.round(Number(dur[1]));
  }
  return out;
}

const url = new URL(path, base).href;
const started = performance.now();
let status = 0;
let body = "";
let timing = "";
let error = null;
try {
  const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(15000), headers: { "cache-control": "no-store" } });
  status = response.status;
  timing = response.headers.get("server-timing") ?? "";
  body = await response.text();
} catch (caught) {
  error = caught instanceof Error ? caught.message : String(caught);
}
const elapsedMs = Math.round(performance.now() - started);
let revision = null;
if (status === 200) {
  try {
    const parsed = JSON.parse(body);
    if (typeof parsed.sourceRevision === "string" && /^[a-f0-9]{40}$/i.test(parsed.sourceRevision)) revision = parsed.sourceRevision.toLowerCase();
  } catch { /* reported as a failed probe */ }
}
const metrics = serverTimings(timing);
const serverMs = Number.isFinite(metrics.total) ? metrics.total : null;
const appMs = Number.isFinite(metrics.app) ? metrics.app : null;
const reasons = [];
if (error) reasons.push(`request failed: ${error}`);
else if (status !== 200) reasons.push(`status ${status}`);
else if (!revision) reasons.push("no deployed sourceRevision in the body");
if (serverMs == null && elapsedMs >= maxMs) reasons.push(`${elapsedMs} ms wall clock with no Worker timing, budget ${maxMs} ms`);
if (serverMs != null && serverMs >= maxMs) reasons.push(`Worker total ${serverMs} ms, budget ${maxMs} ms`);
if (serverMs != null && elapsedMs >= maxWallMs) reasons.push(`${elapsedMs} ms wall clock, ceiling ${maxWallMs} ms`);
const pass = reasons.length === 0;
const networkAndEdgeMs = serverMs == null ? null : Math.max(0, elapsedMs - serverMs);
const report = {
  checked_at: new Date().toISOString(),
  url,
  status,
  elapsedMs,
  serverMs,
  appMs,
  networkAndEdgeMs,
  budgetMs: maxMs,
  wallCeilingMs: maxWallMs,
  judgedOn: serverMs == null ? "wall clock (no Worker timing)" : "Worker total",
  sourceRevision: revision,
  pass,
  ...(reasons.length ? { reasons } : {}),
  cold_start: "first request after deploy, before other staging traffic",
  ...(error ? { error } : {})
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (process.env.GITHUB_STEP_SUMMARY) {
  const split = serverMs == null ? "no Worker timing" : `Worker ${serverMs} ms (object handler ${appMs ?? "?"} ms), network and edge ${networkAndEdgeMs} ms`;
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, [
    "## Cold start",
    "",
    `${pass ? "Pass" : "Fail"}: \`${url}\` answered ${status} in ${elapsedMs} ms; ${split}. Budget ${maxMs} ms on the Worker, ${maxWallMs} ms wall.`,
    ...reasons.map(reason => `- ${reason}`),
    ""
  ].join("\n"));
}
if (!pass) {
  process.stderr.write(`COLD START: ${url} ${reasons.join("; ")}\n`);
  process.exit(1);
}
