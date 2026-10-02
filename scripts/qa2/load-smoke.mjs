#!/usr/bin/env node
// Load/latency smoke with k6-style thresholds, dependency-free (Node 22+).
// Usage: node scripts/qa2/load-smoke.mjs --origin http://127.0.0.1:4173 [--vus 20] [--seconds 30] [--json out.json]
// Mixes anonymous reads (/, /llms.txt, /api/health) with one authenticated agent reading events and posting
// at a gentle rate. Only point at production with --vus <= 3 (single Durable Object; see QA2 findings).
// Thresholds (fail exit 1): p95 static <= 500 ms, p95 API read <= 800 ms, p95 post <= 1200 ms, error rate < 1% (429 counted separately).
import { argv, exit } from "node:process";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i > 0 ? argv[i + 1] : d; };
const origin = arg("origin", "http://127.0.0.1:4173"), vus = Number(arg("vus", "20")), seconds = Number(arg("seconds", "30"));
if (!/127\.0\.0\.1|localhost/.test(origin) && vus > 3) { console.error("refusing >3 VUs against a non-local origin"); exit(2); }
const H = { "content-type": "application/json", origin, "user-agent": "project-room-qa2-load/1" };
const ident = await (await fetch(`${origin}/api/agent-identities`, { method: "POST", headers: H, body: JSON.stringify({ displayName: `qa2-load-${Date.now().toString(36)}` }) })).json();
const auth = { ...H, authorization: `Bearer ${ident.secret}` };
const room = await (await fetch(`${origin}/api/agent-rooms`, { method: "POST", headers: auth, body: JSON.stringify({ title: `qa2-load-${Date.now().toString(36)}`, purpose: "load smoke; archived after" }) })).json();
const R = `${origin}/api/rooms/${room.roomId}`;
const samples = { static: [], read: [], post: [] }; let errors = 0, limited = 0, total = 0;
const scenarios = [
  ["static", () => fetch(`${origin}/`, { headers: { accept: "text/html" } })],
  ["static", () => fetch(`${origin}/llms.txt`)],
  ["static", () => fetch(`${origin}/api/health`)],
  ["read", () => fetch(`${R}/events?limit=50`, { headers: auth })],
  ["read", () => fetch(`${origin}/api/needs-me`, { headers: auth })],
];
const end = Date.now() + seconds * 1000;
async function vu(n) {
  let i = n;
  while (Date.now() < end) {
    const isPost = n === 0 && i % 10 === 0; // one VU posts every 10th iteration
    const [kind, go] = isPost ? ["post", () => fetch(`${R}/commands`, { method: "POST", headers: auth, body: JSON.stringify({ id: randomUUID(), type: "message.posted", data: { messageId: randomUUID(), body: `load ${i}` } }) })] : scenarios[i % scenarios.length];
    const t0 = performance.now();
    try { const r = await go(); await r.arrayBuffer(); total++; if (r.status === 429) limited++; else if (r.status >= 400) errors++; else samples[kind].push(performance.now() - t0); }
    catch { total++; errors++; }
    i++;
  }
}
await Promise.all(Array.from({ length: vus }, (_, n) => vu(n)));
await fetch(`${R}/commands`, { method: "POST", headers: auth, body: JSON.stringify({ id: randomUUID(), type: "room.archived", data: {} }) });
await fetch(`${origin}/api/agent-identities/${ident.identityId}/revoke`, { method: "POST", headers: auth, body: JSON.stringify({ confirm: true }) });
const pct = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return Math.round(s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))]); };
const budget = { static: 500, read: 800, post: 1200 };
const report = { origin, vus, seconds, total, rps: Math.round(total / seconds), errors, rateLimited: limited, errorRate: total ? errors / total : 0 };
let failed = report.errorRate >= 0.01;
for (const k of Object.keys(samples)) { report[k] = { n: samples[k].length, p50: pct(samples[k], 50), p95: pct(samples[k], 95), p99: pct(samples[k], 99), budgetP95: budget[k] }; if (report[k].p95 !== null && report[k].p95 > budget[k]) failed = true; }
report.pass = !failed;
console.log(JSON.stringify(report, null, 1));
if (arg("json")) writeFileSync(arg("json"), JSON.stringify(report, null, 2));
exit(failed ? 1 : 0);
