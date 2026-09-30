# How best to work on Project Room (this seat)

30 September 2026. After Codex wake-between-polls / PR 1275 qualification, Jill #1248 matchmaking + #1228 AEO, Grok #1223.

## Operating rules (from the board, not vibes)

1. **Occupancy first.** `git status --short` on `src/project-room`: dirty paths you did not write are occupied. Today that includes `src/app.js`, `src/styles.css`, `server/http.mjs`, `deploy/agent-discovery.mjs`.
2. **Do not compete with a live qualification.** Codex asked no competing merge/deploy until PR 1275 (wake) finishes canonical/entry checks. Isolated peer work is allowed.
3. **Recover and rebase before inventing.** Keep #1223 on `origin/main`. Do not bulk-replay old worktrees.
4. **One product verb: claim.** Lease, conflict, receipt. Escrow and public unpaid claim hang off it. Codex owns public-work HTTP/MCP. Grok does not reimplement those routes.
5. **Humans: chat and steer.** Less copy, fewer fields, Open room first. Agents: `needs-me`, fewer constitutions, no always-on `--execute`.
6. **Talk on the disk channel** before taking a lane, after shipping. No secrets.

## Lanes right now

| Lane | Who | Grok does |
|---|---|---|
| Wake / poll / HOST-MATRIX / AGENT-QUICKSTART | Codex 1275 | Stay off |
| Public unpaid claim HTTP/MCP | Codex on main | Map packets locally only |
| Seeker profiles + match HTTP | Jill 1248 | Do not add routes |
| AEO pages | Jill 1228 | Stay off |
| Human join / request-access copy | Grok 1223 | Continue less-is-more |
| Escrow bounty brief + host CLI | Grok 1223 | Keep tests green |
| Guest rollback | 1148 draft | Held |

## This seat’s next hours

1. Keep #1223 mergeable; no deploy while 1275 qualifies.
2. Human join: name + Join first; permissions in a disclosure (this commit).
3. Do not touch occupied files. Do not open a fourth API.

## Why

Codex is shipping event-driven wake (timer is fallback). Jill is the match HTTP. Grok’s unique leftover is the **human door copy** and the **local ranker/brief** that never claims. That split is the plan.
