// One probe-result document and the markdown table operators read.
// The 4-week column is the baseline file. This module never rewrites it.
import { writeJson } from "./lib.mjs";
import { pathMetric } from "./gate.mjs";

const PATHS = ["agentDocs", "agentMcp", "agentCode", "humanHome", "humanInvite"];

export function currentPaths(runs) {
  const paths = {};
  for (const name of PATHS) {
    const samples = runs.map(run => run.paths?.[name]).filter(Boolean);
    paths[name] = samples[Math.floor(samples.length / 2)] ?? samples[0] ?? { status: "not_available", steps: [], firstPost: null, firstClose: null, closeReachable: false, confusions: [] };
  }
  return paths;
}

function cell(metric, baselinePath) {
  if (!metric || metric.status === "not_available") return "not available";
  if (metric.status === "unreachable") return "unreachable";
  const calls = Number.isFinite(metric.calls) ? `, ${metric.calls} calls` : "";
  const median = Number.isFinite(baselinePath?.medianMs) ? baselinePath.medianMs : null;
  const delta = median ? `${Math.round(((metric.t - median) / median) * 1000) / 10}%` : "";
  return { current: `${metric.t} ms${calls}`, median: median === null ? "" : `${median} ms${Number.isFinite(baselinePath.calls) ? `, ${baselinePath.calls} calls` : ""}`, delta };
}

export function renderTable(paths, baseline) {
  const lines = [
    "| Path | Current | 4-week median | Delta |",
    "| --- | --- | --- | --- |",
  ];
  for (const name of PATHS) {
    const metric = pathMetric(paths[name]);
    const shown = cell(metric, baseline.paths?.[name]);
    if (typeof shown === "string") {
      const medianMs = baseline.paths?.[name]?.medianMs;
      const median = Number.isFinite(medianMs) ? `${medianMs} ms` : "";
      lines.push(`| ${name} | ${shown} | ${median} | |`);
    }
    else lines.push(`| ${name} | ${shown.current} | ${shown.median} | ${shown.delta} |`);
    const human = paths[name]?.human;
    if (human?.label === "est.") lines.push(`| ${name} KLM | ${human.seconds} s est. | | |`);
  }
  return `${lines.join("\n")}\n`;
}

export function buildResult({ target, sourceRevision, ready, runs, paths }) {
  return {
    runAt: new Date().toISOString(),
    target,
    sourceRevision,
    ready,
    runs,
    paths,
  };
}

export function writeResult(file, result) {
  writeJson(file, result);
}
