// measure-spawn-latency.mjs — decompose per-spawn dispatch cost.
// Coordinator forks 5 trivial one-shot workers ("reply DONE immediately") and
// decomposes the spawn call -> delivered-report pipeline into:
//
//   (a) spawn call -> worker start        (tStart_worker - t0_coordinator)
//   (b) worker start -> first tool call   (tFirst_worker  - tStart_worker)
//   (c) final message -> delivery         (tDoneArrival_coordinator - tDone_worker)
//   (d) coordinator read/parse of report  (readFileSync + JSON.parse, timed)
//
// Two sweeps separate fixed from variable cost:
//   - brief-size sweep: SL_BRIEF env payload of 1KB / 16KB / 64KB / 256KB,
//     workers spawned sequentially (clean fixed cost, no burst contention)
//   - report-size sweep: report file of 2KB / 20KB / 200KB, isolates (c)+(d)
//   - one burst-5 run at 16KB brief for burst-contention comparison
//
// Raw per-worker rows land in .tmp/spawn-latency/*.json (worktree-local,
// git-ignored). This file prints the summary decomposition table.
//
// Usage: node scripts/measure-spawn-latency.mjs
import { fork } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const workerPath = join(here, 'spawn-latency-worker.mjs');
const outDir = join(here, '..', '.tmp', 'spawn-latency');
mkdirSync(outDir, { recursive: true });

// Wall-clock ms throughout: Date.now() shares one origin across processes.
// (performance.now() does not — it is per-process boot — so the worker records
// Date.now() per the brief's requirement.)
const nowMs = () => Date.now();

const BRIEF_SIZES = [1024, 16 * 1024, 64 * 1024, 120 * 1024]; // env-string ceiling ~128KB
const REPORT_SIZES = [2048, 20 * 1024, 200 * 1024];
const WORKERS = 5;
const ROUNDS = 3;

function filler(n, ch) {
  return ch.repeat(n);
}

function spawnOnce(briefBytes, reportBytes, tag, briefViaFile = false) {
  return new Promise((resolve, reject) => {
    const reportPath = join(outDir, `report-${tag}.json`);
    const env = { ...process.env, SL_REPORT_BYTES: String(reportBytes), SL_REPORT_PATH: reportPath };
    if (briefViaFile) {
      const briefPath = join(outDir, `brief-${tag}.bin`);
      writeFileSync(briefPath, filler(briefBytes, 'b'));
      env.SL_BRIEF_PATH = briefPath;
      delete env.SL_BRIEF;
    } else {
      env.SL_BRIEF = filler(briefBytes, 'b');
      delete env.SL_BRIEF_PATH;
    }
    const t0 = nowMs();
    const child = fork(workerPath, [], { env, silent: true });
    const rec = { t0, briefBytes, reportBytes, briefViaFile };
    child.on('message', (msg) => {
      const tNow = nowMs();
      if (msg.type === 'started') {
        rec.tStartedArrival = tNow;
        Object.assign(rec, { tStart: msg.tStart, tFirst: msg.tFirst });
      } else if (msg.type === 'done') {
        rec.tDoneArrival = tNow;
        rec.tDone = msg.tDone;
        // (d) coordinator read/parse of the report
        const tParse0 = nowMs();
        const raw = readFileSync(reportPath, 'utf8');
        const parsed = JSON.parse(raw);
        rec.readParseMs = nowMs() - tParse0;
        rec.parsedBytes = raw.length;
        rec.parsedOk = parsed.done === true;
      }
    });
    child.on('exit', (code) => {
      if (code !== 0) return reject(new Error(`worker exit ${code}`));
      // (a),(b),(c) decomposition
      rec.a_spawnToStart = rec.tStart - rec.t0;
      rec.b_startToFirstTool = rec.tFirst - rec.tStart;
      rec.c_finalToDelivery = rec.tDoneArrival - rec.tDone;
      rec.dispatchRtt = rec.tDoneArrival - rec.t0;
      resolve(rec);
    });
    child.on('error', reject);
  });
}

