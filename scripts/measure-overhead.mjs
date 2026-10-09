#!/usr/bin/env node
// measure-overhead.mjs — coordination-overhead measurement harness (WAVE-500).
//
// Spawns N synthetic one-shot workers (see measure-overhead-worker.mjs) on a
// trivial task ("write a 10-line file, report back") and measures, per worker:
//
//   (a) dispatch round-trip: coordinator fork() call -> worker's first IPC
//       message, the analogue of "spawn call -> worker's first tool call";
//   (b) coordinator read/parse time: readFileSync + JSON.parse of the worker's
//       completion report;
//   (c) room events consumed per worker lifecycle: CLAIM/PROGRESS/DONE posts
//       appended to a JSONL event log (single serialized writer, like the
//       room's event log), with the per-event append cost timed.
//
// It then reports the overhead ratio  overhead / (work + overhead), where
//   work     = sum of worker self-measured pure task time, and
//   overhead = sum of (dispatch_rtt + report read/parse + event appends).
//
// Usage:
//   node scripts/measure-overhead.mjs --workers 8 --runs 3 --out report.json
//
// Flags: --workers N (default 4), --runs R (default 1), --out PATH,
//        --tmp DIR (default $TMPDIR or <worktree>/.tmp/overhead-<ts>).
import { fork } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKTREE = join(HERE, '..');
const WORKER = join(HERE, 'measure-overhead-worker.mjs');
const WORKER_TIMEOUT_MS = 30_000;

const now = () => performance.now();

function parseArgs(argv) {
  const out = { workers: 4, runs: 1, out: null, tmp: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--workers') out.workers = Math.max(1, parseInt(argv[++i], 10) || 4);
    else if (a === '--runs') out.runs = Math.max(1, parseInt(argv[++i], 10) || 1);
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--tmp') out.tmp = argv[++i];
    else if (a === '--help' || a === '-h') { console.log(USAGE); process.exit(0); }
    else { console.error(`unknown flag: ${a}\n${USAGE}`); process.exit(2); }
  }
  return out;
}
const USAGE = `usage: node scripts/measure-overhead.mjs [--workers N] [--runs R] [--out PATH] [--tmp DIR]`;

function stats(xs) {
  const s = [...xs].filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return { n: 0, mean: null, p50: null, p95: null, max: null };
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: s.length, mean: s.reduce((a, b) => a + b, 0) / s.length, p50: q(0.5), p95: q(0.95), max: s[s.length - 1] };
}

