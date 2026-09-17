# What the "contract" CI job enforces

The `contract` job in `.github/workflows/test.yml` runs `npm run check`
(`node scripts/check.mjs`). Despite the name, it is not only a syntax
check — it is eight steps, run in this order:

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
4. **`scripts/route-docs-check.mjs`** — every `/api` route template
   `server/http.mjs` can match is described in `docs/openapi.yaml` (with
   its security scheme), and nothing described there has gone unserved.
   Added after the 2026-09-14 re-audit found 23 of 64 templates documented.
5. **`scripts/check-schema-version.mjs`** — the store schema number has one
   source (`STORE_SCHEMA_VERSION` in `server/writer-fence.mjs`); the README,
   `docs/CURRENT-ROOM.md`, `docs/SERVICE.md` and the writer fence must agree.
6. **`scripts/lint.mjs`** — ESLint with the correctness-only rules in
   `eslint.config.mjs` (`no-undef`, `no-unused-vars`, `no-dupe-keys`, …).
   Errors fail the gate, warnings are printed; it is skipped with a notice
   when the `eslint` devDependency is not installed (no `npm ci`). The CI
   `lint` job runs the same script standalone (`npm run lint`).
7. **`scripts/open-routes.mjs --check`** — every `security: []` route in
   `docs/openapi.yaml` is named in `docs/ROUTE-AUTH-TABLE.md` and
   `docs/INVITE-ONLY-CHECKLIST.md` §1, so no open route is undocumented.
8. **`node --test`** — the full unit suite. The browser suite
   (`test:browser`) runs in a separate job.

If `contract` is green but `browser` is red, the failure is in the
Playwright UI checks, not in the API contract. If `contract` is red, start
with the gate that failed — in that order, syntax, coverage, shadows,
route docs, schema version, lint, open routes, units.
