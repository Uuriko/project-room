// Synthetic one-shot worker for the coordination-overhead harness (WAVE-500).
//
// Emulates the real wave worker lifecycle in miniature:
//   1. first observable action  -> IPC 'started' (analogue of the worker's first tool call)
//   2. room CLAIM event         -> before any work, like a real claim post
//   3. synthetic task           -> write a 10-line file + a small deterministic compute
//   4. room PROGRESS events, completion report written to disk
//   5. room DONE event + IPC 'done' pointing at the report
//
// Room events travel to the coordinator over IPC; the coordinator is the single
// writer to the JSONL event log (muse-room's event log is likewise a single
// serialized stream per room). Pure task time is self-measured inside the worker
// so the coordinator can separate "work" from "coordination".
import { writeFileSync } from 'node:fs';

const id = process.env.OVERHEAD_WORKER_ID ?? 'w?';
const taskFile = process.env.OVERHEAD_TASK_FILE;
const reportPath = process.env.OVERHEAD_REPORT_PATH;

if (!taskFile || !reportPath) {
  console.error('measure-overhead-worker: missing OVERHEAD_TASK_FILE / OVERHEAD_REPORT_PATH');
  process.exit(2);
}

const send = (msg) => { if (process.send) process.send({ id, ...msg }); };

// (1) First "tool call": the worker's first observable action after spawn.
send({ type: 'started', t: Date.now() });

// (2) CLAIM before any work, like a real work-claim post.
send({ type: 'event', kind: 'CLAIM', t: Date.now() });

// (3) Synthetic task. Timed inside the worker so the coordinator can split
// work vs coordination cleanly.
const tWork0 = performance.now();
const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1} of 10 — worker ${id}`);
writeFileSync(taskFile, lines.join('\n') + '\n');
let acc = 0;
for (let i = 0; i < 200000; i++) acc += i; // deterministic busy work (~a few ms)
const tWork1 = performance.now();
const workMs = tWork1 - tWork0;

send({ type: 'event', kind: 'PROGRESS', t: Date.now(), note: 'task complete' });

// (4) Completion report, exactly what a real worker's final report looks like
// at small scale: a JSON file the coordinator must read and parse.
const report = {
  id,
  status: 'ok',
  work_ms: workMs,
  task_file: taskFile,
  lines: 10,
  checksum: acc,
};
writeFileSync(reportPath, JSON.stringify(report));

send({ type: 'event', kind: 'PROGRESS', t: Date.now(), note: 'report written' });
send({ type: 'event', kind: 'DONE', t: Date.now() });

// (5) Hand the report back to the coordinator.
send({ type: 'done', reportPath, t: Date.now() });
