#!/usr/bin/env node
// partition-plan.mjs — static partition planner for parallel agent work.
//
// Takes a JSON task list and emits K non-overlapping partitions: no file or
// directory appears in two partitions, partitions are balanced by task count
// (±1), and each partition gets its own claim-id namespace
// (claimPrefix + "-p" + partition index).
//
// Why: static partitioning produced zero conflicts/duplicates across 40 tasks
// in the WAVE-500 coordination-overhead study, while unpartitioned work
// produced duplicate byte-identical fixes. This tool industrializes that
// finding: give it a task list, get conflict-free lane assignments.
//
// Algorithm (two phases):
//   1. Greedy graph coloring (largest-degree-first) on the file-overlap
//      conflict graph. Nodes are tasks; an edge joins two tasks whose file
//      or dir footprints overlap (same file, or a dir owning the other's
//      path). Each color class is internally conflict-free.
//   2. Balanced bin-packing with must-link closure: property (a) — no
//      file/dir in two partitions — FORCES conflicting tasks to be
//      co-located in one partition (coloring alone would separate them and
//      violate (a)). So color classes joined by conflicts are merged first
//      (closure = connected components, the indivisible atoms), then atoms
//      are packed into exactly K bins, largest-first into the smallest bin,
//      with local improvement until max-min size <= 1.
//
//      Each partition also emits execution WAVES: its tasks grouped by color,
//      so a lane can run each wave in parallel and sequence across waves.
//
// Guarantees (verified, not trusted):
//   (a) cross-partition non-overlap holds BY CONSTRUCTION — conflicting
//       tasks are never separated across partitions; a final independent
//       check recomputes it from the emitted bins.
//   (b) balance is best-effort and HONESTLY REPORTED — an indivisible
//       component larger than ceil(N/K) makes ±1 impossible; the residual
//       imbalance is printed, not hidden.
//   (c) deterministic: identical input always yields the identical plan.
//
// What it cannot do (see docs/PARTITION-PLANNER.md): semantic overlap with
// no file overlap — two lanes changing the same API contract from different
// files will sail through. Static partitioning is a floor, not a ceiling.
//
// Usage:
//   node scripts/partition-plan.mjs --tasks tasks.json --partitions 10
//   node scripts/partition-plan.mjs --demo wave300 --partitions 10
//   node scripts/partition-plan.mjs --tasks tasks.json -k 10 --prefix wave300 \
//       --out plan.json --json
//
// Input JSON: a bare array, or {"tasks": [...], "claimPrefix": "..."}.
//   Each task: {id, files[], dirs[], claimPrefix} — extra fields pass through.
//
// Exit codes: 0 clean plan · 1 plan with overlap violations or residual
// imbalance (coordinator attention) · 2 usage or input error.

import fs from "node:fs";

const VERSION = 1;

// ---------------------------------------------------------------------------
// Demo: the WAVE-300 ten-lane split (40 tasks), modeled as planner input.
// Lanes: data-plane, reaper, backpressure, fanout, shards, payloads, replay,
// stranger-qa, burn-down, telemetry. Each task owns disjoint files, so the
// planner must reproduce a conflict-free 10-way split, 4 tasks per lane.
// ---------------------------------------------------------------------------

const t = (id, lane, files, dirs = []) => ({ id, lane, files, dirs, claimPrefix: "wave300" });

