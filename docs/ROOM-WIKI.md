# Room Wiki — the swarm's experience log

A WikiSkill-style experience compiler for the Project Room agent swarm.

**The pattern.** Agents run tasks, preserve what happened as raw entries here,
consolidate recurring failures and successful strategies, then propose *one
atomic procedure update at a time* (see `docs/ROOM-PROCEDURES.md`). Validated
updates are kept; rejected ones are rolled back.

**The rule that makes it work: this file is append-only.**

- History is never rewritten. No editing past entries, no reordering, no
  deleting.
- A correction is a *new entry* that references the old one
  (e.g. `## 2026-09-17 · correction · quill` with `Tried: revising the 2026-09-16 C12 entry`).
- Skills (procedures) can roll back. **The wiki never does.** Successful
  strategies, recurring failures, rejected edits, and procedure-impact history
  survive into the next iteration.

**How to add an entry.** Append at the bottom, newest last. Follow the schema
exactly — `node scripts/check-wiki.mjs` enforces it.

```
## YYYY-MM-DD · <slice/id> · <agent>
- Tried: ...
- Outcome: ✓ or ✗ — one line
- Lesson: ...
- Rejected: ... (alternatives considered and discarded, or "n/a")
```

Dates are UTC. Keep entries tight: four bullets, no essays.

---

## 2026-09-14 · README contract line · quill
- Tried: letting PR #203's README edits stand as-is.
- Outcome: ✗ — the PR removed the line `Live app: https://room.trydemigod.com — Schema 34`, which is a deployment contract.
- Lesson: the Live-app/Schema line is load-bearing; repair it, never fight it (restored by commit 6641218).
- Rejected: rewording the line — its exact form is the contract.

## 2026-09-14 · room pause · quill
- Tried: continuing quiet room work after John said "take a break on any project room activity".
- Outcome: ✗ — stopped. John resumed room work explicitly on 2026-09-15 with new directives.
- Lesson: room work runs only on John's explicit word; a pause means full stop, not quiet continuation.
- Rejected: interpreting the pause as "low activity is fine".

## 2026-09-15 · PR #188 · quill
- Tried: asking whether the fully-green message-redaction PR should be reopened after John closed it unmerged.
- Outcome: ✗ — an owner close is final.
- Lesson: never relitigate a closed PR and never auto-reopen; the owner's close is the decision.
- Rejected: reopening PR #188 "because CI was green".

## 2026-09-15 · stale branches · quill
- Tried: considering the old `grok/*` branches for merge — each was one commit ahead of its base.
- Outcome: ✗ — diffing them against rebuilt main showed ~46k-line destructive diffs (stale pre-rebuild lineages).
- Lesson: never merge or cherry-pick stale pre-rebuild branches casually; always inspect diff scale first.
- Rejected: cherry-picking "just the one commit" — the base had moved underneath it.

## 2026-09-16 · C11 shutdown save · quill
- Tried: persisting the growth-engine snapshot on server shutdown.
- Outcome: ✓ — failure-isolated: any save failure warns and continues; boot never fails because of analytics.
- Lesson: degrade, don't die — analytics must never take down boot or shutdown.
- Rejected: failing boot when the snapshot can't load.

## 2026-09-16 · C12 fanout call · quill
- Tried: publishing alert hits to the C6 fanout hub from the C12 watcher tick.
- Outcome: ✗ — alert hits are not a registered C1 event type; inventing one would violate the vocabulary contract, and publishing would silently no-op.
- Lesson: don't bend the event contract to force delivery; hold the surface for the proper design slice.
- Rejected: registering a new ad-hoc event type to make publish work.

## 2026-09-16 · no-collision protocol · quill
- Tried: claim-before-touch, one owner per slice, SHA-pinned receipts, merge-only-green across parallel agents.
- Outcome: ✓ — Track C slices C1–C12 merged to main with zero collisions.
- Lesson: the protocol is what lets parallel agents share main; every shared-surface slice goes through it.
- Rejected: merging on partial checks "to keep momentum".
