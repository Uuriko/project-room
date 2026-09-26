// merge-queue-dryrun.mjs — read-only merge-queue readiness tracker.
//
// DRY-RUN ONLY: performs no writes, enables nothing, needs no admin rights.
// Lists open PRs targeting `main`, fetches each PR's combined check state and
// mergeable_state via the read-only GitHub API, and prints the simulated FIFO
// queue order with per-PR flags:
//
//   READY      green required checks + mergeable      -> safe to enqueue
//   NOT-GREEN  required checks not green/absent       -> cannot enqueue yet
//   DIRTY      mergeable_state == "dirty"             -> would be ejected;
//              (known platform behavior: GitHub creates NO pull_request
//              workflow runs for dirty PRs, so a dirty PR may show no CI at
//              all — rebase first, then re-verify, then enqueue)
//   BEHIND     mergeable but behind main              -> informational; the
//              queue re-verifies against latest main anyway
//
// Also reports whether the merge queue is currently enabled on the repo and
// whether required status checks are strict (incompatible with the queue;
// the queue owns freshness — see docs/MERGE-QUEUE-DESIGN.md §2.3).
//
// Usage: node scripts/merge-queue-dryrun.mjs [--repo owner/name]
// Requires: gh CLI authenticated (read-only scopes suffice).
import { execFileSync } from "node:child_process";

const REPO = argValue("--repo") || "Uuriko/project-room";
const BASE = "main";

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

function ghApi(path, jq) {
  const args = ["api", path];
  if (jq) args.push("--jq", jq);
  try {
    return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    const msg = (e.stderr || e.message || "").toString().split("\n")[0];
    console.error(`gh api ${path} failed: ${msg}`);
    process.exit(2);
  }
}

function ghApiJson(path, jq) {
  const out = ghApi(path, jq);
  return out.trim() === "" ? null : JSON.parse(out);
}

// --- repo / protection state ------------------------------------------------
const repoInfo = ghApiJson(`repos/${REPO}`, "{default_branch}");
const protection = ghApiJson(`repos/${REPO}/branches/${BASE}/protection`);
const requiredChecks = (protection.required_status_checks?.checks || []).map((c) => c.context);
const strict = protection.required_status_checks?.strict === true;
const rulesets = ghApiJson(`repos/${REPO}/rulesets`);
const queueRuleset = rulesets.find((r) =>
  (r.rules || []).some((rule) => rule.type === "merge_queue")
);

console.log(`repo: ${REPO} (default branch: ${repoInfo.default_branch || BASE})`);
console.log(`merge queue enabled: ${queueRuleset ? `YES (ruleset "${queueRuleset.name}")` : "NO"}`);
console.log(`required checks: ${requiredChecks.join(", ") || "(none)"}`);
console.log(`strict (require up to date): ${strict ? "ON — incompatible with the queue (§2.3)" : "off"}`);
console.log("");

// --- open PRs ----------------------------------------------------------------
const prs = ghApiJson(`repos/${REPO}/pulls?state=open&base=${BASE}&per_page=100`);
if (prs.length === 0) {
  console.log("No open PRs targeting main. Queue is empty (trivially).");
  process.exit(0);
}

const rows = prs
  .sort((a, b) => a.number - b.number) // FIFO: queue order = enqueue order ~ PR number
  .map((pr) => {
    const detail = ghApiJson(`repos/${REPO}/pulls/${pr.number}`, "{mergeable_state, mergeable, draft, head_sha: .head.sha}");
    const combined = ghApiJson(`repos/${REPO}/commits/${detail.head_sha}/check-runs`, "[.check_runs[] | {name, status, conclusion}]");
    const states = {};
    for (const run of combined) {
      if (requiredChecks.includes(run.name)) states[run.name] = run.status === "completed" ? run.conclusion : run.status;
    }
    const missing = requiredChecks.filter((c) => !(c in states));
    const failing = requiredChecks.filter((c) => c in states && states[c] !== "success");
    const dirty = detail.mergeable_state === "dirty";
    const behind = detail.mergeable_state === "behind";
    let flag = "READY";
    let note = "";
    if (detail.draft) { flag = "NOT-GREEN"; note = "draft"; }
    else if (dirty) { flag = "DIRTY"; note = "conflicted — no pull_request runs are created while dirty; rebase, re-verify, then enqueue"; }
    else if (missing.length > 0 || failing.length > 0) {
      flag = "NOT-GREEN";
      note = [
        missing.length > 0 ? `no runs: ${missing.join(",")}` : "",
        failing.length > 0 ? `not green: ${failing.map((c) => `${c}=${states[c]}`).join(",")}` : "",
      ].filter(Boolean).join("; ");
    } else if (behind) { flag = "BEHIND"; note = "behind main — queue re-verifies against latest main; informational"; }
    return { number: pr.number, title: pr.title, head: detail.head_sha.slice(0, 7), flag, note, mergeable_state: detail.mergeable_state };
  });

const w = Math.max(...rows.map((r) => String(r.number).length));
console.log(`open PRs targeting ${BASE} (simulated FIFO order):`);
for (const r of rows) {
  console.log(`  #${String(r.number).padEnd(w)} [${r.flag.padEnd(9)}] ${r.head} ${r.title.slice(0, 72)}${r.note ? `\n${" ".repeat(w + 15)}↳ ${r.note}` : ""}`);
}
console.log("");
const ready = rows.filter((r) => r.flag === "READY").length;
const dirty = rows.filter((r) => r.flag === "DIRTY").length;
const notGreen = rows.filter((r) => r.flag === "NOT-GREEN").length;
console.log(`summary: ${ready} ready · ${notGreen} not-green · ${dirty} dirty · ${rows.length} total`);
if (!queueRuleset) console.log("note: queue not enabled — this is a dry-run simulation only; nothing was enqueued.");
