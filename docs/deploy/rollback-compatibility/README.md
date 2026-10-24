# Rollback compatibility receipts (rollback-prod / R0)

`rollback-prod` refuses to run without a **committed** JSON receipt
covering the exact current/target pair, in the format
`scripts/manual-rollback.mjs` (`qualification()`) admits. This directory
holds those receipts and their qualification evidence.

## The format (extracted from scripts/manual-rollback.mjs at d7f723ad)

- The receipt is read from the checkout via `git show HEAD:<path>`; the
  `compatibility_file` workflow input is that repo-relative path. The
  path must match `^[a-zA-Z0-9][a-zA-Z0-9_./-]*\.json$` with no `.`/`..`/
  empty segments. Receipts in this directory satisfy that.
- Shape:
  ```json
  { "format": 1,
    "current": { "prod":  {"versionId": "<uuid>", "sourceRevision": "<40-hex>"},
                 "entry": {"versionId": "<uuid>", "sourceRevision": "<40-hex>"} },
    "targets": { "prod":  {"versionId": "<uuid>", "sourceRevision": "<40-hex>"},
                 "entry": {"versionId": "<uuid>", "sourceRevision": "<40-hex>"} | null },
    "checks":  { "oldCodeNewData":  {"result": "passed", "evidence": "<url>"},
                 "retainedRuntime": {"result": "passed", "evidence": "<url>"},
                 "workerBindings":  {"result": "passed", "evidence": "<url>"} } }
  ```
  `targets.entry` must be `null` when the dispatch leaves the entry
  Worker as-is; otherwise it must match exactly.
- `current`/`targets` must match the Cloudflare-observed allocations
  **exactly** (versionId + sourceRevision, both workers) at preflight
  time — so a receipt is pair- and deployment-specific, never reusable
  across deployments of the same SHA.
- Every check's `evidence` must be an `https://github.com/…` URL of the
  form `…/actions/runs/<digits>[/attempts/<digits>]` or
  `…/blob/<40-hex-commit>/<path>`, with no credentials, hash, or query.
  A `blob/main/…` (mutable) reference is rejected.
- Equal schema numbers alone are **not** qualification (script header):
  each check needs its exact-pair evidence, and the dispatcher must
  additionally set `compatibility_reviewed=true` after reviewing it.
  Version ids come from a deploy-prod run: the versions it creates are
  printed in its deploy job log (`Current Version ID: …`), and the
  versions it replaced are in its `pre-deploy-<sha>` artifact (the
  snapshot JSON is also printed in the same log).

## Receipts and evidence in this directory

| File | Pair | State |
|---|---|---|
| `ee97df61-to-77df0e0b.json` | current prod `ee97df613…` → `77df0e0b7…` | **Issued, format-valid.** Evidence: [evidence-ee97df61-to-77df0e0b.md](evidence-ee97df61-to-77df0e0b.md) + `boot-ee97df61-to-77df0e0b.json`. Valid while production remains on the `ee97df61` deployment recorded there. |
| [evidence-d7f723ad-to-ee97df61.md](evidence-d7f723ad-to-ee97df61.md) | freeze pair `d7f723ad…` → `ee97df61…` | Evidence complete and passing; **receipt not yet issuable** — the forward version ids do not exist until that head is deployed (named gap, in the evidence file). |
| [evidence-470d546a-to-ee97df61.md](evidence-470d546a-to-ee97df61.md) + `boot-470d546a-to-ee97df61.json` | declared-head pair `470d546a…` → `ee97df61…` | Evidence complete and passing (incl. the patrol_blocks variant; one restore-path limitation named in the evidence). **Receipt not yet issuable** — the forward version ids are created by that head's deploy-prod run; completion is the one generator command in [470d546a-to-ee97df61.GAP.md](470d546a-to-ee97df61.GAP.md). |

## Regenerating for the final frozen head (one command, post-deploy)

After the freeze deploy-prod run for the frozen head completes:

```sh
node scripts/make-rollback-receipt.mjs \
  --current-revision <frozen-head-sha> \
  --current-prod-id <prod uuid created by that run> \
  --current-entry-id <entry uuid created by that run> \
  --target-revision <previous prod sha> \
  --target-prod-id <prod uuid from that run's pre-deploy-<sha> artifact> \
  --target-entry-id <entry uuid from that run's pre-deploy-<sha> artifact> \
  --evidence https://github.com/Uuriko/project-room/blob/<commit-sha-of-the-evidence-file>/docs/deploy/rollback-compatibility/evidence-<pair>.md \
  --out docs/deploy/rollback-compatibility/<current-short>-to-<target-short>.json
```

The generator validates every field against the same rules
`manual-rollback.mjs` enforces and refuses to write anything with a
missing or malformed id or evidence URL. Commit the output on `main`
before dispatching `rollback-prod` with it.
