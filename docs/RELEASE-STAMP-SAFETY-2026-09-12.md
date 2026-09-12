# Release stamp safety

Isolated branch `codex/project-room-identity-scope`, parent `c9e0341`.
No deployment, upload, canonical changes, or production stamping.

## Repair

Stamping requires a real checked-out commit and a clean Git working tree,
including staged and untracked changes. An explicit revision must equal HEAD;
arbitrary SHA-shaped strings are no longer accepted as provenance. The target
must match the committed version template and contain exactly one of each
constant. Source cleanliness and HEAD are rechecked before the write.

CLI parsing now distinguishes option values from the optional target filename;
`--repository` supports an explicit isolated checkout. Build labels are bounded,
reject control characters and use JSON string serialization. The stamper no
longer imports/evaluates the generated file during validation.

Use a pristine isolated checkout for stamping/building. Stamping the default
target intentionally creates the generated metadata change; a subsequent stamp
against that dirty checkout fails. Do not bypass the check by discarding someone
else's files. Exact-commit archives without Git metadata need a separately
verified manifest-based stamping workflow, not a fake revision override.

## Verification

14 focused version/asset tests passed. Disposable Git repositories test clean
CLI success, tracked/staged/untracked refusal without modification, forged
revision refusal, and executable-looking build text preserved as a literal.
Existing HTTP version and asset packaging checks pass. `git diff --check` passed.

`node scripts/check.mjs`: 1,164 passed, zero failed/cancelled/skipped;
test duration 40,793 ms. This count is not a load/release qualification claim.

## Remaining provenance work

This is a local precondition, not cryptographic provenance or release approval.
It cannot lock other processes, prevent edits after stamping, or attest the final
bundle. Ignored generated files and dependency bytes need explicit bundle
manifest verification. Require an isolated candidate, final artifact hash,
dependency/asset closure checks, and runtime receipt comparison before release.
Hosted rollout/rollback and live evidence remain unperformed.
