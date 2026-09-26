// Read-only, bounded release observations. This is not deployment or health proof.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const run = promisify(execFile);
const SHA = /^[a-f0-9]{40}$/i;
const DEFAULT_ORIGINS = ["https://room.trydemigod.com", "https://www.getdasha.com/room"];
const TIMEOUT_MS = 10000;
const MAX_BYTES = 256 * 1024;
const safeText = (value, limit = 160) => typeof value === "string" ? value.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, limit) : null;
const sha = value => typeof value === "string" && SHA.test(value) ? value.toLowerCase() : null;

function evidenceUrl(value) {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash ? url.href : null;
  } catch { return null; }
}

function checkObservation(row) {
  let status = "unknown";
  if (row?.__typename === "CheckRun") {
    if (["QUEUED", "IN_PROGRESS", "WAITING", "PENDING", "REQUESTED"].includes(row.status)) status = "incomplete";
    else if (row.status === "COMPLETED") {
      if (row.conclusion === "SUCCESS") status = "passed";
      else if (["NEUTRAL", "SKIPPED"].includes(row.conclusion)) status = "not_run";
      else if (["FAILURE", "TIMED_OUT", "ACTION_REQUIRED", "CANCELLED", "STARTUP_FAILURE"].includes(row.conclusion)) status = "failed";
    }
  } else if (row?.__typename === "StatusContext") {
    status = ({ SUCCESS: "passed", FAILURE: "failed", ERROR: "failed", PENDING: "incomplete", EXPECTED: "incomplete" })[row.state] ?? "unknown";
  }
  return { name: safeText(row?.name ?? row?.context) ?? "Unnamed check", workflow: safeText(row?.workflowName), status,
    conclusion: safeText(row?.conclusion ?? row?.state), completedAt: safeText(row?.completedAt),
    detailsUrl: evidenceUrl(row?.detailsUrl ?? row?.targetUrl) };
}

// Pure reduction used by the CLI: input snapshots are observations, never authority.
export function summarizeCheckpoint({ checkedAt, repository, prNumber, expectedRevision = null, before, checks, after, doors }) {
  const initial = before?.value, latest = after?.value;
  const head = sha(initial?.headRefOid), finalHead = sha(latest?.headRefOid), checkHead = sha(checks?.value?.headRefOid);
  const base = sha(initial?.baseRefOid), finalBase = sha(latest?.baseRefOid);
  const rows = Array.isArray(checks?.value?.statusCheckRollup) ? checks.value.statusCheckRollup.map(checkObservation) : [];
  let state = "unknown", reason = "observation_failed";
  if (head && finalHead && base && finalBase && !before.error && !after.error) {
    if (head !== finalHead) reason = "head_changed";
    else if (base !== finalBase || initial.baseRefName !== latest.baseRefName) reason = "base_changed";
    else if (checkHead !== head) reason = "checks_not_for_head";
    else if (checks.error || !Array.isArray(checks.value.statusCheckRollup)) reason = "checks_unavailable";
    else if (!rows.length) { state = "incomplete"; reason = "no_checks"; }
    else if (rows.some(row => row.status === "failed")) { state = "failed"; reason = "check_failed"; }
    else if (rows.some(row => row.status === "unknown")) reason = "check_status_unknown";
    else if (rows.some(row => row.status === "incomplete")) { state = "incomplete"; reason = "checks_pending"; }
    else if (rows.every(row => row.status === "not_run")) { state = "incomplete"; reason = "no_passing_checks"; }
    else if (rows.some(row => row.status === "not_run")) { state = "passed_with_skips"; reason = "some_checks_not_run"; }
    else { state = "passed"; reason = "observed_checks_completed"; }
  }
  const expected = sha(expectedRevision);
  const doorViews = (doors ?? []).map(door => {
    const sourceRevision = sha(door.value?.sourceRevision);
    return { origin: door.origin, checkedAt: door.checkedAt, httpStatus: door.httpStatus ?? null,
      reachable: door.httpStatus === 200, sourceRevision, buildId: safeText(door.value?.buildId, 128),
      error: door.error ?? null,
      revisionMatch: !expected ? "not_requested" : !sourceRevision || door.error || door.httpStatus !== 200 ? "unknown"
        : sourceRevision === expected ? "match" : "mismatch" };
  });
  return {
    schemaVersion: 1, checkedAt, repository, expectedRevision: expected,
    pullRequest: { number: prNumber, url: `https://github.com/${repository}/pull/${prNumber}`,
      state: safeText(latest?.state ?? initial?.state), headRevision: head, finalHeadRevision: finalHead,
      baseBranch: safeText(latest?.baseRefName ?? initial?.baseRefName), baseRevision: base, finalBaseRevision: finalBase,
      mergeStateStatus: safeText(latest?.mergeStateStatus ?? initial?.mergeStateStatus),
      observations: { before: before?.checkedAt ?? null, checks: checks?.checkedAt ?? null, after: after?.checkedAt ?? null },
      errors: [before?.error, checks?.error, after?.error].filter(Boolean),
      checks: { state, reason, revision: checkHead, requiredChecksEvaluated: false, integrationBaseVerified: false, rows } },
    doors: doorViews,
    authenticatedProbe: "not_performed",
    limitations: ["Passed means the observed check rollup succeeded for an unchanged head across PR snapshots. Required branch rules were not evaluated.",
      "PR-reported base metadata was observed; check runs were not bound to a tested base or merge revision. The current base branch tip and merge readiness are not verified.",
      "HTTP 200 means public version endpoint reachability only. No authenticated room access, deployment, or application health is verified.",
      "Source revision is reported metadata, not a bundle digest. Use scripts/release-evidence.mjs for digest-based evidence."]
  };
}

