#!/usr/bin/env node
/**
 * overhead-model.mjs — WAVE-500 coordination-overhead predictive budget model.
 *
 * Worker 14/17. Turns the lane's point measurements into overhead(N):
 *
 *   overhead(N) = dispatch_fixed×N + burst_contention(N)
 *               + dispatch_variable×context_bytes×N
 *               + report_read_time×N + room_events(N)×event_cost
 *
 * burst_contention(N) is the measured superlinear term: per-spawn dispatch
 * cost grows with burst width W as W^α (α≈0.71, worker-1 N=3/N=8 doubling),
 * so the contention surcharge over the constant-per-spawn baseline is
 *   burst_contention(N) = dispatch_fixed × N × ((N/N_cal)^α − 1).
 * Under batch dispatch the fan-out width is the batch count, not N.
 *
 * Every parameter carries provenance: MEASURED (sibling doc / brief point
 * measurement) or ASSUMED (calibrated to reproduce the point measurements,
 * or derived from a sibling spec's design bounds — marked as such).
 *
 * Usage:
 *   node scripts/overhead-model.mjs [--levers=batch,digest,standing]
 *       [--tasks-per-agent=1] [--json]
 *
 * Levers:
 *   batch    — batch dispatch (docs/BATCH-DISPATCH-SPEC.md): one coordinator
 *              turn per batch (cap 100 workers/batch), shared context sent once
 *              per batch instead of once per worker.
 *   digest   — structured receipts + coordinator digest (workers 11/17, 12/17):
 *              coordinator reads one digest instead of N free-text reports.
 *   standing — standing claims (docs/STANDING-CLAIMS-PROPOSAL.md §b): one claim
 *              per lane per wave + heartbeats + linked structured receipts,
 *              amortizing the 6.5-event lifecycle toll.
 */

const MEASURED = "MEASURED";
const ASSUMED = "ASSUMED";

const PARAMS = [
  { name: "productive_per_agent", value: 100, unit: "time units", provenance: ASSUMED,
    note: "Normalization: one agent's full task output = 100 units; all overhead expressed in the same units." },
  { name: "dispatch_fixed", value: 7.5, unit: "units/spawn", provenance: `${ASSUMED} (calibrated)`,
    note: "Per-spawn coordinator turn (handshake, scheduling, acknowledgement) at the reference burst width. Calibrated so the model reproduces 37% total overhead with 23.1% dispatch share at N=100." },
  { name: "burst_exponent", value: 0.71, unit: "exponent", provenance: `${MEASURED} (docs/OVERHEAD-BASELINE.md)`,
    note: "Per-spawn dispatch cost scales with burst width W as W^α. Fitted from worker-1's point measurements: mean dispatch_rtt 733.73 ms at width 3 → 1470.16 ms at width 8; α = ln(1470.16/733.73)/ln(8/3) ≈ 0.71. Transfers structurally (fork-latency exponent → subagent-spawn exponent) — the absolute scale comes from dispatch_fixed, the shape from this exponent." },
  { name: "dispatch_variable", value: 29.0 / 16200, unit: "units/byte", provenance: `${ASSUMED} (calibrated)`,
    note: "Context-assembly cost per byte. At naive context 16,200 B = 29.0 units/spawn. Batch dispatch moves most context out of the per-worker payload (BATCH-DISPATCH-SPEC.md §2)." },
  { name: "context_shared_bytes", value: 15000, unit: "bytes", provenance: `${ASSUMED} (spec-bounded)`,
    note: "Shared context per wave (goal, conventions, board snapshot, file map). Spec caps sharedContext at 200,000 chars (BATCH-DISPATCH-SPEC.md §4); 15k is a mid-size working value." },
  { name: "context_brief_bytes", value: 1200, unit: "bytes", provenance: `${ASSUMED} (spec-bounded)`,
    note: "Per-worker brief delta. Spec caps brief at 2,000 chars (BATCH-DISPATCH-SPEC.md §4)." },
  { name: "dispatch_share_total_time", value: 0.231, unit: "ratio", provenance: `${MEASURED} (docs/BATCH-DISPATCH-SPEC.md §1)`,
    note: "Coordinator dispatch is 23.1% of total wave time." },
  { name: "total_overhead_ratio_ref", value: 0.37, unit: "ratio", provenance: `${MEASURED} (lane point measurement)`,
    note: "37% total coordination overhead at the reference wave." },
  { name: "calibration_N", value: 100, unit: "agents", provenance: ASSUMED,
    note: "Reference wave size for calibration (the 37%/23.1% point measurements were not tagged with N)." },
  { name: "report_read_time", value: 9.0, unit: "units/report", provenance: `${ASSUMED} (calibrated)`,
    note: "Coordinator time to read + reconcile one free-text worker report. Structured receipts + digest (lever 'digest') replace N reads with one digest read." },
  { name: "digest_read_cost", value: 15, unit: "units/digest", provenance: `${ASSUMED} (modeled)`,
    note: "Coordinator cost to read the single aggregated digest. Sized at ~1.7× one free-text report: digest is denser than a report but read once." },
  { name: "events_per_lifecycle", value: 6.5, unit: "events", provenance: `${MEASURED} (docs/STANDING-CLAIMS-PROPOSAL.md §a)`,
    note: "Room events per claim lifecycle: create+acquired ~2, state updates ~1–2, heartbeat ~1, PR link/CI/settle ~1–1.5." },
  { name: "events_per_lifecycle_standing", value: 1.5, unit: "events", provenance: `${ASSUMED} (derived from docs/STANDING-CLAIMS-PROPOSAL.md §b)`,
    note: "Amortized toll under standing claims: claim once per lane per wave + heartbeat + structured-receipt links per task. ~77% below the 6.5-event toll." },
  { name: "event_cost", value: 2.0, unit: "units/event", provenance: `${ASSUMED} (calibrated)`,
    note: "Coordinator attention per room event (read, reconcile, act). Calibrated jointly with the other terms." },
  { name: "event_ceiling", value: 10000, unit: "events", provenance: `${MEASURED} (docs/STANDING-CLAIMS-PROPOSAL.md §a, per docs/WORK-CLAIMS.md)`,
    note: "Room lifetime event budget. Model feasibility requires room_events(N) < ceiling per wave-window." },
  { name: "event_refuse_ratio", value: 0.90, unit: "ratio", provenance: `${MEASURED} (docs/WORK-CLAIMS.md, via STANDING-CLAIMS-PROPOSAL.md §a)`,
    note: "Server refuses non-owner board writes at 90% of the event budget — effective operational cap 9,000 events." },
  { name: "tasks_per_agent", value: 1, unit: "tasks", provenance: `${ASSUMED} (default)`,
    note: "Claim lifecycles per agent per wave. STANDING-CLAIMS-PROPOSAL.md treats 5 tasks/agent as a typical heavy wave; sweep with --tasks-per-agent=5." },
  { name: "batch_cap", value: 100, unit: "workers", provenance: `${MEASURED} (docs/BATCH-DISPATCH-SPEC.md §4)`,
    note: "Worker count cap per batch dispatch manifest." },
];