const WAVE300_DEMO = {
  claimPrefix: "wave300",
  tasks: [
    // data-plane fastpath (lane 1)
    t("dp-fastpath-cache", "data-plane", ["server/data-plane-cache.mjs", "tests/data-plane-cache.test.js"]),
    t("dp-fastpath-batch", "data-plane", ["server/data-plane-batch.mjs", "tests/data-plane-batch.test.js"]),
    t("dp-fastpath-index", "data-plane", ["server/data-plane-index.mjs", "tests/data-plane-index.test.js"]),
    t("dp-fastpath-bench", "data-plane", ["scripts/dp-bench.mjs", "docs/DATA-PLANE-PERF.md"]),
    // reaper: read purity + reaper (lane 2)
    t("reaper-sweep", "reaper", ["server/reaper.mjs", "tests/reaper.test.js"]),
    t("reaper-purity", "reaper", ["server/read-purity.mjs", "tests/read-purity.test.js"]),
    t("reaper-scan", "reaper", ["scripts/reaper-scan.mjs", "tests/reaper-scan.test.js"]),
    t("reaper-docs", "reaper", ["docs/REAPER.md", "docs/READ-PURITY.md"]),
    // honest backpressure (lane 3)
    t("bp-admission", "backpressure", ["server/admission.mjs", "tests/admission.test.js"]),
    t("bp-backpressure", "backpressure", ["server/backpressure.mjs", "tests/backpressure.test.js"]),
    t("bp-load-shed", "backpressure", ["server/load-shed.mjs", "tests/load-shed.test.js"]),
    t("bp-policy", "backpressure", ["docs/BACKPRESSURE-POLICY.md", "tests/backpressure-policy.test.js"]),
    // fan-out perf (lane 4)
    t("fanout-core", "fanout", ["server/fanout.mjs", "tests/fanout.test.js"]),
    t("fanout-worker", "fanout", ["server/fanout-worker.mjs", "tests/fanout-worker.test.js"]),
    t("fanout-retry", "fanout", ["server/fanout-retry.mjs", "tests/fanout-retry.test.js"]),
    t("fanout-bench", "fanout", ["scripts/fanout-bench.mjs", "docs/FANOUT-PERF.md"]),
    // sharded claim boards (lane 5)
    t("shard-board", "shards", ["server/shard-board.mjs", "tests/shard-board.test.js"]),
    t("shard-router", "shards", ["server/shard-router.mjs", "tests/shard-router.test.js"]),
    t("shard-claims", "shards", ["server/shard-claims.mjs", "tests/shard-claims.test.js"]),
    t("shard-migrate", "shards", ["scripts/shard-migrate.mjs", "docs/SHARD-BOARDS.md"]),
    // payload store (lane 6)
    t("payload-store", "payloads", ["server/payload-store.mjs", "tests/payload-store.test.js"]),
    t("payload-gc", "payloads", ["server/payload-gc.mjs", "tests/payload-gc.test.js"]),
    t("payload-encrypt", "payloads", ["server/payload-encrypt.mjs", "tests/payload-encrypt.test.js"]),
    t("payload-docs", "payloads", ["docs/PAYLOAD-STORE.md"]),
    // replay harness (lane 7)
    t("replay-capture", "replay", ["server/replay-capture.mjs", "tests/replay-capture.test.js"]),
    t("replay-harness", "replay", ["scripts/replay-harness.mjs", "tests/replay-harness.test.js"]),
    t("replay-diff", "replay", ["scripts/replay-diff.mjs", "tests/replay-diff.test.js"]),
    t("replay-docs", "replay", ["docs/REPLAY-HARNESS.md"]),
    // stranger-QA round 2 (lane 8)
    t("stranger-flow", "stranger-qa", ["tests/stranger-flow.test.js", "scripts/stranger-probe.mjs"]),
    t("stranger-onboard", "stranger-qa", ["scripts/stranger-onboard-check.mjs", "docs/STRANGER-QA.md"]),
    t("stranger-mobile", "stranger-qa", ["tests/stranger-mobile.test.js"]),
    t("stranger-2min", "stranger-qa", ["tests/stranger-two-minute.test.js", "docs/STRANGER-2MIN-RULE.md"]),
    // ranked-fixes burn-down (lane 9)
    t("ranked-fixes", "burn-down", ["scripts/ranked-fixes.mjs", "tests/ranked-fixes.test.js"]),
    t("burndown-report", "burn-down", ["scripts/burndown-report.mjs", "docs/RANKED-FIXES.md"]),
    t("burndown-board", "burn-down", ["scripts/burndown-board.mjs", "tests/burndown-board.test.js"]),
    t("burndown-triage", "burn-down", ["scripts/burndown-triage.mjs", "tests/burndown-triage.test.js"]),
    // telemetry-prod (lane 10)
    t("telemetry-core", "telemetry", ["server/telemetry.mjs", "tests/telemetry.test.js"]),
    t("telemetry-dash", "telemetry", ["scripts/telemetry-dash.mjs", "docs/TELEMETRY.md"]),
    t("telemetry-alerts", "telemetry", ["server/telemetry-alerts.mjs", "tests/telemetry-alerts.test.js"]),
    // coordination-only task: no files. Conflicts with nothing; the planner
    // absorbs it into whichever partition needs the count.
    t("telemetry-coord", "telemetry", []),
  ],
};

