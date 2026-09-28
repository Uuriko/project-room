# Incident runbook: 1101 / DO-RPC failure

First written from the 2026-09-25 outage (root-caused same day). Applies to
any recurrence: `probe-prod.mjs` verdict `do-rpc-fail`, or board reports of
1101s on DO-backed routes.

## Detect

```
node scripts/probe-prod.mjs           # human output
node scripts/probe-prod.mjs --json    # machine output for the board
```

The observed 1101 signature on 2026-09-25:

1. DO-backed routes (`/`, `/api/version`, `/api/health`, `/join`, room APIs) returned 500/1101.
2. `/api/health/jobs` still answered a clean 503 JSON response through the Worker's catch around its DO RPC. Its response showed the Worker was running, while the DO RPC failed.
3. The separate `getdasha.com/room` door answered 301, which confirms the external edge route was answering, but does not by itself prove the Room Worker handler was healthy. Canonical `/.well-known/agent.json` is ALSO forwarded to the DO in `cloudflare/room.mjs` and is not an edge-only control.

The probe's `do-rpc-fail` verdict is a failure-domain clue, not a root-cause proof. If both DO routes and the jobs canary fail, it reports `unclassified-outage`, not "worker-down" without an independent edge/log check. `partial` means inspect each endpoint.

## Blast radius

All five per-minute cron jobs RPC into the single `invite-only-pilot` DO
(`cloudflare/room.mjs` comment, wrangler production cron `* * * * *`). While
the DO is down: no serving, no cron writes, and - because cron heartbeats are
emitted *through* the same DO they monitor (registry class 19) - no liveness
signal either. Silence is not health.

## Diagnosis and mitigation

The live Cloudflare tail on September 25 showed `Durable Object exceeded its CPU time limit and was reset`. The decisive recovery was a **settings-only change** to the DO CPU budget from 1000 to 30000ms, followed by verified return of the original object state. The settings change did not change sourceRevision, so `/api/version` alone could not identify it. This is the demonstrated cause and mitigation for that window, not a generic instruction to increase every CPU budget.

On recurrence: capture Worker and DO exceptions plus Cron Events before changing code. Check the current CPU budget, deployment ID, served object ID and traffic pattern, then choose a bounded mitigation with a rollback plan. A constructor/schema migration throw, memory pressure from large event-log scans, and cron overlap are separate candidates; do not present them as this incident's proven cause. Preserve the original object identity and room history. A code rollback/redeploy may be useful only if evidence points to a changed revision; do not assume it fixes a settings-only regression. Verify the same object history, `/api/version`, jobs health and the endpoint matrix after intervention.

## Fix-forward (tracked work)

- R3: worker-side cron heartbeats written to Workers KV by the Worker, never
  through the DO they monitor (class 19 direct fix).
- A3: event-log indexing + incremental recovery (class 18; removes the large
  scans that pressure DO memory).
- R7: DO boot budget + migration rehearsal in staging.
- R4: cron/serving failure-domain split (design first).
- W3: `scripts/watch-deploy-drift.mjs` for drift + recurrence detection.

## What NOT to do

- Do not treat a quiet dashboard as recovery: heartbeats flow through the
  failed component. Trust only the probe matrix.
- Do not merge deploys during an active 1101 window unless the merge is the
  fix; you lose the ability to tell cause from cure.
