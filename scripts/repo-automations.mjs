#!/usr/bin/env node
// Landing, superseded-check rerun, and hourly deploy selection.
//
//   node scripts/repo-automations.mjs land
//   node scripts/repo-automations.mjs rerun
//   node scripts/repo-automations.mjs deploy-candidate
//
// Reads check runs and commit statuses. Never creates a status and never
// deletes a workflow run. Merge pins the head SHA and does not bypass
// branch protection. When the repository requires a merge queue, that
// command enqueues instead of merging.
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const HEAD_CHECK_NAMES = ["test", "contract", "lint", "browser", "cloudflare"];
const UNSETTLED = new Set(["queued", "in_progress", "pending", "waiting", "requested", "missing"]);
const PASSING = new Set(["success", "skipped", "neutral"]);
const BLOCKING_STATUS = new Set(["failure", "error", "pending"]);
const HOUR_MS = 60 * 60 * 1000;
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 project-room-deploy";

function time(value) {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function latestBy(items, key, stamp) {
  const map = new Map();
  for (const item of items ?? []) {
    const id = key(item);
    if (!id) continue;
    const prev = map.get(id);
    if (!prev || stamp(item) >= stamp(prev)) map.set(id, item);
  }
  return map;
}

export function headCheckDecision(checkRuns, statuses = []) {
  const latest = latestBy(
    checkRuns,
    run => run?.name,
    run => time(run.startedAt ?? run.started_at),
  );
  for (const name of HEAD_CHECK_NAMES) {
    const run = latest.get(name);
    if (!run || run.status !== "completed" || run.conclusion !== "success") {
      const detail = run ? `${run.status}/${run.conclusion ?? "none"}` : "missing";
      return { green: false, reason: `${name} is ${detail}` };
    }
  }
  for (const [name, run] of latest) {
    if (run.status !== "completed" || !PASSING.has(run.conclusion)) {
      return { green: false, reason: `${name} is ${run.status}/${run.conclusion ?? "none"}` };
    }
  }
  const statusLatest = latestBy(
    statuses,
    status => status?.context,
    status => time(status.updatedAt ?? status.updated_at),
  );
  for (const [context, status] of statusLatest) {
    if (BLOCKING_STATUS.has(status.state)) return { green: false, reason: `${context} is ${status.state}` };
  }
  return { green: true, reason: "head checks passed" };
}

function conflicted(pr) {
  return pr.mergeable === false
    || pr.mergeable === "CONFLICTING"
    || pr.mergeStateStatus === "DIRTY"
    || pr.mergeStateStatus === "CONFLICTING";
}

export function selectLandingBatch(pulls) {
  return (pulls ?? [])
    .filter(pr => pr?.state === "open"
      && pr.draft !== true
      && pr.base === "main"
      && (pr.labels ?? []).includes("ready-to-land")
      && !conflicted(pr)
      && pr.green === true
      && /^[0-9a-f]{40}$/.test(pr.sha ?? ""))
    .sort((a, b) => a.number - b.number)
    .map(pr => ({ number: pr.number, sha: pr.sha }));
}

function sameWorkflow(run, item) {
  if (run.workflowId != null && item.workflowId != null && String(item.workflowId) === String(run.workflowId)) return true;
  return Boolean(run.name) && item.name === run.name;
}

export function rerunTarget({ run, pullRequest, headRuns = [], pullRuns = [] }) {
  const no = (reason, retry = false) => ({ rerun: null, reason, retry });
  if (!run || run.conclusion !== "cancelled") return no("run is not cancelled");
  if (run.event !== "pull_request") return no("not a pull request run");
  if (!pullRequest || String(pullRequest.state).toLowerCase() !== "open") return no("pull request is not open");
  if (pullRequest.draft === true) return no("pull request is a draft");
  if (!(pullRequest.labels ?? []).includes("ready-to-land")) return no("pull request is not ready-to-land");
  const superseded = (pullRuns ?? []).some(item => sameWorkflow(run, item)
      && item.conclusion === "cancelled"
      && item.headSha
      && item.headSha !== pullRequest.headSha)
    || (run.headSha && run.headSha !== pullRequest.headSha);
  if (!superseded) return no("cancelled run is still the head commit");
  const head = (headRuns ?? []).filter(item => sameWorkflow(run, item) && (!item.event || item.event === "pull_request"));
  if (head.some(item => item.status === "queued" || item.status === "in_progress" || item.conclusion === "success")) {
    return no("head already has a live or successful run");
  }
  const target = head
    .filter(item => item.conclusion === "cancelled" && Number(item.runAttempt) === 1 && item.headSha === pullRequest.headSha)
    .sort((a, b) => time(b.createdAt ?? b.startedAt) - time(a.createdAt ?? a.startedAt))[0];
  if (!target) return no(head.length === 0 ? "head has no run yet" : "head run is not a first-attempt cancel", head.length === 0);
  return { rerun: target.id, reason: "rerun the head run cancelled after a newer commit", retry: false };
}

export async function resolveRerun({ run, pullRequest, load, sleep }) {
  let decision = rerunTarget({ run, pullRequest, ...(await load()) });
  if (decision.rerun || !decision.retry) return { ...decision, retry: false };
  await sleep(15000);
  decision = rerunTarget({ run, pullRequest, ...(await load()) });
  return { ...decision, retry: false };
}

export function indexRuns(runs) {
  const sorted = (runs ?? []).map(run => ({
    name: run.name,
    headSha: run.headSha ?? run.head_sha,
    createdAt: run.createdAt ?? run.created_at ?? "",
    conclusion: run.conclusion || null,
    status: run.status || null,
    id: String(run.id ?? ""),
  })).sort((a, b) => time(a.createdAt) - time(b.createdAt) || a.id.localeCompare(b.id));
  const bySha = {};
  for (const run of sorted) {
    if (run.name !== "test" && run.name !== "schema-gate") continue;
    if (!run.headSha) continue;
    bySha[run.headSha] ??= {};
    bySha[run.headSha][run.name] = run.conclusion || run.status || "missing";
  }
  return bySha;
}

export function selectDeployCandidate({ commits, runsBySha, prodSha, isAncestor }) {
  if (!commits?.length) return { sha: null, reason: "no commits on main" };
  const gate = (sha, name) => runsBySha?.[sha]?.[name] ?? "missing";
  const hard = value => !UNSETTLED.has(value) && value !== "success";
  const tip = commits[0];
  const tipValues = [gate(tip, "test"), gate(tip, "schema-gate")];
  if (!tipValues.some(hard) && tipValues.some(value => UNSETTLED.has(value))) {
    return { sha: null, reason: "the newest main commit is still running its gates" };
  }
  const candidate = commits.find(sha => gate(sha, "test") === "success" && gate(sha, "schema-gate") === "success") ?? null;
  if (!candidate) return { sha: null, reason: "no green main commit" };
  if (prodSha && prodSha === candidate) return { sha: null, reason: "production is already on the newest green commit" };
  if (prodSha && isAncestor?.(candidate, prodSha) === true) {
    return { sha: null, reason: "the newest green commit is behind production" };
  }
  if (prodSha && isAncestor?.(prodSha, candidate) === false) {
    return { sha: null, reason: "production is not an ancestor of the newest green commit" };
  }
  return { sha: candidate, reason: "newest green main commit" };
}

export function scheduledDeployBlocked(runs, { now, runId, intervalMs = HOUR_MS } = {}) {
  return (runs ?? []).some(run => {
    if (String(run.id) === String(runId)) return false;
    const then = Date.parse(run.createdAt ?? run.created_at ?? "");
    return Number.isFinite(then) && now - then < intervalMs;
  });
}

export function mergeArgs(repo, pr) {
  return ["pr", "merge", String(pr.number), "--repo", repo, "--merge", "--match-head-commit", pr.sha];
}

export function dispatchArgs(repo, workflow) {
  return ["workflow", "run", workflow, "--ref", "main", "--repo", repo];
}

export function rerunArgs(repo, runId) {
  return ["run", "rerun", String(runId), "--repo", repo];
}

export function choosePullRequest(pulls) {
  const normalized = (pulls ?? []).map(pr => ({
    number: pr.number,
    state: String(pr.state ?? "").toLowerCase(),
    draft: pr.draft === true || pr.isDraft === true,
    base: pr.base ?? pr.baseRefName ?? pr.base?.ref ?? "",
    labels: (pr.labels ?? []).map(label => (typeof label === "string" ? label : label?.name)).filter(Boolean),
    headSha: pr.headSha ?? pr.headRefOid ?? pr.head?.sha ?? "",
    branch: pr.branch ?? pr.headRefName ?? pr.head?.ref ?? "",
  }));
  const openMain = normalized.filter(pr => pr.state === "open" && pr.base === "main");
  return openMain.find(pr => pr.labels.includes("ready-to-land")) ?? openMain[0] ?? null;
}

export async function runLanding({ listPulls, checksFor, merge, view, dispatch }) {
  const pulls = await listPulls();
  const eligible = selectLandingBatch((pulls ?? []).map(pr => ({ ...pr, green: true })));
  const batch = [];
  for (const item of eligible) {
    const snap = await checksFor(item.sha);
    if (headCheckDecision(snap?.checkRuns ?? [], snap?.statuses ?? []).green) batch.push(item);
  }
  const attempted = [];
  let direct = 0;
  for (const pr of batch) {
    let mergeError = null;
    try {
      await merge(pr);
    } catch (error) {
      mergeError = error;
    }
    let state = "";
    try { state = String(await view(pr.number) ?? "").toUpperCase(); } catch { state = ""; }
    if (state === "MERGED") {
      direct += 1;
      attempted.push({ number: pr.number, sha: pr.sha, merged: true, queued: false });
    } else if (!mergeError && state === "OPEN") {
      attempted.push({ number: pr.number, sha: pr.sha, merged: false, queued: true });
    } else {
      attempted.push({
        number: pr.number,
        sha: pr.sha,
        merged: false,
        queued: false,
        error: String(mergeError?.message ?? mergeError ?? `unexpected state ${state}`).slice(0, 300),
      });
    }
  }
  if (direct > 0) {
    await dispatch("test.yml");
    await dispatch("schema-gate.yml");
  }
  return { attempted, dispatched: direct > 0, skipped: eligible.length - batch.length };
}

export function landingExitCode(result) {
  const failed = (result?.attempted ?? []).filter(item => item.error);
  return result?.attempted?.length > 0 && failed.length === result.attempted.length ? 1 : 0;
}

function ghOut(args) {
  return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function ghLines(args) {
  const out = ghOut(args);
  if (!out) return [];
  return out.split("\n").map(line => JSON.parse(line));
}

function repoName() {
  const repo = process.env.REPO || process.env.GITHUB_REPOSITORY;
  if (!repo || !/^[^/\s]+\/[^/\s]+$/.test(repo)) throw new Error("REPO must be owner/name");
  return repo;
}

function summarize(title, body) {
  console.log(body);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (!summary) return;
  try {
    appendFileSync(summary, `## ${title}\n\n${body}\n`);
  } catch (error) {
    console.error(`step summary skipped: ${error?.message ?? error}`);
  }
}

function checkRuns(repo, sha) {
  return ghLines(["api", "--paginate", `repos/${repo}/commits/${sha}/check-runs?per_page=100`, "--jq", ".check_runs[] | {name,status,conclusion,startedAt:.started_at}"]);
}

function commitStatuses(repo, sha) {
  return ghLines(["api", `repos/${repo}/commits/${sha}/status`, "--jq", "(.statuses // [])[] | {context,state,updatedAt:.updated_at}"]);
}

function workflowRuns(repo, workflowId, { sha, branch }) {
  const query = sha
    ? `head_sha=${sha}&per_page=20`
    : `branch=${encodeURIComponent(branch)}&event=pull_request&per_page=40`;
  return ghLines(["api", `repos/${repo}/actions/workflows/${workflowId}/runs?${query}`, "--jq", ".workflow_runs[] | {id,name,workflowId:.workflow_id,headSha:.head_sha,conclusion,status,runAttempt:.run_attempt,createdAt:.created_at,event}"]);
}

async function landCommand() {
  const repo = repoName();
  const result = await runLanding({
    listPulls: () => {
      const rows = JSON.parse(ghOut(["pr", "list", "--repo", repo, "--base", "main", "--state", "open", "--limit", "100", "--json", "number,isDraft,mergeable,mergeStateStatus,labels,headRefOid,baseRefName,state"]));
      return rows.map(pr => ({
        number: pr.number,
        state: String(pr.state ?? "").toLowerCase(),
        draft: pr.isDraft === true,
        base: pr.baseRefName,
        labels: (pr.labels ?? []).map(label => label.name),
        sha: pr.headRefOid,
        mergeable: pr.mergeable,
        mergeStateStatus: pr.mergeStateStatus,
      }));
    },
    checksFor: async sha => ({ checkRuns: checkRuns(repo, sha), statuses: commitStatuses(repo, sha) }),
    merge: pr => ghOut(mergeArgs(repo, pr)),
    view: number => ghOut(["pr", "view", String(number), "--repo", repo, "--json", "state", "--jq", ".state"]),
    dispatch: workflow => ghOut(dispatchArgs(repo, workflow)),
  });
  const lines = result.attempted.map(item => `#${item.number} ${item.merged ? "merged" : item.queued ? "queued" : "not merged"}${item.error ? ` ${item.error}` : ""}`);
  summarize("land-ready", lines.join("\n") || "no ready pull request");
  if (result.dispatched) console.log("dispatched test and schema-gate on main");
  return landingExitCode(result);
}

async function rerunCommand() {
  const repo = repoName();
  const run = {
    id: process.env.RUN_ID,
    conclusion: process.env.RUN_CONCLUSION || "cancelled",
    event: process.env.RUN_EVENT,
    headSha: process.env.RUN_SHA,
    name: process.env.RUN_NAME,
    workflowId: process.env.WORKFLOW_ID,
    runAttempt: Number(process.env.RUN_ATTEMPT),
  };
  if (!/^[0-9a-f]{40}$/.test(run.headSha ?? "")) {
    console.log("cancelled run has no head sha");
    return 0;
  }
  const pulls = ghLines(["api", "--paginate", "-H", "Accept: application/vnd.github+json", `repos/${repo}/commits/${run.headSha}/pulls`, "--jq", ".[] | {number,state,draft,base:.base.ref,labels:[.labels[].name],headSha:.head.sha,branch:.head.ref}"]);
  const pullRequest = choosePullRequest(pulls);
  if (!pullRequest) {
    console.log("no open pull request for the cancelled commit");
    return 0;
  }
  const decision = await resolveRerun({
    run,
    pullRequest,
    load: () => ({
      headRuns: workflowRuns(repo, run.workflowId, { sha: pullRequest.headSha }),
      pullRuns: workflowRuns(repo, run.workflowId, { branch: pullRequest.branch }),
    }),
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  });
  console.log(decision.reason);
  if (!decision.rerun) return 0;
  ghOut(rerunArgs(repo, decision.rerun));
  return 0;
}

function gitIsAncestor(ancestor, descendant) {
  if (!/^[0-9a-f]{40}$/.test(ancestor ?? "") || !/^[0-9a-f]{40}$/.test(descendant ?? "")) return null;
  for (const sha of [ancestor, descendant]) {
    if (spawnSync("git", ["cat-file", "-e", `${sha}^{commit}`], { stdio: "ignore" }).status !== 0) return null;
  }
  const result = spawnSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], { stdio: "ignore" });
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  return null;
}

