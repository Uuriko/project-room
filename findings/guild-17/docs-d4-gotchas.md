# CI/CD gotchas (guild-17 reference)

_Date: 2026-10-08 · all verified against `origin/main` @ b53c52af1._

1. **Workflow flags are GLOBAL and must precede the verb.** `scripts/room --dry-run
   sweep` is a dry run; `scripts/room sweep --dry-run` silently runs LIVE. (This
   bit a room-watch run on 2026-09-18.)

2. **`pull_request` vs `pull_request_target`.** `pull_request` runs the base
   branch's workflow file but checks out the PR merge commit (untrusted code runs
   — keep permissions read-only, no secrets). `pull_request_target` runs in full
   base context (trusted code, may hold secrets) and must never check out the PR
   head. Both patterns are used correctly in this repo (trace-entry, room-work-sync).

3. **GITHUB_TOKEN suppresses downstream workflows.** Events caused by GITHUB_TOKEN
   don't trigger new workflow runs (anti-recursion). That's why trace-entry uses a
   PAT — a bot PR opened with GITHUB_TOKEN would never get CI and could never merge.

4. **`review-mechanical`'s `workflow_run` leg checks SHA pairing.** A completed
   `test` run is only paired with a PR when `workflow_run.head_sha` equals the
   PR's current head — stale runs are skipped, not misattributed.

5. **Required checks are jobs inside `test.yml`, not one-workflow-per-check.**
   The contexts `test/contract/lint/browser/cloudflare` are mostly jobs in a
   single workflow file. Two workflows emit `test` and two emit `cloudflare` —
   all same-named runs must be green.

6. **`strict: false`.** PRs merge behind main. The push-to-main re-runs
   (test, schema-gate, staging, …) are the backstop, not the gate.

7. **Actions are 100% SHA-pinned** — but `soak-test.yml` uses a different
   upload-artifact SHA than everyone else. Same action, two pins. Harmless,
   confusing.

8. **Merge-queue workflows are inert** (double-gated: no `merge_group` events
   without the queue; `MERGE_QUEUE_BOT` unset). If the queue is ever enabled,
   re-audit the eject-budget ledger-commit path.

9. **The default wrangler env name is misleading.** Top-level `name:
   "project-room-staging"` in wrangler.jsonc — a bare `wrangler deploy` targets
   staging-named config. CI always passes `--env` explicitly; humans should too.

10. **Every merge spawns a trace-entry bot PR**, which itself runs full CI and
    merges. Budget ~2× CI runs per merge at high velocity.

11. **`verify:affected` can hang** (>180s). Fall back to targeted `node --test`
    on the changed files.

12. **`schema-gate` is advisory, not required** — but `deploy-prod` refuses to
    ship any SHA without a green schema-gate push run. A schema-red main blocks
    all deploys and trips the hourly drift alarm until a green commit lands.

13. **No CODEOWNERS + advisory reviews + push-to-main workflows carrying deploy
    secrets = the live exfiltration hole** (see gate-g5). A fix commit exists on
    `origin/wave400/audit` (b42febd80) but is unmerged, and it additionally needs
    the `require_code_owner_reviews` admin setting flipped.