const SWEEP_N = [10, 25, 50, 100, 250, 500];

function param(name) {
  const p = PARAMS.find((p) => p.name === name);
  if (!p) throw new Error(`unknown parameter ${name}`);
  return p.value;
}

/**
 * Per-N overhead breakdown under a lever set.
 * levers: { batch?: bool, digest?: bool, standing?: bool }
 */
function breakdown(N, levers = {}, tasksPerAgent = 1) {
  const f = param("dispatch_fixed");
  const alpha = param("burst_exponent");
  const calN = param("calibration_N");
  const v = param("dispatch_variable");
  const shared = param("context_shared_bytes");
  const brief = param("context_brief_bytes");
  const r = param("report_read_time");
  const e = param("event_cost");

  // Fan-out width the contention term is computed against: N, or the
  // batch count when batch dispatch collapses the fan-out.
  let width, batches = 1;
  let fixedBase, variableBytes;
  if (levers.batch) {
    batches = Math.ceil(N / param("batch_cap"));
    width = batches;
    fixedBase = f * batches;                       // one coordinator turn per batch
    variableBytes = brief * N + shared * batches; // shared sent once per batch
  } else {
    width = N;
    fixedBase = f * N;
    variableBytes = (shared + brief) * N;
  }
  // No contention relief below the reference width: the calibrated
  // dispatch_fixed is anchored there, and worker-1 measured absolute
  // rtt ~734 ms even at width 3.
  const contentionMult = Math.max(1, Math.pow(width / calN, alpha));
  const fixed = fixedBase * contentionMult;
  const burst = fixed - fixedBase; // superlinear surcharge over constant-per-spawn
  const variable = v * variableBytes;

  const report = levers.digest ? param("digest_read_cost") : r * N;

  const eventsPerTask = levers.standing
    ? param("events_per_lifecycle_standing")
    : param("events_per_lifecycle");
  const eventsCount = eventsPerTask * tasksPerAgent * N;
  const events = e * eventsCount;

  const total = fixed + variable + report + events;
  const productive = param("productive_per_agent") * N;
  return { N, fixed, fixedBase, burst, variable, report, events, eventsCount,
           total, productive, ratio: total / (total + productive) };
}

function dominantComponent(b) {
  const parts = [
    ["dispatch_fixed", b.fixedBase],
    ["burst_contention", b.burst],
    ["dispatch_variable×context", b.variable],
    ["report_read", b.report],
    ["room_events", b.events],
  ];
  parts.sort((a, b2) => b2[1] - a[1]);
  return { name: parts[0][0], share: parts[0][1] / b.total };
}

function feasibility(eventsCount) {
  const ceiling = param("event_ceiling");
  const refuseAt = ceiling * param("event_refuse_ratio");
  if (eventsCount >= ceiling) return "INFEASIBLE (≥10k event ceiling)";
  if (eventsCount >= refuseAt) return "WARNING (≥90% — server refuses non-owner board writes)";
  return "feasible";
}

