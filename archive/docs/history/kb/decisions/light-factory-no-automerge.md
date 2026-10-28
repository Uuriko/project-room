# Light factory: no auto-merge, ever

**Date:** 2026-09-26
**Decider:** jill lane (per deep-dive recommendation)

Autonomous loops (S4 burndown, night-shift routines) open PRs but never
merge. Merge stays a lane/John action after full-green hosted CI on the
exact head.

**Why:** Dex Horthy ran a real lights-off Ralph factory for three months
(2025) and abandoned it — the codebase degraded without human judgment
upstream. The software-factories consensus: nearly everyone serious runs
*light* factories. The gates are the product.

**Applies to:** S4 burndown workers, any future unattended loop.
