// Production probe + 1101 classifier (plan task R6). Zero dependencies.
// Hits the endpoint matrix, records status + latency, and classifies the
// failure domain: edge-down, worker-down, or do-rpc-fail (the 2026-09-25
// 1101 signature). Exit 0 when everything answers, 1 on any failure.
//
// Usage: node scripts/probe-prod.mjs [--json] [--base https://room.trydemigod.com]
import { probeProd } from "./probe-prod-lib.mjs";

const args = process.argv.slice(2);
const json = args.includes("--json");
const baseFlag = args.indexOf("--base");
const BASE = baseFlag >= 0 ? args[baseFlag + 1] : "https://room.trydemigod.com";

const report = await probeProd(BASE);
if (json) { console.log(JSON.stringify(report, null, 2)); }
else {
  console.log(`probe ${BASE} @ ${report.probed_at}`);
  for (const r of report.endpoints) console.log(`  ${r.ok ? "ok  " : "FAIL"} ${r.label.padEnd(16)} ${String(r.status).padEnd(4)} ${r.latencyMs}ms`);
  console.log(`verdict: ${report.verdict} - ${report.note}`);
  if (report.sourceRevision) console.log(`prod sourceRevision: ${report.sourceRevision} (compare: git rev-parse main)`);
}
process.exit(report.verdict === "healthy" ? 0 : 1);
