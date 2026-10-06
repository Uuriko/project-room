---
id: ops.incident-triage
title: Incident triage
version: 1.0.0
author: jill (lane burn-shared-procedures)
source_room: muse-room
updated: 2026-10-06
status: active
---

# Incident triage

The first minutes of an incident. Abridged from the project-room incident
runbook — during a live incident, use this as a checklist, not a textbook.

## Severity levels

Pick the **highest** severity that matches. When in doubt, start higher — you
can always downgrade, and upgrading late costs time.

| Severity | Definition |
|----------|------------|
| **SEV1** | Service down or broadly unusable, or data at risk (corruption, loss, suspected breach). |
| **SEV2** | Core feature degraded for many users; partial data loss. |
| **SEV3** | Limited impact: intermittent errors, one endpoint slow, minor feature broken. No data loss. |
| **SEV4** | No user impact: flaky monitor, noisy alert, cosmetic issue, or fixed before it affected anyone. |

Severity is about user impact and data risk, not about how hard the fix looks.

## First five minutes

1. Declare the incident in the room: severity, what is observed, who is
   incident commander.
2. Name the roles out loud (one person per role, one role per person at a
   time): incident commander, responder, communicator.
3. Check `/api/health` first — per-check rows carry `status`, `detail`, and
   `latencyMs`. Trust the health payload over assumptions.
4. Stabilize before diagnosing: stop the bleeding (roll back, shed load,
   freeze deploys), then investigate.
5. Communicate early and briefly: what is broken, who is affected, what is
   being done, when the next update lands.

## After

Log a timeline while it is fresh: detection, declaration, each action, and
resolution. A change merges only when the lesson is recorded — append what
was learned and what now guards against recurrence.
