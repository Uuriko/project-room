// Read-only, bounded release observations. This is not deployment or health proof.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createHash } from "node:crypto";

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

function validVersion(value) {
  return value?.status === "ok" && Boolean(sha(value.sourceRevision));
}

function candidateFor(metadata) {
  return metadata?.state === "MERGED" ? sha(metadata.mergeCommit?.oid) : sha(metadata?.headRefOid);
}

// Compare BASE=candidate to HEAD=observed revision. Commit lists may be paginated;
// only the pinned comparison metadata establishes ancestry.
function containment(observation, candidate, target, stable) {
  if (!stable || !candidate || !target || observation?.error || observation?.base !== candidate || observation?.head !== target) return "unknown";
  const value = observation.value;
  if (sha(value?.base_commit?.sha) !== candidate || !sha(value?.merge_base_commit?.sha)) return "unknown";
  if (["ahead", "identical"].includes(value.status) && sha(value.merge_base_commit.sha) === candidate) return "contains";
  if (["behind", "diverged"].includes(value.status) && sha(value.merge_base_commit.sha) !== candidate) return "does_not_contain";
  return "unknown";
}

// Pure reduction used by the CLI: input snapshots are observations, never authority.
export function summarizeCheckpoint({ checkedAt, repository, prNumber, expectedRevision = null, before, checks, after, doors, mainBefore, mainAfter, comparisons = [], workers = [] }) {
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
  const candidate = candidateFor(latest);
  const prStable = !before?.error && !after?.error && head && head === finalHead
    && base && base === finalBase && initial?.baseRefName === latest?.baseRefName
    && initial?.state === latest?.state && candidate && candidateFor(initial) === candidate;
  const main = sha(mainBefore?.value?.object?.sha), finalMain = sha(mainAfter?.value?.object?.sha);
  const mainStable = Boolean(main && main === finalMain && !mainBefore?.error && !mainAfter?.error);
  const comparisonFor = target => comparisons.find(row => row.base === candidate && row.head === target);
  const currentMain = { revision: main, finalRevision: finalMain,
    state: mainStable ? "stable" : "unknown",
    reason: !main || !finalMain || mainBefore?.error || mainAfter?.error ? "observation_failed" : main !== finalMain ? "main_changed" : "observed_unchanged",
    observations: { before: mainBefore?.checkedAt ?? null, after: mainAfter?.checkedAt ?? null },
    candidateContainment: containment(comparisonFor(main), candidate, main, prStable && mainStable) };

  const publicView = (door, worker = false) => {
    const valid = door.httpStatus === 200 && !door.error && validVersion(door.value) && (!worker || door.value.servedBy === "worker");
    const sourceRevision = valid ? sha(door.value.sourceRevision) : null;
    return { origin: door.origin, endpoint: worker ? "/api/version/worker" : "/api/version", checkedAt: door.checkedAt, httpStatus: door.httpStatus ?? null,
      reachable: door.httpStatus === 200, sourceRevision, buildId: safeText(door.value?.buildId, 128),
      error: door.error ?? (door.httpStatus === 200 && !valid ? "invalid_version_response" : null),
      candidateContainment: containment(comparisonFor(sourceRevision), candidate, sourceRevision, prStable && mainStable && valid),
      ...(worker ? { reportedDurableObject: valid ? { name: safeText(door.value.durableObject?.name), id: safeText(door.value.durableObject?.id) } : null } : {}),
      revisionMatch: !expected ? "not_requested" : !sourceRevision || door.error || door.httpStatus !== 200 ? "unknown"
        : sourceRevision === expected ? "match" : "mismatch" };
  };
  const doorViews = (doors ?? []).map(door => publicView(door));
  const workerViews = workers.map(door => publicView(door, true));
  return {
    schemaVersion: 2, checkedAt, repository, expectedRevision: expected,
    currentMain, candidate: { revision: candidate, kind: latest?.state === "MERGED" ? "merge_commit" : "pr_head", stable: Boolean(prStable) },
    pullRequest: { number: prNumber, url: `https://github.com/${repository}/pull/${prNumber}`,
      mergeRevision: sha(latest?.mergeCommit?.oid), state: safeText(latest?.state ?? initial?.state), headRevision: head, finalHeadRevision: finalHead,
      baseBranch: safeText(latest?.baseRefName ?? initial?.baseRefName), baseRevision: base, finalBaseRevision: finalBase,
      mergeStateStatus: safeText(latest?.mergeStateStatus ?? initial?.mergeStateStatus),
      observations: { before: before?.checkedAt ?? null, checks: checks?.checkedAt ?? null, after: after?.checkedAt ?? null },
      errors: [before?.error, checks?.error, after?.error].filter(Boolean),
      checks: { state, reason, revision: checkHead, requiredChecksEvaluated: false, integrationBaseVerified: false, rows } },
    doors: doorViews, workers: workerViews,
    authenticatedProbe: "not_performed",
    limitations: ["Merged describes GitHub state, not deployment. Containment is Git ancestry of a reported revision, not verification of deployed bytes or retained behavior.",
      "Both public version URLs may share a backend. Their agreement does not establish independent Worker versions or Worker/Durable Object equality.","Passed means the observed check rollup succeeded for an unchanged head across PR snapshots. Required branch rules were not evaluated.",
      "PR-reported base metadata was observed; check runs were not bound to a tested base or merge revision. Main was separately observed; the PR tested integration base and merge readiness remain unverified.",
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
    `Observed checks: **${pr.checks.state}** (${pr.checks.reason})`,
    `PR state: ${markdownText(pr.state)}; merge revision: ${pr.mergeRevision ?? "unknown"}`,
    `Current main: ${report.currentMain.finalRevision ?? "unknown"} (${report.currentMain.reason}); candidate containment: ${report.currentMain.candidateContainment}`,
    `Candidate: ${report.candidate.revision ?? "unknown"} (${report.candidate.kind}); deployment is not verified.`, ""];
  for (const row of pr.checks.rows) lines.push(`- ${markdownText(row.workflow ? `${row.workflow} / ${row.name}` : row.name)}: ${row.status}${row.conclusion ? ` (${markdownText(row.conclusion)})` : ""}${row.detailsUrl ? ` — [check details](<${row.detailsUrl}>)` : ""}`);
  if (pr.errors.length) lines.push("", `Collection errors: ${pr.errors.map(markdownText).join(", ")}`);
  lines.push("", "## Public version endpoints", "", `Expected source revision: ${report.expectedRevision ?? "not supplied"}`, "");
  for (const door of report.doors) {
    lines.push(`- ${markdownText(door.origin)} — HTTP ${door.httpStatus ?? "unknown"}; source ${door.sourceRevision ?? "unknown"}; build ${markdownText(door.buildId)}; expected revision: ${door.revisionMatch}; candidate ancestry: ${door.candidateContainment}. Checked ${markdownText(door.checkedAt)}${door.error ? `; ${door.error}` : ""}.`);
  }
  lines.push("", "## Independent Worker diagnostics", "");
  for (const worker of report.workers) lines.push(`- ${markdownText(worker.origin)}${worker.endpoint} — HTTP ${worker.httpStatus ?? "unknown"}; Worker source ${worker.sourceRevision ?? "unknown"}; candidate ancestry: ${worker.candidateContainment}; reported object name ${markdownText(worker.reportedDurableObject?.name)}, id ${markdownText(worker.reportedDurableObject?.id)}${worker.error ? `; ${worker.error}` : ""}.`);
  lines.push("", "## Limits", "", ...report.limitations.map(text => `- ${text}`), "");
  return lines.join("\n");
}

async function ghRead(args) {
  try {
    const { stdout } = await run("gh", args,
      { timeout: TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: 2 * 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: "1" } });
    return { checkedAt: new Date().toISOString(), value: JSON.parse(stdout) };
  } catch (error) {
    return { checkedAt: new Date().toISOString(), error: error.killed ? "github_timeout" : error instanceof SyntaxError ? "github_invalid_json" : "github_unavailable" };
  }
}

