## Docs A–G audit

34 docs checked. Method: extracted every `scripts/|server/|src/|tests/` path reference and every `/api/` path from each doc, verified existence against the worktree; spot-checked behavioral claims against code.

| Doc | Verdict | Notes |
|---|---|---|
| ADMIN-GUIDE.md | accurate | Operator auth, purge flow match code |
| ADOPTION.md | accurate | `server/analytics-ingest.mjs` refs are explicitly conditional ("Until that module exists, the snapshot is not sent") — aspirational, not stale |
| AGENT-ACCOUNT-LINK.md | accurate | No falsifiable claims found contradicted |
| AGENT-CARD-CUSTODY.md | accurate | |
| AGENT-HOST-PLAN-2026-09-29.md | abandoned | Dated 2026-09-29 plan ("Make Project Room great for every agent"); companion to GROK-DEEP-PLUG-PLAN; no owner/checkable claims — historical |
| AGENT-QUICKSTART.md | accurate | `src/parser.js` / `tests/parser.test.js` refs are inside example receipt JSON (illustrative), not claims |
| AGENT-SEO.md | accurate | Same conditional analytics-ingest pattern as ADOPTION.md — honest |
| AGENT-START-HERE.md | accurate | All endpoints verified live in server/http.mjs: /api/agent-rooms, /api/agent-identities, /api/public-work/tasks, /match, /tasks/{id}/claim |
| AGENTS-WANT.md | accurate | No falsifiable claims contradicted |
| ARCHITECTURE.md | accurate | /api/rooms/{roomId}/commands, /stream (SSE), /events, /work-claims all match http.mjs route regexes |
| AUDIT-CONTEST.md | accurate | |
| BACKUPS.md | **stale** | See stale flags |
| BOUNTY-MCP-TOOLS.md | accurate | |
| BUG-BOUNTY.md | accurate | |
| CLAUDE-CHANNEL.md | accurate | |
| CODE-DROPS.md | accurate | |
| COLD-AGENT-WALKTHROUGH.md | accurate | |
| CONNECT-AGENT-QUICKSTART.md | accurate | |
| CONNECT-RECEIVE.md | accurate | /api/agent-webhooks exists in http.mjs |
| CONNECT-WAKE.md | **stale** | See stale flags |
| CURRENT-ROOM.md | accurate | Glob refs (server/email-*.mjs etc.) all match real files; schema-34 claims not deeply verified |
| DEMIGOD-BUYER-OFFER.md | accurate | No falsifiable claims contradicted (offer prose) |
| DEPLOY-LANE.md | accurate | ROLE-DEPLOYER claim flow, /api/version/worker, smoke scripts all match code |
| ERROR-TAXONOMY.md | accurate | /api/rooms/:id/spend-allowance exists (server/spend-allowance.mjs) |
| EVENT-FIXTURES.md | accurate | |
| FAQ.md | accurate | |
| FLAKY-QUARANTINE.md | accurate | `tests/worker-pool.test.js` ref is inside example quarantine JSON (illustrative schema), not a claim |
| GITHUB-APP.md | accurate | |
| GITHUB-DOOR.md | accurate | |
| GLOSSARY.md | accurate | |
| GROK-BUILD-CONTINUOUS.md | abandoned | Lane-ops doc describing one lane's local setup (`~/src/dg-bus.py`, `~/src/AGENT-BOARD.md`); dg-bus is now the Uuriko/dg-bus repo — historical |
| GROK-DEEP-PLUG-PLAN-2026-09-29.md | abandoned | Dated 2026-09-29 plan; historical |
| GUEST-AGENT-LINKS.md | accurate | |
| a2a-receipt-extension.md | accurate | |

### Stale flags

- `STALE docs/BACKUPS.md:7` — "`GET /api/operator/export` streams NDJSON…" — no such route exists in server/http.mjs or server/operator-routes.mjs (independently confirmed by routes worker r5). The whole export/restore drill in BACKUPS.md:7-78 describes a non-existent endpoint.
- `STALE docs/CONNECT-WAKE.md:29` — "(`GET /api/agent-wakes/poll`)" presented as a live endpoint — no such route in server/http.mjs. The path exists only as an MCP action descriptor in server/agent-plugin-routes.mjs:187 (discovery), not as an HTTP route.
- `STALE docs/CONNECT-WAKE.md:36` — "`GET /api/wake-status` answers 'who is actually listening'" — no such route in server/http.mjs; server/routes/wake-status.mjs (named in the code comment at agent-plugin-routes.mjs:845-848) does not exist. Discovery-only.

### Accurate & valuable

- docs/AGENT-START-HERE.md — the onboarding curl path; every endpoint verified live.
- docs/ARCHITECTURE.md — event log / SSE / commands / work-claims topology matches the code.
- docs/DEPLOY-LANE.md — ROLE-DEPLOYER claim discipline and smoke sequence match reality.
- docs/ERROR-TAXONOMY.md — HTTP canonical envelope; no contradictions found.

### Suspected bugs (found while auditing)
- None in this slice.

DONE: 34 docs checked, 3 stale flags, 0 suspected bugs
