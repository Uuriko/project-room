// Deploy drift + 1101 watcher (plan task W3). Zero dependencies.
// Compares production's public /api/version to the local repo's main tip.
// Drift means that revision is missing, is not an ancestor of the tip, or
// the tip is ahead by more than --max-prs commits (default 5) or the first
// of those commits is older than --max-hours (default 24). A matching
// revision, or a lag inside both budgets, is not drift. An unhealthy probe
// still fails. Exit 0 = no drift and healthy.
// Intended for cron/CI: `git fetch origin main` first, then run this.
// Usage: node scripts/watch-deploy-drift.mjs [--base URL] [--ref origin/main] [--max-prs 5] [--max-hours 24]
import { execFileSync } from "node:child_process";
import { probeProd } from "./probe-prod-lib.mjs";

const args = process.argv.slice(2);
function option(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}
function integerOption(name, fallback) {
  const raw = option(name);
  if (raw === undefined) return fallback;
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) {
    console.error(`${name} expects a non-negative integer`);
    process.exit(2);
  }
  return Number(raw);
}

const BASE = option("--base") ?? "https://room.trydemigod.com";
const REF = option("--ref") ?? "origin/main";
const maxPrs = integerOption("--max-prs", 5);
const maxHours = integerOption("--max-hours", 24);

function git(args, encoding) {
  return execFileSync("git", args, encoding ? { encoding, stdio: ["ignore", "pipe", "pipe"] } : { stdio: "ignore" });
}

function lag(prod, ref, nowSeconds) {
  if (!/^[0-9a-f]{40}$/.test(prod)) return { known: false, ancestor: false, commits: null, hours: null, reason: "unknown" };
  try { git(["cat-file", "-e", `${prod}^{commit}`]); }
  catch { return { known: false, ancestor: false, commits: null, hours: null, reason: "unknown" }; }
  try { git(["merge-base", "--is-ancestor", prod, ref]); }
  catch { return { known: true, ancestor: false, commits: null, hours: null, reason: "not-ancestor" }; }
  const commits = Number(git(["rev-list", "--count", `${prod}..${ref}`], "utf8").trim());
  let hours = 0;
  if (commits > 0) {
    const first = Number(git(["log", "--reverse", "--format=%ct", `${prod}..${ref}`], "utf8").split("\n")[0]);
    hours = (nowSeconds - first) / 3600;
  }
  const reason = commits > maxPrs ? "prs" : hours > maxHours ? "hours" : null;
  return { known: true, ancestor: true, commits, hours, reason };
}

const mainTip = git(["rev-parse", "--verify", REF], "utf8").trim();
const report = await probeProd(BASE);
const measured = report.sourceRevision ? lag(report.sourceRevision, REF, Date.now() / 1000) : null;
const drift = Boolean(measured?.reason);
const out = {
  checked_at: report.probed_at,
  base: BASE,
  ref: REF,
  main_tip: mainTip,
  prod_sourceRevision: report.sourceRevision,
  max_prs: maxPrs,
  max_hours: maxHours,
  behind_prs: measured?.commits ?? null,
  behind_hours: measured?.hours ?? null,
  lag: measured?.reason ?? null,
  drift,
  probe_verdict: report.verdict,
  incident_window: report.verdict === "do-rpc-fail"
};
console.log(JSON.stringify(out, null, 2));
if (drift) console.error(`DRIFT: prod ${report.sourceRevision} lags ${REF} ${mainTip} (${measured.reason})`);
if (out.incident_window) console.error("1101 WINDOW: do-rpc-fail signature present - docs/INCIDENT-1101-RUNBOOK.md");
process.exit(drift || out.incident_window || report.verdict !== "healthy" ? 1 : 0);
