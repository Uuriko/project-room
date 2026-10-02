// First-request budget for an isolated staging deploy.
// The workflow runs this immediately after `wrangler deploy --env staging`,
// before smoke traffic, so the request constructs the Durable Object.
// Usage: node scripts/cold-start-probe.mjs --base URL [--path /api/version] [--max-ms 2000]
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
const flag = name => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const base = flag("--base");
const path = flag("--path") || "/api/version";
const maxMs = Number(flag("--max-ms") ?? 2000);

if (!base || !Number.isFinite(maxMs) || maxMs <= 0) {
  process.stderr.write("Usage: node scripts/cold-start-probe.mjs --base URL [--path /api/version] [--max-ms 2000]\n");
  process.exit(1);
}

const url = new URL(path, base).href;
const started = performance.now();
let status = 0;
let body = "";
let error = null;
try {
  const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(15000), headers: { "cache-control": "no-store" } });
  status = response.status;
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
const pass = status === 200 && Boolean(revision) && elapsedMs < maxMs && !error;
const report = {
  checked_at: new Date().toISOString(),
  url,
  status,
  elapsedMs,
  budgetMs: maxMs,
  sourceRevision: revision,
  pass,
  cold_start: "first request after deploy, before other staging traffic",
  ...(error ? { error } : {})
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, [
    "## Cold start",
    "",
    `${pass ? "Pass" : "Fail"}: \`${url}\` answered ${status} in ${elapsedMs} ms (budget ${maxMs} ms).`,
    ""
  ].join("\n"));
}
if (!pass) {
  process.stderr.write(`COLD START: ${url} status ${status} in ${elapsedMs} ms, budget ${maxMs} ms\n`);
  process.exit(1);
}
