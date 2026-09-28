# Secret scanning

Two gates, one detector (`server/secret-scan.mjs`):

1. **Tree scan** — `scripts/secret-scan-check.mjs`. Runs in the contract CI job
   (`node check.mjs` spawns it). Walks `server/`, `src/`, `scripts/`,
   `client/`, `cloudflare/`, `deploy/`, `lanes/`, `specs/` plus repo-root
   `*.mjs`, and fails the build on any finding.
2. **Diff gate** — `scripts/secret-scan-diff.mjs`. PR-focused and fast: scans
   only ADDED lines of `git diff <base>...HEAD` (default base `origin/main`).
   Same detector, same line allowlist, same scope policy — the two gates
   never disagree about a line.

Exit codes (diff gate): `0` clean, `1` findings, `2` usage/environment error.
Findings print `path:line [rule] label (preview)` — previews are redacted,
so they are safe to leave in CI logs.

## Exemptions

- **Line allowlist** (`ALLOWLIST` in `scripts/secret-scan-check.mjs`): named
  known-safe patterns (the scanner's own documented regexes, redacted
  placeholders, runtime-generated values like `randomBytes(...)`, env-var
  *names*). Entries match the documented regex *text* (e.g.
  `AKIA[0-9A-Z]{16}` as literal characters), never real secret shapes — a
  looser entry would silently disable a whole rule.
- **Path allowlist** (`.github/secret-scan-allowlist.txt`): whole-path globs
  for the diff gate. Every entry MUST carry a reason after `#`; entries
  without one are ignored, so exemptions stay reviewable in PR diffs.
  Prefer the line-level allowlist; use paths only for known-safe files
  (e.g. fixture files of seeded fake secrets).

## Local usage

```sh
node scripts/secret-scan-diff.mjs                  # diff vs origin/main
node scripts/secret-scan-diff.mjs --base main      # diff vs main
node scripts/secret-scan-diff.mjs --staged         # staged changes (pre-commit hook)
node scripts/secret-scan-diff.mjs --files a b c    # scan files directly
node scripts/secret-scan-diff.mjs --allowlist none # disable the path allowlist
```

## Tests

`tests/secret-scan.test.js` pins the detector; `tests/secret-scan-diff.test.js`
pins the diff gate (10 tests): diff parsing (added-lines-only, line numbers,
deleted/binary handling), all 11 seeded rule families flagging on added lines,
exit codes, the path-allowlist loader, the pre-commit `--staged` path, zero
false positives against the current `origin/main` tree, and the gate's own
new files not self-flagging. All example secrets are generated at runtime so
the test files never contain a literal secret-shaped string.

If the gate flags your change: remove the secret (rotate it if it was ever
real) or add a path entry with a reason to
`.github/secret-scan-allowlist.txt`.
