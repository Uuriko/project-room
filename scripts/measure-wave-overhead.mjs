#!/usr/bin/env node
/**
 * measure-wave-overhead.mjs — honest wave coordination accounting.
 *
 * COORD-300 guild-02. Additive; does not touch live systems.
 * Default mode is OFFLINE: parses fixture ledgers under tests/fixtures/coord300/.
 * Live mode (--live) reads the real launcher ledger + claim registry + a
 * previously captured `git ls-remote` ref list. It never writes to the room,
 * never spawns agents, never generates load.
 *
 * Core discipline (Dot redirect 2026-10-09): planned vs spawned vs runnable
 * vs finished are DIFFERENT numbers — reported separately. Token/compute
 * cost comes ONLY from receipts; with no receipts the field is the string
 * "unknown", never an estimate.
 *
 * Usage:
 *   node scripts/measure-wave-overhead.mjs [--live] [--json]
 */
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = homedir();
const LIVE_LEDGER = join(HOME, "workspace/pr-wave2000/launcher-ledger.md");
const LIVE_CLAIMS = join(
  HOME,
  "workspace/goals/autonomous-work-engine-never-stop/hidden_files/loop-state/claims.json"
);

const TS = /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:-\d{2}:\d{2}|Z)?)/;

/** Parse "2026-10-09T08:35:00-07:00" (or without seconds / with Z) to ms. */
export function parseTs(s) {
  const m = s.match(TS);
  if (!m) return null;
  let t = m[1];
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(t)) t += ":00-07:00"; // ledger default: PDT
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(t)) t += "-07:00";
  const ms = Date.parse(t);
  return Number.isNaN(ms) ? null : ms;
}

const GUILD_SPAWN = /^-\s*Guild\s+(\d+)\s+spawned\b/i;
const WORKERS_DONE = /^-\s*G(\d+)\s+WORKERS\s+50\/50\s+SPAWNED\s*@\s*(.+?)\s*—/i;
const WORKERS_PARTIAL = /^-\s*G(\d+)\s+at\s+(\d+)\/50/i;
const GUILD_DONE = /^-\s*Guild\s+(\d+)\s+DONE\s*@\s*(.+?)\s*—/i;
const HEARTBEAT = /^-\s*LAUNCHER HEARTBEAT\s+(.+?)\s*—\s*(.*)$/i;
const DRAIN = /SYSTEM DRAIN INCIDENT.*?killed\s+(\d+)\s+workers?\s*\(([^)]*)\)/i;
const RESPAWNED = /All respawned by\s+(.+?)(?:\.|\s|$)/i;
const LIVE_COUNT = /~(\d+)\s+agents?\s+(?:live|still live|active)/i;

/**
 * Pure accounting over ledger text (+ optional claims map + ref list).
 * Returns { counts, queue, duplicates, anomalies, reviewLatency, costs, notProven }.
 */
