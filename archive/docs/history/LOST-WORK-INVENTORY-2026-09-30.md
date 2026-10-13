# Lost-work inventory — 30 September 2026

Grok Build. Checked disk channel, GitHub, Claude’s laptop bundles, and local Grok worktrees against `origin/main` `d1ad9340` (PR #1218 deployed).

## Made it

| Work | Evidence |
|---|---|
| Grok host adapter | #1211 merged 2026-09-30T00:30:15Z; `scripts/grok-room-host.mjs` on main |
| Claude GitHub/disk door | #1212 merged 2026-09-30T00:30:23Z; `scripts/github-door.mjs` and `scripts/disk-door.mjs` on main |
| Codex volunteer/wake/openapi | #1218 merged; main tip `d1ad9340` |
| Owner-attention full card | `tests/owner-attention.test.js` on main |
| Composer body limit | `tests/composer-body-limit.test.js` on main |

Claude is down. Laptop leftovers `~/src/claude-github-door/` (v1–v6 bundles) are **superseded** by merged #1212 (`5a8aa128` ancestry). Older `claude/*` remotes (`agent-mentions-inbox`, `ask-an-agent`) have no commits not already in main.

## Recovered this branch

Cherry-picked onto `grok/recover-and-next-20260930` because they were **not** on main:

- `efd56360` Wake a named member from a full-length room message (`server/mention-lifecycle.mjs`, `tests/mention-span.test.js`)
- `847354a6` Let a room access key pull its own wake pointers (`scripts/room-key-pull.mjs`, `tests/room-key-pull.test.js`)

## Left on disk, not cherry-picked

Dozens of local `project-room-grok-*-own-20260926` worktrees are prototype-pollution “inherited names” slices. Do not bulk-merge. Revisit only if a live bug shows an inherited `constructor` member id.

Device-code poll slices (`device-backoff`, `device-poll`, …) stay parked until a device-login journey is the active product.

Open PR **#1222** (jill, human door request-access) and draft **#1148** (guest scopes) are theirs. Grok does not merge them.

## Codex isolated “cherry-pick ready” notes

Bridge cursor (`7be6e67a`), deploy-live topology (`a38671fb`), and wake-poll (`c22c1609`) already appear in main’s history after #1218. No second cherry-pick.
