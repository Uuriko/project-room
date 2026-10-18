#!/usr/bin/env node
/**
 * scripts/quarantine-trigger.mjs
 *
 * Zero-Bug System: quarantine ENTRY TRIGGER (Q-1).
 *
 * The quarantine mechanism (tests/quarantine.json + scripts/quarantine-check.mjs
 * + the non-blocking lane in zero-bug-quarantine.yml) had no trigger: entry
 * was a manual act, and pressing "re-run" left no trace except run_attempt >= 2
 * in the API. On 2026-10-17/18 at least four tests met the documented entry
 * criterion in under 24h and none were entered (research wave 2026-10-18,
 * lane 05-test-systems §6).
 *
 * This script scans recent `test` workflow evidence for the two objective
 * flake signatures and PROPOSES entries. It never writes tests/quarantine.json
 * and never quarantines anything by itself: acceptance is a reviewed act by
 * the landing authority / owning lane, who confirms the candidate with
 * scripts/flaky-detect.mjs and fills in the owner before entry.
 *
 * Signatures (both are same-head evidence, so the code under test is
 * byte-identical between the failing and passing observations — the
 * "diff-untouched code unchanged" condition holds by construction):
 *   (a) rerun flip — a run with run_attempt >= 2 whose final conclusion is
 *       success, where the same job failed in an earlier attempt and passed
 *       in the final attempt;
 *   (b) same-SHA divergence — two completed runs at the same head_sha with
 *       opposite conclusions, where the named job failed in the failing run
 *       and passed in a passing run at that SHA.
 *
 * Exclusions (a candidate is NEVER proposed from these):
 *   - silent runner death: the failing job produced shard evidence naming
 *     no failing test (empty receipt failures and no failing junit
 *     testcase), or no step in the job is recorded as failed. A dead runner
 *     is infrastructure, not a flaky test; it is reported under
 *     `excluded` with reason "runner-death-suspect" for CI-AUTOMATION.
 *   - timeout cancels: a shard job cancelled at its timeout names no
 *     failing test; it is reported as status "needs-naming", never as a
 *     proposed entry.
 *   - real failures: a job that fails in every attempt / at every run of
 *     its head SHA is a failure, not a flake — no event is emitted.
 *   - superseded runs (conclusion "cancelled" at run level) are queue
 *     hygiene, not evidence, and are ignored entirely.
 *
 * Failing test names are resolved from the runs' shard evidence artefacts
 * (unit-shard-evidence-* / conversation-browser-evidence-*): the shard
 * receipt's `failures` list and the junit sidecar's failing testcases
 * (which carry the file). A signature whose artefact names no test stays
 * shard-level ("needs-naming") — quarantine.json entries are by test.
 *
 * Outputs (proposals only):
 *   --out=<path>         proposals JSON (default tests/quarantine-proposals.json)
 *   --evidence-out=<path> human-readable evidence file (default: the .md
 *                        sibling of --out)
 *   --print-draft        also print a draft quarantine.json diff (the
 *                        suggested entries, for the accepting lane to paste
 *                        after assigning an owner and confirming)
 *
 * Usage:
 *   node scripts/quarantine-trigger.mjs [--hours=48] [--repo=owner/name]
 *     [--workflow=test.yml] [--out=path] [--evidence-out=path]
 *     [--print-draft] [--max-pages=20]
 *
 * Auth: GITHUB_TOKEN or GH_TOKEN; falls back to `gh auth token`.
 * Dependency-free: node builtins only.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { pathToFileURL } from "node:url";
import path from "node:path";

export const DAY_MS = 86_400_000;
export const REPAIR_WINDOW_DAYS = 14; // quarantine-check.mjs cap; do not extend

export function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

export function addDaysISO(iso, days) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return isoDate(d);
}

/**
 * Only jobs that run tests and upload shard evidence can indict a test.
 * Aggregator jobs (unit / browser / test) fail *because* a shard failed —
 * they are derivative, never evidence — and gate jobs (lint, contract, …)
 * carry no shard artefact to name a test from.
 */
export function isEvidenceJob(name) {
  return /shard \d+\/\d+/.test(name ?? "") || name === "cloudflare";
}

/** Strip a runner-absolute path (workspace prefix ahead of tests/…)
 * down to its repo-relative form; leave relative paths untouched. */
