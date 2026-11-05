#!/usr/bin/env node
// Repeatable, read-only baseline: prod latency/payload + GitHub workflow metrics.
// Usage: node scripts/measure-baseline.mjs [--base URL] [--samples N] [--repo owner/name] [--no-gh] [--json]
// Sends no credentials to prod. gh calls use your local gh login (run as `env -u GH_TOKEN`).
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const BASE = opt("--base", "https://room.trydemigod.com");
const N = Number(opt("--samples", "20"));
const REPO = opt("--repo", "Uuriko/project-room");
const NO_GH = args.includes("--no-gh");
const JSON_OUT = args.includes("--json");

export function pct(values, p) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
}
const median = (v) => pct(v, 50);
const MCP_HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-11-25" };
const rpc = (id, method, params) => JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });

const probes = [
  { name: "GET /api/health", run: () => fetch(`${BASE}/api/health`) },
  { name: "GET /api/rooms/project-room-lobby/messages?latest (anon, auth edge)", run: () => fetch(`${BASE}/api/rooms/project-room-lobby/messages?latest=true&limit=50`) },
  { name: "GET /api/public-work/tasks (public board list)", run: () => fetch(`${BASE}/api/public-work/tasks`) },
  { name: "GET /.well-known/mcp.json", run: () => fetch(`${BASE}/.well-known/mcp.json`) },
  { name: "POST /mcp initialize+tools/list (anon)", run: async () => {
      const a = await fetch(`${BASE}/mcp`, { method: "POST", headers: MCP_HEADERS, body: rpc(1, "initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "measure-baseline", version: "1" } }) });
      await a.arrayBuffer();
      return fetch(`${BASE}/mcp`, { method: "POST", headers: MCP_HEADERS, body: rpc(2, "tools/list") });
    } },
];

async function measureProbe(p) {
  const ms = []; let bytes = 0; let status = 0; let body = "";
  for (let i = 0; i < N; i++) {
    const t = performance.now();
    const r = await p.run();
    body = await r.text();
    ms.push(performance.now() - t); bytes = Buffer.byteLength(body); status = r.status;
  }
  return { name: p.name, status, bytes, p50: median(ms), p95: pct(ms, 95), body };
}

function gh(argv) {
  return JSON.parse(execFileSync("gh", argv, { encoding: "utf8", maxBuffer: 256 << 20, env: { ...process.env, GH_TOKEN: "" } }));
}
const hours = (a, b) => (new Date(b) - new Date(a)) / 3.6e6;

function workflowMetrics() {
  const out = {};
  const open = gh(["api", "-X", "GET", "search/issues", "-f", `q=repo:${REPO} is:pr is:open`, "-f", "per_page=1"]);
  out.openPrs = open.total_count;
  const since = new Date(Date.now() - 864e5).toISOString().slice(0, 19);
  const merged = gh(["api", "-X", "GET", "search/issues", "-f", `q=repo:${REPO} is:pr is:merged merged:>=${since}`, "-f", "per_page=1"]);
  out.merged24h = merged.total_count;
  const recent = gh(["pr", "list", "-R", REPO, "--state", "merged", "--limit", "100", "--json", "createdAt,mergedAt"]);
  out.medianOpenToMergeHours = median(recent.map((p) => hours(p.createdAt, p.mergedAt)));
  // CI = the test workflow (the heavy, required suite). Cancelled/skipped runs are excluded from durations.
  const runs = gh(["run", "list", "-R", REPO, "--workflow", "test.yml", "--limit", "50", "--json", "workflowName,conclusion,status,startedAt,updatedAt,attempt,event"]);
  const finished = runs.filter((r) => r.status === "completed");
  out.cancelledRate = finished.filter((r) => r.conclusion === "cancelled").length / (finished.length || 1);
  const done = finished.filter((r) => r.conclusion === "success" || r.conclusion === "failure");
  const mins = (r) => (new Date(r.updatedAt) - new Date(r.startedAt)) / 60000;
  const dur = done.map(mins);
  out.ciRuns = done.length;
  out.ciMinutesP50 = median(dur); out.ciMinutesP95 = pct(dur, 95);
  out.rerunRate = done.filter((r) => (r.attempt ?? 1) > 1).length / (done.length || 1);
  const byWf = {};
  const all = gh(["run", "list", "-R", REPO, "--limit", "100", "--json", "workflowName,conclusion,status,startedAt,updatedAt"]).filter((r) => r.conclusion === "success" || r.conclusion === "failure");
  for (const r of all) (byWf[r.workflowName] ??= []).push(mins(r));
  out.byWorkflow = Object.entries(byWf).map(([k, v]) => ({ workflow: k, runs: v.length, p50: median(v), p95: pct(v, 95) })).sort((a, b) => b.p95 - a.p95);
  const mainRuns = gh(["run", "list", "-R", REPO, "--branch", "main", "--event", "push", "--limit", "50", "--json", "conclusion,status,workflowName"]).filter((r) => r.status === "completed" && r.conclusion !== "cancelled" && r.conclusion !== "skipped");
  out.mainRedRate = mainRuns.filter((r) => r.conclusion === "failure").length / (mainRuns.length || 1);
  out.mainRuns = mainRuns.length;
  return out;
}

const f = (n, d = 0) => (n == null ? "n/a" : Number(n).toFixed(d));
async function main() {
  const lat = [];
  for (const p of probes) lat.push(await measureProbe(p));
  let toolCount = null; let toolBytes = null;
  const tl = lat.at(-1);
  try { const m = tl.body.match(/\{[\s\S]*\}/); const j = JSON.parse(m[0]); toolCount = j.result?.tools?.length ?? null; toolBytes = tl.bytes; } catch { /* sse or error */ }
  const wf = NO_GH ? null : workflowMetrics();
  const result = { measuredAt: new Date().toISOString(), base: BASE, samples: N, latency: lat.map(({ body, ...r }) => r), mcp: { anonToolCount: toolCount, toolsListBytes: toolBytes }, workflow: wf };
  if (JSON_OUT) { console.log(JSON.stringify(result, null, 2)); return; }
  const L = [`# Baseline ${result.measuredAt}`, "", `Base ${BASE}, ${N} samples each, sequential, read-only, no credentials.`, "", "| Probe | Status | Bytes | p50 ms | p95 ms |", "|---|---|---|---|---|"];
  for (const r of result.latency) L.push(`| ${r.name} | ${r.status} | ${r.bytes} | ${f(r.p50)} | ${f(r.p95)} |`);
  L.push("", `Anonymous MCP tools/list: ${toolCount ?? "n/a"} tools, ${toolBytes ?? "n/a"} bytes.`);
  if (wf) {
    L.push("", "## Workflow", "", `- Open PRs: ${wf.openPrs}`, `- PRs merged last 24h: ${wf.merged24h}`, `- Median PR open-to-merge (last 100 merged): ${f(wf.medianOpenToMergeHours, 2)} h`,
      `- test workflow duration over last ${wf.ciRuns} success/failure runs (of 50): p50 ${f(wf.ciMinutesP50, 1)} min, p95 ${f(wf.ciMinutesP95, 1)} min`, `- Rerun (flake proxy) rate: ${f(wf.rerunRate * 100, 1)}%`, `- Cancelled (superseded) test runs: ${f(wf.cancelledRate * 100, 1)}%`,
      `- Main push red rate (last ${wf.mainRuns} non-cancelled): ${f(wf.mainRedRate * 100, 1)}%`, "", "Per workflow, last 100 runs of any workflow (success/failure only):", "", "| Workflow | Runs | p50 min | p95 min |", "|---|---|---|---|");
    for (const w of wf.byWorkflow) L.push(`| ${w.workflow} | ${w.runs} | ${f(w.p50, 1)} | ${f(w.p95, 1)} |`);
  }
  console.log(L.join("\n"));
}
if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e.message); process.exit(1); });