const ghSnapshot = (repository, prNumber, fields) => ghRead(["pr", "view", String(prNumber), "--repo", repository, "--json", fields]);
const mainSnapshot = repository => ghRead(["api", `repos/${repository}/git/ref/heads/main`]);
async function compareSnapshot(repository, base, head) {
  return { ...await ghRead(["api", `repos/${repository}/compare/${base}...${head}?per_page=1`]), base, head };
}

async function versionProbe(origin, worker = false) {
  const observation = { origin, checkedAt: new Date().toISOString(), httpStatus: null };
  try {
    const response = await fetch(`${origin}/api/version${worker ? "/worker" : ""}`, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "manual",
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
    if (!validVersion(value) || (worker && value.servedBy !== "worker")) return { ...observation, error: "invalid_version_response" };
    return { ...observation, value };
  } catch (error) {
    return { ...observation, error: ["TimeoutError", "AbortError"].includes(error.name) ? "request_timeout" : error instanceof SyntaxError ? "invalid_json" : "request_failed" };
  }
}

async function sourceBinding(cwd) {
  const git = async args => (await run('git', args, { cwd, timeout: 10000, maxBuffer: MAX_BYTES })).stdout.trim();
  return { revision: await git(['rev-parse', 'HEAD']), tree: await git(['rev-parse', 'HEAD^{tree}']),
    clean: (await git(['status', '--porcelain', '--untracked-files=normal'])) === '' };
}

async function smokeProcess(kind, { source, expectedRevision, origins }) {
  const env = { ...process.env };
  // Keep production signature/count defaults; no inherited test seams or summary writes.
  for (const key of Object.keys(env)) if (key.startsWith('SMOKE_') || key.startsWith('ROOM_SMOKE_') || key === 'GITHUB_STEP_SUMMARY') delete env[key];
  const args = kind === 'strict'
    ? [resolve(source, 'scripts/prod-deploy-smoke.mjs'), '--sha', expectedRevision, '--origin', origins[0], '--entry', origins[1], '--wait-ms', '0']
    : [resolve(source, 'scripts/live-smoke.mjs')];
  if (kind === 'live') env.ROOM_SMOKE_ORIGIN = origins[0];
  let stdout, exitCode;
  try { const result = await run(process.execPath, args, { cwd: source, env, timeout: 300000, maxBuffer: 2 * 1024 * 1024 }); stdout = result.stdout; exitCode = 0; }
  catch (error) { stdout = error.stdout; exitCode = Number.isInteger(error.code) ? error.code : null; }
  // Never persist raw child stderr or command/environment dumps.
  try { return { exitCode, report: JSON.parse(stdout) }; }
  catch { return { exitCode, error: 'invalid_or_missing_report' }; }
}

function expectedSmokeNames(origins) {
  return origins.flatMap(origin => [
    ...['/api/version', '/api/version/worker'].map(path => `version ${origin}${path}`),
    `health ${origin}/api/health`, `ready ${origin}/api/ready`,
    ...['/terms', '/privacy', '/'].map(path => `page ${origin}${path}`),
    `agent-card ${origin}/.well-known/agent-card.json`
  ]);
}

export function verificationPolicy(strict, live, { expectedRevision, origins }) {
  const names = expectedSmokeNames(origins), s = strict?.report, l = live?.report;
  const strictPassed = strict?.exitCode === 0 && s?.ok === true && s.sha === expectedRevision
    && s.origin === origins[0] && s.entry === origins[1] && Array.isArray(s.checks)
    && s.checks.length === names.length && new Set(s.checks.map(c => c?.name)).size === names.length
    && s.checks.every(c => names.includes(c.name) && c.pass === true);
  const validLive = [0, 1].includes(live?.exitCode) && l?.origin === origins[0] && l.liveRevision === expectedRevision
    && typeof l.ok === 'boolean' && Array.isArray(l.findings)
    && l.findings.every(f => typeof f?.code === 'string' && ['warn', 'fail'].includes(f.severity))
    && l.ok === !l.findings.some(f => f.severity === 'fail') && live.exitCode === (l.ok ? 0 : 1);
  const advisory = new Set(['deploy_lag', 'deploy_diverged']);
  return { strictPassed, livePassed: Boolean(validLive && !l.findings.some(f => f.severity === 'fail' && !advisory.has(f.code))),
    warnings: validLive ? l.findings.filter(f => f.severity === 'warn' || advisory.has(f.code)) : [],
    policy: 'Explicit deployed target: main lag/divergence advisory only; original reports and exit codes unchanged.' };
}

// Rerunning verifies everything afresh into a new attempt, never overwriting a
// failed deployment or claiming that before/after observations are an atomic lock.
export async function verifyCheckpoint(args, dependencies = {}) {
  const source = dependencies.source ?? process.cwd();
  const tooling = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const bind = dependencies.sourceBinding ?? sourceBinding;
  const probe = dependencies.versionProbe ?? versionProbe;
  const execute = dependencies.smokeProcess ?? smokeProcess;
  await mkdir(resolve(args.output), { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(resolve(args.output, 'verify-'));
  const save = (name, value) => writeFile(resolve(directory, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  const report = { schemaVersion: 1, mode: 'verify-only', expectedRevision: args.expectedRevision,
    origins: args.origins, startedAt: new Date().toISOString(), state: 'incomplete', directory,
    publicationPerformed: false, authenticatedProbe: 'not_performed',
    limitations: ['Point-in-time public verification; before/after checks do not exclude an intervening deployment or later change.',
      'No authenticated or browser journey is implied. Publication remains a separate action with fresh source checks.'] };
  await save('receipt.json', report);
  const matching = rows => rows.length === 4 && rows.every(row => !row.error && row.httpStatus === 200 && row.value?.sourceRevision === args.expectedRevision);
  const doors = () => Promise.all(args.origins.flatMap(origin => [probe(origin, false), probe(origin, true)]));
  let startedChecks = false;
  try {
    if (!/^[a-f0-9]{40}$/.test(args.expectedRevision ?? '') || args.origins.length !== 2) throw new Error('invalid_verification_target');
    report.sourceBefore = await bind(source);
    report.toolingBefore = await bind(tooling);
    if (!report.sourceBefore.clean || report.sourceBefore.revision !== args.expectedRevision || !report.toolingBefore.clean) throw new Error('source_not_pinned_clean');
    if (args.priorReport) {
      const raw = await readFile(args.priorReport);
      if (raw.length > 1000000) throw new Error('prior_report_too_large');
      let prior;
      try { prior = JSON.parse(raw.toString('utf8')); } catch { throw new Error('invalid_prior_report'); }
      if (prior?.ok !== false || prior.sha !== args.expectedRevision || prior.origin !== args.origins[0] || prior.entry !== args.origins[1]
          || !Array.isArray(prior.checks) || !prior.checks.some(c => c.pass === false)) throw new Error('prior_failure_not_for_target');
      await writeFile(resolve(directory, 'original-failure.json'), raw, { mode: 0o600, flag: 'wx' });
      report.originalFailure = { file: 'original-failure.json', sha256: createHash('sha256').update(raw).digest('hex'), bytes: raw.length };
    }
    report.before = await doors();
    if (!matching(report.before)) throw new Error('live_revision_mismatch_before');
    startedChecks = true;
    report.strict = await execute('strict', { source, ...args });
    await save('strict-smoke.json', report.strict);
    report.live = await execute('live', { source, ...args });
    await save('live-smoke.json', report.live);
    report.evaluation = verificationPolicy(report.strict, report.live, args);
  } catch (error) {
    const known = ['invalid_verification_target', 'source_not_pinned_clean', 'prior_report_too_large', 'invalid_prior_report', 'prior_failure_not_for_target', 'live_revision_mismatch_before'];
    report.error = known.includes(error.message) ? error.message : 'verification_observation_failed';
  } finally {
    if (startedChecks) {
      try {
        report.after = await doors();
        report.sourceAfter = await bind(source); report.toolingAfter = await bind(tooling);
        report.stable = matching(report.after) && JSON.stringify(report.sourceBefore) === JSON.stringify(report.sourceAfter)
          && JSON.stringify(report.toolingBefore) === JSON.stringify(report.toolingAfter);
      } catch { report.stable = false; }
    }
    report.state = !report.error && report.stable && report.evaluation?.strictPassed && report.evaluation?.livePassed ? 'verified' : 'failed';
    report.completedAt = new Date().toISOString();
    await save('receipt.json', report);
  }
  return report;
}

function options(argv) {
  const result = { repository: "Uuriko/project-room", origins: [], format: "json", mode: "observe" };
  const names = { "--mode": "mode", "--prior-report": "priorReport", "--pr": "prNumber", "--repo": "repository", "--expected-revision": "expectedRevision", "--origin": "origin", "--output": "output", "--format": "format" };
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i], key = names[flag], value = argv[++i];
    if (!key || !value || value.startsWith("--") || (seen.has(flag) && flag !== "--origin")) throw new Error("invalid_arguments");
    seen.add(flag);
    if (key === "origin") result.origins.push(value);
    else result[key] = value;
  }
  if (!["observe", "verify"].includes(result.mode)) throw new Error("invalid_mode");
  if (result.mode === "verify" && (!sha(result.expectedRevision) || !result.output)) throw new Error("verification_requires_revision_and_output");
  if (result.mode === "observe" && (!/^[1-9]\d*$/.test(result.prNumber ?? "") || !Number.isSafeInteger(Number(result.prNumber)))) throw new Error("invalid_pr");
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
  if (result.mode === "verify" && result.origins.length !== 2) throw new Error("verification_requires_two_origins");
  return result;
}

const HELP = "Usage: node scripts/release-checkpoint.mjs --pr NUMBER [--repo OWNER/REPO] [--expected-revision FULL_SHA] [--origin HTTPS_ORIGIN[/PREFIX]] [--format json|markdown] [--output DIRECTORY]\nVerification: --mode verify --expected-revision FULL_SHA --output DIRECTORY [--prior-report FAILED_SMOKE_JSON], from a clean target checkout; the tooling checkout must also be clean. No upload or publication. Read-only public observations. --origin repeats (max 8); defaults to canonical Room and getdasha/room. --output writes release-checkpoint.json and release-checkpoint.md. No output option writes only stdout. In verify mode exit 0 means this attempt verified; in observe mode exit 0 means collection complete, not ready to merge/deploy; exit 1 means incomplete observation; exit 2 means invalid arguments or output failure.";

async function main(argv) {
  if (argv.length === 1 && argv[0] === "--help") { console.log(HELP); return; }
  let args;
  try { args = options(argv); } catch { console.error(HELP); process.exitCode = 2; return; }
  if (args.mode === "verify") {
    const report = await verifyCheckpoint(args);
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    if (report.state !== "verified") process.exitCode = 1;
    return;
  }
  const metadata = "number,headRefOid,baseRefName,baseRefOid,state,mergeStateStatus,mergeCommit";
  const collectPR = async () => {
    const before = await ghSnapshot(args.repository, args.prNumber, metadata);
    const checks = await ghSnapshot(args.repository, args.prNumber, "headRefOid,statusCheckRollup");
    const after = await ghSnapshot(args.repository, args.prNumber, metadata);
    return { before, checks, after };
  };
  const [pr, doors, workers, mainBefore] = await Promise.all([collectPR(),
    Promise.all(args.origins.map(origin => versionProbe(origin))),
    Promise.all(args.origins.map(origin => versionProbe(origin, true))), mainSnapshot(args.repository)]);
  const candidate = candidateFor(pr.after.value);
  const targets = [...new Set([sha(mainBefore.value?.object?.sha), ...[...doors, ...workers].filter(door => !door.error && validVersion(door.value)).map(door => sha(door.value.sourceRevision))].filter(Boolean))];
  const comparisons = candidate ? await Promise.all(targets.map(target => compareSnapshot(args.repository, candidate, target))) : [];
  const mainAfter = await mainSnapshot(args.repository);
  const report = summarizeCheckpoint({ ...args, ...pr, doors, workers, mainBefore, mainAfter, comparisons, checkedAt: new Date().toISOString() });
  const json = JSON.stringify(report, null, 2) + "\n", markdown = checkpointMarkdown(report);
  if (args.output) {
    try {
      const directory = resolve(args.output);
      await mkdir(directory, { recursive: true });
      await writeFile(resolve(directory, "release-checkpoint.json"), json, { mode: 0o600 });
      await writeFile(resolve(directory, "release-checkpoint.md"), markdown, { mode: 0o600 });
    } catch { console.error("Could not write checkpoint output."); process.exitCode = 2; return; }
  } else process.stdout.write(args.format === "markdown" ? markdown : json);
  if (report.pullRequest.errors.length || report.pullRequest.checks.state === "unknown" || report.currentMain.state === "unknown" || report.currentMain.candidateContainment === "unknown" || [...report.doors, ...report.workers].some(door => door.error || door.candidateContainment === "unknown")) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main(process.argv.slice(2));
