# Gate G9: supply-chain hygiene — action pinning, cache, artifacts

_date: 2026-10-08 · guild-17 ci-deploy · head b53c52af1_

## Action pinning sweep (all 31 workflows, verified)
Every `uses:` observed across all workflow files is **SHA-pinned** (40-hex ref
with a `# vN` comment for readability):
- `actions/checkout@11d5960a326750d5838078e36cf38b85af677262` (v4)
- `actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020` (v4)
- `actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02` (v4) —
  note: `soak-test.yml` uses a DIFFERENT SHA `b5c5fca5f78071c0d17c0d02a9e0dcf5e5e1`
  for the same action (still SHA-pinned; inconsistent but not vulnerable)
- `actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093` (v4)
- `actions/cache@5a3ec84eff668545956fd18022155c47e93e2684` (v4.2.3)
- `pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1` (v4)
- `astral-sh/setup-uv@d0cc045d04ccac9d8b7881df0226f9e82c39688e` (v6)
- `actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09` (v5, mcp-registry-publish only)
No tag-only or branch refs. No `docker://` actions. No third-party composite
actions beyond the well-known set above.

## Cache poisoning
`actions/cache` is used in `test.yml` (node_modules) and `soak-test.yml`.
Cache keys on PR runs are writable by the PR run itself; a poisoned cache could
only affect subsequent runs of the same branch/PR (GitHub cache isolation:
PRs cannot overwrite base-branch caches, only read them). Acceptable; no
cross-PR contamination path. No cache is restored in the deploy workflows
(deploy-prod does `npm ci --no-audit --no-fund` fresh — verified in the probe job).

## Artifact hygiene
- Artifacts are test evidence (fuzz corpora, soak reports, synthetic journey
  JSON) with bounded retention (14d fuzz, 90d answer-engine/snippet-adoption).
- `answer-engine-check.yml` uploads **raw LLM answers** as artifacts
  (90-day retention). The workflow header says "Raw answers are artifacts and
  are not committed." Residual: artifacts are visible to anyone with repo read
  access; prompts ask about Project Room — low sensitivity, but the raw-answer
  artifact could in principle echo prompt content. No secrets are passed in
  prompts (keys are env-only). Acceptable.

## Verdict: PASS. Pinning is exemplary (100% SHA). No cache/deploy contamination.
One hygiene nit: unify the upload-artifact SHA in soak-test.yml to the common
`ea165f8d…` (zero behavior change; reduces pin-drift confusion).
