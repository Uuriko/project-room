# Plan: Room GitHub + Dasha Compute audit (2026-09-15)

Do not mix products. Do not set Room `ship: true`. Do not merge GitHub `main` onto the live host. Dasha Compute is report-only from this lane (`dasha-desk` AGENTS.md: compute/ is a contractor lane).

## Prompt

Audit **Project Room** (`Uuriko/project-room`, live `https://room.trydemigod.com`) and **Dasha Compute** (`Uuriko/dasha-desk` `compute/`, live lobby `/compute`) for GitHub messiness and real bugs. Fix only Room paths you own. Record Compute findings; do not edit `compute/`.

## Room GitHub

1. List branches, open PRs/issues (REST; GraphQL was reset this session).
2. Compare `main` vs `production` vs live `/api/version`.
3. Read README on the live SHA. If it still names staging, correct it.
4. Extra branches: do not delete another agent’s work (`quill/specs-queue`).
5. Run `node scripts/live-audit.mjs`.

## Dasha Compute

1. `git ls-remote` `Uuriko/dasha-desk`.
2. Live: healthz, models, network, skill, agent.json. Follow 308s.
3. `cd ~/src/dasha-desk/compute && node --test tests/*.test.mjs`.
4. Write findings under `dasha-desk/docs/`. Do not wrangler, do not mint keys for the report body.

## Execute (this run)

Done below in Findings.

## Findings — Project Room GitHub

| Item | Result |
|---|---|
| Branches | `main`, `production`, extra `quill/specs-queue` |
| Live SHA | `c569027` = `production` on the remote |
| `main` | `6641218` Schema 34 / README rewrite — **not** this host |
| README on live SHA | Named **staging** `project-room-staging.getdasha.workers.dev` Schema 26 — **wrong**. Fixed this run. |
| Open PRs/issues | GitHub API TCP reset this session; `git ls-remote` worked |
| Live audit | Pass (`ship: false`, Google PKCE, privacy, `channels.js`) |

Do not fast-forward `main` onto `production`. Schema 34 stays off this Worker.

## Findings — Dasha Compute

Recorded in `~/src/dasha-desk/docs/COMPUTE-AUDIT-2026-09-15.md`. Local `npm test` 11/11. Live healthz `0.3.1` vs package `0.3.0`. Network path is `/compute/api/network`, not `/v1/network`. GitHub `dasha-desk` has many leftover OCM/cursor/quill branches.
