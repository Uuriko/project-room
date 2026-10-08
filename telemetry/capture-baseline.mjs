// telemetry/capture-baseline.mjs
// WAVE-300 before/after helper: fetches GET /api/health/tripwires and writes
// telemetry/baseline-<ISO>.json so coordinators can snapshot the trip-wire
// gauges before their change and after, then compare in ops-dashboard.html
// ("Load baseline JSON…") or by diffing the JSON files.
//
// Usage:
//   node telemetry/capture-baseline.mjs [--host http://127.0.0.1:8787]
// Baseline files are compared by gauge name; the localStorage "Capture
// baseline" button in the dashboard stores the same shape client-side.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
let host = 'http://127.0.0.1:8787';
for (let i = 0; i < args.length; i++) {
  if ((args[i] === '--host' || args[i] === '-h') && args[i + 1]) host = args[++i];
  else if (args[i] === '--help') {
    console.log('usage: node telemetry/capture-baseline.mjs [--host http://127.0.0.1:8787]');
    process.exit(0);
  }
}

const url = host.replace(/\/+$/, '') + '/api/health/tripwires';
let res;
try {
  res = await fetch(url);
} catch (e) {
  throw new Error(`fetch ${url} failed: ${e.message}`);
}
if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
const data = await res.json();
if (!data || !Array.isArray(data.gauges)) {
  throw new Error('unexpected response shape: missing gauges[] array');
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, `baseline-${stamp}.json`);
const record = {
  capturedAt: new Date().toISOString(),
  source: url,
  updatedAt: data.updatedAt,
  gauges: data.gauges,
};
writeFileSync(out, JSON.stringify(record, null, 2) + '\n');
console.log(`wrote ${out} (${data.gauges.length} gauges)`);
