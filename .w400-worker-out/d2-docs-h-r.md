## Docs H–R audit

39 docs checked. Method: extracted every `scripts/|server/|src/|tests/` path and `/api/` path per doc, verified existence; spot-checked endpoint and behavioral claims.

| Doc | Verdict | Notes |
|---|---|---|
| HERDR-OPERATOR-RUNBOOK.md | accurate | No contradicted claims found |
| HERDR-SESSIONS-AGENTS.md | accurate | |
| HOST-MATRIX.md | accurate | |
| HUMAN-ONBOARDING.md | accurate | |
| I18N-HARNESS.md | accurate | |
| IDENTITY-LIFECYCLE.md | accurate | |
| INBOX-QUICKSTART.md | accurate | |
| INCIDENT-1101-RUNBOOK.md | accurate | Incident runbook; procedural |
| INCIDENT-RUNBOOK.md | accurate | |
| INDEX.md | accurate | All 49 indexed docs exist; 54 unindexed docs is curation, not rot |
| INVITE-ONLY-CHECKLIST.md | accurate | |
| JOIN-ANY-AGENT.md | accurate | `~/src/agent-bus` refs are local-disk conventions, not repo claims; /api/access-requests verified live |
| JOINING.md | accurate | |
| JOURNEY-COVERAGE-MAP.md | accurate | |
| LISTINGS.md | accurate | |
| MACHINES.md | accurate | |
| MATCHMAKING.md | accurate | No contradicted claims found |
| OAUTH-PROVIDER-SECURITY-REVIEW.md | historical | Dated review; kept for record |
| ONBOARDING-PROBE.md | accurate | |
| OPENAPI-CONTRACT-REPORT.md | accurate | |
| OPERATOR.md | accurate | Purge find/plan/execute flow matches code (two-phase, 10-min token, 409 plan_changed) |
| PERF-BUDGET.md | accurate | |
| PRIVACY-POLICY-TEMPLATE.md | accurate | Template, not claims |
| PRODUCT-CONSOLIDATION-PLAN-2026-09-30.md | abandoned | Dated 2026-09-30 plan; historical |
| PUSH-VAPID-KEYS.md | accurate | |
| QA-MUTATION-PROBES.md | accurate | |
| QA-SYSTEM.md | accurate | |
| QA2-SYSTEMS.md | accurate | |
| RECEIPTS-PAGE.md | accurate | |
| REVIEW-PARALLELISM.md | accurate | |
| ROOM-COORDINATION.md | accurate | Correctly notes #11/#1160 are historical (line 40) |
| ROOM-DEPLOYMENT.md | accurate | |
| ROOM-KITS-CATALOG.md | accurate | |
| ROOM-PROTOCOL.md | accurate | |
| ROOM-ROSTER.md | accurate | |
| ROOM-WIKI.md | accurate | |
| ROUTE-AUTH-TABLE.md | accurate | No work-claims rows to contradict; spot checks pass |
| join.md | accurate | |
| lesson-scorer.md | accurate | |

### Stale flags
- None in H–R. (The `server/discover` hit in SWARM-PLUG-IN.md is an MCP protocol method name, not a file path — regex misfire, not stale.)

### Accurate & valuable
- docs/ROOM-COORDINATION.md — the claims/outage-fallback contract; correctly marks the GitHub mirrors historical.
- docs/OPERATOR.md — the purge flow documentation matches the code's two-phase confirm exactly.
- docs/INDEX.md — curated map; all indexed docs exist.

DONE: 39 docs checked, 0 stale flags, 0 suspected bugs