async function readProdSha(origin) {
  try {
    const response = await fetch(`${origin}/api/version`, {
      headers: { accept: "application/json", "user-agent": UA },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) return null;
    const body = await response.json();
    const sha = body?.sourceRevision;
    return typeof sha === "string" && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

async function deployCandidateCommand() {
  const repo = repoName();
  const origin = (process.env.PROD_ORIGIN || "https://room.trydemigod.com").replace(/\/$/, "");
  const scheduleRuns = ghLines(["api", `repos/${repo}/actions/workflows/deploy-prod.yml/runs?event=schedule&per_page=20`, "--jq", ".workflow_runs[] | {id,createdAt:.created_at}"]);
  if (scheduledDeployBlocked(scheduleRuns, { now: Date.now(), runId: process.env.GITHUB_RUN_ID || "" })) {
    console.log(JSON.stringify({ sha: null, reason: "a scheduled deploy already started within the last hour" }));
    return 0;
  }
  const commits = execFileSync("git", ["rev-list", "--max-count=40", "origin/main"], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
  const runs = ["test.yml", "schema-gate.yml"].flatMap(name => ghLines([
    "api",
    `repos/${repo}/actions/workflows/${name}/runs?branch=main&per_page=40`,
    "--jq",
    ".workflow_runs[] | {id,name,headSha:.head_sha,conclusion,status,createdAt:.created_at}",
  ]));
  const decision = selectDeployCandidate({
    commits,
    runsBySha: indexRuns(runs),
    prodSha: await readProdSha(origin),
    isAncestor: gitIsAncestor,
  });
  console.log(JSON.stringify({ sha: decision.sha, reason: decision.reason }));
  return 0;
}

async function main() {
  const command = process.argv[2];
  if (command === "land") return landCommand();
  if (command === "rerun") return rerunCommand();
  if (command === "deploy-candidate") return deployCandidateCommand();
  console.error("usage: repo-automations.mjs <land|rerun|deploy-candidate>");
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    code => process.exit(code),
    error => {
      console.error(`repo-automations: ${error?.message ?? error}`);
      process.exit(1);
    },
  );
}
