// Compare a probe run with docs/onboarding-probe/baseline.json.
// A path fails when it is more than 20% slower, uses more than 1.2 times the
// calls, or loses a step the baseline could reach. Exactly 20% still passes.
// A newly reachable close is an improvement. Ready-latency jitter is inconclusive.
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function classifyReady(medianMs, baseline, { retried = false } = {}) {
  const hot = Number.isFinite(medianMs) && medianMs > baseline.ready.medianMs * 3;
  if (!hot) return { inconclusive: false, retry: false, medianMs };
  if (!retried) return { inconclusive: false, retry: true, medianMs };
  return { inconclusive: true, retry: false, medianMs };
}

function median(values) {
  const nums = values.filter(value => Number.isFinite(value)).sort((a, b) => a - b);
  if (!nums.length) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}

function overTwenty(current, baseline) {
  return current * 100 > baseline * 120;
}

export function pathMetric(result) {
  if (!result || result.status === "not_available") return { status: "not_available" };
  if (result.closeReachable && result.firstClose && Number.isFinite(result.firstClose.t)) {
    return { status: "ok", step: "firstClose", t: result.firstClose.t, calls: result.firstClose.calls ?? null, reachable: true };
  }
  if (result.firstPost && Number.isFinite(result.firstPost.t)) {
    return { status: "ok", step: "firstPost", t: result.firstPost.t, calls: result.firstPost.calls ?? null, reachable: false };
  }
  return { status: "unreachable", reachable: false };
}

export function evaluateGate(runs, baseline, ready = {}) {
  const failures = [];
  const improvements = [];
  const inconclusive = [];
  if (ready.inconclusive) {
    return { pass: true, failures, improvements, inconclusive: ["ready"] };
  }
  const byPath = new Map();
  for (const run of runs) {
    for (const [name, path] of Object.entries(run.paths ?? run)) {
      if (!byPath.has(name)) byPath.set(name, []);
      byPath.get(name).push(path);
    }
  }
  for (const [name, samples] of byPath) {
    const baselinePath = baseline.paths?.[name];
    if (!baselinePath) continue;
    const metrics = samples.map(pathMetric);
    if (metrics.every(item => item.status === "not_available")) {
      inconclusive.push(name);
      continue;
    }
    const usable = metrics.filter(item => item.status === "ok");
    if (!usable.length) {
      failures.push({ path: name, step: baselinePath.step, reason: "unreachable" });
      continue;
    }
    const reachable = usable.some(item => item.reachable);
    if (!baselinePath.closeReachable && reachable) {
      improvements.push(name);
      continue;
    }
    if (baselinePath.closeReachable && !reachable) {
      failures.push({ path: name, step: "firstClose", reason: "unreachable" });
      continue;
    }
    const current = median(usable.map(item => item.t));
    const calls = median(usable.map(item => item.calls));
    const step = usable[0].step;
    if (Number.isFinite(baselinePath.medianMs) && overTwenty(current, baselinePath.medianMs)) {
      failures.push({ path: name, step, reason: "slower" });
    }
    if (Number.isFinite(baselinePath.calls) && Number.isFinite(calls) && calls * 5 > baselinePath.calls * 6) {
      failures.push({ path: name, step, reason: "more-calls" });
    }
  }
  return { pass: failures.length === 0, failures, improvements, inconclusive };
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const args = process.argv.slice(2);
  const resultFlag = args.indexOf("--result");
  const baselineFlag = args.indexOf("--baseline");
  const result = readJson(args[resultFlag + 1]);
  const baseline = readJson(args[baselineFlag + 1]);
  const runs = Array.isArray(result.runs) && result.runs.length ? result.runs : [result];
  const verdict = evaluateGate(runs, baseline, { inconclusive: result.ready?.inconclusive === true });
  const line = verdict.pass ? "onboarding probe gate: pass" : "onboarding probe gate: fail";
  console.log(line);
  if (verdict.inconclusive.length) console.log(`inconclusive: ${verdict.inconclusive.join(", ")}`);
  for (const failure of verdict.failures) console.log(`fail ${failure.path} ${failure.step} ${failure.reason}`);
  for (const name of verdict.improvements) console.log(`improved ${name}`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n${line}\n`);
  process.exit(verdict.pass ? 0 : 1);
}