// ---------------------------------------------------------------------------
// Path + overlap utilities
// ---------------------------------------------------------------------------

function normFile(p) {
  return String(p).replace(/^\.\//, "").replace(/^\//, "");
}

function normDir(p) {
  return normFile(p).replace(/\/+$/, "");
}

// Segment-aware: "server/x" owns "server/x.mjs" but NOT "server/xyz.mjs".
function underDir(file, dir) {
  return file === dir || file.startsWith(dir + "/");
}

// Returns the overlapping footprint entries, [] when disjoint.
function footprintOverlap(a, b) {
  const hits = [];
  const aFiles = (a.files || []).map(normFile);
  const bFiles = (b.files || []).map(normFile);
  const aDirs = (a.dirs || []).map(normDir).filter(Boolean);
  const bDirs = (b.dirs || []).map(normDir).filter(Boolean);
  for (const f of aFiles) {
    if (bFiles.includes(f)) hits.push({ a: f, b: f });
    for (const d of bDirs) if (underDir(f, d)) hits.push({ a: f, b: d + "/" });
  }
  for (const f of bFiles) {
    for (const d of aDirs) if (underDir(f, d)) hits.push({ a: d + "/", b: f });
  }
  for (const d1 of aDirs) {
    for (const d2 of bDirs) {
      if (underDir(d1, d2) || underDir(d2, d1)) hits.push({ a: d1 + "/", b: d2 + "/" });
    }
  }
  return hits;
}

function tasksConflict(a, b) {
  return footprintOverlap(a, b).length > 0;
}

// ---------------------------------------------------------------------------
// Phase 1: conflict graph + greedy coloring (largest-degree-first)
// ---------------------------------------------------------------------------

function buildConflictGraph(tasks) {
  const n = tasks.length;
  const adj = Array.from({ length: n }, () => new Set());
  let edges = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (tasksConflict(tasks[i], tasks[j])) {
        adj[i].add(j);
        adj[j].add(i);
        edges++;
      }
    }
  }
  return { adj, edges };
}

function greedyColor(tasks, adj) {
  const n = tasks.length;
  const order = [...Array(n).keys()].sort((x, y) => {
    const d = adj[y].size - adj[x].size;
    return d !== 0 ? d : String(tasks[x].id).localeCompare(String(tasks[y].id));
  });
  const colors = new Array(n).fill(-1);
  for (const i of order) {
    const used = new Set();
    for (const nb of adj[i]) if (colors[nb] !== -1) used.add(colors[nb]);
    let c = 0;
    while (used.has(c)) c++;
    colors[i] = c;
  }
  const groups = new Map();
  for (const i of order) {
    if (!groups.has(colors[i])) groups.set(colors[i], []);
    groups.get(colors[i]).push(i);
  }
  return { colors, groups: [...groups.values()] };
}

// ---------------------------------------------------------------------------
// Phase 2: balanced bin-packing with must-link closure.
//
// Property (a) forces conflicting tasks into the SAME partition, so the
// indivisible atoms are the conflict graph's connected components (the
// must-link closure over the color classes). Components are packed into
// exactly K bins: largest-first into the currently smallest bin, then local
// improvement (move one atom from a max bin to a min bin while the spread
// strictly shrinks) until max-min <= 1. Best-effort: an atom larger than
// ceil(N/K) makes ±1 impossible, and the residual imbalance is reported.
//
// K > component count cannot satisfy (a) with K non-empty partitions
// (splitting a component separates conflicting tasks), so it is a usage
// error unless --allow-overlap explicitly opts into overlap violations.
// ---------------------------------------------------------------------------

function connectedComponents(tasks, adj) {
  const n = tasks.length;
  const seen = new Array(n).fill(false);
  const comps = [];
  for (let s = 0; s < n; s++) {
    if (seen[s]) continue;
    const comp = [];
    const stack = [s];
    seen[s] = true;
    while (stack.length > 0) {
      const i = stack.pop();
      comp.push(i);
      for (const nb of adj[i]) {
        if (!seen[nb]) {
          seen[nb] = true;
          stack.push(nb);
        }
      }
    }
    comp.sort((x, y) => String(tasks[x].id).localeCompare(String(tasks[y].id)));
    comps.push(comp);
  }
  // Deterministic atom order: largest first, ties by first task id.
  comps.sort((a, b) => b.length - a.length || String(tasks[a[0]].id).localeCompare(String(tasks[b[0]].id)));
  return comps;
}

