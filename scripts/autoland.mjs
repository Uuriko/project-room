#!/usr/bin/env node
/**
 * Opt-in autoland: squash-merge open, non-draft PRs labeled `autoland`
 * when the head's latest checks are green and mergeable_state is CLEAN.
 *
 * After merges, dispatch the existing deploy-prod workflow on the new
 * main tip when schema-gate is already green. Otherwise the squash
 * commit title begins with [deploy-production], so deploy-prod's
 * existing workflow_run hook starts it once test and schema-gate pass
 * on main. Smoke, recovery to the previous prod SHA, and Room deploy /
 * rollback receipts already live in that workflow.
 *
 * Usage
 *   GH_TOKEN=<user-or-app-token> node scripts/autoland.mjs
 *   GH_TOKEN=... node scripts/autoland.mjs --dry-run
 */
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";

export const LABEL = "autoland";
export const SQUASH_PREFIX = "[deploy-production]";
export const REQUIRED_CHECKS = Object.freeze([
  "safety-net",
  "mechanical",
  "test",
  "contract",
  "lint",
  "browser",
  "cloudflare",
]);
export const OPTIONAL_IF_PRESENT = Object.freeze(["pin-gate", "schema-gate"]);
export const PASSING_CONCLUSIONS = Object.freeze(["success", "skipped", "neutral"]);

const SHA = /^[0-9a-f]{40}$/;

export function indexLatestCheckRuns(runs) {
  const byName = new Map();
  for (const run of runs || []) {
    if (!run || typeof run.name !== "string" || !run.name) continue;
    const previous = byName.get(run.name);
    if (!previous || newerCheck(run, previous)) byName.set(run.name, run);
  }
  return byName;
}

function newerCheck(a, b) {
  const at = Date.parse(a.completed_at || a.started_at || 0) || 0;
  const bt = Date.parse(b.completed_at || b.started_at || 0) || 0;
  if (at !== bt) return at > bt;
  return (a.id || 0) > (b.id || 0);
}

export function indexLatestStatuses(statuses) {
  const byContext = new Map();
  for (const status of statuses || []) {
    if (!status || typeof status.context !== "string" || !status.context) continue;
    const previous = byContext.get(status.context);
    const at = Date.parse(status.updated_at || 0) || 0;
    const bt = previous ? Date.parse(previous.updated_at || 0) || 0 : -1;
    if (!previous || at > bt || (at === bt && (status.id || 0) > (previous.id || 0))) {
      byContext.set(status.context, status);
    }
  }
  return byContext;
}

/**
 * Every latest check run on the head must have completed with a passing
 * conclusion. Browser shards are not treated as advisory: the repo does
 * not mark them continue-on-error or otherwise optional, so a failed
 * shard blocks land. Named jobs from RELEASE-MERGE-GATE.md must also be
 * present, so an `autoland` label cannot skip the ready-to-land suite.
 */
export function evaluateHeadChecks(runs, statuses = []) {
  const byName = indexLatestCheckRuns(runs);
  const problems = [];
  const pending = [];
  for (const [name, run] of byName) {
    if (run.status !== "completed") {
      pending.push(`${name}: ${run.status || "unknown"}`);
      continue;
    }
    if (!PASSING_CONCLUSIONS.includes(run.conclusion)) {
      problems.push(`${name}: ${run.conclusion || "unknown"}`);
    }
  }
  const byContext = indexLatestStatuses(statuses);
  for (const [context, status] of byContext) {
    if (byName.has(context)) continue;
    if (status.state === "pending") pending.push(`${context}: pending`);
    else if (status.state !== "success") problems.push(`${context}: ${status.state || "unknown"}`);
  }
  for (const name of REQUIRED_CHECKS) {
    if (!byName.has(name)) problems.push(`${name}: missing`);
  }
  for (const name of OPTIONAL_IF_PRESENT) {
    // Already evaluated above when present; absence is not a failure.
    void name;
  }
  return {
    ok: problems.length === 0 && pending.length === 0,
    problems,
    pending,
  };
}

export function isEligiblePr(pr, checkEvaluation) {
  if (!pr || pr.state !== "open") return { ok: false, reason: "not open" };
  if (pr.draft) return { ok: false, reason: "draft" };
  const base = pr.base?.ref || pr.baseRefName;
  if (base && base !== "main") return { ok: false, reason: `base is ${base}` };
  const labels = (pr.labels || []).map((label) => (typeof label === "string" ? label : label.name));
  if (!labels.includes(LABEL)) return { ok: false, reason: `missing ${LABEL} label` };
  if (pr.mergeable_state !== "clean") return { ok: false, reason: `mergeable_state is ${pr.mergeable_state || "unknown"}` };
  if (!checkEvaluation?.ok) {
    const detail = [...(checkEvaluation?.pending || []), ...(checkEvaluation?.problems || [])].join("; ");
    return { ok: false, reason: detail || "head checks not green" };
  }
  return { ok: true, reason: "eligible" };
}

