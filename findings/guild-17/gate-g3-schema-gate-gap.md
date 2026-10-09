# Gate G3: schema-gate is NOT a required check — merge/deploy gap

_date: 2026-10-08 · guild-17 ci-deploy · head b53c52af1_

## Evidence
- Branch protection required contexts (live API): `[test, contract, lint, browser, cloudflare]`. `schema-gate` is **absent**.
- `schema-gate.yml` header comment (lines 30-33): *"What blocks: this job failing fails the check run. To make it merge-blocking on main, add the `schema-gate` job as a required status check in the repo's branch protection settings (a repo-settings change — needs John's tap)."*
- `schema-gate.yml` runs on `pull_request` AND `push: [main]` — so every main commit still gets a schema-gate run; it just cannot block the merge itself.

## Impact analysis
- **Merge-time**: a PR can merge with schema-gate red (or skipped). The bounty-propose-500 incident (post-#792, 2026-09-22: `bounty_records has no column named rubric_json` on partially-migrated shards) is exactly the class of bug this gate exists to catch — and it is the one gate that understands shard-migration convergence.
- **Deploy-time mitigation (real)**: `deploy-prod.yml` gate job *refuses* any deploy whose SHA lacks a successful `schema-gate` **push** run (`for wf in test schema-gate; ... [ "$CONCLUSION" != "success" ] ... refuse/skip`). So a schema-broken commit can land on main but cannot be deployed to production. Verified in deploy-prod.yml lines ~118-133.
- The residual window: a schema-broken merge sits on main until fixed; `deploy-drift` will alarm (production behind main), and every subsequent deploy is blocked until a schema-green commit lands. Self-limiting but noisy.

## Verdict: GAP CONFIRMED but self-mitigating at the deploy gate. Adding schema-gate to required checks needs John's tap (repo-settings change). Recommending it be proposed as a tap item rather than filed as a new BUG — the workflow itself documents this state.
