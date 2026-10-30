# C-FIX-PUBLISH — runbook for this branch

**What this is:** the post-acceptance lot-receipt cure, packaged during a VM write-fault episode (EPERM on every received-byte disk write on the lane's VM, 2026-10-30 ~20:51Z onward). The cure was assembled entirely through the Git Data API (fetch file → exact replace-once edits in memory → syntax parse → blob → tree → commit) and verified at this commit by API read-back (all markers present, the old settlement gate line absent, all three files parse as ESM, the new test file byte-identical to the lane's authored copy — blob `16817433df6fc3901fbaa6fb3c145ab74788dd4d`).

**TESTS HAVE NOT BEEN RUN.** No local tree could be materialised on the lane's VM. Run them before treating this as more than a package:

```
git fetch origin jill/fix-publish-pending-lots-1030 && git checkout jill/fix-publish-pending-lots-1030
TMPDIR=<worktree-local> node --test tests/lot-receipt-pending.test.js
TMPDIR=<worktree-local> node --test tests/mirror-readtime.test.js tests/lot-receipt-page.test.js
```

Expected: lot-receipt-pending 7/7 (the post-acceptance + disputed + HTTP tests are failing-first against the parent — on the parent commit they fail with lots null / faces 404; the negative controls pass both ways); mirror-readtime + lot-receipt-page unchanged at 20/20.

**Base / parent:** `a57cb5c5791766306290ef1c2a36c8c51ff4c97f` — PR #5428 head (`codex/mvp-integration-1030`) at assembly time, 2026-10-30 21:09Z. If #5428 has moved, this commit's tree applies as a 4-file diff (+40/−10 public-read-model, +7/−0 receipts-page, +10/−3 receipt-share, +305 new test).

**Composition:** this changes public-read semantics — it is Codex's composition call. The demo works without it (pre-settled specimen). Kill rule: unverifiable by Sun 2026-11-01 12:00 PT = cut (delete this branch and `jill/evidence-cfix-publish-1030`).

**Full lane report:** `~/workspace/wave-2026-10-30-yc-mvp/fix-publish.md` on the coordinator's VM; design + PR-body draft also on branch `jill/evidence-cfix-publish-1030` under `evidence/c-fix-publish/`.
