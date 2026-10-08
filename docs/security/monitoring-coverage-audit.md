# Monitoring-coverage audit

**Task:** 200-hard-tasks #178 — audit that every critical path has monitoring:
settlement, room, deploy, venue bots. Done when: a coverage matrix; every gap
gets a monitor spec or a waiver.
**Date:** 2026-10-07 · **Lane:** HT-7

Scope note: this lane covers Project Room. Settlement/ACP paths belong to the
ACP lanes and the dasha-settlement repo — they get waivers here, not specs.

## Coverage matrix

| Critical path | Monitor | Type | Status |
|---|---|---|---|
| Production Worker health | `cloudflare/health-probe.check.mjs`, `/api/health`, `/api/ready` | synthetic probe | ✅ covered |
| Deploy correctness | `scripts/prod-deploy-smoke.mjs` (revision, health, pages, agent-card signature on every fetch) + `scripts/live-smoke.mjs` | deploy gate | ✅ covered |
| Deploy drift | `scripts/watch-deploy-drift.mjs` + `.github/workflows/deploy-drift.yml` | drift watch | ✅ covered |
| Deploy receipts | deploy-prod posts a receipt to muse-room | human-visible | ✅ covered |
| Rollback readiness | pre-deploy snapshot + `scripts/deploy-recovery.mjs` | recovery | ✅ covered |
| CI health | CI-WATCH lane + `test`/`schema-gate` dual-green deploy gate | process | ✅ covered |
| Room liveness (messages, claims) | `cloudflare/messages-fidelity.check.mjs`, `public-work-claims.check.mjs` | synthetic probe | ✅ covered |
| Onboarding funnel | `scripts/onboarding-probe/predeploy.mjs` + `.github/workflows/onboarding-probe.yml` | synthetic probe | ✅ covered (gate optional) |
| Agent wake / upgrade | `cloudflare/agent-wake.check.mjs`, `agent-upgrade.check.mjs` | synthetic probe | ✅ covered |
| MCP / public work surface | `cloudflare/public-work-mcp.check.mjs`, `public-work-reviews.check.mjs` | synthetic probe | ✅ covered |
| Room projection integrity | `cloudflare/projection-at-rest.check.mjs` (+ the 4 MB pilot-cap incident 2026-10-07 showed the *limit* needs a gauge — see G-1) | synthetic probe | ⚠️ partial |
| Inbox / channel webhooks (venue bots) | `scripts/inbox-telegram-check.mjs`, `scripts/inbox-unified-check.mjs` | operational check | ✅ covered |
| Compatibility / edge | `cloudflare/compatibility.check.mjs`, `edge-public.check.mjs`, `external-probe.mjs` | synthetic probe | ✅ covered |
| Jobs / alarms | `cloudflare/jobs-alarm.check.mjs` | probe | ✅ covered |
| QR / join door | `cloudflare/bootstrap.check.mjs`, `browser.check.mjs` | probe | ✅ covered |
| Settlement / escrow / evaluator | — (ACP lanes) | — | ➖ waived (out of PR scope) |
| Dasha compute / venue bots (Dasha side) | — (Dasha lanes) | — | ➖ waived (out of PR scope) |

## Gaps

### G-1: projection-size gauge (spec)

The 2026-10-07 production incident (muse-room projection hit the 4 MB pilot
cap; all writes 409-rejected) was discovered by a user-visible failure, not a
monitor. The cap exists (`PILOT_LIMITS.projectionBytes`); nothing graphs its
approach.

**Monitor spec:** a periodic check (hourly cron or Cloudflare check) that
reads the room projection size for the pilot rooms and emits a gauge; alert at
80% of the cap. Suggested home: extend `cloudflare/projection-at-rest.check.mjs`
or a new `scripts/projection-size-check.mjs` run by the room-watch tick. Alert
threshold: `projectionBytes > 0.8 * PILOT_LIMITS.projectionBytes`. Owner: the
room-watch / core lane.

### G-2: webhook delivery failure alerting (spec)

Channel and PR webhooks log deliveries, and the poll fallback covers missed
PR webhooks, but there is no alert when a venue webhook goes silent (e.g. the
Telegram secret rotates and deliveries start 401ing — the failure is only
visible in logs).

**Monitor spec:** `scripts/inbox-unified-check.mjs` already probes the channel
webhooks operationally; promote its failure to an alert (room post or CI
failure) on a schedule, rather than a manual run. Track consecutive failures;
alert at 3.

### G-3: backup verification (waiver → separate task)

`docs/BACKUPS.md` + `deploy/project-room-backup.{service,timer}` exist, but
there is no automated *restore* verification (task #168, another lane's
slice). Waived here; covered by #168's quarterly restore drill.

### G-4: receipt-posting pipeline (spec)

Deploy receipts post to muse-room `continue-on-error: true` — a broken
`ROOM_RECEIPT_TOKEN` fails silently by design. If receipts stop arriving,
deploys still succeed but the room loses its audit trail.

**Monitor spec:** the room-watch tick already diffs the event log; add an
expectation that a deploy receipt appears within N minutes of a
`deploy-prod` success (correlate via the Actions API or the summary). Alert on
missing receipt.

## Waivers

- **Settlement/escrow/evaluator:** ACP lanes own these paths and their
  monitoring; this audit does not spec monitors for code it does not own.
- **Dasha-side venue bots:** Dasha lanes own them.
- **Backup restore drills:** owned by task #168.

## Verdict

Room, deploy, and venue-bot (Project Room side) paths are well covered by
synthetic probes and deploy gates. Four gaps: one incident-proven (projection
size — spec G-1), one silent-failure mode (webhook alerting — spec G-2), one
owned elsewhere (backups — waiver), one audit-trail gap (deploy receipts —
spec G-4).
