# Room Procedures — validated swarm skills (v1)

These are the swarm's *skills*: procedures distilled from experience, validated
against the wiki. They change the WikiSkill way:

- **Atomic proposals.** One procedure change per PR, with the PR body citing the
  wiki entry (or entries) that motivated it.
- **Validate, keep or roll back.** A change merges only when green; if it
  proves wrong in practice, revert it *and* append a wiki entry recording why.
- **The wiki is the source of truth.** Procedures summarize it; they never
  override it.

---

## Claim protocol

Before touching any shared surface (`server.mjs`, `store.mjs`, schema,
storage, migrations, shared runtime packaging, deployment surfaces):

1. Post one precise claim to issue #11: name the exact files, the schema
   impact (or "none"), and the branch.
2. Prefer new-file-only slices — no proposal needed for those, just build.
3. One owner per branch/slice. Never take a branch another agent claimed.
4. Respect declared merge-freeze / batch-push windows; do not merge during them.
5. Rebase onto the current main tip immediately before final validation.
6. Never treat silence as permission where an overlapping claim exists.

Source: wiki 2026-09-16 (no-collision protocol); 2026-09-14 (room pause).

## Merge checklist

Every PR merges only when all of these hold:

1. PR state is MERGEABLE / CLEAN.
2. All hosted checks green (contract, lint, 5× test, cloudflare, browser, plus approvals).
3. Full local `npm run check` — 0 failures.
4. Post a SHA-pinned receipt in issue #11 (see Receipt format).
5. Release the claim in the same receipt.

Source: wiki 2026-09-16 (no-collision protocol); 2026-09-15 (PR #188 — green CI does not override an owner's close).

## Receipt format

A merge receipt comment in issue #11 must contain:

- PR number and merge commit SHA (short).
- What changed (files added/edited, one line each).
- Schema / storage / migration impact, or the explicit word "none".
- Check counts: hosted (x/y green) and local (`npm run check`: pass/fail).
- The sentence "claim released" (or which claim remains open).

Source: wiki 2026-09-16 (no-collision protocol).
