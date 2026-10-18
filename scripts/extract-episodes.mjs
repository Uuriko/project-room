#!/usr/bin/env node
// Work-episode extract CLI (data programme W2).
//
//   node scripts/extract-episodes.mjs --snapshot <backup.ndjson> \
//     --out <episodes.ndjson> --report <report.json> --state <state.json> \
//     [--fleet-roster <refs.json>] [--full] [--allow-chain-break]
//
// Streams a trailer-verified snapshot through
// server/work-episode-extract.mjs and writes the episodes this run
// emits (new or changed since the state file's run; every episode on
// a full run). The state file is rewritten atomically for the next
// incremental run. The report carries the completeness measurement
// and the R3/B7 trigger counters alongside wall time, throughput, and
// peak RSS, so a run's numbers are reproducible from its artifacts.

import { createReadStream, createWriteStream, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { assembleWorkEpisodes } from "../server/work-episode-extract.mjs";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--full") args.full = true;
    else if (arg === "--allow-chain-break") args.allowChainBreak = true;
    else if (arg.startsWith("--")) args[arg.slice(2)] = argv[++i];
    else throw new Error(`unexpected argument: ${arg}`);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.snapshot) throw new Error("--snapshot <path> is required");
  const started = Date.now();

  let state = null;
  if (args.state && !args.full && existsSync(args.state)) {
    state = JSON.parse(readFileSync(args.state, "utf8"));
    if (state?.version !== 1) throw new Error(`unsupported extract state version: ${state?.version}`);
  }
  const fleetRoster = args["fleet-roster"] ? JSON.parse(readFileSync(args["fleet-roster"], "utf8")) : null;
  if (fleetRoster !== null && !Array.isArray(fleetRoster)) throw new Error("--fleet-roster must be a JSON array of party refs");

  const lines = createInterface({ input: createReadStream(args.snapshot, "utf8"), crlfDelay: Infinity });
  const { episodes, report, nextState } = await assembleWorkEpisodes({
    source: lines, state, allowChainBreak: Boolean(args["allow-chain-break"]), fleetRoster,
  });

  if (args.out) {
    const stream = createWriteStream(args.out, "utf8");
    for (const episode of episodes) stream.write(`${JSON.stringify(episode)}\n`);
    await new Promise((resolve, reject) => { stream.on("error", reject); stream.end(resolve); });
  }
  if (args.state) {
    const tmp = `${args.state}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(nextState)}\n`, "utf8");
    renameSync(tmp, args.state);
  }
  const wallMs = Date.now() - started;
  const fullReport = {
    ...report,
    run: {
      wallMs,
      assembledPerSecond: wallMs > 0 ? Math.round((report.totals.assembled / (wallMs / 1000)) * 10) / 10 : null,
      emitted: episodes.length,
      peakRssMb: Math.round(((process.resourceUsage().maxRSS ?? process.resourceUsage().maxrss ?? 0) / 1024) * 10) / 10,
      fleetRosterSupplied: fleetRoster !== null,
      incremental: state !== null,
    },
  };
  if (args.report) writeFileSync(args.report, `${JSON.stringify(fullReport, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({
    verification: report.snapshot.verification,
    episodesEmitted: episodes.length,
    episodesKnown: report.totals.episodesKnown,
    settled: report.surfaces.bounty?.settled ?? null,
    settledComplete: report.surfaces.bounty?.settledComplete ?? null,
    distinctOperators: report.triggerCounters?.distinctOperators ?? null,
    wallMs,
  })}\n`);
}

main().catch(error => {
  process.stderr.write(`extract-episodes: ${error.message}\n`);
  process.exit(2);
});
