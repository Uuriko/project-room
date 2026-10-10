#!/usr/bin/env node
// Per-file duration capture for the sharded unit suite (lane G4).
//
// `node --test` does not print per-file timings in a parseable form (the TAP
// reporter merges files into one stream in Node 24), but the raw event
// stream carries exactly what the shard balancer needs:
//   - `test:complete` with `name` === the file's own path: the file-level
//     point, whose `details.duration_ms` is the file's wall-clock cost in
//     this run (child-process spawn + module load + its tests).
//   - `test:pass` / `test:fail` per test: test count and summed test time.
//
// Use as a second reporter pair so the default console reporter is untouched:
//   node --test \
//     --test-reporter=spec --test-reporter-destination=stdout \
//     --test-reporter=./scripts/unit-file-durations-reporter.mjs \
//     --test-reporter-destination=test-results/unit-file-durations-1-of-3.json \
//     ...files
// The yielded JSON is written to the destination by the runner; the gate
// ignores this file (unit-shards-check.mjs only reads unit-shard-*.json).
//
// The reporter never throws: a broken capture yields an error payload and
// the refresh script treats it as no-data. A missing capture must never
// fail the merge gate.

export const REPORTER_VERSION = 1;

// Minimal event record the aggregator understands: the runner's raw event
// ({ type, data }) with an `at` receipt timestamp stamped by the caller.
// Tests synthesize these directly.
export function normalizeRepoPath(path, cwd) {
  if (typeof path !== "string" || !path) return path;
  let p = path.replace(/\\/g, "/");
  const base = String(cwd ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
  if (base && (p === base || p.startsWith(base + "/"))) {
    p = p.slice(base.length).replace(/^\/+/, "");
  }
  return p.replace(/^\.\/+/, "");
}

function isFilePoint(type, name, fileKey, cwd) {
  if (type !== "test:complete") return false;
  if (typeof name !== "string" || !name) return false;
  return normalizeRepoPath(name, cwd) === fileKey;
}

export function aggregateFileDurations(events, { cwd } = {}) {
  const files = new Map(); // fileKey -> { tests, sumMs, firstAt, lastAt, fileMs }
  const entry = (key) => {
    let e = files.get(key);
    if (!e) {
      e = { tests: 0, sumMs: 0, firstAt: Infinity, lastAt: -Infinity, fileMs: null };
      files.set(key, e);
    }
    return e;
  };
  for (const event of events ?? []) {
    const data = event?.data ?? {};
    const details = data.details ?? {};
    const file = typeof data.file === "string" && data.file ? data.file : null;
    if (!file) continue;
    const key = normalizeRepoPath(file, cwd);
    const e = entry(key);
    const at = event.at;
    if (Number.isFinite(at)) {
      if (event.type === "test:start" || event.type === "test:enqueue") {
        e.firstAt = Math.min(e.firstAt, at);
      }
      e.lastAt = Math.max(e.lastAt, at);
    }
    const duration = data.duration_ms ?? details.duration_ms;
    const ms = Number.isFinite(duration) && duration >= 0 ? duration : null;
    if (isFilePoint(event.type, data.name, key, cwd)) {
      // The file-level point: authoritative wall-clock cost for this file.
      if (ms !== null) e.fileMs = Math.round(ms);
      continue;
    }
    if (event.type === "test:pass" || event.type === "test:fail") {
      e.tests += 1;
      if (ms !== null) e.sumMs += ms;
    }
  }
  const out = {};
  for (const [key, e] of files) {
    const spanMs = e.lastAt >= e.firstAt && Number.isFinite(e.firstAt) ? e.lastAt - e.firstAt : 0;
    // Prefer the runner's own file-level wall time; fall back to the observed
    // span (floored by summed test time) when the file point is missing
    // (aborted run). Files with no completed tests carry no signal and are
    // omitted so the planner's conservative default applies downstream.
    let ms = e.fileMs;
    if (ms === null) {
      if (e.tests === 0) continue;
      ms = Math.round(Math.max(spanMs, e.sumMs));
    }
    if (!(ms > 0)) continue;
    out[key] = {
      tests: e.tests,
      sumMs: Math.round(e.sumMs * 100) / 100,
      spanMs: Math.round(spanMs * 100) / 100,
      ms,
    };
  }
  return { version: REPORTER_VERSION, files: out };
}

export default async function* unitFileDurationsReporter(source) {
  const events = [];
  try {
    for await (const event of source) {
      events.push({ type: event?.type, data: event?.data ?? {}, at: Date.now() });
    }
  } catch (err) {
    yield JSON.stringify({ version: REPORTER_VERSION, error: `event stream failed: ${err?.message ?? err}`, files: {} }) + "\n";
    return;
  }
  let payload;
  try {
    payload = aggregateFileDurations(events, { cwd: process.cwd() });
  } catch (err) {
    payload = { version: REPORTER_VERSION, error: `aggregation failed: ${err?.message ?? err}`, files: {} };
  }
  yield JSON.stringify(payload, null, 2) + "\n";
}
