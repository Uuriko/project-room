// spawn-latency-worker.mjs — synthetic one-shot worker for SPAWN-LATENCY profiling.
// "Reply DONE immediately": records Date.now() at entry (same clock origin as the
// coordinator across processes — performance.now() is NOT, it is per-process boot),
// at first tool-call analog (first IPC send), and at final message send.
import { writeFileSync, readFileSync } from 'node:fs';

const tStart = Date.now(); // worker start: first line of module eval

// (b) worker start -> first tool call: the first IPC send is the tool-call analog
const tFirst = Date.now();
process.send({ type: 'started', tStart, tFirst });

// Brief arrived via env (SL_BRIEF) or sidecar file (SL_BRIEF_PATH). Touch it so the
// payload is real work the worker must receive.
let brief;
if (process.env.SL_BRIEF_PATH) {
  brief = readFileSync(process.env.SL_BRIEF_PATH, 'utf8');
} else {
  brief = process.env.SL_BRIEF ?? '';
}
const briefBytes = brief.length;

const reportBytes = Number(process.env.SL_REPORT_BYTES || 2048);

// Build a ~reportBytes JSON report. Deterministic filler keeps byte count stable.
const fillerLen = Math.max(0, reportBytes - 160);
const report = {
  workerPid: process.pid,
  done: true,
  briefBytes,
  payload: 'x'.repeat(fillerLen),
};
const reportJson = JSON.stringify(report);
writeFileSync(process.env.SL_REPORT_PATH, reportJson);

// (c) final message: record tDone immediately before the final send
const tDone = Date.now();
process.send({ type: 'done', tStart, tFirst, tDone, reportBytes: reportJson.length });
