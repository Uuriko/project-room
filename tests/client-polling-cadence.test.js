// PERF-F-S3/S4/S5: client + stream polling cadence pins.
// These loops live in browser/server wiring with no unit harness, so the
// cadence constants themselves are the contract (the PERF-50 F3/F5 census
// measured the rates they produce). Each pin names the per-hour rate the
// constant yields; a change that restores the old cadence fails here
// until the census numbers are re-derived and this file updated.
//   S3 account confirm: 5s -> 60s     = 720 -> 60 req/hr/tab
//   S4 SSE recheck:     2s -> 10s cap = 1,800 -> 360 probes/hr/stream
//   S5 request-runs:    10s forced    = 360 -> <=60 forced reads/hr
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");
const http = readFileSync(new URL("../server/http.mjs", import.meta.url), "utf8");
const deployment = readFileSync(new URL("../server/deployment.mjs", import.meta.url), "utf8");

const HOUR_MS = 3_600_000;

test("S3: account confirm polls at 60s, focus/visibility triggers retained", () => {
  assert.match(app, /setInterval\(\(\) => \{ if \(!document\.hidden\) confirmAccount\(\); \}, 60000\);/);
  assert.equal(HOUR_MS / 60_000, 60, "60s cadence is 60 req/hr/tab");
  assert.match(app, /window\.addEventListener\("focus", \(\) => confirmAccount\(\)\);/);
  assert.match(app, /document\.addEventListener\("visibilitychange", \(\) => \{ if \(!document\.hidden\) confirmAccount\(\); \}\);/);
});

test("S4: SSE recheck reaches the 10s cap at the default stream interval", () => {
  const match = http.match(/const RECHECK_MS = Math\.min\(10000, Math\.max\(250, streamInterval \* (\d+)\)\);/);
  assert.ok(match, "RECHECK_MS keeps its min(10s cap, max(250, streamInterval * N)) shape");
  const defaultInterval = Number(deployment.match(/STREAM_INTERVAL_DEFAULT_MS = (\d+)/)[1]);
  const recheckMs = Math.min(10000, Math.max(250, defaultInterval * Number(match[1])));
  assert.equal(recheckMs, 10_000, "default-interval recheck is the 10s cap");
  assert.equal(HOUR_MS / recheckMs, 360, "10s cadence is 360 probes/hr/stream");
});

test("S5: request-runs 10s tick is unforced; the forced backstop is 60s", () => {
  assert.match(app, /setInterval\(\(\) => \{ void refreshRequestRuns\(\); \}, 10000\);/,
    "the 10s tick relies on the change-key dedupe, not force");
  assert.match(app, /setInterval\(\(\) => \{ void refreshRequestRuns\(\{ force: true \}\); \}, 60000\);/,
    "the only forced tick is the 60s backstop");
  assert.equal(HOUR_MS / 60_000, 60, "60s forced backstop is <=60 forced reads/hr");
  assert.doesNotMatch(app, /refreshRequestRuns\(\{ force: true \}\); \}, 10000\)/,
    "no 10s forced tick remains (that was 360 unconditional reads/hr)");
});