// Split atoms (only under --allow-overlap): halve the largest atom until we
// have K bins. Halving a component separates conflicting tasks, so the
// resulting cross-partition overlaps are reported as violations.
function splitAtomsToK(bins, K) {
  while (bins.length < K) {
    let li = 0;
    for (let i = 1; i < bins.length; i++) {
      if (bins[i].length > bins[li].length) li = i;
    }
    const big = bins[li];
    if (big.length < 2) throw new Error(`cannot fill ${K} partitions from ${bins.length} indivisible groups`);
    const mid = Math.ceil(big.length / 2);
    bins = bins.filter((_, idx) => idx !== li);
    bins.push(big.slice(0, mid), big.slice(mid));
  }
  return bins;
}

function packAtoms(atoms, tasks, K) {
  const bins = Array.from({ length: K }, () => []);
  for (const atom of atoms) {
    // Smallest bin first, ties by lowest index — deterministic.
    let bi = 0;
    for (let i = 1; i < K; i++) {
      if (bins[i].length < bins[bi].length) bi = i;
    }
    bins[bi].push(...atom);
  }
  // Local improvement: move one atom from a max bin to a min bin while the
  // max-min spread strictly shrinks.
  for (;;) {
    const sizes = bins.map((b) => b.length);
    const mx = Math.max(...sizes);
    const mn = Math.min(...sizes);
    if (mx - mn <= 1) break;
    let best = null; // {from, to, atomIdx, spread}
    for (let from = 0; from < K; from++) {
      if (bins[from].length !== mx) continue;
      for (let to = 0; to < K; to++) {
        if (to === from || bins[to].length !== mn) continue;
        // Candidate atoms are whole components currently in `from`.
        for (const atom of atomsInBin(bins[from], atoms)) {
          const nsFrom = bins[from].length - atom.length;
          const nsTo = bins[to].length + atom.length;
          const others = sizes.filter((_, i) => i !== from && i !== to);
          const spread = Math.max(nsFrom, nsTo, ...others) - Math.min(nsFrom, nsTo, ...others);
          const cur = { from, to, atom, spread };
          if (!best || spread < best.spread) best = cur;
        }
      }
    }
    if (!best || best.spread >= mx - mn) break;
    const { from, to, atom } = best;
    const atomSet = new Set(atom);
    bins[from] = bins[from].filter((i) => !atomSet.has(i));
    bins[to] = [...bins[to], ...atom];
  }
  // Merged components: final bins holding more than one connected
  // component (independent groups sharing a partition — informative, since
  // this is how balancing absorbs leftovers when atoms < K * ceil(N/K)).
  const atomOf = new Map();
  atoms.forEach((a, ai) => a.forEach((i) => atomOf.set(i, ai)));
  const mergedAtoms = [];
  for (const bin of bins) {
    const atomIds = [...new Set(bin.map((i) => atomOf.get(i)))].sort((x, y) => x - y);
    if (atomIds.length > 1) {
      mergedAtoms.push({
        partition: null, // filled after namespaces are assigned
        atoms: atomIds.map((ai) => atoms[ai].map((i) => tasks[i].id)),
      });
    }
  }
  return { bins, mergedAtoms };
}

// Whole connected components currently sitting in bin (task-index arrays).
function atomsInBin(bin, atoms) {
  const inBin = new Set(bin);
  return atoms.filter((a) => a.length > 0 && a.every((i) => inBin.has(i)));
}

// ---------------------------------------------------------------------------
// Orchestration + independent verification
// ---------------------------------------------------------------------------