function spawnWorker(i, runDir, onEvent) {
  return new Promise((resolve, reject) => {
    const id = `w${i}`;
    const taskFile = join(runDir, `task-${id}.txt`);
    const reportPath = join(runDir, `report-${id}.json`);
    const rec = {
      id, ok: false,
      dispatch_rtt_ms: null,   // (a) fork() -> worker's first observable action
      work_ms: null,           // worker self-measured pure task time
      report_read_parse_ms: null, // (b) coordinator read + JSON.parse of report
      event_append_ms: 0,      // coordinator-side cost of serializing room events
      room_events: 0,          // (c) CLAIM/PROGRESS/DONE posts
      lifecycle_ms: null,      // fork() -> worker exit
    };
    const tDispatch0 = now();
    let child;
    try {
      child = fork(WORKER, [], {
        env: {
          ...process.env,
          OVERHEAD_WORKER_ID: id,
          OVERHEAD_TASK_FILE: taskFile,
          OVERHEAD_REPORT_PATH: reportPath,
        },
        silent: true,
      });
    } catch (e) { reject(e); return; }
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`worker ${id} timed out`)); }, WORKER_TIMEOUT_MS);
    child.on('message', (m) => {
      if (!m || typeof m !== 'object') return;
      if (m.type === 'started' && rec.dispatch_rtt_ms === null) {
        rec.dispatch_rtt_ms = now() - tDispatch0; // (a)
      } else if (m.type === 'event') {
        rec.event_append_ms += onEvent(id, m.kind, m.t, m.note); // (c)
        rec.room_events += 1;
      } else if (m.type === 'done') {
        const r0 = now(); // (b)
        const raw = readFileSync(m.reportPath, 'utf8');
        const rep = JSON.parse(raw);
        rec.report_read_parse_ms = now() - r0;
        rec.work_ms = rep.work_ms;
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      rec.lifecycle_ms = now() - tDispatch0;
      rec.ok = code === 0 && rec.work_ms !== null;
      resolve(rec);
    });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

async function runOnce(n, runDir) {
  const eventLog = join(runDir, 'room-events.jsonl');
  let seq = 0;
  const onEvent = (worker, kind, t) => {
    const a0 = now();
    seq += 1;
    appendFileSync(eventLog, JSON.stringify({ seq, worker, kind, t }) + '\n');
    return now() - a0;
  };
  const tAll0 = now();
  // Dispatch in a tight burst, like a coordinator fanning out one-shot workers.
  const workers = await Promise.all(
    Array.from({ length: n }, (_, i) => spawnWorker(i, runDir, onEvent)),
  );
  const wallMs = now() - tAll0;
  return { workers, wallMs, eventLog, totalEvents: seq };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseTmp = args.tmp
    || process.env.TMPDIR
    || join(WORKTREE, '.tmp');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const runRoot = join(baseTmp, `overhead-${stamp}`);
  mkdirSync(runRoot, { recursive: true });

  const runs = [];
  for (let r = 0; r < args.runs; r++) {
    const runDir = join(runRoot, `run-${r}`);
    mkdirSync(runDir, { recursive: true });
    runs.push({ run: r, dir: runDir, ...(await runOnce(args.workers, runDir)) });
  }

  const all = runs.flatMap((r) => r.workers);
  const ok = all.filter((w) => w.ok);
  const overheadOf = (w) => (w.dispatch_rtt_ms ?? 0) + (w.report_read_parse_ms ?? 0) + w.event_append_ms;
  const totalWork = ok.reduce((a, w) => a + (w.work_ms ?? 0), 0);
  const totalOverhead = ok.reduce((a, w) => a + overheadOf(w), 0);
  const ratio = totalWork + totalOverhead > 0 ? totalOverhead / (totalWork + totalOverhead) : null;

  const dispatchTotal = ok.reduce((a, w) => a + (w.dispatch_rtt_ms ?? 0), 0);
  const reportTotal = ok.reduce((a, w) => a + (w.report_read_parse_ms ?? 0), 0);
  const eventsTotal = ok.reduce((a, w) => a + w.event_append_ms, 0);

  const report = {
    generated_at: new Date().toISOString(),
    config: { workers: args.workers, runs: args.runs },
    methodology: {
      worker: 'synthetic one-shot: IPC started (first-tool-call analogue) -> CLAIM -> write 10-line file + 200k-iter busy loop -> PROGRESS x2 -> JSON report -> DONE',
      dispatch_rtt_ms: 'coordinator fork() call to worker first IPC message',
      report_read_parse_ms: 'coordinator readFileSync + JSON.parse of completion report',
      room_events: 'CLAIM/PROGRESS/DONE appended to JSONL event log; per-event append cost timed on the coordinator',
      overhead: 'sum(dispatch_rtt + report_read_parse + event_append) per worker',
      work: 'worker self-measured pure task time (file write + busy loop)',
      ratio: 'total_overhead / (total_work + total_overhead)',
      caveat: 'dispatch here is node fork latency, not an LLM subagent spawn; absolute dispatch cost is ~constant per worker, so the ratio is a function of task size — trivial tasks inflate it. Room event cost is local file-append, a lower bound on real HTTP room posts.',
    },
    room_event_log: {
      events_per_worker_lifecycle: stats(ok.map((w) => w.room_events)),
      total_events: runs.reduce((a, r) => a + r.totalEvents, 0),
      room_lifetime_ceiling: 10000,
      ceiling_headroom_note: 'N workers x events-per-lifecycle of the 10,000-event lifetime ceiling',
    },
    phases_ms: {
      dispatch_rtt: stats(ok.map((w) => w.dispatch_rtt_ms)),
      work: stats(ok.map((w) => w.work_ms)),
      report_read_parse: stats(ok.map((w) => w.report_read_parse_ms)),
      event_append_per_worker: stats(ok.map((w) => w.event_append_ms)),
      lifecycle: stats(ok.map((w) => w.lifecycle_ms)),
    },
    totals_ms: {
      work: totalWork,
      overhead: totalOverhead,
      dispatch: dispatchTotal,
      reporting: reportTotal,
      room_events: eventsTotal,
      coordinator_wall: runs.reduce((a, r) => a + r.wallMs, 0),
    },
    overhead_breakdown_share: totalOverhead > 0 ? {
      dispatch: dispatchTotal / totalOverhead,
      reporting: reportTotal / totalOverhead,
      room_events: eventsTotal / totalOverhead,
    } : null,
    overhead_ratio: ratio,
    workers: all,
  };

  const outPath = args.out ? resolve(args.out) : join(runRoot, 'report.json');
  if (!existsSync(dirname(outPath))) mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(report, null, 2));

  const f2 = (x) => (x === null || x === undefined ? 'n/a' : Number(x).toFixed(2));
  const s = report.phases_ms;
  console.log(`workers=${args.workers} runs=${args.runs} ok=${ok.length}/${all.length}`);
  console.log(`dispatch_rtt_ms : mean=${f2(s.dispatch_rtt.mean)} p50=${f2(s.dispatch_rtt.p50)} p95=${f2(s.dispatch_rtt.p95)} max=${f2(s.dispatch_rtt.max)}`);
  console.log(`work_ms         : mean=${f2(s.work.mean)} p50=${f2(s.work.p50)} p95=${f2(s.work.p95)} max=${f2(s.work.max)}`);
  console.log(`report_parse_ms : mean=${f2(s.report_read_parse.mean)} p50=${f2(s.report_read_parse.p50)} max=${f2(s.report_read_parse.max)}`);
  console.log(`events/lifecycle: mean=${f2(report.room_event_log.events_per_worker_lifecycle.mean)}`);
  console.log(`overhead share  : dispatch=${f2(report.overhead_breakdown_share?.dispatch)} reporting=${f2(report.overhead_breakdown_share?.reporting)} room_events=${f2(report.overhead_breakdown_share?.room_events)}`);
  console.log(`OVERHEAD RATIO  : ${ratio === null ? 'n/a' : (ratio * 100).toFixed(1) + '%'}  (overhead/(work+overhead))`);
  console.log(`report: ${outPath}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