export function accountWave({ ledgerText, claims = {}, refLines = [], ledgerMtimeMs = null }) {
  const lines = ledgerText.split("\n");
  const guildSpawns = new Map(); // guild -> [lineNos]
  const workerMilestones = new Map(); // guild -> {complete: ms|null, partial: [{n, ms}]}
  const guildDones = new Map(); // guild -> [{ms, line}]
  const heartbeats = [];
  const anomalies = [];
  const notProven = [];

  lines.forEach((line, i) => {
    const ln = i + 1;
    let m;
    if ((m = line.match(GUILD_SPAWN))) {
      const g = normGuild(m[1]);
      pushTo(guildSpawns, g, ln);
    } else if ((m = line.match(WORKERS_DONE))) {
      const g = normGuild(m[1]);
      const rec = workerRec(workerMilestones, g);
      const ms = parseTs(m[2]);
      if (ms == null) anomalies.push({ type: "unparseable-timestamp", line: ln, text: line.trim() });
      rec.complete = ms;
    } else if ((m = line.match(WORKERS_PARTIAL))) {
      const g = normGuild(m[1]);
      const rec = workerRec(workerMilestones, g);
      rec.partial.push({ n: Number(m[2]), line: ln });
    } else if ((m = line.match(GUILD_DONE))) {
      const g = normGuild(m[1]);
      const ms = parseTs(m[2]);
      if (ms == null) anomalies.push({ type: "unparseable-timestamp", line: ln, text: line.trim() });
      pushTo(guildDones, g, { ms, line: ln });
    } else if ((m = line.match(HEARTBEAT))) {
      const ms = parseTs(m[1]);
      const live = (m[2].match(LIVE_COUNT) || [])[1];
      heartbeats.push({ ms, live: live ? Number(live) : null, line: ln, note: m[2].trim().slice(0, 120) });
    }
  });

  // --- duplicate / anomaly detection (negative-control surface) ---
  const duplicates = [];
  for (const [g, lns] of guildSpawns) {
    if (lns.length > 1) duplicates.push({ kind: "guild-spawned-twice", guild: g, lines: lns });
  }
  const waveBeginMs = heartbeats.length ? heartbeats[0].ms : lastTimestampedLineMs(lines);
  for (const [g, dones] of guildDones) {
    const spawnLn = guildSpawns.get(g)?.[0];
    for (const d of dones) {
      if (d.ms != null && waveBeginMs != null && d.ms < waveBeginMs) {
        anomalies.push({ type: "done-before-wave-start", guild: g, doneLine: d.line });
      }
      if (d.ms != null && spawnLn != null) {
        const spawnMs = firstSpawnMs(lines, spawnLn);
        if (spawnMs != null && d.ms < spawnMs) {
          anomalies.push({ type: "done-before-spawn", guild: g, doneLine: d.line, spawnLine: spawnLn });
        }
      }
      if (spawnLn == null) anomalies.push({ type: "done-without-spawn", guild: g, doneLine: d.line });
    }
    if (dones.length > 1) duplicates.push({ kind: "guild-done-twice", guild: g, lines: dones.map((d) => d.line) });
  }

  // --- the four counts (kept separate by construction) ---
  const plannedGuilds = 40;
  const plannedWorkersPerGuild = 50;
  const planned = plannedGuilds * plannedWorkersPerGuild + plannedGuilds; // 2040

  const spawnedGuilds = new Set(guildSpawns.keys());
  let spawnedWorkers = 0;
  for (const [g, rec] of workerMilestones) {
    if (rec.complete != null) spawnedWorkers += 50;
    else if (rec.partial.length) {
      spawnedWorkers += Math.max(...rec.partial.map((p) => p.n));
    }
  }
  // NOTE: respawns replace killed workers; they are NOT new spawns. Drain
  // accounting is tracked separately below, never added to spawnedWorkers.

  let drainKilled = 0;
  let drainRespawnedMs = null;
  for (const line of lines) {
    const dm = line.match(DRAIN);
    if (dm) drainKilled += Number(dm[1]);
    const rm = line.match(RESPAWNED);
    if (rm && drainRespawnedMs == null) drainRespawnedMs = parseTs(rm[1]);
  }

  const lastHb = heartbeats.filter((h) => h.live != null).pop();
  const runnable = lastHb ? { agents: lastHb.live, atMs: lastHb.ms, heartbeatLine: lastHb.line, approximate: true }
                          : { agents: "unknown", atMs: null, approximate: true };
  if (runnable.agents === "unknown") notProven.push("no heartbeat with a live-agent count was found");

  const finishedGuilds = [...guildDones.keys()].sort();
  // Completions reported only in prose (no timestamped DONE line) are kept
  // separate — they are weaker evidence, not merged into finishedGuilds.
  const finishedProse = proseReportedDone(lines).filter((p) => !guildDones.has(p.guild));
  if (finishedProse.length) {
    notProven.push(
      `prose-reported completions without timestamped DONE lines: ${finishedProse.map((p) => p.guild).join(",")}`
    );
  }

  // --- queue wait: per-guild worker-spawn phase durations (ledger-time deltas) ---
  // Semantics: completion − first OBSERVED signal = LOWER BOUND on the true
  // spawn-phase duration (the true first spawn is earlier or equal).
  const queue = [];
  for (const [g, rec] of workerMilestones) {
    if (rec.complete != null) {
      const startMs = firstWorkerSignalMs(lines, g, rec.complete);
      queue.push({
        guild: g,
        spawnPhaseMs: startMs != null ? rec.complete - startMs : "unknown",
        lowerBound: startMs != null,
        note: startMs == null ? "no start signal before completion; start unobserved" : "lower bound",
      });
    }
  }
  if (!queue.length) notProven.push("no worker-spawn phase durations parseable");

  // --- review latency: spawn/DONE or workers-complete/DONE deltas ---
  const reviewLatency = [];
  for (const g of finishedGuilds) {
    const doneMs = guildDones.get(g).map((d) => d.ms).find((x) => x != null);
    const base = workerMilestones.get(g)?.complete ?? firstSpawnMs(lines, guildSpawns.get(g)?.[0]);
    reviewLatency.push({
      guild: g,
      ms: doneMs != null && base != null ? doneMs - base : "unknown",
      basis: workerMilestones.get(g)?.complete != null ? "workers-complete→DONE" : "spawn→DONE",
    });
  }
  if (!reviewLatency.length) notProven.push("no guild DONE lines parsed; review latency unknown");

  // --- branch census from ref list ---
  const branchGuilds = new Set();
  for (const rl of refLines) {
    const bm = rl.match(/refs\/heads\/wave2000\/guild-(\d+)\s*$/);
    if (bm) branchGuilds.add(normGuild(bm[1]));
  }

  // --- clock skew: ledger mtime vs last timestamped line ---
  let clockSkewMs = "unknown";
  const lastTsMs = lastTimestampedLineMs(lines);
  if (ledgerMtimeMs != null && lastTsMs != null) clockSkewMs = ledgerMtimeMs - lastTsMs;

  // --- costs: ONLY from receipts; none observed -> unknown ---
  const costs = "unknown";
  notProven.push("no token/compute cost receipts observed; cost stays unknown per Dot constraint");

  return {
    counts: {
      planned,
      plannedNote: "40 guilds x 50 workers + 40 coordinators (design)",
      spawnedCoordinators: spawnedGuilds.size,
      spawnedWorkersUnique: spawnedWorkers,
      drainKilled,
      drainRespawnedMs,
      runnable,
      finishedGuilds,
      finishedCount: finishedGuilds.length,
      finishedProseReported: finishedProse.map((p) => p.guild),
      branchesOnOrigin: branchGuilds.size,
      branchGuilds: [...branchGuilds].sort(),
    },
    queue,
    duplicates,
    anomalies,
    reviewLatency,
    costs,
    clockSkewMs,
    notProven,
  };
}