function planPartitions(input, K, claimPrefix, opts = {}) {
  const tasks = input.tasks;
  if (!Array.isArray(tasks) || tasks.length === 0) throw new Error("no tasks in input");
  if (!Number.isInteger(K) || K < 1) throw new Error("--partitions must be a positive integer");
  if (K > tasks.length) {
    throw new Error(`--partitions ${K} exceeds task count ${tasks.length}: cannot fill K non-empty partitions`);
  }
  const seen = new Set();
  for (const tsk of tasks) {
    if (!tsk || typeof tsk.id !== "string" || !tsk.id) throw new Error("every task needs a string id");
    if (seen.has(tsk.id)) throw new Error(`duplicate task id: ${tsk.id}`);
    seen.add(tsk.id);
  }

  const { adj, edges } = buildConflictGraph(tasks);
  const { colors, groups } = greedyColor(tasks, adj);
  const atoms = connectedComponents(tasks, adj);

  let bins;
  let mergedAtoms = [];
  let overlapAllowed = false;
  if (atoms.length < K) {
    if (!opts.allowOverlap) {
      throw new Error(
        `tasks deconflict into only ${atoms.length} independent groups, fewer than ${K} requested partitions: ` +
          `splitting a group would put shared files in two partitions. Use fewer partitions or --allow-overlap.`,
      );
    }
    overlapAllowed = true;
    bins = splitAtomsToK(atoms.map((a) => [...a]), K);
  } else {
    const packed = packAtoms(atoms, tasks, K);
    bins = packed.bins;
    mergedAtoms = packed.mergedAtoms;
  }

  const partitions = bins.map((bin, index) => {
    const ns = `${claimPrefix}-p${index}`;
    // Execution waves: tasks grouped by color; each wave is internally
    // conflict-free, so a lane can parallelize within a wave and sequence
    // across waves.
    const byColor = new Map();
    for (const i of bin) {
      if (!byColor.has(colors[i])) byColor.set(colors[i], []);
      byColor.get(colors[i]).push(tasks[i].id);
    }
    const waves = [...byColor.entries()].sort((a, b) => a[0] - b[0]).map(([, ids]) => ids);
    return {
      index,
      claimNamespace: ns,
      taskIds: bin.map((i) => tasks[i].id),
      tasks: bin.map((i) => tasks[i]),
      waves,
    };
  });

  // Resolve merged-atom records to their final partition namespaces.
  const taskToPartition = new Map();
  for (const p of partitions) for (const id of p.taskIds) taskToPartition.set(id, p.claimNamespace);
  for (const m of mergedAtoms) m.partition = taskToPartition.get(m.atoms[0][0]);

  return {
    tasks,
    K,
    claimPrefix,
    partitions,
    mergedAtoms,
    overlapAllowed,
    stats: { conflictEdges: edges, colorsUsed: groups.length, components: atoms.length },
  };
}

// Independent verification: recomputed from the emitted bins, not trusted
// from the construction phases.
function verifyPlan(plan) {
  const { tasks, partitions } = plan;
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const crossPartitionOverlaps = [];
  for (let a = 0; a < partitions.length; a++) {
    for (let b = a + 1; b < partitions.length; b++) {
      for (const ida of partitions[a].taskIds) {
        for (const idb of partitions[b].taskIds) {
          const hits = footprintOverlap(byId.get(ida), byId.get(idb));
          if (hits.length > 0) {
            crossPartitionOverlaps.push({
              partitions: [partitions[a].claimNamespace, partitions[b].claimNamespace],
              tasks: [ida, idb],
              paths: hits,
            });
          }
        }
      }
    }
  }
  const internalConflicts = [];
  for (const p of partitions) {
    for (let x = 0; x < p.taskIds.length; x++) {
      for (let y = x + 1; y < p.taskIds.length; y++) {
        const hits = footprintOverlap(byId.get(p.taskIds[x]), byId.get(p.taskIds[y]));
        if (hits.length > 0) {
          internalConflicts.push({ partition: p.claimNamespace, tasks: [p.taskIds[x], p.taskIds[y]], paths: hits });
        }
      }
    }
  }
  const sizes = partitions.map((p) => p.taskIds.length);
  const balanced = Math.max(...sizes) - Math.min(...sizes) <= 1;
  const namespaces = new Set(partitions.map((p) => p.claimNamespace));
  return {
    crossPartitionOverlaps,
    internalConflicts,
    sizes,
    balanced,
    namespacesUnique: namespaces.size === partitions.length,
    mergedAtoms: plan.mergedAtoms,
    overlapAllowed: plan.overlapAllowed,
  };
}

