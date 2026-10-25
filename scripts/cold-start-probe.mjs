// Cold-start probes for an isolated staging deploy.
//
// The workflow runs this immediately after `wrangler deploy --env staging`,
// before smoke traffic, and the two measurements below are kept separate:
//
//   GATED — Worker cold start. GET /api/version/worker is answered entirely
//     from Worker module scope in cloudflare/room.mjs (it derives the
//     durable-object id with idFromName but never touches the Durable
//     Object), so this measures the Worker isolate cold start only. This is
//     the only measurement the --max-ms budget gates on.
//
//   REPORTED, NOT GATED — Durable Object cold start. GET /api/version is
//     answered inside the Durable Object (Node bridge + handler), so it
//     measures DO cold start on top of a warm Worker. It runs second, so it
//     is still the first DO-touching request after deploy. Its elapsed time
//     is reported distinctly as `doCold` with no budget folded in: a slow
//     DO cold start does not fail this script. Before this split the single
//     probe defaulted to /api/version, so the staging "cold start" gate
//     silently measured Worker + DO together and flaked on DO-cold time.
//
// Incident signals are counted separately per measurement and in total:
// Cloudflare 1101 means the Worker threw a JavaScript exception, while
// 1102 means the Worker exceeded its CPU time limit. They are different
// signals (a bug vs a budget) with different fixes, so they are never
// merged into one error count. A signal is counted only when the response
// body names the code explicitly; an HTTP status alone proves neither.
//
// Usage: node scripts/cold-start-probe.mjs --base URL [--path /api/version/worker] [--do-path /api/version] [--max-ms 2000]
//   --path     gated Worker-only path (default /api/version/worker)
//   --do-path  separate DO path (default /api/version); "none" skips it
//   --max-ms   budget for the gated Worker measurement only (default 2000)
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
const flag = name => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const base = flag("--base");
const path = flag("--path") || "/api/version/worker";
const doPath = flag("--do-path") || "/api/version";
const maxMs = Number(flag("--max-ms") ?? 2000);

if (!base || !Number.isFinite(maxMs) || maxMs <= 0) {
  process.stderr.write("Usage: node scripts/cold-start-probe.mjs --base URL [--path /api/version/worker] [--do-path /api/version] [--max-ms 2000]\n");
  process.exit(1);
}

// One count per response: a single request can surface a given Cloudflare
// error at most once, whichever spelling the error page uses.
function incidentSignals(body) {
  const text = typeof body === "string" ? body : "";
  const seen = code => [
    new RegExp(`error\\s+code\\s*[:#]?\\s*${code}\\b`, "i"),
    new RegExp(`\\berror\\s+${code}\\b`, "i"),
    new RegExp(`"code"\\s*:\\s*"?${code}"?\\b`, "i"),
    new RegExp(`\\bcode\\s*[:=]\\s*${code}\\b`, "i")
  ].some(pattern => pattern.test(text));
  return {
    // 1101: Worker threw a JavaScript exception.
    error1101WorkerJsException: seen("1101") ? 1 : 0,
    // 1102: Worker exceeded its CPU time limit.
    error1102WorkerCpuLimitExceeded: seen("1102") ? 1 : 0
  };
}

async function probe(probePath) {
  const url = new URL(probePath, base).href;
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
  return {
    url,
    status,
    elapsedMs,
    sourceRevision: revision,
    answered: status === 200 && Boolean(revision) && !error,
    incidentSignals: incidentSignals(body),
    ...(error ? { error } : {})
  };
}

// Worker first: it must not be preceded by any DO-touching request, and the
// DO probe that follows is then the first request that constructs the DO.
const workerCold = await probe(path);
const pass = workerCold.answered && workerCold.elapsedMs < maxMs;
const doCold = doPath === "none" ? null : await probe(doPath);

const incidentSignalsTotal = {
  error1101WorkerJsException: workerCold.incidentSignals.error1101WorkerJsException + (doCold?.incidentSignals.error1101WorkerJsException ?? 0),
  error1102WorkerCpuLimitExceeded: workerCold.incidentSignals.error1102WorkerCpuLimitExceeded + (doCold?.incidentSignals.error1102WorkerCpuLimitExceeded ?? 0)
};

const report = {
  checked_at: new Date().toISOString(),
  // Top-level fields keep their pre-split meaning for existing consumers of
  // cold-start.json, except that they now describe the gated Worker
  // measurement instead of the old combined Worker + DO one.
  url: workerCold.url,
  status: workerCold.status,
  elapsedMs: workerCold.elapsedMs,
  budgetMs: maxMs,
  sourceRevision: workerCold.sourceRevision,
  pass,
  cold_start: "worker: first request after deploy, before other staging traffic; durable-object: second request, first DO-touching request",
  workerCold: {
    ...workerCold,
    budgetMs: maxMs,
    gated: true,
    measures: "Worker isolate cold start only: /api/version/worker is answered from Worker module scope and never touches the Durable Object",
    pass
  },
  doCold: doCold
    ? {
        ...doCold,
        budgetMs: null,
        gated: false,
        measures: "Durable Object cold start (constructor + Node bridge + handler) via /api/version, on top of a warm Worker; reported separately and not folded into the Worker budget"
      }
    : null,
  incidentSignals: incidentSignalsTotal,
  ...(workerCold.error ? { error: workerCold.error } : {})
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (process.env.GITHUB_STEP_SUMMARY) {
  const lines = [
    "## Cold start — Worker (gated)",
    "",
    `${pass ? "Pass" : "Fail"}: \`${workerCold.url}\` answered ${workerCold.status} in ${workerCold.elapsedMs} ms (budget ${maxMs} ms). This gate measures the Worker isolate only; the route never touches the Durable Object.`,
    ""
  ];
  if (doCold) {
    lines.push(
      "## Cold start — Durable Object (separate, not gated)",
      "",
      `\`${doCold.url}\` answered ${doCold.status} in ${doCold.elapsedMs} ms. No budget is applied to this measurement; a slow DO cold start is reported here and does not fail the Worker gate above.`,
      ""
    );
  }
  lines.push(
    "## Incident signals (counted separately)",
    "",
    `- 1101 — Worker threw a JavaScript exception: ${incidentSignalsTotal.error1101WorkerJsException}`,
    `- 1102 — Worker exceeded CPU time limit: ${incidentSignalsTotal.error1102WorkerCpuLimitExceeded}`,
    ""
  );
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join("\n"));
}
if (!pass) {
  process.stderr.write(`COLD START (Worker, gated): ${workerCold.url} status ${workerCold.status} in ${workerCold.elapsedMs} ms, budget ${maxMs} ms; 1101 count ${incidentSignalsTotal.error1101WorkerJsException}, 1102 count ${incidentSignalsTotal.error1102WorkerCpuLimitExceeded}\n`);
  process.exit(1);
}