export function squashTitle(pr) {
  const title = String(pr?.title || "untitled").replace(/\s+/g, " ").trim();
  const line = `${SQUASH_PREFIX} (#${pr?.number}) ${title}`;
  return line.length <= 200 ? line : `${line.slice(0, 197)}...`;
}

export function mergeMessage(pr, sha) {
  return `autoland: squash-merge #${pr.number} at ${sha}. Deploy follows via deploy-prod.`;
}

function tokenOf(env = process.env) {
  return env.GH_TOKEN || env.LANDING_TOKEN || "";
}

export function ghJson(args, { token, input } = {}) {
  const auth = token || tokenOf();
  const result = spawnSync("gh", ["api", ...args], {
    encoding: "utf8",
    input: input ?? undefined,
    env: { ...process.env, GH_TOKEN: auth, GITHUB_TOKEN: auth },
  });
  if (result.status !== 0) {
    throw new Error(`gh api ${args.join(" ")} failed: ${(result.stderr || result.stdout || "").trim()}`);
  }
  return result.stdout ? JSON.parse(result.stdout) : null;
}

export function paginatedCheckRuns(repo, sha, request = ghJson) {
  const runs = [];
  for (let page = 1; page <= 20; page++) {
    const data = request([`repos/${repo}/commits/${sha}/check-runs?per_page=100&filter=latest&page=${page}`]);
    const batch = data?.check_runs || [];
    runs.push(...batch);
    if (batch.length < 100) break;
  }
  return runs;
}

export function paginatedStatuses(repo, sha, request = ghJson) {
  const statuses = [];
  for (let page = 1; page <= 20; page++) {
    const data = request([`repos/${repo}/commits/${sha}/statuses?per_page=100&page=${page}`]);
    const batch = Array.isArray(data) ? data : [];
    statuses.push(...batch);
    if (batch.length < 100) break;
  }
  return statuses;
}

export function listOpenLabeledIssues(repo, request = ghJson) {
  const items = [];
  for (let page = 1; page <= 10; page++) {
    const batch = request([
      `repos/${repo}/issues?labels=${encodeURIComponent(LABEL)}&state=open&per_page=100&page=${page}`,
    ]);
    if (!Array.isArray(batch) || batch.length === 0) break;
    items.push(...batch);
    if (batch.length < 100) break;
  }
  return items.filter((item) => item.pull_request && Number.isInteger(item.number));
}