function sweep(levers = {}, tasksPerAgent = 1) {
  return SWEEP_N.map((N) => {
    const b = breakdown(N, levers, tasksPerAgent);
    const d = dominantComponent(b);
    return { ...b, dominant: d.name, dominantShare: d.share, feasibility: feasibility(b.eventsCount) };
  });
}

function fmtPct(x, dp = 1) { return (x * 100).toFixed(dp) + "%"; }
function fmtN(x) { return x >= 10000 ? x.toLocaleString("en-US") : Math.round(x).toString(); }

function printParams() {
  console.log("# Parameter table");
  for (const p of PARAMS) {
    console.log(`- ${p.name} = ${p.value}${p.unit ? ` ${p.unit}` : ""}  [${p.provenance}] — ${p.note}`);
  }
  console.log();
}

function printSweep(title, levers, tasksPerAgent) {
  console.log(`## ${title}  (tasks/agent=${tasksPerAgent})`);
  console.log("N | overhead units | ratio | dominant component | room events | feasibility");
  console.log("--|---------------|-------|-------------------|-------------|----------------");
  for (const row of sweep(levers, tasksPerAgent)) {
    console.log(
      `${row.N} | ${fmtN(row.total)} | ${fmtPct(row.ratio)} | ${row.dominant} (${fmtPct(row.dominantShare, 0)}) | ${fmtN(row.eventsCount)} | ${row.feasibility}`
    );
  }
  console.log();
}

function leverImpactAt500(tasksPerAgent = 1) {
  const base = breakdown(500, {}, tasksPerAgent).total;
  const defs = [
    ["batch dispatch", { batch: true }],
    ["structured receipts + digest", { digest: true }],
    ["standing claims", { standing: true }],
  ];
  const rows = defs.map(([name, levers]) => {
    const b = breakdown(500, levers, tasksPerAgent);
    const baseRatio = breakdown(500, {}, tasksPerAgent).ratio;
    return { name, saved: base - b.total, ratio: b.ratio, deltaPp: (baseRatio - b.ratio) * 100 };
  });
  rows.sort((a, b) => b.saved - a.saved);
  return rows;
}

function main() {
  const args = process.argv.slice(2);
  const levers = {};
  let tasksPerAgent = 1;
  let json = false;
  for (const a of args) {
    if (a.startsWith("--levers=")) for (const l of a.slice(9).split(",")) levers[l.trim()] = true;
    else if (a.startsWith("--tasks-per-agent=")) tasksPerAgent = Number(a.slice(18));
    else if (a === "--json") json = true;
    else { console.error(`unknown arg ${a}`); process.exit(2); }
  }
  for (const l of Object.keys(levers)) {
    if (!["batch", "digest", "standing"].includes(l)) { console.error(`unknown lever ${l}`); process.exit(2); }
  }
  if (!(tasksPerAgent > 0)) { console.error("tasks-per-agent must be > 0"); process.exit(2); }

  if (json) {
    console.log(JSON.stringify({
      parameters: PARAMS.map((p) => ({ name: p.name, value: p.value, unit: p.unit, provenance: p.provenance, note: p.note })),
      sweep_N: SWEEP_N,
      naive: sweep({}, tasksPerAgent),
      levered: sweep(levers, tasksPerAgent),
      leverRanking_N500: leverImpactAt500(tasksPerAgent),
      allLevers_N500: breakdown(500, { batch: true, digest: true, standing: true }, tasksPerAgent),
    }, null, 2));
    return;
  }

  printParams();
  printSweep("Naive (no levers)", {}, tasksPerAgent);
  if (tasksPerAgent === 1) {
    printSweep("Naive — typical heavy wave", {}, 5);
  }
  const leverName = Object.keys(levers).sort().join("+");
  if (leverName) printSweep(`Levered (${leverName})`, levers, tasksPerAgent);

  console.log("## Top-3 levers at N=500, ranked by modeled overhead saved");
  const base500 = breakdown(500, {}, tasksPerAgent);
  console.log(`baseline N=500: ${fmtN(base500.total)} units, ratio ${fmtPct(base500.ratio)}, events ${fmtN(base500.eventsCount)} (${feasibility(base500.eventsCount)})`);
  leverImpactAt500(tasksPerAgent).forEach((r, i) => {
    console.log(`${i + 1}. ${r.name}: saves ${fmtN(r.saved)} units → ratio ${fmtPct(r.ratio)} (−${r.deltaPp.toFixed(1)}pp)`);
  });
  const all = breakdown(500, { batch: true, digest: true, standing: true }, tasksPerAgent);
  console.log(`all three levers: ${fmtN(all.total)} units, ratio ${fmtPct(all.ratio)}, events ${fmtN(all.eventsCount)} (${feasibility(all.eventsCount)})`);
}

main();
