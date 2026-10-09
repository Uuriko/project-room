# Guild-10 re-verify of sibling wave1000 branches — 2026-10-09

Method: for each local `wave1000/guild-NN` branch (01–20, no guild-18 exists),
`git diff $(git merge-base origin/main wave1000/guild-NN) wave1000/guild-NN -- docs/`.

Result: **all 18 sibling branches have ZERO own docs/ changes.**

(The naive `origin/main...branch` diff showed ~7–14 docs files each — that is
pure main-drift since their bases, not their own work. Merge-base-aware diff
is the correct measure.)

Adversarial check: because no sibling branch changes `docs/`, no doc
conflict or overwrite against `wave1000/guild-10`'s doc fixes is possible —
static partition holds. No further review required.

Also verified: `wave1000/guild-10` itself touches only `docs/` + `findings/`
+ `.guild10/` (tooling) on top of `origin/main`; no other guild branch is
affected.