function mean(xs) {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function row(label, recs) {
  const m = (k) => mean(recs.map((r) => r[k]));
  return { label, n: recs.length, a: m('a_spawnToStart'), b: m('b_startToFirstTool'), c: m('c_finalToDelivery'), d: m('readParseMs'), rtt: m('dispatchRtt') };
}

function fmt(x) {
  return x < 10 ? x.toFixed(2) : x.toFixed(1);
}

async function main() {
  const all = [];
  console.log(`# SPAWN-LATENCY sweep: ${WORKERS} workers x ${ROUNDS} rounds, sequential`);
  console.log('# (a)=spawn->worker-start (b)=start->first-tool (c)=final->delivery (d)=read/parse, ms\n');
  console.log('| brief | report | a: spawn→start | b: start→1st-tool | c: final→delivery | d: read/parse | dispatch RTT |');
  console.log('|---|---|---|---|---|---|---|');
  for (const brief of BRIEF_SIZES) {
    const reportBytes = 2048;
    const recs = [];
    for (let r = 0; r < ROUNDS; r++) {
      for (let w = 0; w < WORKERS; w++) recs.push(await spawnOnce(brief, reportBytes, `b${brief}-r${r}-w${w}`));
    }
    const rr = row(`brief ${brief / 1024}KB`, recs);
    all.push({ ...rr, brief, reportBytes, recs });
    console.log(`| ${brief / 1024}KB | 2KB | ${fmt(rr.a)} | ${fmt(rr.b)} | ${fmt(rr.c)} | ${fmt(rr.d)} | ${fmt(rr.rtt)} |`);
  }
  // 1MB brief via sidecar file: does the payload-sidecar pattern keep spawn flat?
  const fileRecs = [];
  for (let r = 0; r < ROUNDS; r++) {
    for (let w = 0; w < WORKERS; w++) fileRecs.push(await spawnOnce(1024 * 1024, 2048, `file1m-r${r}-w${w}`, true));
  }
  const fr = row('brief 1MB (sidecar file)', fileRecs);
  all.push({ ...fr, brief: 1024 * 1024, reportBytes: 2048, briefViaFile: true, recs: fileRecs });
  console.log(`| 1MB (file) | 2KB | ${fmt(fr.a)} | ${fmt(fr.b)} | ${fmt(fr.c)} | ${fmt(fr.d)} | ${fmt(fr.rtt)} |`);
  console.log('| report | c: final→delivery | d: read/parse | report RTT delta |');
  console.log('|---|---|---|---|');
  for (const reportBytes of REPORT_SIZES) {
    if (reportBytes === 2048) continue; // already covered above
    const recs = [];
    for (let r = 0; r < ROUNDS; r++) {
      for (let w = 0; w < WORKERS; w++) recs.push(await spawnOnce(16 * 1024, reportBytes, `rep${reportBytes}-r${r}-w${w}`));
    }
    const rr = row(`report ${reportBytes / 1024}KB`, recs);
    all.push({ ...rr, brief: 16 * 1024, reportBytes, recs });
    console.log(`| ${reportBytes / 1024}KB | ${fmt(rr.c)} | ${fmt(rr.d)} | ${(rr.rtt).toFixed(1)} |`);
  }
  console.log('\n# burst-5 (parallel fork of 5, brief 16KB, report 2KB):');
  const burstRecs = [];
  for (let r = 0; r < ROUNDS; r++) {
    const batch = await Promise.all(
      Array.from({ length: WORKERS }, (_, w) => spawnOnce(16 * 1024, 2048, `burst-r${r}-w${w}`)),
    );
    burstRecs.push(...batch);
  }
  const br = row('burst-5', burstRecs);
  all.push({ ...br, brief: 16 * 1024, reportBytes: 2048, burst: true, recs: burstRecs });
  console.log(`| burst a=${fmt(br.a)} b=${fmt(br.b)} c=${fmt(br.c)} d=${fmt(br.d)} RTT=${fmt(br.rtt)} |`);

  // Persist raw rows (strip big recs' duplicated payloads — keep numbers only)
  const compact = all.map(({ recs, ...rest }) => ({
    ...rest,
    recs: recs.map((r) => ({
      a: r.a_spawnToStart, b: r.b_startToFirstTool, c: r.c_finalToDelivery,
      d: r.readParseMs, rtt: r.dispatchRtt, briefBytes: r.briefBytes,
      parsedBytes: r.parsedBytes, parsedOk: r.parsedOk,
    })),
  }));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = join(outDir, `spawn-latency-${stamp}.json`);
  writeFileSync(outPath, JSON.stringify(compact, null, 1));
  console.log(`\nraw: ${outPath}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