export function normalizeRepoPath(p) {
  if (!p || !p.startsWith("/")) return p ?? "";
  const m = /^(?:.*\/)?((?:tests|scripts|server|src|machine|cloudflare|relay)\/.+)$/.exec(p);
  return m ? m[1] : p;
}

function jobDurationMs(job) {
  if (!job?.started_at || !job?.completed_at) return null;
  const ms = new Date(job.completed_at) - new Date(job.started_at);
  return Number.isFinite(ms) ? ms : null;
}

/** A job is a silent-runner-death suspect when it "failed" but no step did. */
export function jobHasFailedStep(job) {
  if (!Array.isArray(job?.steps)) return null; // unknown — do not infer
  return job.steps.some((s) => s.conclusion === "failure");
}

/**
 * Detect flake signature events from workflow runs + their jobs.
 * @param runs  array of workflow-run objects (Actions API shape)
 * @param jobsByRunId  Map/object runId -> jobs (jobs?filter=all shape)
 * @returns events: [{kind, runId, headSha, branch, jobName, failingAttempt,
 *   failingConclusion, evidenceRunIds, runUrls}]
 */
export function detectSignatures(runs, jobsByRunId) {
  const events = [];
  const completed = runs.filter((r) => r.status === "completed" && r.conclusion !== "cancelled");
  const jobsOf = (id) => jobsByRunId.get?.(id) ?? jobsByRunId[id] ?? [];

  // (a) rerun flips (+ timeout-cancel flips, kept separate)
  for (const run of completed) {
    if ((run.run_attempt ?? 1) < 2 || run.conclusion !== "success") continue;
    const byName = new Map();
    for (const job of jobsOf(run.id)) {
      if (!byName.has(job.name)) byName.set(job.name, []);
      byName.get(job.name).push(job);
    }
    for (const [name, jobs] of byName) {
      if (!isEvidenceJob(name)) continue;
      const final = jobs.filter((j) => j.run_attempt === run.run_attempt);
      if (!final.some((j) => j.conclusion === "success")) continue;
      for (const job of jobs) {
        if (job.run_attempt >= run.run_attempt) continue;
        if (job.conclusion === "failure") {
          events.push({
            kind: "rerun-flip", runId: run.id, headSha: run.head_sha,
            branch: run.head_branch ?? null, jobName: name,
            failingAttempt: job.run_attempt, failingConclusion: "failure",
            failingJob: job, evidenceRunIds: [run.id],
          });
        } else if (job.conclusion === "cancelled") {
          const ms = jobDurationMs(job);
          // A shard cancelled well short of its timeout is a superseded /
          // aborted job, not a timeout specimen.
          if (ms !== null && ms >= 10 * 60_000) {
            events.push({
              kind: "timeout-flip", runId: run.id, headSha: run.head_sha,
              branch: run.head_branch ?? null, jobName: name,
              failingAttempt: job.run_attempt, failingConclusion: "cancelled",
              failingJob: job, evidenceRunIds: [run.id],
            });
          }
        }
      }
    }
  }

  // (b) same-SHA divergence
  const bySha = new Map();
  for (const run of completed) {
    if (!bySha.has(run.head_sha)) bySha.set(run.head_sha, []);
    bySha.get(run.head_sha).push(run);
  }
  for (const [sha, group] of bySha) {
    const failures = group.filter((r) => r.conclusion === "failure");
    const successes = group.filter((r) => r.conclusion === "success");
    if (!failures.length || !successes.length) continue;
    for (const fRun of failures) {
      for (const job of jobsOf(fRun.id)) {
        if (!isEvidenceJob(job.name)) continue;
        if (job.conclusion !== "failure") continue;
        const passedElsewhere = successes.some((sRun) =>
          jobsOf(sRun.id).some((j) => j.name === job.name && j.conclusion === "success"));
        if (!passedElsewhere) continue;
        events.push({
          kind: "same-sha-divergence", runId: fRun.id, headSha: sha,
          branch: fRun.head_branch ?? null, jobName: job.name,
          failingAttempt: job.run_attempt ?? 1, failingConclusion: "failure",
          failingJob: job,
          evidenceRunIds: [...new Set([fRun.id, ...successes.map((r) => r.id)])],
        });
      }
    }
  }
  return events;
}