// ---------------------------------------------------------------------------
// Output formatters
// ---------------------------------------------------------------------------

function footprintSummary(tsk) {
  const parts = [...(tsk.files || []), ...((tsk.dirs || []).map((d) => d.replace(/\/+$/, "") + "/"))];
  return parts.length > 0 ? parts.join(", ") : "(no files — coordination/research)";
}

function formatHuman(plan, verification) {
  const L = [];
  L.push(`PARTITION PLAN — ${plan.tasks.length} tasks → ${plan.K} partitions (claim prefix "${plan.claimPrefix}")`);
  L.push("=".repeat(72));
  for (const p of plan.partitions) {
    const pathCount = p.tasks.reduce((n, t) => n + (t.files || []).length + (t.dirs || []).length, 0);
    const waveStr = p.waves.map((w) => `{${w.join(", ")}}`).join(" » ");
    L.push(`[${p.claimNamespace}] ${p.taskIds.length} tasks · ${pathCount} paths · waves: ${waveStr}`);
    for (const tsk of p.tasks) {
      const lane = tsk.lane ? ` (${tsk.lane})` : "";
      L.push(`  ${tsk.id}${lane}`);
      L.push(`    ${footprintSummary(tsk)}`);
    }
  }
  L.push("-".repeat(72));
  L.push("VERIFICATION (recomputed from emitted bins)");
  const v = verification;
  L.push(`  cross-partition overlap : ${v.crossPartitionOverlaps.length === 0 ? "NONE" : v.crossPartitionOverlaps.length + " VIOLATIONS (--allow-overlap was given)"}`);
  for (const o of v.crossPartitionOverlaps) {
    L.push(`    !! ${o.partitions[0]} × ${o.partitions[1]}: ${o.tasks[0]} vs ${o.tasks[1]} → ${o.paths.map((h) => h.a).join(", ")}`);
  }
  const sizes = v.sizes;
  L.push(`  balance                 : ${v.balanced ? "OK" : "IMBALANCED"} — sizes [${sizes.join(", ")}] (max-min ${Math.max(...sizes) - Math.min(...sizes)})`);
  L.push(`  merged components       : ${v.mergedAtoms.length} (independent groups sharing a partition — no file overlap between them)`);
  for (const m of v.mergedAtoms) {
    L.push(`    [${m.partition}] ${m.atoms.map((g) => g.join("+")).join("  +  ")}`);
  }
  L.push(`  internal conflicts      : ${v.internalConflicts.length} (same file/dir inside one partition — serialize within the lane)`);
  for (const c of v.internalConflicts) {
    L.push(`    [${c.partition}] ${c.tasks[0]} × ${c.tasks[1]} → ${c.paths.map((h) => h.a).join(", ")}`);
  }
  L.push(`  claim namespaces unique : ${v.namespacesUnique ? "yes" : "NO"}`);
  L.push(`  edges / colors / groups : ${plan.stats.conflictEdges} edges → ${plan.stats.colorsUsed} greedy colors → ${plan.stats.components} independent groups`);
  if (v.crossPartitionOverlaps.length > 0 || !v.balanced) {
    L.push("");
    L.push("NOTE: this plan needs coordinator attention — see docs/PARTITION-PLANNER.md");
    L.push("(limitations) for what to do about overlap violations and imbalance.");
  }
  return L.join("\n");
}

