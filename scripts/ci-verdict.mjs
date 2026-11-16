// CI verdict: the one honest grading of a `test` workflow run.
//
// The verdict is bound to the in-repo job table, `.github/ci-substantive.json`
// (closed schema: job_id, workflow, required, substantive, proves,
// subset_allowed). The manifest is the authority on what a run must show:
//
//   - a required job that did not pass — FAILED, skipped, cancelled, or
//     absent from the run — fails the verdict;
//   - a substantive job that failed, or whose evidence never ran (skipped /
//     absent = NOT-RUN), fails the verdict: skipped is stripped from the
//     passing set, never folded into green;
//   - a job present in the run but absent from the manifest is itself a
//     defect and fails the verdict (the manifest is closed);
//   - a job whose `proves` begins "OUT-OF-SCOPE" is named in the table as
//     NOT-GRADED and its conclusion is never consulted.
//
// Before this module, the ci-verdict workflow job only wrote a summary and
// exited 0 unconditionally, so GitHub reported the check green even in runs
// where a substantive job had FAILED and coverage never ran (run 43750749856
// at PR #6208's head 96f12308: ci-verdict job 132925697957 = success). This
// module's exit code is the verdict: 0 only when the verdict is PASSED.
//
// Consumed identically by the ci-verdict workflow job (needs.* results via
// CI_JOB_RESULT_<JOB_ID> env vars) and by scripts/ci-receipt.mjs (jobs API
// display names, mapped by jobIdOfName). One verify form, no second standard.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const MANIFEST_PATH = ".github/ci-substantive.json";
const JOB_FIELDS = ["job_id", "workflow", "required", "substantive", "proves", "subset_allowed"];
const OUT_OF_SCOPE = "OUT-OF-SCOPE";

// GitHub job conclusion -> verdict vocabulary. Anything that is not an
// executed pass or an executed failure is NOT-RUN: the evidence does not
// exist, and absence never defaults green.
export function resultOf(conclusion) {
  if (conclusion === "success") return "PASSED";
  if (["failure", "cancelled", "timed_out", "action_required", "startup_failure"].includes(conclusion)) return "FAILED";
  return "NOT-RUN"; // skipped, neutral, null, or absent
}

export function isOutOfScope(job) {
  return typeof job?.proves === "string" && job.proves.startsWith(OUT_OF_SCOPE);
}

// Validate the closed manifest schema. Throws on any violation: an
// unmanifested or malformed table must fail loud, never grade silently.
export function parseManifest(raw) {
  const manifest = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error("ci manifest: not an object");
  if (typeof manifest.workflow !== "string" || !manifest.workflow) throw new Error("ci manifest: workflow missing");
  if (!Array.isArray(manifest.jobs) || manifest.jobs.length === 0) throw new Error("ci manifest: jobs missing");
  const seen = new Set();
  for (const job of manifest.jobs) {
    const keys = Object.keys(job ?? {}).sort();
    if (JSON.stringify(keys) !== JSON.stringify([...JOB_FIELDS].sort())) {
      throw new Error(`ci manifest: job ${job?.job_id ?? "?"} must carry exactly the fields ${JOB_FIELDS.join(", ")}`);
    }
    if (typeof job.job_id !== "string" || !job.job_id) throw new Error("ci manifest: job_id missing");
    if (seen.has(job.job_id)) throw new Error(`ci manifest: duplicate job_id ${job.job_id}`);
    seen.add(job.job_id);
    if (job.workflow !== manifest.workflow) throw new Error(`ci manifest: job ${job.job_id} names workflow ${job.workflow}, manifest is ${manifest.workflow}`);
    for (const flag of ["required", "substantive", "subset_allowed"]) {
      if (typeof job[flag] !== "boolean") throw new Error(`ci manifest: job ${job.job_id} field ${flag} must be boolean`);
    }
    if (typeof job.proves !== "string" || !job.proves) throw new Error(`ci manifest: job ${job.job_id} proves missing`);
  }
  return manifest;
}