/** Parse failing testcases ({file, name}) out of a junit XML string.
 * A hand scanner, not a regex over tags: Node's junit reporter leaves
 * literal ">" characters inside attribute values (e.g. a failure message
 * reading "lag p99 361 ms > 250 ms threshold"), which defeats [^>]* tag
 * matching — that is exactly the shape the proven flakes produce. */
export function parseJunitFailures(xml) {
  const out = [];
  const seen = new Set();
  const text = String(xml ?? "");
  let i = 0;
  while (true) {
    const start = text.indexOf("<testcase", i);
    if (start < 0) break;
    // Find the end of the opening tag, respecting double-quoted values.
    let j = start + "<testcase".length;
    let inQuotes = false;
    while (j < text.length) {
      const ch = text[j];
      if (ch === '"') inQuotes = !inQuotes;
      else if (ch === ">" && !inQuotes) break;
      j++;
    }
    if (j >= text.length) break;
    const attrs = text.slice(start + "<testcase".length, j);
    const selfClosing = attrs.trimEnd().endsWith("/");
    let body = "";
    let next = j + 1;
    if (!selfClosing) {
      const close = text.indexOf("</testcase>", j);
      if (close < 0) break;
      body = text.slice(j + 1, close);
      next = close + "</testcase>".length;
    }
    i = next;
    if (!/<(failure|error)\b/.test(body)) continue;
    const name = attr(attrs, "name");
    if (!name) continue;
    const file = normalizeRepoPath(attr(attrs, "file") || attr(attrs, "classname") || "");
    const key = `${file} > ${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ file, name });
  }
  return out;
}

function attr(attrs, name) {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(attrs ?? "");
  if (!m) return "";
  return m[1]
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .trim();
}

/**
 * Classify one event against its shard evidence.
 * evidence: {receiptPresent, receiptFailures: string[], junitFailures:
 *   [{file, name}]} — null when the artefact could not be fetched.
 * Returns {status, tests, classificationReason} where status is one of
 * "proposed" | "needs-naming" | "excluded-runner-death".
 */
export function classifyEvent(event, evidence) {
  const stepFailed = jobHasFailedStep(event.failingJob);
  if (event.kind === "timeout-flip") {
    return {
      status: "needs-naming",
      tests: [],
      classificationReason:
        "job cancelled at/near its timeout and passed on re-run at the same head; " +
        "a timeout names no failing test, so no entry is proposed — the shard's " +
        "evidence goes to the shard flake hunt (T-2) instead",
    };
  }
  if (!evidence) {
    return {
      status: "needs-naming", tests: [],
      classificationReason:
        "shard evidence artefact unavailable (expired or not uploaded); " +
        "the failing test is not named, so no entry can be proposed",
    };
  }
  const named = evidence.junitFailures.length > 0
    ? evidence.junitFailures.map((f) => {
        // A file-level failure reports the file itself as the testcase
        // name; quarantine.json accepts a bare file entry for those.
        if (f.file && normalizeRepoPath(f.name) === f.file) return f.file;
        return f.file ? `${f.file} > ${f.name}` : f.name;
      })
    : evidence.receiptFailures;
  if (named.length === 0 || stepFailed === false) {
    return {
      status: "excluded-runner-death", tests: [],
      classificationReason:
        "failing job produced shard evidence naming no failing test" +
        (stepFailed === false ? " and no job step is recorded as failed" : "") +
        " — silent runner death is infrastructure, not a flaky test; excluded " +
        "from quarantine and referred to CI-AUTOMATION",
    };
  }
  const fileless = evidence.junitFailures.length === 0;
  return {
    status: fileless ? "needs-naming" : "proposed",
    tests: named,
    classificationReason: fileless
      ? "receipt names the failing test but no junit file attribution was " +
        "available; a reviewer must confirm the file before entry"
      : "same-head fail→pass evidence with the failing test named by the " +
        "shard junit artefact; code at the failing and passing observations " +
        "is the identical head SHA",
  };
}

/**
 * Build the proposals document from classified events.
 * existing: parsed tests/quarantine.json (entries already quarantined are
 * not re-proposed). today: ISO date the proposal is generated.
 */
export function buildProposals(classified, { today, windowHours, repo, workflow, existing = { quarantined: [] } }) {
  const already = new Set((existing.quarantined ?? []).map((e) => e.test));
  const byTest = new Map();
  const shardLevel = [];
  const excluded = [];
  for (const { event, status, tests, classificationReason } of classified) {
    const base = {
      job: event.jobName,
      signature: event.kind,
      head_sha: event.headSha,
      branch: event.branch,
      evidence_runs: event.evidenceRunIds,
      evidence_urls: event.evidenceRunIds.map((id) => `https://github.com/${repo}/actions/runs/${id}`),
      failing_attempt: event.failingAttempt,
      reason: classificationReason,
    };
    if (status === "excluded-runner-death") { excluded.push(base); continue; }
    if (status === "needs-naming" || tests.length === 0) { shardLevel.push(base); continue; }
    for (const test of tests) {
      if (already.has(test)) continue;
      if (!byTest.has(test)) byTest.set(test, { test, events: [] });
      byTest.get(test).events.push(base);
    }
  }
  const candidates = [...byTest.values()].map(({ test, events }) => ({
    test,
    status: "proposed",
    confirmation_required:
      "owning lane confirms with scripts/flaky-detect.mjs (>=5 runs) and " +
      "assigns owner; landing authority accepts before any quarantine.json entry",
    evidence: events,
    suggested_entry: {
      test,
      reason:
        `flake evidence (${[...new Set(events.map((e) => e.signature))].join(", ")}): ` +
        `failed then passed at identical head ${events[0].head_sha.slice(0, 9)} — ` +
        `runs ${[...new Set(events.flatMap((e) => e.evidence_runs))].join(", ")}`,
      owner: "",
      quarantined_at: today,
      repair_by: addDaysISO(today, REPAIR_WINDOW_DAYS),
      evidence: [...new Set(events.flatMap((e) => e.evidence_urls))],
    },
  }));
  return {
    generated_at: new Date().toISOString(),
    generator: "scripts/quarantine-trigger.mjs (Q-1)",
    repo, workflow, window_hours: windowHours,
    criteria: {
      entry_requires:
        "same-head flake evidence (rerun flip or same-SHA divergence) with the " +
        "failing test named by shard evidence; entry date = acceptance date; " +
        "repair_by <= entry + 14 days (quarantine-check.mjs cap)",
      excluded:
        "silent runner deaths (no named failing test / no failed step), " +
        "timeout cancels without a named test, jobs failing at every " +
        "observation of their head, superseded (cancelled) runs",
    },
    candidates,
    needs_naming: shardLevel,
    excluded,
  };
}

