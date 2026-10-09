# Guild-10 doc/code consistency report — 2026-10-09

1132 raw scanner items → manually triaged at HEAD → 13 stale claims fixed,
0 code bugs (no BUG CONFIRMED filed — every finding was doc-side).

## Fixed (commit 6fdd14487, branch wave1000/guild-10)

**Moved-file refs retargeted (5):**
1. `docs/ROOM-PROTOCOL.md:21` — `docs/AGENT-LANES.md` → `docs/history/AGENT-LANES.md`
2. `docs/SERVICE.md:99` — `docs/CONVERSATION.md` → `docs/history/CONVERSATION.md`
3. `docs/GROK-BUILD-CONTINUOUS.md:32` — `docs/AUTOMATION-DECISION-2026-09-29.md` → `docs/history/...`
4. `docs/ROOM-WIKI.md:13` — `docs/ROOM-PROCEDURES.md` → `docs/history/...`
5. `docs/ADMIN-GUIDE.md:35` — `docs/EMAIL-ROUTING-RUNBOOK.md` → `docs/history/EMAIL-ROUTING.md`

**Unmerged-companion / removed-module annotations (5):**
6. `docs/security/time-handling-audit.md:49` — `tests/time-skew-boundaries.test.js`
   exists only on unmerged branch `ht-7/sec-impl-171-180` (df32a1428 NOT in HEAD).
7. `docs/exchange/104-exchange-slice-2-spec.md:23,69,71` — ledger module + lifecycle
   tests exist only on unmerged branch `feat/ht4-101-116-credits-ledger` (75d288df8 NOT in HEAD).
8. `docs/exchange/118-credits-explorer-ui-mock.md:4` — same unmerged branch.
9. `docs/GROK-DEEP-PLUG-PLAN-2026-09-29.md:252` — `docs/GROK-HOST.md` existed only on
   unmerged `grok/recover-and-next-20260930` (07d46ad01 NOT in HEAD).
10. `docs/PRODUCT-CONSOLIDATION-PLAN-2026-09-30.md:28` — `server/public-claims.mjs`,
    `server/public-claim-routes.mjs`, `server/receipt-payout.mjs` removed in #1315;
    the concern raised is now moot.
11. `docs/analytics/EVENTS.md:5` — `docs/analytics/weekly/` never created; aspirational.

**History-doc endpoint notes (3):**
12. `docs/history/self-serve-join.md:186` — `POST /api/guest-agent-links/:memberId/approve-drafts`
    never implemented (`-S approve-drafts` finds nothing in server/ history).
13. `docs/history/REFERRAL-TREE-DESIGN.md:30` — `POST /api/guest-agent-links/redeem-card`
    implemented in #857, reverted by `5be224672`/`35767fbcb`.
14. `docs/history/ISSUE-6-TRIAGE-2026-09-14.md:126` — `GET /api/auth/oidc/start|callback`
    never implemented.

## Verified TRUE (scanner false positives — no change)

- `GET /api/inbox/sources/:id/send-context` — live route `server/routes/inbox.mjs:281`.
- `GET /api/healthz`, `GET /healthz` — served (bridge.mjs:601; cloudflare http.check asserts).
- `GET /.well-known/ai-catalog.json` — served compat path (deploy/agent-discovery.mjs:237).
- `POST /api/account-bind` — doc says "Do not add" (negation, correctly absent).
- All 9 dead `scripts/room` verb/flag hits — flags of sibling scripts / rejected-design prose.
- All 21 env-var candidates — every current-doc claim has a real reader (workflows,
  tests, worker vars, GitHub repo variables).
- All 132 openapi `PATH_NOT_FOUND_IN_CODE` — route-index gaps, zero real drift.
- 128 `PARAM_NOT_IN_HANDLER` — heuristic noise; sampled top candidates, none real.

## Coverage written

11 family pages in `findings/guild-10/docs/` covering all 229 previously-undocumented
modules (80 `server/*.mjs`, 149 `scripts/*`): purpose from header comments, exports,
`git grep` caller lists. Coverage matrix: `findings/guild-10/coverage-matrix.json`
(611 modules, 382 already covered, 229 now documented).

Triage artifacts: `findings/guild-10/triage/{endpoints,paths,links,verbs,env,openapi}.{json,md}`.
