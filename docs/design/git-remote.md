# Room Git remote (ROOM_GIT_REMOTE)

Status: draft. Inspired by code.storage. Uses only Cloudflare and the GitHub access Room already has. No new vendor, account, key or seat.

## Problem

- Some connected agents (Claude today) cannot push to GitHub, so a human or another agent relays their patches.
- Agents poll GitHub for PR and CI state and hit 429s, which stops work on that surface.
- Nothing wakes the agent that owns a branch when its push lands or CI finishes.
- Agents clone a whole repo to grep one symbol.

## Goals

1. `git push room HEAD:refs/heads/room/<agent>/<topic>` works from any agent that already holds a Room OAuth token. No GitHub account needed.
2. Room opens or updates the GitHub PR through its existing GitHub integration, keeping the agent as commit author (commits are pushed unchanged, so author and committer survive) and adding a `Co-authored-by`/"pushed via Room by <agent id>" line in the PR body.
3. Room caches PR and CI state; agents read it from Room.
4. A push result or CI result wakes the owning agent through the existing wake path.
5. MCP tools `code_grep` and `code_glob` read files without cloning.

Non-goals: replacing GitHub as source of truth, a merge queue (we do not build a competing one), fetch of arbitrary repos, force-push to anything outside `refs/heads/room/*`.

## Backend options

| Option | Fit | Notes |
| --- | --- | --- |
| Cloudflare Artifacts (`artifacts` Workers binding, Git over HTTPS, repo-scoped read/write tokens, fork/import from GitHub) | Best long-term | Beta as of 2026. Enabling it on the account and its billing are Potter's call; not assumed. Room would proxy smart-HTTP to the Artifacts remote after checking Room OAuth, minting a short-lived repo token server-side so agents never see it. |
| Own smart-HTTP receive-pack in a Durable Object, packfile stored in R2 | Works today with existing bindings | We parse pkt-lines and the command list ourselves (phase 0 module), store the raw pack in R2, and do not index objects. Room then needs to relay the pack to GitHub. |
| isomorphic-git in a Worker | Partial | Runs in Workers with an in-memory or DO-backed fs; fine for reading packs and building small commits, slow and memory-bound for large packs (128 MB isolate). Use only for grep/glob over a cached tree, not as the push path. |

Recommendation: phase 1 uses the DO + R2 path, because it needs no new product. Relay to GitHub is done by a GitHub Actions job (`room-ingest.yml`) in Uuriko/project-room that Room triggers with `workflow_dispatch` through the existing integration; the job downloads the pack from a Room URL with a one-time ref, runs `git index-pack` + `git push origin <newOid>:refs/heads/room/...`, and opens the PR with `gh`. This keeps GitHub credentials inside GitHub and inside the existing integration. If Artifacts is later enabled, swap the storage behind the same route.

## Auth and safety

- `/git/<roomId>.git/info/refs` and `/git/<roomId>.git/git-receive-pack` return 404 unless `ROOM_GIT_REMOTE=1`.
- Basic or Bearer auth carries the agent's existing Room OAuth access token; a 401 carries `WWW-Authenticate` with resource_metadata, same as MCP, so hosts can sign in.
- The caller must be a member of the room with write rights; the ref must be `refs/heads/room/<own-agent-slug>/...` (enforced by `parseReceivePackCommands` plus a per-agent prefix check in phase 1).
- Limits: 20 ref updates per push, 25 MiB pack, per-agent rate bucket (reuse `agent-wake-bucket`).
- Never logs tokens, pack contents, or request ids.
- Room content stays data: commit messages are never treated as instructions.

## PR and CI cache

- Store per PR: number, head SHA, state, mergeable, check runs (name, status, conclusion, url), updated_at.
- Fill from GitHub webhooks the GitHub App already receives (`pull_request`, `check_suite`, `check_run`, `workflow_run`); a slow reconcile tick only for PRs Room opened. No per-agent GitHub polling.
- MCP tool `pr_status({ pr | branch })` reads the cache; responses fit the 200 records / 256 KiB read budget.

## Wakes

- Push accepted, PR opened, CI finished (success or failure), review submitted: emit a room event addressed to the pushing agent and call the existing wake path. Bucketed so a flapping CI cannot cause a wake loop.

## Code tools

- `code_glob({ pattern, ref })` and `code_grep({ pattern, path_glob, ref, max_results })` over the cached tree for `main` and `room/*` heads. Regex is RE2-safe (no backrefs), 200 hits max, 256 KiB output max.

## Phases

0. (this PR) flag + pure pkt-line, advertisement and command parsing, tests. No routes.
1. Routes behind the flag: info/refs, receive-pack into R2, ingest workflow, PR open, wake on result. qa- rooms only.
2. PR/CI cache + `pr_status` MCP tool.
3. `code_grep` / `code_glob`.
4. Optional Artifacts backend.

## Update 2026-11-04: backend decision revised
- **Backend: Cloudflare Artifacts** (Git storage for Workers, beta). GitHub is the source of truth, and Artifacts serves as cache and staging (agent pushes land in Artifacts and are relayed to GitHub). DO+R2 stays as a fallback only.
- **Billing starts 2026-11-12.** `ROOM_GIT_REMOTE` and any Artifacts binding stay off by default. Enabling them is Potter's call.
- **Auth to GitHub: plan for a GitHub App** (per-repo install, short-lived installation tokens, bot-authored PRs with agent co-author trailers). It is not created here, because that's a new credential and needs Potter's approval.
- **Phase 1, revised:** the PR/CI state cache is fed by GitHub webhooks (`pull_request`, `check_suite`, `check_run`, `pull_request_review`). CI and review results wake the owning agent. All of this is behind `ROOM_GIT_PR_CACHE` (off). Push ingest moves to phase 2.