export function renderEvidenceMarkdown(proposals) {
  const lines = [
    "# Quarantine candidates — evidence file (Q-1 trigger)",
    "",
    `Generated: ${proposals.generated_at} · window: last ${proposals.window_hours}h · ` +
      `workflow: ${proposals.workflow} · repo: ${proposals.repo}`,
    "",
    "Proposals only — nothing here is quarantined. Acceptance: the owning lane",
    "confirms with `scripts/flaky-detect.mjs` (>=5 runs), assigns an owner, and",
    "the landing authority enters the test in `tests/quarantine.json` with",
    "`repair_by` <= entry + 14 days. An entry without evidence is worse than",
    "no entry: quarantine weakens a gate.",
    "",
    `## Proposed entries (${proposals.candidates.length})`,
    "",
  ];
  if (!proposals.candidates.length) lines.push("None.", "");
  for (const c of proposals.candidates) {
    lines.push(`### ${c.test}`, "");
    for (const e of c.evidence) {
      lines.push(`- signature: ${e.signature} · job: ${e.job} · head: ${e.head_sha}`);
      lines.push(`- evidence: ${e.evidence_urls.join(" , ")}`);
    }
    lines.push(`- draft repair_by: ${c.suggested_entry.repair_by} (if entered ${c.suggested_entry.quarantined_at})`, "");
  }
  lines.push(`## Needs naming before any proposal (${proposals.needs_naming.length})`, "");
  for (const e of proposals.needs_naming) {
    lines.push(`- ${e.job} — ${e.signature}, head ${e.head_sha}: ${e.reason}`);
    lines.push(`  evidence: ${e.evidence_urls.join(" , ")}`);
  }
  if (!proposals.needs_naming.length) lines.push("None.");
  lines.push("", `## Excluded — not flaky tests (${proposals.excluded.length})`, "");
  for (const e of proposals.excluded) {
    lines.push(`- ${e.job} — ${e.signature}, head ${e.head_sha}: ${e.reason}`);
    lines.push(`  evidence: ${e.evidence_urls.join(" , ")}`);
  }
  if (!proposals.excluded.length) lines.push("None.");
  lines.push("");
  return lines.join("\n");
}

