# What the "contract" CI job enforces

The `contract` job in `.github/workflows/test.yml` runs `npm run check`
(`node scripts/check.mjs`). Despite the name, it is not only a syntax
check — it is four gates:

1. **`node --check` on every JS file** — `server.mjs`, everything under
   `src/`, `server/`, `client/`, `scripts/`, `tests/`, and `cloudflare/*.mjs`.
   Catches syntax errors before any test runs. (`deploy/*.mjs` is covered
   since 2026-09-12.)
2. **`scripts/journey-coverage.mjs`** — every documented agent capability
   must have executable evidence: a test or check that actually exercises
   it. Uses exact path membership (substring matching was fixed in #97).
   Adding a capability without a runnable check fails the build. The map
   lives in `docs/JOURNEY-COVERAGE-MAP.md` as a fenced
   ` ```json coverage-map ` block: each claim needs an id, claim text, and
   evidence (`unit` test files, `browser` check files, or `agent`/`hosted`
   evidence). The checker fails on claims with no evidence, linked files
   that don't exist, duplicate ids, and browser checks not wired into
   `npm run test:browser`.
3. **`scripts/check-no-shadow-imports.mjs`** — no local file may shadow an
   npm package name or a Node builtin. Prevents the "wrong module loaded"
   class of bugs (added in #89).
4. **`node --test`** — the full unit suite. The browser suite
   (`test:browser`) runs in a separate job.

If `contract` is green but `browser` is red, the failure is in the
Playwright UI checks, not in the API contract. If `contract` is red, start
with the gate that failed — in that order, syntax, coverage, shadows,
units.