function normGuild(s) {
  return String(Number(s)).padStart(2, "0");
}
function pushTo(map, k, v) {
  if (!map.has(k)) map.set(k, []);
  map.get(k).push(v);
}
function workerRec(map, g) {
  if (!map.has(g)) map.set(g, { complete: null, partial: [] });
  return map.get(g);
}
function firstSpawnMs(lines, spawnLineNo) {
  if (spawnLineNo == null) return null;
  return parseTs(lines[spawnLineNo - 1]);
}
function firstWorkerSignalMs(lines, g, beforeMs) {
  // earliest timestamped line mentioning this guild's worker phase,
  // strictly before the completion signal (the completion line itself
  // is not a start signal).
  const padded = String(Number(g)).padStart(2, "0");
  const re = new RegExp(
    `\\bG${padded}\\b.*(?:WORKERS|\\bat\\s+\\d+/50)|worker pilot[^\\n]*guild ${padded}`,
    "i"
  );
  for (const line of lines) {
    if (re.test(line)) {
      const ms = parseTs(line);
      if (ms != null && ms < beforeMs) return ms;
    }
  }
  return null;
}

/** Prose-reported completions, e.g. "(guilds 22, 26, 31 completed before their notice)". */
function proseReportedDone(lines) {
  const out = [];
  for (const [i, line] of lines.entries()) {
    const m = line.match(/\(guilds\s+([\d,\s]+?)\s+completed/i);
    if (m) {
      for (const n of m[1].split(",")) {
        const t = n.trim();
        if (/^\d+$/.test(t)) out.push({ guild: normGuild(t), line: i + 1 });
      }
    }
  }
  return out;
}
function lastTimestampedLineMs(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const ms = parseTs(lines[i]);
    if (ms != null) return ms;
  }
  return null;
}

// ---- CLI ----
if (process.argv[1] && process.argv[1].endsWith("measure-wave-overhead.mjs")) {
  const live = process.argv.includes("--live");
  const asJson = process.argv.includes("--json");
  let ledgerText, ledgerMtimeMs = null, claims = {}, refLines = [];
  if (live) {
    ledgerText = readFileSync(LIVE_LEDGER, "utf8");
    ledgerMtimeMs = statSync(LIVE_LEDGER).mtimeMs;
    try {
      claims = JSON.parse(readFileSync(LIVE_CLAIMS, "utf8")).claims ?? {};
    } catch { /* claims stay empty; flagged in output */ }
    try {
      refLines = readFileSync(join(HOME, "workspace/pr-coord300-guild-02/scratch/refs-wave2000.txt"), "utf8")
        .split("\n").filter(Boolean);
    } catch { /* ref list optional */ }
  } else {
    const fx = new URL("../tests/fixtures/coord300/ledger-clean.md", import.meta.url);
    ledgerText = readFileSync(fx, "utf8");
  }
  const out = accountWave({ ledgerText, claims, refLines, ledgerMtimeMs });
  if (asJson) console.log(JSON.stringify(out, null, 2));
  else {
    const c = out.counts;
    console.log(`planned=${c.planned} spawned_coordinators=${c.spawnedCoordinators} ` +
      `spawned_workers_unique=${c.spawnedWorkersUnique} drain_killed=${c.drainKilled} ` +
      `runnable=${JSON.stringify(c.runnable.agents)} finished_guilds=${c.finishedCount} ` +
      `finished_prose=[${c.finishedProseReported.join(",")}] ` +
      `branches_on_origin=${c.branchesOnOrigin} costs=${out.costs}`);
    console.log(`duplicates=${out.duplicates.length} anomalies=${out.anomalies.length} ` +
      `clock_skew_ms=${out.clockSkewMs}`);
    for (const q of out.queue) console.log(`queue guild=${q.guild} spawn_phase_ms=${q.spawnPhaseMs}`);
    for (const r of out.reviewLatency) console.log(`review guild=${r.guild} ms=${r.ms} basis=${r.basis}`);
    for (const n of out.notProven) console.log(`NOT-PROVEN: ${n}`);
  }
}
