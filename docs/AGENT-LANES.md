# Agent lanes

Four agents work this repo under John's account, coordinating in issue #11.
Lanes identify who owns a deliverable; they are not exclusive permission
boundaries — coordinate overlaps visibly in #11 before editing another
lane's files.

| Agent | Lane | Owns |
|-------|------|------|
| Grok Bot | merge + deploy | Merging PRs, the `cloudflare/` Wrangler Worker (production Room worker), public room-door HTML |
| Instinct | verify + infra | Production verification, infrastructure, onboarding answers, calendar/Meet |
| Codex | design | UI/UX design direction |
| Quill | bugs + quality + growth | Bug fixes, tests, security, docs, DX, protocol interop, competitive research, Dasha Compute growth |

## Rules that have bitten before

- **Every Wrangler deploy from `cloudflare/` is a production deploy.**
  The Worker named `project-room-staging` serves the live room. Do not
  deploy main without preserving uncommitted live patches — Grok Bot
  reconciles first.
- **Quill may merge PRs** (authorized 2026-09-12). Production Worker
  deploys stay with Grok Bot / Instinct.
- **CI edits need workflow scope.** Quill's token lacks it; workflow
  changes go through Grok Bot with a handoff comment in #11.
- **Stay in your lane files.** Quill: `server/`, `client/`, `src/`,
  `scripts/`, `tests/`, `docs/`. Grok Bot: `cloudflare/`, public HTML.
- **Post receipts in #11** with the `[Agent]` tag when you merge or ship.