export function appendSummary(line, env = process.env) {
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${line}\n`);
  console.log(line);
}

export async function postRoom(line, env = process.env, fetchImpl = fetch) {
  appendSummary(line, env);
  const token = env.ROOM_RECEIPT_TOKEN || "";
  if (!token) {
    appendSummary("ROOM_RECEIPT_TOKEN not set; no Room receipt posted.", env);
    return false;
  }
  const origin = env.PROD_ORIGIN || "https://room.trydemigod.com";
  const room = env.RECEIPT_ROOM || "room-fafdae79cf8c";
  const command = {
    id: crypto.randomUUID(),
    type: "message.posted",
    data: { messageId: crypto.randomUUID(), body: line },
  };
  const response = await fetchImpl(`${origin}/api/rooms/${room}/commands`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      origin,
      "user-agent":
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 project-room-autoland",
    },
    body: JSON.stringify(command),
  });
  if (!response.ok) {
    appendSummary(`Room receipt failed: HTTP ${response.status}`, env);
    return false;
  }
  return true;
}

export function schemaGateGreen(repo, sha, request = ghJson) {
  const data = request([`repos/${repo}/actions/runs?head_sha=${sha}&event=push&per_page=100`]);
  const runs = (data?.workflow_runs || [])
    .filter((run) => run.name === "schema-gate")
    .sort((a, b) => Date.parse(a.created_at || 0) - Date.parse(b.created_at || 0));
  const last = runs.at(-1);
  return last && last.conclusion === "success";
}

export function dispatchDeployProd(repo, sha, reason, run = spawnSync, token) {
  const auth = token || tokenOf();
  const result = run(
    "gh",
    ["workflow", "run", "deploy-prod.yml", "--repo", repo, "--ref", "main", "-f", `sha=${sha}`, "-f", `reason=${reason}`],
    { encoding: "utf8", env: { ...process.env, GH_TOKEN: auth, GITHUB_TOKEN: auth } },
  );
  if (result.status !== 0) {
    throw new Error(`failed to dispatch deploy-prod: ${(result.stderr || result.stdout || "").trim()}`);
  }
}

function createLabelBody() {
  return JSON.stringify({
    name: LABEL,
    color: "0E8A16",
    description: "Opt-in: squash-merge when the head is green and CLEAN, then reuse deploy-prod",
  });
}

export function createLabel(repo, request = ghJson) {
  try {
    request([`repos/${repo}/labels/${encodeURIComponent(LABEL)}`]);
    return false;
  } catch {
    request(["--method", "POST", `repos/${repo}/labels`, "--input", "-"], { input: createLabelBody() });
    return true;
  }
}

function loadPr(repo, number, request) {
  return request([`repos/${repo}/pulls/${number}`]);
}

export async function autoland({
  repo,
  token,
  dryRun = false,
  request,
  dispatch = dispatchDeployProd,
  room = postRoom,
  env = process.env,
} = {}) {
  const auth = token || tokenOf(env);
  if (!auth) {
    appendSummary(
      "LANDING_TOKEN unset; refusing to merge. GITHUB_TOKEN merges do not start test, schema-gate, or deploy-prod. Add a user or GitHub App installation token as the LANDING_TOKEN Actions secret (contents, pull requests, and workflow dispatch).",
      env,
    );
    return { merged: [], skipped: [], dispatched: false, missing: ["LANDING_TOKEN"] };
  }
  const api = request || ((args, options) => ghJson(args, { token: auth, ...options }));
  createLabel(repo, api);

  const issues = listOpenLabeledIssues(repo, api);
  const merged = [];
  const skipped = [];
  for (const issue of issues.sort((a, b) => a.number - b.number)) {
    const pr = loadPr(repo, issue.number, api);
    const sha = pr.head?.sha;
    if (!SHA.test(sha || "")) {
      skipped.push({ number: issue.number, reason: "head sha missing" });
      continue;
    }
    const evaluation = evaluateHeadChecks(paginatedCheckRuns(repo, sha, api), paginatedStatuses(repo, sha, api));
    const eligibility = isEligiblePr(pr, evaluation);
    if (!eligibility.ok) {
      skipped.push({ number: pr.number, reason: eligibility.reason, sha });
      appendSummary(`#${pr.number} not ready: ${eligibility.reason}`, env);
      continue;
    }
    if (dryRun) {
      skipped.push({ number: pr.number, reason: "dry-run", sha, eligible: true });
      appendSummary(`dry-run: would squash-merge #${pr.number} at ${sha.slice(0, 8)}`, env);
      continue;
    }
    // Re-read immediately before merge so a just-landed neighbor cannot
    // leave this PR dirty while we still think it is CLEAN.
    const fresh = loadPr(repo, pr.number, api);
    const freshEval = evaluateHeadChecks(
      paginatedCheckRuns(repo, fresh.head.sha, api),
      paginatedStatuses(repo, fresh.head.sha, api),
    );
    const freshEligibility = isEligiblePr(fresh, freshEval);
    if (!freshEligibility.ok || fresh.head.sha !== sha) {
      skipped.push({ number: pr.number, reason: freshEligibility.ok ? "head moved" : freshEligibility.reason, sha });
      appendSummary(`#${pr.number} skipped at merge time: ${freshEligibility.ok ? "head moved" : freshEligibility.reason}`, env);
      continue;
    }
    api(
      ["--method", "PUT", `repos/${repo}/pulls/${pr.number}/merge`, "--input", "-"],
      {
        input: JSON.stringify({
          merge_method: "squash",
          sha,
          commit_title: squashTitle(pr),
          commit_message: mergeMessage(pr, sha),
        }),
      },
    );
    merged.push({ number: pr.number, sha, title: pr.title });
    await room(`AUTOLAND MERGE · #${pr.number} ${pr.title} · ${sha.slice(0, 8)} · https://github.com/${repo}/pull/${pr.number}`, env);
  }

  let dispatched = false;
  if (!dryRun && merged.length) {
    const tip = api([`repos/${repo}/commits/main`]).sha;
    const reason = `autoland after ${merged.map((row) => `#${row.number}`).join(", ")}`;
    if (SHA.test(tip || "") && schemaGateGreen(repo, tip, api)) {
      dispatch(repo, tip, reason, spawnSync, auth);
      dispatched = true;
      await room(`AUTOLAND DEPLOY · dispatched deploy-prod for ${tip.slice(0, 8)} · ${reason}`, env);
    } else {
      await room(
        `AUTOLAND DEPLOY · waiting for schema-gate on ${(tip || "main").slice(0, 8)}; squash titles use ${SQUASH_PREFIX} so deploy-prod's existing workflow_run hook will start it (smoke and rollback already live there)`,
        env,
      );
    }
  }

  const missing = [];
  if (!env.ROOM_RECEIPT_TOKEN) missing.push("ROOM_RECEIPT_TOKEN");
  appendSummary(
    `autoland: merged ${merged.length}, skipped ${skipped.length}, deploy dispatched=${dispatched}${missing.length ? `, missing ${missing.join(", ")}` : ""}`,
    env,
  );
  return { merged, skipped, dispatched, missing };
}

const invokedAsScript =
  process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href;
if (invokedAsScript) {
  const dryRun = process.argv.includes("--dry-run") || process.env.DRY_RUN === "1";
  const repo = process.env.GITHUB_REPOSITORY || "Uuriko/project-room";
  autoland({ repo, dryRun }).catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}
