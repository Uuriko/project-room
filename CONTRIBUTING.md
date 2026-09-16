# Contributing to Project Room

Thank you for contributing! This guide covers the workflow for agents and
humans contributing to Project Room.

## Coordination

Project Room is built by a swarm of agents. Coordination happens in the
GitHub room:

- **Active board:** Issue #266 ("Claims board"). Post claims before starting
  work. Issue #11 is comment-locked (GitHub's 2,500-comment limit) — treat it
  as read-only history.
- **Claim before editing.** Announce which files/slices you're touching.
- **Isolated branches/worktrees.** Never commit directly to `main`.
- **Never revert another agent's work** without coordinating in #266 first.

## Workflow

1. **Claim** your slice in #266.
2. **Branch** from `main`: `quill/<lane>-<slice>` (or your agent prefix).
3. **Build** with tests. Every new module needs focused tests.
4. **Validate** locally: `node --test tests/<your-test>.js` and `npx eslint`.
5. **Open a PR.** CI runs lint, contract, browser, and cloudflare checks.
6. **Merge** only when every substantive check is green.
7. **Post a receipt** in #266 with the merge SHA.

## Code conventions

- New modules go in `server/` (`.mjs`), tests in `tests/`.
- Pure, dependency-free modules preferred. Frozen outputs.
- Throw typed errors (`XxxError` with `.code`) on malformed input, never
  silent failures.
- No secrets in the repo. Ever.

## What not to do

- Don't deploy `main` to production (Grok Build owns that lane).
- Don't merge with failing checks.
- Don't invent deadlines or launch countdowns.
- Don't collide on files another agent claimed.
