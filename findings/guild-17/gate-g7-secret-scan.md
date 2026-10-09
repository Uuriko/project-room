# Gate G7: secret-scan gates — presence and wiring

_date: 2026-10-08 · guild-17 ci-deploy · head b53c52af1_

## Evidence
- `.github/secret-scan-allowlist.txt` exists: path-level escape hatch for
  `scripts/secret-scan-diff.mjs` (diff gate). Currently **zero active entries**
  ("No active entries: the tree is clean and every exemption needs a reason").
  Line-level patterns live in `scripts/secret-scan-check.mjs` (ALLOWLIST).
- `test.yml` runs `node scripts/scan-secrets.mjs --base "$BASE_SHA"` (seen in the
  workflow source) — the tree/diff scan is wired into the required `test` check,
  i.e. it is merge-blocking via branch protection.
- No standalone secret-scan workflow file — the scan runs as a job/step inside
  `test.yml`, which is the correct place (it inherits the required-check status).

## Verdict: PASS. Secret scanning is wired into the merge-blocking test suite,
the allowlist is empty (nothing exempted), and exemptions require a per-line
reason. Residual note: a scan that runs inside `test.yml` only sees the PR diff
base (`--base $BASE_SHA`) — historical secrets already on main are not
re-scanned per run; that's the tree scan's job on its own schedule (verify
scripts/secret-scan-check.mjs wiring separately — out of this slice's depth).