export function loadManifest(path = MANIFEST_PATH) {
  return parseManifest(readFileSync(path, "utf8"));
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

// The manifest hash sealed into claim packets and receipt ids by consumers:
// H over the canonical manifest, so the table that graded a run is provable.
export function manifestHash(manifest) {
  return createHash("sha256").update(canonical(manifest)).digest("hex");
}

// Map a jobs-API display name to a manifest job_id. Display names are the
// workflow's own naming ("browser shard 3/6", "ci-verdict (NOTHING RAN -
// add ready-to-land)"), never pull-request text.
export function jobIdOfName(name) {
  const n = String(name ?? "");
  if (/^browser shards?\b/.test(n) || /^browser shard \d+\/\d+$/.test(n)) return "browser-shards";
  if (/^ci-verdict\b/.test(n)) return "ci-verdict";
  return n;
}

const RANK = { failure: 5, cancelled: 4, timed_out: 4, action_required: 4, startup_failure: 4, skipped: 3, neutral: 2, success: 1 };

// Collapse several API jobs that map to one manifest job (the browser
// shards): the worst conclusion wins, so one failed shard fails the row.
export function worstConclusion(a, b) {
  if (a == null) return b ?? null;
  if (b == null) return a;
  return (RANK[b] ?? 0) > (RANK[a] ?? 0) ? b : a;
}

// Grade one run. results: { [job_id]: github conclusion } — a manifest job
// missing from the map is absent from the run and grades NOT-RUN.
export function gradeJobs(manifest, results = {}) {
  const table = [];
  const failed = [], notRun = [], unmanifested = [];
  for (const job of manifest.jobs) {
    if (isOutOfScope(job)) {
      table.push({ job_id: job.job_id, verdict: "NOT-GRADED", required: job.required, substantive: job.substantive });
      continue;
    }
    const verdict = resultOf(results[job.job_id] ?? null);
    table.push({ job_id: job.job_id, verdict, required: job.required, substantive: job.substantive });
    if (verdict === "FAILED" && (job.required || job.substantive)) failed.push(job.job_id);
    if (verdict === "NOT-RUN" && (job.required || job.substantive)) notRun.push(job.job_id);
  }
  const known = new Set(manifest.jobs.map(job => job.job_id));
  for (const jobId of Object.keys(results)) if (!known.has(jobId)) unmanifested.push(jobId);
  const verdict = failed.length || notRun.length || unmanifested.length ? "FAILED" : "PASSED";
  return { verdict, table, failed, notRun, unmanifested, manifestHash: manifestHash(manifest) };
}

export function gradeMarkdown(grade, { subject } = {}) {
  const lines = ["## CI verdict", ""];
  if (subject) lines.push(`Subject: ${subject}`, "");
  lines.push(`**${grade.verdict}** — manifest ${grade.manifestHash.slice(0, 12)}`, "");
  lines.push("| Job | Verdict |", "| --- | --- |");
  for (const row of grade.table) lines.push(`| ${row.job_id} | ${row.verdict} |`);
  if (grade.unmanifested.length) lines.push("", `Unmanifested jobs in this run (defect): ${grade.unmanifested.join(", ")}`);
  return lines.join("\n") + "\n";
}

// CLI: results arrive as CI_JOB_RESULT_<JOB_ID> env vars holding GitHub
// needs.* result strings (success / failure / skipped / cancelled).
export function resultsFromEnv(env = process.env) {
  const results = {};
  for (const [key, value] of Object.entries(env)) {
    const match = /^CI_JOB_RESULT_([A-Z0-9_]+)$/.exec(key);
    if (match) results[match[1].toLowerCase().replaceAll("_", "-")] = value;
  }
  return results;
}

export function main(env = process.env) {
  const manifest = loadManifest(env.CI_MANIFEST_PATH || MANIFEST_PATH);
  const grade = gradeJobs(manifest, resultsFromEnv(env));
  const subject = env.CI_SUBJECT || undefined;
  const markdown = gradeMarkdown(grade, { subject });
  process.stdout.write(markdown);
  if (grade.verdict !== "PASSED") {
    console.error(`ci-verdict: ${grade.verdict} — failed: [${grade.failed.join(", ")}], not-run: [${grade.notRun.join(", ")}], unmanifested: [${grade.unmanifested.join(", ")}]`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try { main(); } catch (error) { console.error(`ci-verdict: ${error.message}`); process.exitCode = 1; }
}
