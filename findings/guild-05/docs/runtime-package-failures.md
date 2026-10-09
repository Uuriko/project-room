# scripts/runtime-package.mjs — failure modes & gotchas (guild-05 D7)

## Failure modes
- Every mismatch throws 'Runtime package does not match its exact allowlisted contract: <detail>' — the contract is exact, any drift fails.
- Shallow checkouts fail: baseline commit must be in history ('git fetch --unshallow').
- check() failures name the offending path/value for one-cycle fixes.

## Invariants
- Offline: no installs, uploads, deployments. Standalone-verifiable (copiable outside the checkout).
- Never reuses/overwrites the destination (mkdir wx, mode 0700/0600).
- Manifest is the completion marker; partial dirs are never valid packages.
- Asset declaration parsed, never executed (regex over the data-only array/spread/map shape).
- Limitation is explicit: content consistency only — not provenance, recovery freshness, hosted readiness, or publication approval.

## Gotchas
- tests/runtime-package.test.js has a companion COUNT assertion — registering a module without bumping it breaks main (recurring drift source).
- When rebasing onto a main that also changed the allowlist: union the path lists, keep main's.
- The literal-import scan is regex-based, not a full parser; computed loaders need human review.
- CLI catches ALL errors into one generic message ('Inspect the private output') — debug via the API, not the CLI.