export function draftQuarantineDiff(proposals) {
  return {
    quarantined: proposals.candidates.map((c) => c.suggested_entry),
  };
}

/* ---------------- artefact (zip) reading, dependency-free ---------------- */

export function readZipEntries(buf) {
  // Minimal ZIP reader: central directory + stored/deflate entries.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65536); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a zip (no end-of-central-directory)");
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const out = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.subarray(off + 46, off + 46 + nameLen).toString("utf8");
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataOff = localOff + 30 + lNameLen + lExtraLen;
    const comp = buf.subarray(dataOff, dataOff + compSize);
    out.set(name, method === 8 ? inflateRawSync(comp) : Buffer.from(comp));
    off += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/**
 * Pick the evidence artefact belonging to a job. Unit and browser evidence
 * names both contain "-<shard>-" and "attempt-<n>", so matching on those
 * alone can select the WRONG suite's artefact (a passing browser artefact
 * would make a real unit flake look like a runner death). Match the
 * job-specific prefix first; fall back to any evidence artefact only when
 * the job type is unknown.
 */
export function pickArtefact(artifacts, jobName, attempt) {
  const prefix = /^unit shard/.test(jobName ?? "") ? "unit-shard-evidence-"
    : /^browser shard/.test(jobName ?? "") ? "conversation-browser-evidence-"
    : jobName === "cloudflare" ? "cloudflare-browser-evidence" : null;
  const shard = /shard (\d+)\//.exec(jobName ?? "")?.[1];
  const byPrefix = (a) =>
    (!prefix || a.name.startsWith(prefix)) &&
    (!shard || a.name.includes(`-${shard}-`)) &&
    (attempt == null || a.name.includes(`attempt-${attempt}`));
  return (artifacts ?? []).find(byPrefix) ??
    (artifacts ?? []).find((a) => a.name.includes("evidence") &&
      (!shard || a.name.includes(`-${shard}-`)));
}

export function evidenceFromArtefact(buf) {
  const files = readZipEntries(buf);
  let receiptPresent = false;
  const receiptFailures = [];
  const junitFailures = [];
  for (const [name, data] of files) {
    if (name.endsWith(".json")) {
      try {
        const j = JSON.parse(data.toString("utf8"));
        if (Array.isArray(j.failures)) {
          receiptPresent = true;
          for (const f of j.failures) if (typeof f === "string") receiptFailures.push(f);
        }
      } catch { /* not a receipt */ }
    } else if (name.endsWith(".xml")) {
      junitFailures.push(...parseJunitFailures(data.toString("utf8")));
    }
  }
  return { receiptPresent, receiptFailures, junitFailures };
}

/* ---------------- CLI ---------------- */

function parseArgs(argv) {
  const opts = {
    hours: 48, repo: "Uuriko/project-room", workflow: "test.yml",
    out: "tests/quarantine-proposals.json", evidenceOut: null,
    printDraft: false, maxPages: 20,
  };
  for (const a of argv) {
    if (a.startsWith("--hours=")) opts.hours = Number(a.slice(8));
    else if (a.startsWith("--repo=")) opts.repo = a.slice(7);
    else if (a.startsWith("--workflow=")) opts.workflow = a.slice(11);
    else if (a.startsWith("--out=")) opts.out = a.slice(6);
    else if (a.startsWith("--evidence-out=")) opts.evidenceOut = a.slice(15);
    else if (a.startsWith("--max-pages=")) opts.maxPages = Number(a.slice(12));
    else if (a === "--print-draft") opts.printDraft = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!Number.isFinite(opts.hours) || opts.hours <= 0) throw new Error("--hours must be positive");
  opts.evidenceOut ??= opts.out.replace(/\.json$/, ".md");
  return opts;
}

function token() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  try { return execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim(); }
  catch { throw new Error("no GITHUB_TOKEN/GH_TOKEN and `gh auth token` failed"); }
}