function formatJSON(plan, verification) {
  return JSON.stringify(
    {
      tool: "partition-plan",
      version: VERSION,
      generatedAt: new Date().toISOString(),
      input: { taskCount: plan.tasks.length, requestedPartitions: plan.K, claimPrefix: plan.claimPrefix },
      partitions: plan.partitions.map((p) => ({
        index: p.index,
        claimNamespace: p.claimNamespace,
        taskIds: p.taskIds,
        waves: p.waves,
        tasks: p.tasks.map((t) => ({
          id: t.id,
          ...(t.lane ? { lane: t.lane } : {}),
          files: t.files || [],
          dirs: t.dirs || [],
        })),
        pathCount: p.tasks.reduce((n, t) => n + (t.files || []).length + (t.dirs || []).length, 0),
      })),
      verification: {
        crossPartitionOverlaps: verification.crossPartitionOverlaps,
        internalConflicts: verification.internalConflicts,
        sizes: verification.sizes,
        balanced: verification.balanced,
        namespacesUnique: verification.namespacesUnique,
        mergedAtoms: verification.mergedAtoms,
        overlapAllowed: verification.overlapAllowed,
      },
      stats: plan.stats,
    },
    null,
    2,
  );
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function usage(exitCode) {
  const msg = [
    "partition-plan.mjs — static partition planner for parallel agent work.",
    "",
    "Usage:",
    "  node scripts/partition-plan.mjs --tasks tasks.json --partitions 10 [--prefix X]",
    "  node scripts/partition-plan.mjs --demo wave300 [--partitions 10]",
    "",
    "Options:",
    "  --tasks FILE      JSON task list: [{id, files[], dirs[], claimPrefix}] or {tasks:[...], claimPrefix}",
    "  --demo wave300    built-in demo: the WAVE-300 ten-lane split (40 tasks)",
    "  --partitions K, -k K   number of partitions (required unless --demo)",
    "  --prefix P        claim-id prefix (default: input claimPrefix, else first task's)",
    "  --allow-overlap   permit K > independent-group count (overlap violations",
    "                    reported, exit 1); without it, that case is an error",
    "  --out FILE        write machine JSON to FILE",
    "  --json            also print machine JSON to stdout after the human plan",
    "  --help, -h        this text",
    "",
    "Exit: 0 clean plan · 1 plan with overlap violations or residual imbalance",
    "      (coordinator attention) · 2 usage or input error.",
  ].join("\n");
  console.log(msg);
  process.exitCode = exitCode;
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--tasks") opts.tasks = argv[++i];
    else if (a === "--demo") opts.demo = argv[++i];
    else if (a === "--partitions" || a === "-k") opts.partitions = Number(argv[++i]);
    else if (a === "--prefix") opts.prefix = argv[++i];
    else if (a === "--out") opts.out = argv[++i];
    else if (a === "--json") opts.json = true;
    else if (a === "--allow-overlap") opts.allowOverlap = true;
    else if (a === "--help" || a === "-h") usage(0);
    else {
      console.error(`unknown argument: ${a}`);
      usage(2);
    }
  }
  return opts;
}

function loadInput(opts) {
  if (opts.demo) {
    if (opts.demo !== "wave300") {
      console.error(`unknown demo: ${opts.demo} (available: wave300)`);
      process.exitCode = 2;
      return null;
    }
    return { ...WAVE300_DEMO, tasks: WAVE300_DEMO.tasks.map((t) => ({ ...t })) };
  }
  if (!opts.tasks) {
    console.error("need --tasks FILE or --demo wave300");
    usage(2);
    return null;
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(opts.tasks, "utf8"));
  } catch (e) {
    console.error(`cannot read/parse ${opts.tasks}: ${e.message}`);
    process.exitCode = 2;
    return null;
  }
  const tasks = Array.isArray(raw) ? raw : raw.tasks;
  const claimPrefix = raw.claimPrefix;
  if (!Array.isArray(tasks)) {
    console.error("input must be a task array or {tasks:[...]}");
    process.exitCode = 2;
    return null;
  }
  return { tasks, claimPrefix };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (process.exitCode) return;
  const input = loadInput(opts);
  if (!input) return;
  const K = opts.partitions ?? (opts.demo ? 10 : undefined);
  if (K === undefined) {
    console.error("need --partitions K");
    usage(2);
    return;
  }
  const prefix = opts.prefix ?? input.claimPrefix ?? input.tasks[0]?.claimPrefix ?? "plan";
  let plan;
  try {
    plan = planPartitions(input, K, prefix, { allowOverlap: opts.allowOverlap });
  } catch (e) {
    console.error(`error: ${e.message}`);
    process.exitCode = 2;
    return;
  }
  const verification = verifyPlan(plan);
  console.log(formatHuman(plan, verification));
  const json = formatJSON(plan, verification);
  if (opts.out) fs.writeFileSync(opts.out, json + "\n");
  if (opts.json) {
    console.log("\n--- MACHINE JSON ---");
    console.log(json);
  }
  const dirty = verification.crossPartitionOverlaps.length > 0 || !verification.balanced;
  if (dirty && (process.exitCode == null || process.exitCode === 0)) process.exitCode = 1;
}

main();
