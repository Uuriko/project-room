#!/usr/bin/env node
// Detects whole-service stalls (a single Durable Object blocked so every request queues).
// Fires one cheap request per second for --seconds (default 120) and reports the longest window where
// requests launched at different times all completed at roughly the same moment.
// Usage: node scripts/qa2/stall-probe.mjs --url https://room.trydemigod.com/api/health [--seconds 120] [--max-ms 3000] [--json out.json]
import { argv, exit } from "node:process";
import { writeFileSync } from "node:fs";
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i > 0 ? argv[i + 1] : d; };
const url = arg("url", "http://127.0.0.1:4173/api/health"), seconds = Number(arg("seconds", "120")), maxMs = Number(arg("max-ms", "3000"));
const control = arg("control"); // optional: an endpoint that does not touch the DO (e.g. /api/version/worker)
const probes = [];
async function probe(target, kind) {
  const start = Date.now();
  try { const r = await fetch(target, { headers: { "user-agent": "project-room-qa2-stall/1" }, signal: AbortSignal.timeout(45000) }); await r.arrayBuffer(); probes.push({ kind, start, end: Date.now(), status: r.status }); }
  catch (e) { probes.push({ kind, start, end: Date.now(), status: 0, error: e.name }); }
}
const inflight = [];
for (let i = 0; i < seconds; i++) { inflight.push(probe(url, "do")); if (control) inflight.push(probe(control, "control")); await new Promise(r => setTimeout(r, 1000)); }
await Promise.all(inflight);
const dos = probes.filter(p => p.kind === "do").sort((a, b) => a.start - b.start);
const lat = dos.map(p => p.end - p.start);
const sorted = [...lat].sort((a, b) => a - b);
const slow = dos.filter(p => p.end - p.start > maxMs);
// stall windows: consecutive slow probes whose completion times are within 1.5 s of each other
const windows = [];
for (const p of slow) { const w = windows.at(-1); if (w && Math.abs(p.end - w.end) < 1500) { w.count++; } else windows.push({ from: new Date(p.start).toISOString(), end: p.end, count: 1, worstMs: p.end - p.start }); }
for (const w of windows) { w.until = new Date(w.end).toISOString(); delete w.end; }
const controlSlow = probes.filter(p => p.kind === "control" && p.end - p.start > maxMs).length;
const report = { url, seconds, n: dos.length, p50: sorted[Math.floor(sorted.length / 2)], p95: sorted[Math.floor(sorted.length * 0.95)], max: sorted.at(-1), slowCount: slow.length, stallWindows: windows, controlSlow, errors: dos.filter(p => p.status === 0 || p.status >= 500).length };
report.pass = report.slowCount === 0 && report.errors === 0;
console.log(JSON.stringify(report, null, 1));
if (arg("json")) writeFileSync(arg("json"), JSON.stringify({ ...report, probes }, null, 2));
exit(report.pass ? 0 : 1);
