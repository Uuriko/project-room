// Provider cost breakdown model (200-hard-tasks #28).
// Unit economics per provider Mac: electricity (measured wall-power
// delta), tokens/job, orchestration overhead, jitter/p99 throughput
// impact, hardware amortization — against 2x$49/mo revenue.
// Sensitivity analysis: +/-50% on each input, ranked by margin impact.
// Emits a CSV sensitivity table (the "spreadsheet model").
// Usage: node scripts/provider-cost-model.mjs [--csv out.csv]
import { writeFileSync } from "node:fs";

// --- Base-case inputs (measured or estimated; override via env JSON) ---
const BASE = {
  // Revenue: 2 x $49/mo per provider Mac (two $49 subscription slots).
  revenuePerMonth: 2 * 49,
  // Electricity: wall-power delta under load, serving hours, rate.
  wallPowerDeltaW: 45, // measured via powermetrics (task #27)
  servingHoursPerDay: 12,
  electricityPerKwh: 0.30,
  // Hardware amortization: $3,500 Mac / 3y.
  hardwarePerHour: 0.16,
  // Throughput: mean tokens/sec, tokens/job, orchestration overhead/job.
  tokensPerSec: 42,
  tokensPerJob: 800, // mean in+out per job
  overheadMsPerJob: 7.4, // task #29 steady-state
  // Jitter: p99/p50 ratio; effective throughput derate for latency-sensitive jobs.
  p99ToP50Ratio: 2.5,
  latencySensitiveShare: 0.3, // share of jobs where p99 (not mean) sets throughput
};

function monthlyModel(p) {
  const hoursPerMonth = p.servingHoursPerDay * 30;
  const electricity = (p.wallPowerDeltaW / 1000) * hoursPerMonth * p.electricityPerKwh;
  const hardware = p.hardwarePerHour * hoursPerMonth;
  // Throughput: raw jobs/h from tokens/sec, derated by orchestration overhead
  // and by p99 jitter on the latency-sensitive share.
  const rawJobsPerHour = (p.tokensPerSec * 3600) / p.tokensPerJob;
  const overheadDerate = 1 / (1 + (p.overheadMsPerJob / 1000) / (p.tokensPerJob / p.tokensPerSec));
  const jitterDerate = 1 - p.latencySensitiveShare * (1 - 1 / p.p99ToP50Ratio);
  const effectiveJobsPerHour = rawJobsPerHour * overheadDerate * jitterDerate;
  const jobsPerMonth = effectiveJobsPerHour * hoursPerMonth;
  // Variable cost scales with jobs only via electricity (already counted);
  // hardware is fixed. Margin:
  const totalCost = electricity + hardware;
  const margin = p.revenuePerMonth - totalCost;
  const marginPct = (margin / p.revenuePerMonth) * 100;
  const costPerJob = jobsPerMonth > 0 ? totalCost / jobsPerMonth : Infinity;
  return { electricity, hardware, totalCost, margin, marginPct, jobsPerMonth, effectiveJobsPerHour, costPerJob };
}

const SENSITIVITY_INPUTS = [
  ["wallPowerDeltaW", "electricity (wall power W)"],
  ["electricityPerKwh", "electricity ($/kWh)"],
  ["tokensPerJob", "tokens per job"],
  ["tokensPerSec", "throughput (tok/s)"],
  ["overheadMsPerJob", "orchestration overhead (ms/job)"],
  ["p99ToP50Ratio", "jitter (p99/p50)"],
  ["servingHoursPerDay", "serving hours/day"],
  ["hardwarePerHour", "hardware amortization ($/h)"],
  ["revenuePerMonth", "revenue ($/mo)"],
];

export function sensitivityAnalysis(base = BASE) {
  const baseResult = monthlyModel(base);
  const rows = [];
  for (const [key, label] of SENSITIVITY_INPUTS) {
    for (const dir of [-0.5, 0.5]) {
      const p = { ...base, [key]: base[key] * (1 + dir) };
      const r = monthlyModel(p);
      rows.push({
        input: label,
        change: dir > 0 ? "+50%" : "-50%",
        margin: +r.margin.toFixed(2),
        marginDelta: +(r.margin - baseResult.margin).toFixed(2),
        costPerJob: +r.costPerJob.toFixed(4),
        costPerJobDeltaPct: +(((r.costPerJob - baseResult.costPerJob) / baseResult.costPerJob) * 100).toFixed(1),
      });
    }
  }
  // Rank inputs by max |marginDelta|.
  const rank = new Map();
  for (const r of rows) {
    rank.set(r.input, Math.max(rank.get(r.input) || 0, Math.abs(r.marginDelta)));
  }
  const ranked = [...rank.entries()].sort((a, b) => b[1] - a[1]);
  // Rank inputs by max |costPerJobDeltaPct| (capacity/efficiency view).
  const rankCpJ = new Map();
  for (const r of rows) {
    rankCpJ.set(r.input, Math.max(rankCpJ.get(r.input) || 0, Math.abs(r.costPerJobDeltaPct)));
  }
  const rankedCostPerJob = [...rankCpJ.entries()].sort((a, b) => b[1] - a[1]);
  return { base: { ...baseResult, margin: +baseResult.margin.toFixed(2) }, rows, ranked, rankedCostPerJob };
}

export function toCsv(analysis) {
  const lines = ["input,change,margin_usd,margin_delta_usd,cost_per_job_usd,cost_per_job_delta_pct"];
  for (const r of analysis.rows) {
    lines.push([`"${r.input}"`, r.change, r.margin, r.marginDelta, r.costPerJob, r.costPerJobDeltaPct].join(","));
  }
  lines.push("");
  lines.push("rank,input,max_abs_margin_delta_usd");
  analysis.ranked.forEach(([input, delta], i) => lines.push([i + 1, `"${input}"`, delta.toFixed(2)].join(",")));
  lines.push("");
  lines.push("rank,input,max_abs_cost_per_job_delta_pct");
  analysis.rankedCostPerJob.forEach(([input, delta], i) => lines.push([i + 1, `"${input}"`, delta.toFixed(1)].join(",")));
  return lines.join("\n");
}

const isCli = process.argv[1] && process.argv[1].endsWith("provider-cost-model.mjs");
if (isCli) {
  const envJson = process.env.COST_INPUTS ? JSON.parse(process.env.COST_INPUTS) : {};
  const base = { ...BASE, ...envJson };
  const a = sensitivityAnalysis(base);
  console.log(`base: margin $${a.base.margin}/mo (${a.base.marginPct.toFixed(1)}%), ${Math.round(a.base.jobsPerMonth)} jobs/mo, $${a.base.costPerJob.toFixed(4)}/job`);
  console.log("sensitivity ranking — margin (dominant first):");
  for (const [input, delta] of a.ranked) {
    console.log(`  ${input}: max margin swing $${delta.toFixed(2)}`);
  }
  console.log("sensitivity ranking — cost/job (dominant first):");
  for (const [input, delta] of a.rankedCostPerJob) {
    console.log(`  ${input}: max cost/job swing ${delta.toFixed(1)}%`);
  }
  const csvIdx = process.argv.indexOf("--csv");
  if (csvIdx !== -1 && process.argv[csvIdx + 1]) {
    writeFileSync(process.argv[csvIdx + 1], toCsv(a));
    console.log(`wrote ${process.argv[csvIdx + 1]}`);
  }
}