const markdownText = value => String(value ?? "unknown").replace(/[\\`*_{}\[\]<>()#|]/g, "\\$&").replace(/\r?\n/g, " ");
export function checkpointMarkdown(report) {
  const pr = report.pullRequest;
  const lines = ["# Release checkpoint", "", `Checked at: ${markdownText(report.checkedAt)}`, "",
    `PR: ${pr.url}`, `Head: ${pr.headRevision ?? "unknown"}`, `Head after check collection: ${pr.finalHeadRevision ?? "unknown"}`,
    `PR-reported base: ${markdownText(pr.baseBranch)} (${pr.finalBaseRevision ?? "unknown"})`,
    `GitHub merge state: ${markdownText(pr.mergeStateStatus)} (not independently verified)`,
    `Observed checks: **${pr.checks.state}** (${pr.checks.reason})`, ""];
  for (const row of pr.checks.rows) lines.push(`- ${markdownText(row.workflow ? `${row.workflow} / ${row.name}` : row.name)}: ${row.status}${row.conclusion ? ` (${markdownText(row.conclusion)})` : ""}${row.detailsUrl ? ` — [check details](<${row.detailsUrl}>)` : ""}`);
  if (pr.errors.length) lines.push("", `Collection errors: ${pr.errors.map(markdownText).join(", ")}`);
  lines.push("", "## Public version endpoints", "", `Expected source revision: ${report.expectedRevision ?? "not supplied"}`, "");
  for (const door of report.doors) {
    lines.push(`- ${markdownText(door.origin)} — HTTP ${door.httpStatus ?? "unknown"}; source ${door.sourceRevision ?? "unknown"}; build ${markdownText(door.buildId)}; expected revision: ${door.revisionMatch}. Checked ${markdownText(door.checkedAt)}${door.error ? `; ${door.error}` : ""}.`);
  }
  lines.push("", "## Limits", "", ...report.limitations.map(text => `- ${text}`), "");
  return lines.join("\n");
}

async function ghSnapshot(repository, prNumber, fields) {
  try {
    const { stdout } = await run("gh", ["pr", "view", String(prNumber), "--repo", repository, "--json", fields],
      { timeout: TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: 2 * 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: "1" } });
    return { checkedAt: new Date().toISOString(), value: JSON.parse(stdout) };
  } catch (error) {
    return { checkedAt: new Date().toISOString(), error: error.killed ? "github_timeout" : error instanceof SyntaxError ? "github_invalid_json" : "github_unavailable" };
  }
}

async function versionProbe(origin) {
  const observation = { origin, checkedAt: new Date().toISOString(), httpStatus: null };
  try {
    const response = await fetch(`${origin}/api/version`, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "manual",
      headers: { Accept: "application/json" } });
    observation.httpStatus = response.status;
    if (response.status !== 200) { await response.body?.cancel(); return { ...observation, error: "http_error" }; }
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > MAX_BYTES) return { ...observation, error: "response_too_large" };
      chunks.push(chunk);
    }
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return { ...observation, error: "invalid_version_response" };
    return { ...observation, value };
  } catch (error) {
    return { ...observation, error: ["TimeoutError", "AbortError"].includes(error.name) ? "request_timeout" : error instanceof SyntaxError ? "invalid_json" : "request_failed" };
  }
}

function options(argv) {
  const result = { repository: "Uuriko/project-room", origins: [], format: "json" };
  const names = { "--pr": "prNumber", "--repo": "repository", "--expected-revision": "expectedRevision", "--origin": "origin", "--output": "output", "--format": "format" };
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i], key = names[flag], value = argv[++i];
    if (!key || !value || value.startsWith("--") || (seen.has(flag) && flag !== "--origin")) throw new Error("invalid_arguments");
    seen.add(flag);
    if (key === "origin") result.origins.push(value);
    else result[key] = value;
  }
  if (!/^[1-9]\d*$/.test(result.prNumber ?? "") || !Number.isSafeInteger(Number(result.prNumber))) throw new Error("invalid_pr");
  result.prNumber = Number(result.prNumber);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(result.repository)) throw new Error("invalid_repository");
  if (result.expectedRevision !== undefined && !sha(result.expectedRevision)) throw new Error("expected_revision_must_be_full_sha");
  if (!["json", "markdown"].includes(result.format)) throw new Error("invalid_format");
  if (!result.origins.length) result.origins = DEFAULT_ORIGINS;
  if (result.origins.length > 8) throw new Error("too_many_origins");
  result.origins = [...new Set(result.origins.map(origin => {
    const url = new URL(origin);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("invalid_origin");
    return url.href.replace(/\/$/, "");
  }))];
  return result;
}

const HELP = "Usage: node scripts/release-checkpoint.mjs --pr NUMBER [--repo OWNER/REPO] [--expected-revision FULL_SHA] [--origin HTTPS_ORIGIN[/PREFIX]] [--format json|markdown] [--output DIRECTORY]\nRead-only public observations. --origin repeats (max 8); defaults to canonical Room and getdasha/room. --output writes release-checkpoint.json and release-checkpoint.md. No output option writes only stdout. Exit 0 means collection complete, not ready to merge/deploy; exit 1 means incomplete observation; exit 2 means invalid arguments or output failure.";

async function main(argv) {
  if (argv.length === 1 && argv[0] === "--help") { console.log(HELP); return; }
  let args;
  try { args = options(argv); } catch { console.error(HELP); process.exitCode = 2; return; }
  const metadata = "number,headRefOid,baseRefName,baseRefOid,state,mergeStateStatus";
  const collectPR = async () => {
    const before = await ghSnapshot(args.repository, args.prNumber, metadata);
    const checks = await ghSnapshot(args.repository, args.prNumber, "headRefOid,statusCheckRollup");
    const after = await ghSnapshot(args.repository, args.prNumber, metadata);
    return { before, checks, after };
  };
  const [pr, doors] = await Promise.all([collectPR(), Promise.all(args.origins.map(versionProbe))]);
  const report = summarizeCheckpoint({ ...args, ...pr, doors, checkedAt: new Date().toISOString() });
  const json = JSON.stringify(report, null, 2) + "\n", markdown = checkpointMarkdown(report);
  if (args.output) {
    try {
      const directory = resolve(args.output);
      await mkdir(directory, { recursive: true });
      await writeFile(resolve(directory, "release-checkpoint.json"), json, { mode: 0o600 });
      await writeFile(resolve(directory, "release-checkpoint.md"), markdown, { mode: 0o600 });
    } catch { console.error("Could not write checkpoint output."); process.exitCode = 2; return; }
  } else process.stdout.write(args.format === "markdown" ? markdown : json);
  if (report.pullRequest.errors.length || report.pullRequest.checks.state === "unknown" || report.doors.some(door => door.error)) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main(process.argv.slice(2));
