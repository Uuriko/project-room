# Calm return: local verification ledger

Date: September 7, 2026. Canonical branch: codex/unified-local-20260907.
Parent checkpoint: b989af66fa00471b942e2ac729bc28ae2a745eae.
This ledger is an observed summary, not a verbatim log or production telemetry.

Runtime: bundled Node 24.19.0, installed Playwright/Chromium and local workerd.
Only disposable loopback fixtures were used; no operator secrets/live rooms.

| Check | Observed result |
| --- | --- |
| node scripts/check.mjs | Syntax + 335 tests pass |
| package.json test:browser, with concurrency 1 | 64 pass |
| Cloudflare compatibility/store/http/bootstrap/reminder-upgrade/browser checks | 7 pass |
| node cloudflare/build-assets.mjs | 15 exact allowlisted public files prepared |
| Asset packaging tests | Exact bytes, browser import coverage, output/symlink guards pass |
| esbuild on cloudflare/room.mjs, bundle/write:false/esm/neutral, external node:* and cloudflare:* | 194,636-byte production entrypoint output in memory |
| Focused return/first-use/controller rerun | 14 pass after final type-sizing changes |
| Final enlarged-control capture rerun | Both return journeys pass; two additional screenshots inspected |

Full browser command is resolved directly from package.json; no separate shortened
list substitutes for it. Cloudflare suite used --test-concurrency=1 with
compatibility.check.mjs, store.check.mjs, http.check.mjs, bootstrap.check.mjs,
reminder-upgrade.check.mjs and browser.check.mjs.

Current task operations were observed in real HTTP/browser fixtures. Merely
opening/expanding/clicking work, advancing the clock and refreshing catch-up
produced no room-command/reminder/cursor POST. Snapshot/cursor stayed unchanged
until explicitly seeded lifecycle events. Separate existing acknowledgement
regression verifies H+1 survives the sole control. Controller tests cover the
ahead-of-snapshot wait, stale replacement, failed/behind reconciliation and
ignored caller-provided acknowledgement override. Selector tests establish exact
function sharing and consistent actions/status at 1999/2000ms expiry boundary.

First-use, session-boundary, reminder and Cloudflare restart suites retain their
earlier obligations rather than being replaced by the new return scenarios.
The local Cloudflare self-signed probe diagnostic is recorded but all assertions
pass; it is not a hosted certificate incident.

Visual evidence: eight synthetic local PNGs under test-results, closed/expanded
and enlarged-text header/controls for desktop/mobile. No screenshot contains a
visible access key. Existing live browser tabs/previews were not modified.
No new browser-only preview was handed off during this background goal checkpoint;
isolated browser servers existed solely for requested QA and were stopped.

No human preference, activation, return rate, causal uplift, or viral coefficient
was measured. The plan's retention experiment is specified, not run.
