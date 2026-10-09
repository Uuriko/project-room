# Dead-code analysis — client/ (reachability evidence)

**Method.** For each `client/*.mjs`, counted importers via `grep -rl "client/<name>"` over `src scripts server bin cli deploy cloudflare client docs evals` (all JS/MJS/CJS/HTML), excluding `tests/` and the module itself. A module with zero live importers would be dead-code candidate; single-importer modules had their importer checked for liveness (docs/package.json references).

**Result: no dead modules.** Every one of the 33 client modules has ≥1 live importer:

| Importers | Modules |
|---|---|
| 1 | agent-resume.mjs (← agent-wake), assignment-watcher.mjs (← attention-inbox), grok-host.mjs (← agent-resume), host-context-policy.mjs (← host-process), matchmaking.mjs (← scripts/grok-room-host.mjs), swarm-brief.mjs (← scripts/grok-room-host.mjs), text-plug.mjs (← scripts/grok-room-host.mjs), watch-journal.mjs (← attention-inbox) |
| 2 | assistant-tools.mjs (← scripts/runtime-package.mjs, server/mcp-full-profile.mjs), bounty-tools.mjs, claude-channel.mjs (← scripts/reachability.mjs, scripts/room-listen.mjs), host-verification.mjs, request-notices.mjs (← watch-journal, attention-inbox), room-coord.mjs, room-land.mjs, setup-journal.mjs, trust-tools.mjs, work-actions.mjs |
| 3+ | agent-wake, begin-work, help-actions, host-process, host-result, host-subprocess, public-work-claims, request-runner, attention-inbox, work-preparation, agent-setup, reply-actions, mcp-stdio (11), room-agent (31), agent-connection (33) |

**Liveness spot-checks (single-importer modules):**
- `scripts/grok-room-host.mjs` (imports matchmaking, swarm-brief, text-plug) — referenced in `docs/GROK-BUILD-CONTINUOUS.md`, `docs/GROK-DEEP-PLUG-PLAN-2026-09-29.md`.
- `scripts/room-listen.mjs`, `scripts/reachability.mjs` (import claude-channel) — referenced in `docs/CLAUDE-CHANNEL.md`, `docs/CONNECT-RECEIVE.md`.
- `scripts/runtime-package.mjs` imports `client/assistant-tools.mjs` in its optional package list (line 344); `server/mcp-full-profile.mjs` also imports it.
- `agent-resume.mjs` ← `client/agent-wake.mjs`; `grok-host.mjs` ← `client/agent-resume.mjs` (transitively live via wake client).

**Notes.**
- `public/` (named in the slice) does not exist in this tree — nothing to analyze there; not dead code, just absent.
- Within-module dead *exports* were not exhaustively audited; the export surfaces are small and each module's primary exports are consumed by the importers above. No module-level dead code found — nothing removed.
