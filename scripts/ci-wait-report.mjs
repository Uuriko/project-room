#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { parse } from "yaml";

// Step-name heuristics adapted from Joggernaut (MIT).
// Copyright (c) 2026 Machine Intelligence Company.
// See ci-wait-report.LICENSE for the upstream notice.
const setupWords = /set up|setup|checkout|cache|restore|install|download|login|toolchain|dependencies|deps/;
const timestamp = value => typeof value === "string" ? Date.parse(value) / 1000 : NaN;
const round = value => Math.round(value * 10) / 10;
const sum = values => values.reduce((total, value) => total + value, 0);
const p95 = values => values.length ? values.toSorted((a, b) => a - b)[Math.ceil(values.length * .95) - 1] : null;
const median = values => {
  if (!values.length) return null;
  const sorted = values.toSorted((a, b) => a - b), mid = Math.floor(sorted.length / 2);
  return round(sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2);
};

function jobPattern(name) {
  if (/\$\{\{/.test(name.replace(/\$\{\{\s*matrix\.[\w-]+\s*\}\}/g, ""))) return null;
  const parts = name.split(/\$\{\{[^{}]+\}\}/g);
  return new RegExp("^" + parts.map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".+?") + "(?: \\(.*\\))?$");
}

export function workflowJobs(jobs) {
  return Object.entries(jobs ?? {}).map(([id, job]) => ({
    id, name: job.name ?? id, pattern: jobPattern(job.name ?? id),
    needs: Array.isArray(job.needs) ? job.needs : job.needs ? [job.needs] : [],
  }));
}

function describe(job) {
  const start = timestamp(job.started_at), end = timestamp(job.completed_at);
  return Number.isFinite(start) && Number.isFinite(end) && end >= start && job.conclusion !== "skipped"
    ? { ...job, start, end } : null;
}

function segments(job, ready, origin) {
  const c = timestamp(job.created_at);
  const queue = Number.isFinite(c) ? Math.max(0, job.start - Math.max(ready, c, origin)) : null;
  let covered = job.start;
  const steps = [];
  for (const step of (job.steps ?? []).map(describe).filter(Boolean).sort((a, b) => a.start - b.start)) {
    const start = Math.max(covered, step.start, job.start), end = Math.min(step.end, job.end);
    if (end <= start) continue;
    covered = end;
    const name = step.name ?? "(unnamed step)";
    const key = name.toLowerCase();
    const phase = key.startsWith("post ") || key === "complete job" ? "cleanup" : setupWords.test(key) ? "setup" : "execution";
    steps.push({ name, phase, seconds: end - start });
  }
  return { queue, steps };
}

export function traceRun(run, { graph, terminal, required = [] } = {}) {
  const origin = timestamp(run.created_at);
  const attempt = run.run_attempt ?? 1;
  const all = (run.jobs ?? []).map(describe).filter(Boolean);
  const jobs = all.filter(job => (job.run_attempt ?? 1) === attempt);
  if (!Number.isFinite(origin) || required.some(name => !jobs.some(job => job.name === name))) return null;
  const target = jobs.filter(job => !terminal || job.name === terminal).toSorted((a, b) => b.end - a.end)[0];
  if (!target || target.end < origin) return null;

  const groups = new Map(), definitions = new Map();
  const observedIds = new Set();
  for (const record of (run.jobs ?? []).filter(job => (job.run_attempt ?? 1) === attempt)) {
    const exact = graph?.filter(item => item.name === record.name || item.id === record.name) ?? [];
    const patterns = exact.length ? exact : graph?.filter(item => item.pattern?.test(record.name)) ?? [];
    if (patterns.length !== 1) continue;
    const def = patterns[0];
    const job = describe(record);
    if (record.conclusion === "skipped" || job) observedIds.add(def.id);
    if (!job) continue;
    definitions.set(job.id, def);
    const group = groups.get(def.id) ?? [];
    group.push(job);
    groups.set(def.id, group);
  }

  const seen = new Set(), path = [];
  let job = target, completeGraph = Boolean(graph);
  while (job && !seen.has(job.id)) {
    seen.add(job.id);
    const definition = definitions.get(job.id);
    const deps = definition?.needs ?? [];
    if (!definition || deps.some(id => !observedIds.has(id))) completeGraph = false;
    const relevant = deps.flatMap(id => groups.get(id) ?? []);
    if (relevant.some(prev => prev.end > job.start)) completeGraph = false;
    const previous = relevant.filter(prev => prev.end <= job.start).sort((a, b) => b.end - a.end)[0];
    const ready = previous?.end ?? origin;
    path.push({ id: job.id, name: job.name, ...segments(job, ready, origin) });
    job = previous;
  }
  if (job) completeGraph = false;
  path.reverse();
  const wall = target.end - origin;
  const queue = sum(path.map(item => item.queue ?? 0));
  const steps = path.flatMap(item => item.steps);
  const phases = Object.fromEntries(["setup", "execution", "cleanup"].map(phase => [phase, round(sum(steps.filter(step => step.phase === phase).map(step => step.seconds)))]));
  return { runId: run.id, head: run.head_sha, conclusion: run.conclusion, attempt, wallSeconds: round(wall),
    graph: completeGraph ? "observed_dependencies" : path.length > 1 ? "partial_dependencies" : "terminal_job_only",
    phases: { ...phases, observedJobStartDelay: round(queue), unattributed: round(Math.max(0, wall - queue - sum(steps.map(step => step.seconds)))) },
    jobsWithNoCreationTime: path.filter(item => item.queue === null).length, path,
    runnerSecondsAllAttempts: round(sum(all.map(item => item.end - item.start))),
    runnerSecondsPriorAttempts: round(sum(all.filter(item => (item.run_attempt ?? 1) < attempt).map(item => item.end - item.start))),
  };
}

export function summarize(runs, options = {}, getGraph = () => null) {
  const observed = runs.map(run => traceRun(run, { ...options, graph: getGraph(run) })).filter(Boolean);
  const successful = observed.filter(run => run.conclusion === "success");
  const steps = new Map();
  for (const run of observed) {
    for (const job of run.path) {
      for (const step of job.steps) {
        const key = JSON.stringify([job.name, step.name, step.phase]);
        const entry = steps.get(key) ?? { job: job.name, step: step.name, phase: step.phase, seconds: [], runs: new Set() };
        entry.seconds.push(step.seconds);
        entry.runs.add(run.runId);
        steps.set(key, entry);
      }
    }
  }
  return { sampled: runs.length, observed: observed.length, unobserved: runs.length - observed.length,
    outcomes: Object.fromEntries([...new Set(runs.map(run => run.conclusion ?? "unknown"))].sort()
      .map(status => [status, runs.filter(run => (run.conclusion ?? "unknown") === status).length])),
    successful: { count: successful.length, medianWallSeconds: median(successful.map(run => run.wallSeconds)),
      p95WallSeconds: p95(successful.map(run => run.wallSeconds)) },
    runnerSeconds: round(sum(observed.map(run => run.runnerSecondsAllAttempts))),
    runnerSecondsPriorAttempts: round(sum(observed.map(run => run.runnerSecondsPriorAttempts))),
    runnerSecondsWithoutSuccessfulConclusion: round(sum(observed.filter(run => run.conclusion !== "success").map(run => run.runnerSecondsAllAttempts))),
    observedSteps: [...steps.values()].map(({ seconds, runs: occurrences, ...step }) => ({
      ...step, runs: occurrences.size, totalSeconds: round(sum(seconds)), medianSeconds: median(seconds),
    })).sort((a, b) => b.totalSeconds - a.totalSeconds || a.step.localeCompare(b.step)),
    runs: observed,
  };
}

function graphAtHead(run) {
  const path = run.path?.split("@")[0];
  if (!/^[a-f0-9]{40}$/.test(run.head_sha) || !/^\.github\/workflows\/[\w.-]+\.ya?ml$/.test(path)) return null;
  let source;
  try {
    source = execFileSync("git", ["show", `${run.head_sha}:${path}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch { return null; }
  return workflowJobs(parse(source).jobs);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { positionals, values } = parseArgs({ allowPositionals: true,
    options: { terminal: { type: "string" }, "require-job": { type: "string", multiple: true } } });
  if (positionals.length !== 1) throw new Error("Usage: ci-wait-report.mjs RUNS.jsonl [--terminal NAME] [--require-job NAME]...");
  const runs = readFileSync(positionals[0], "utf8").split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line));
  if (!runs.length || runs.some(run => !Number.isSafeInteger(run.id) || !Array.isArray(run.jobs))
      || new Set(runs.map(run => run.id)).size !== runs.length) throw new Error("Expected a nonempty Joggernaut run history with distinct run IDs.");
  console.log(JSON.stringify(summarize(runs, { terminal: values.terminal, required: values["require-job"] }, graphAtHead), null, 2));
}
