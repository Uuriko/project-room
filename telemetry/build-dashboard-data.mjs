// telemetry/build-dashboard-data.mjs
// Reads telemetry/findings.jsonl if present, else telemetry/seed-findings.jsonl,
// and writes telemetry/findings.json as a JSON array for dashboard.html.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const primary = join(here, 'findings.jsonl');
const fallback = join(here, 'seed-findings.jsonl');
const out = join(here, 'findings.json');

const src = existsSync(primary) ? primary : fallback;
const lines = readFileSync(src, 'utf8').split('\n').filter((l) => l.trim().length > 0);
const records = lines.map((l, i) => {
  try {
    return JSON.parse(l);
  } catch (e) {
    throw new Error(`invalid JSON on line ${i + 1} of ${src}: ${e.message}`);
  }
});
writeFileSync(out, JSON.stringify(records, null, 2) + '\n');
console.log(`wrote ${out} with ${records.length} records (source: ${src.split('/').pop()})`);
