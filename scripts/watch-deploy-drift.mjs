// Deploy drift + 1101 watcher (plan task W3). Zero dependencies.
// Compares prod sourceRevision to the local repo's main tip and reports
// drift, probe failures, or a 1101 window. Exit 0 = no drift and healthy.
// Intended for cron/CI: `git fetch origin main` first, then run this.
// Usage: node scripts/watch-deploy-drift.mjs [--base URL] [--ref origin/main]
import { execFileSync } from "node:child_process";
import { probeProd } from "./probe-prod-lib.mjs";

const args = process.argv.slice(2);
const baseFlag = args.indexOf("--base");
const refFlag = args.indexOf("--ref");
const BASE = baseFlag >= 0 ? args[baseFlag + 1] : "https://room.trydemigod.com";
const REF = refFlag >= 0 ? args[refFlag + 1] : "origin/main";

const mainTip = execFileSync("git", ["rev-parse", "--verify", REF], { encoding: "utf8" }).trim();
const report = await probeProd(BASE);
const drift = report.sourceRevision && report.sourceRevision !== mainTip;
const out = {
  checked_at: report.probed_at,
  base: BASE,
  ref: REF,
  main_tip: mainTip,
  prod_sourceRevision: report.sourceRevision,
  drift: Boolean(drift),
  probe_verdict: report.verdict,
  incident_window: report.verdict === "do-rpc-fail"
};
console.log(JSON.stringify(out, null, 2));
if (drift) console.error(`DRIFT: prod ${report.sourceRevision} != ${REF} ${mainTip}`);
if (out.incident_window) console.error("1101 WINDOW: do-rpc-fail signature present - docs/INCIDENT-1101-RUNBOOK.md");
process.exit(drift || out.incident_window || report.verdict !== "healthy" ? 1 : 0);