async function api(tok, repo, p, { binary = false } = {}) {
  const res = await fetch(`https://api.github.com/repos/${repo}${p}`, {
    headers: {
      authorization: `Bearer ${tok}`, accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28", "user-agent": "quarantine-trigger",
    },
  });
  if (res.status === 429) throw new Error("GitHub API 429 — stop and report (fleet rule)");
  if (!res.ok) throw new Error(`GET ${p} -> ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return binary ? Buffer.from(await res.arrayBuffer()) : res.json();
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const tok = token();
  const since = Date.now() - opts.hours * 3_600_000;
  const runs = [];
  for (let page = 1; page <= opts.maxPages; page++) {
    const data = await api(tok, opts.repo,
      `/actions/workflows/${opts.workflow}/runs?per_page=100&page=${page}`);
    const batch = data.workflow_runs ?? [];
    if (!batch.length) break;
    runs.push(...batch.filter((r) => new Date(r.created_at).getTime() >= since));
    if (new Date(batch[batch.length - 1].created_at).getTime() < since) break;
  }
  // Jobs only for runs that can carry a signature: re-run runs, and runs in
  // a same-SHA group with mixed conclusions (checked cheaply at run level).
  const bySha = new Map();
  for (const r of runs) {
    if (!bySha.has(r.head_sha)) bySha.set(r.head_sha, []);
    bySha.get(r.head_sha).push(r);
  }
  const needsJobs = runs.filter((r) =>
    (r.run_attempt ?? 1) >= 2 ||
    (bySha.get(r.head_sha).some((x) => x.conclusion === "success") &&
     bySha.get(r.head_sha).some((x) => x.conclusion === "failure")));
  const jobsByRunId = new Map();
  for (const run of needsJobs) {
    const data = await api(tok, opts.repo, `/actions/runs/${run.id}/jobs?filter=all&per_page=100`);
    jobsByRunId.set(run.id, data.jobs ?? []);
  }
  const events = detectSignatures(runs, jobsByRunId);

  const classified = [];
  for (const event of events) {
    let evidence = null;
    try {
      const arts = await api(tok, opts.repo, `/actions/runs/${event.runId}/artifacts?per_page=100`);
      const art = pickArtefact(arts.artifacts, event.jobName, event.failingAttempt);
      if (art) {
        const zip = await api(tok, opts.repo, `/actions/artifacts/${art.id}/zip`, { binary: true });
        evidence = evidenceFromArtefact(zip);
      }
    } catch (err) {
      console.error(`quarantine-trigger: artefact fetch for run ${event.runId} failed: ${err.message}`);
    }
    classified.push({ event, ...classifyEvent(event, evidence) });
  }

  let existing = { quarantined: [] };
  try {
    const { readFileSync } = await import("node:fs");
    existing = JSON.parse(readFileSync("tests/quarantine.json", "utf8"));
  } catch { /* proposals still valid against an empty registry */ }

  const proposals = buildProposals(classified, {
    today: isoDate(new Date()), windowHours: opts.hours,
    repo: opts.repo, workflow: opts.workflow, existing,
  });
  writeFileSync(opts.out, JSON.stringify(proposals, null, 2) + "\n");
  writeFileSync(opts.evidenceOut, renderEvidenceMarkdown(proposals));
  console.log(
    `quarantine-trigger: ${runs.length} runs scanned, ${events.length} signature events, ` +
    `${proposals.candidates.length} proposed, ${proposals.needs_naming.length} needs-naming, ` +
    `${proposals.excluded.length} excluded -> ${opts.out}, ${opts.evidenceOut}`);
  if (opts.printDraft) {
    console.log("\nDraft quarantine.json entries (acceptance still required):");
    console.log(JSON.stringify(draftQuarantineDiff(proposals), null, 2));
  }
}

const invokedAsCli = (() => {
  try { return process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href; }
  catch { return false; }
})();

if (invokedAsCli) {
  main().catch((err) => { console.error(`quarantine-trigger: ${err.message}`); process.exit(2); });
}
