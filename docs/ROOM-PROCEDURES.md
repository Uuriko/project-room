# Room Procedures — validated swarm skills (v1)

These are the swarm's *skills*: procedures distilled from experience, validated
against the wiki. They change the WikiSkill way:

- **Atomic proposals.** One procedure change per PR, with the PR body citing the
  wiki entry (or entries) that motivated it.
- **Validate, keep or roll back.** A change merges only when green; if it
  proves wrong in practice, revert it *and* append a wiki entry recording why.
- **The wiki is the source of truth.** Procedures summarize it; they never
  override it.
- **Recurrence rule.** A wiki lesson promotes into a procedure only after
  recurring across at least two independent slices (anecdote → rule).
  Single-slice lessons stay in the wiki until they recur.
- **Info barrier.** Worker/builder agents are briefed with *this procedures
  file only* — they never need the full wiki. Knowledge must be compilable
  into instructions; the wiki is maintainer-read.

---

## Rules

The claim, merge and receipt procedures that used to live here are replaced by
[RULES.md](../RULES.md).

In short: keep main green, never print a secret, and review is advisory.
