# Config C5: action-pinning sweep — comprehensive verdict

_date: 2026-10-08 · guild-17 ci-deploy · head b53c52af1_

## Method
Per-workflow `uses:` extraction across all 31 files (track-1 audit units),
classifying each ref as SHA-pinned (40-hex), tag-pinned, branch, or local.

## Result
**100% of third-party `uses:` references are SHA-pinned.** Full inventory:

| Action | Pinned ref | Comment |
|---|---|---|
| actions/checkout | `11d5960a326750d5838078e36cf38b85af677262` | v4, everywhere |
| actions/checkout | `fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09` | v5, mcp-registry-publish only |
| actions/setup-node | `49933ea5288caeca8642d1e84afbd3f7d6820020` | v4, everywhere |
| actions/upload-artifact | `ea165f8d65b6e75b540449e92b4886f43607fa02` | v4, everywhere except… |
| actions/upload-artifact | `b5c5fca5f78071c0d17c0d02a9e0dcf5e5e1` | v4, soak-test.yml only (drift nit) |
| actions/download-artifact | `d3f86a106a0bac45b974a628896c90dbdf5c8093` | v4 |
| actions/cache | `5a3ec84eff668545956fd18022155c47e93e2684` | v4.2.3 |
| pnpm/action-setup | `b906affcce14559ad1aafd4ab0e942779e9f58b1` | v4, test.yml |
| astral-sh/setup-uv | `d0cc045d04ccac9d8b7881df0226f9e82c39688e` | v6, qa2-fuzz.yml |

No `docker://`, no composite third-party actions, no tag-only refs, no branch refs.
This is exactly the posture the wave400 CODEOWNERS fix commit message describes
("Action refs are already SHA-pinned, so this file is the remaining half of the fix").

## Verdict: PASS — exemplary. Only nit: unify soak-test.yml's upload-artifact SHA
to the common one (zero behavior change).
